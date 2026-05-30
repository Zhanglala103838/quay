import { useEffect, useRef, type MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { termRegistry, appendBuffer, flushBuffer } from '../lib/termRegistry'
import { writeRun, resizeRun } from '../lib/ipc'
import { useSettings } from '../state/settings'
import { useStore } from '../state/store'
import { probeGpuRenderer } from '../lib/gpuProbe'
import { termStack, ensureFontsLoaded } from '../lib/fonts'

type Writers = MutableRefObject<Record<string, (s: string) => void>>

/// 只读 xterm(一期不接 stdin)。scrollback 5000 兜住前端内存。
/// 直接把 write 注册进 writers ref(ref 稳定),避免回调变化导致 term 重建丢输出。
///
/// active = 该格在当前分屏页可见(单/双/四格下可同时有多个 active)。性能:
///   1) 每个可见格各挂一个 WebGL 渲染器(切走即 dispose,绕开浏览器 ~16 个 GL 上下文上限);
///      最多四格 → 至多 4 个上下文,远低于上限。WebGL 不可用、或设置里关掉「GPU 渲染加速」
///      时退回 xterm 默认 DOM 渲染器。
///   2) 非可见格的输出囤进 termBuffers 而非实时 write,避免看不见的终端抢占主线程解析;
///      可见时一次性回灌。
///   3) 切布局只在前端 fit(让 xterm 按新宽度 reflow),不 resize 后端 PTY——PTY 保持初始
///      120 列。给 webpack/vite 这类 \r 进度条 TUI 发 SIGWINCH 会让它反复重排、进度行变多行
///      刷爆 scrollback 把真实日志挤掉并错位;只读监控不需要 PTY 跟随,xterm reflow 足够。
export function TerminalView({
  runId,
  writers,
  active,
  interactive = false,
}: {
  runId: string
  writers: Writers
  active: boolean
  // true = 可输入终端:接键盘(onData→PTY stdin)、PTY 列随显示宽度同步、显示光标。
  interactive?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  // GPU 渲染加速开关(设置项)。关闭则不挂 WebGL,退回 xterm 默认 DOM 渲染器。
  const gpuAccel = useSettings((s) => s.render.gpuAcceleration)
  // 终端字体设置(实时切换:变化时只更新 xterm options + 重排,不重建终端)。
  const termLatin = useSettings((s) => s.render.termLatin)
  const termCJK = useSettings((s) => s.render.termCJK)
  const termFontSize = useSettings((s) => s.render.termFontSize)
  // 分屏布局(1/2/4)。切布局会改格子宽度,但对「保持可见」的格 active 不变 → 下面
  // active effect 不重跑、只能靠 ResizeObserver,而布局瞬变时 RO 可能漏触发,列宽就卡在旧值。
  // 故订阅 layout,变化时显式补 fit(见底部 layout effect)。
  const layout = useStore((s) => s.layout)
  // 给 writer 闭包读当前 active(writer 只注册一次,不能靠 prop 闭包)。
  const activeRef = useRef(active)
  // 自绘常驻滚动条:macOS 覆盖式原生滚动条 idle 会被系统隐藏(CSS 改不动),故隐藏原生、
  // 叠一个自定义 thumb,读 xterm 滚动状态(baseY/viewportY/rows)定位。trackH 缓存,避免
  // 在高频 onRender 里逐帧量布局。
  const scrollRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const trackHRef = useRef(0)
  const syncBar = useRef<() => void>(() => {})
  syncBar.current = () => {
    const term = termRef.current
    const thumb = thumbRef.current
    const track = scrollRef.current
    if (!term || !thumb || !track) return
    const trackH = trackHRef.current || track.clientHeight
    const b = term.buffer.active
    const base = b.baseY // 顶部已滚走的行数 = 可滚动范围
    const total = base + term.rows
    if (base <= 0 || trackH <= 0) {
      thumb.style.opacity = '0' // 内容不足一屏 → 不显示滚动条
      return
    }
    const thumbH = Math.min(trackH, Math.max(28, (trackH * term.rows) / total))
    const top = ((trackH - thumbH) * b.viewportY) / base
    thumb.style.opacity = '1'
    thumb.style.height = `${thumbH}px`
    thumb.style.transform = `translateY(${top}px)`
  }
  // 拖拽 thumb:按像素位移换算目标行,scrollToLine(xterm 会触发 onScroll → syncBar 刷新)。
  const onThumbDown = (e: React.PointerEvent) => {
    const term = termRef.current
    const track = scrollRef.current
    if (!term || !track) return
    e.preventDefault()
    const trackH = trackHRef.current || track.clientHeight
    const b = term.buffer.active
    const base = b.baseY
    if (base <= 0) return
    const thumbH = Math.min(trackH, Math.max(28, (trackH * term.rows) / (base + term.rows)))
    const topRange = trackH - thumbH
    const startY = e.clientY
    const startVy = b.viewportY
    const onMove = (ev: PointerEvent) => {
      const dLines = topRange > 0 ? Math.round(((ev.clientY - startY) / topRange) * base) : 0
      term.scrollToLine(Math.max(0, Math.min(base, startVy + dLines)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // fit + 修正滚动位置 + 刷新自绘滚动条。存进 ref(每次渲染刷新闭包),让挂载 effect /
  // active effect / layout effect 都能调同一份逻辑而无需进依赖。
  const fitAndSync = useRef<() => void>(() => {})
  fitAndSync.current = () => {
    const fit = fitRef.current
    const term = termRef.current
    if (!fit || !term) return
    // resize/reflow(切布局、显隐切换)会让 DOM 视口 scrollTop 与 xterm 内部 ydisp 失配:
    // 画面已在底部(最新日志),滚动条 thumb 却停在旧位置;一碰滚动条就按旧位置跳回老日志。
    // 故 fit 前记录是否跟随底部,fit 后若在底部重新 scrollToBottom,把滚动条与画面对齐
    // (只读日志监控默认跟随底部;用户上滚看历史时 wasAtBottom=false,不强拉)。
    const buf = term.buffer.active
    const wasAtBottom = buf.viewportY >= buf.baseY
    try {
      fit.fit()
    } catch {
      return // 容器瞬时 0 尺寸,忽略
    }
    if (wasAtBottom) term.scrollToBottom()
    // 交互终端:把真实列/行同步给 PTY(发 SIGWINCH),让 shell/vim/htop 按显示宽度排版。
    // 只读监控故意不同步(PTY 保持 120 列,避免给 \r 进度条 TUI 反复 SIGWINCH 刷爆 scrollback)。
    if (interactive) resizeRun(runId, term.cols, term.rows)
    // 刚 fit 完布局稳定:量一次轨道高度缓存 + 刷新自绘滚动条 thumb。
    const track = scrollRef.current
    if (track) trackHRef.current = track.clientHeight
    syncBar.current()
  }

  useEffect(() => {
    // 初值取设置快照(非响应式,避免进 effect 依赖触发重建);后续变化由下方字体 effect 实时套用。
    const r0 = useSettings.getState().render
    const term = new Terminal({
      scrollback: 5000,
      fontSize: r0.termFontSize,
      // 英文字体定 metrics + 中文 fallback,见 lib/fonts.ts。字体名须与 @fontsource / @font-face
      // 注册的家族名一致,否则回退 Menlo;字体加载完字符宽度会变,挂载后 fonts.ready 再补一次 fit。
      fontFamily: termStack(r0.termLatin, r0.termCJK),
      letterSpacing: 0,
      lineHeight: 1.25,
      // 交互终端关 convertEol(shell 自发 \r\n,开了会双换行);只读监控保留(兜底裸 \n)。
      convertEol: !interactive,
      cursorBlink: interactive,
      disableStdin: !interactive,
      allowTransparency: true,
      theme: {
        background: 'rgba(0, 0, 0, 0)',
        foreground: '#cdd9e8',
        cursor: '#38e8ff',
        selectionBackground: 'rgba(56, 232, 255, 0.25)',
        black: '#0a1018',
        red: '#ff6b6b',
        green: '#34e8a4',
        yellow: '#fbbf24',
        blue: '#38e8ff',
        magenta: '#a78bfa',
        cyan: '#2dd4bf',
        white: '#cdd9e8',
        brightBlack: '#6b7d93',
        brightRed: '#ff8585',
        brightGreen: '#5ff0bb',
        brightYellow: '#fcd34d',
        brightBlue: '#7af0ff',
        brightMagenta: '#c4b5fd',
        brightCyan: '#5eead4',
        brightWhite: '#f0f6ff',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current!)
    termRef.current = term
    fitRef.current = fit
    // 拖选后复制选区:xterm 6 不内建此绑定,自行处理——有选区时写剪贴板并吞掉,无选区放行。
    // 🔴 交互终端只认 Cmd+C 作复制:Ctrl+C 必须放行去送 SIGINT(中断前台进程),绝不能被复制吞掉;
    //    只读终端无 stdin 语义,Ctrl/Cmd+C 都可作复制。
    term.attachCustomKeyEventHandler((e) => {
      const copyChord = interactive ? e.metaKey : e.metaKey || e.ctrlKey
      if (e.type === 'keydown' && copyChord && (e.key === 'c' || e.key === 'C')) {
        const sel = term.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {})
          return false
        }
      }
      return true
    })
    // 统一走 fitAndSync:fit 后把真实列/行同步给 PTY。
    const fitSafely = () => fitAndSync.current()
    // 不在挂载帧同步 fit:网格里格子此刻可能还没拿到最终宽度,量错列数后——因为 fit 只改
    // xterm 内部列数、不改 .term 盒子尺寸——ResizeObserver 不会再触发,错误列数会被永久卡住。
    // 故延到下一帧(布局稳定)再 fit;webfont 加载完字符宽度会变,字体就绪后再补一次。
    requestAnimationFrame(fitSafely)
    document.fonts?.ready.then(fitSafely)
    termRegistry[runId] = term
    // 激活终端实时写;非激活终端囤进缓冲(激活/拷贝前回灌),不抢主线程解析。
    writers.current[runId] = (s: string) => {
      if (!activeRef.current) {
        appendBuffer(runId, s)
        return
      }
      // 交互终端:打完 prompt 即静默,没有后续输出来自愈渲染;WebGL 偶发丢首帧 → 一直空白
      // 到下次按键才补画。故每段输出「解析完成」回调里强制 refresh 一次(交互输出量小,代价可忽略)。
      // 只读监控是高频流,后续 chunk 天然自愈,不加这层开销。
      if (interactive) term.write(s, () => term.refresh(0, term.rows - 1))
      else term.write(s)
    }
    // 通知 App:本 run 的 writer 已就绪,立即回灌挂载前缓存的早期输出(交互 shell 的首个 prompt
    // 常早于挂载到达,卡在 App.pending;静默 shell 无后续输出触发懒回灌 → 不主动回灌就一直空白)。
    window.dispatchEvent(new CustomEvent('quay:writer-ready', { detail: runId }))

    const ro = new ResizeObserver(() => {
      // 侧栏拖拽期间(html.resizing)跳过 fit:每帧 fit×多格(+WebGL)会卡;松手由
      // quay:resize-end 统一补一次 fit。
      if (document.documentElement.classList.contains('resizing')) return
      fitSafely()
    })
    ro.observe(ref.current!)

    // 拖拽结束:统一 fit 一次(拖动期间 RO 被跳过)。
    const onResizeEnd = () => requestAnimationFrame(fitSafely)
    window.addEventListener('quay:resize-end', onResizeEnd)

    // xterm 滚动 / 重绘时刷新自绘滚动条(用缓存 trackH,不读布局,适配高频 onRender)。
    const sb = () => syncBar.current()
    const dScroll = term.onScroll(sb)
    const dRender = term.onRender(sb)

    // 交互终端:键盘输入 → PTY stdin。只读终端 disableStdin,onData 不触发,故仅交互时挂。
    const dData = interactive ? term.onData((d) => writeRun(runId, d)) : null

    return () => {
      dData?.dispose()
      ro.disconnect()
      window.removeEventListener('quay:resize-end', onResizeEnd)
      dScroll.dispose()
      dRender.dispose()
      webglRef.current?.dispose()
      webglRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
      delete termRegistry[runId]
      delete writers.current[runId]
    }
    // interactive 在 run 生命周期内恒定(只读/交互不会互转),进 deps 仅为满足 lint,不会触发重建。
  }, [runId, writers, interactive])

  // 字体设置变化:实时套用到已存在的终端(不重建),预加载字体就绪后改 options + 重排 + 重绘。
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const stack = termStack(termLatin, termCJK)
    ensureFontsLoaded(stack, termFontSize).then(() => {
      if (termRef.current !== term) return // 期间已卸载
      term.options.fontFamily = stack
      term.options.fontSize = termFontSize
      fitAndSync.current()
      // WebGL 渲染器缓存了字形纹理图集,换字体后需清掉才会用新字形重绘。
      webglRef.current?.clearTextureAtlas?.()
      term.refresh(0, term.rows - 1)
    })
  }, [termLatin, termCJK, termFontSize])

  // 激活/切走/切 GPU 开关:
  //   激活 + GPU 开 → 挂 WebGL(若可用)+ 回灌隐藏期缓冲 + fit + refresh,立即重画。
  //   激活 + GPU 关 → 卸掉 WebGL(若已挂),退回 DOM 渲染器并重画。
  //   切走 → dispose WebGL 释放 GL 上下文(隐藏终端不渲染)。
  // display:none → block 后 xterm 不会自动重绘,直到下次写入,故激活时强制 fit+refresh。
  useEffect(() => {
    activeRef.current = active
    const term = termRef.current
    if (!term) return

    if (!active) {
      webglRef.current?.dispose()
      webglRef.current = null
      return
    }

    // 🔴 交互终端不挂 WebGL:xterm WebGL addon 有「首帧到用户交互前不渲染」的已知回归
    //   (xtermjs/xterm.js#4665、Eugeny/tabby#9823)——交互 shell 打完 prompt 即静默,
    //   首帧空白后无输出自愈 → 一直黑屏到打字。社区公认解法就是退回 canvas/DOM 渲染器。
    //   交互终端是人速低频输入,本就无需 WebGL 的吞吐;只读高频日志流仍用 WebGL 提速。
    if (gpuAccel && !interactive) {
      // 仅激活终端挂 WebGL;失败(WKWebView 无 WebGL2 等)退回 DOM 渲染器并告警(不再静默)。
      if (!webglRef.current) {
        try {
          const addon = new WebglAddon()
          addon.onContextLoss(() => {
            console.warn('[quay/gpu] WebGL 上下文丢失,本终端退回 DOM 渲染器')
            addon.dispose()
            webglRef.current = null
          })
          term.loadAddon(addon)
          webglRef.current = addon
          probeGpuRenderer() // 首次挂载时确认 GPU 真生效(全进程只探一次)
        } catch (e) {
          console.warn('[quay/gpu] WebGL addon 加载失败,退回 DOM 渲染器:', e)
        }
      }
    } else {
      // GPU 关:卸掉 WebGL,xterm 自动退回 DOM 渲染器(下方 raf 里 refresh 重画)。
      webglRef.current?.dispose()
      webglRef.current = null
    }

    let raf = 0
    let cancelled = false
    // 激活时先 fit(此刻格子已 display:flex、布局就绪,量到正确宽度),再回灌隐藏期缓冲——
    // 让重放的 \r 进度类输出按正确列数渲染,避免按旧窄列数回放后再 reflow 造成错位;最后重画。
    raf = requestAnimationFrame(() => {
      if (cancelled) return
      fitAndSync.current() // fit + 同步 PTY 尺寸(此刻格子已 display:flex,量到正确宽度)
      // 交互终端:激活即聚焦,用户可直接打字(同时给静默的 prompt 补一次绘制契机)。
      if (interactive) term.focus()
      flushBuffer(runId).then(() => {
        if (cancelled) return
        term.refresh(0, term.rows - 1)
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [active, runId, gpuAccel, interactive])

  // 切分屏布局(单/双/四):可见格宽度变,但 active 不变 → 上面 active effect 不重跑。
  // 这里对当前可见格显式补一次 fit+同步 PTY,让 xterm 按新宽度重排(软折行历史 reflow、
  // 新输出按新列数排版),不再依赖 ResizeObserver 在布局瞬变时是否恰好触发。
  // 非可见格(activeRef.current=false)跳过:其 fit 留到被激活时由 active effect 处理。
  useEffect(() => {
    if (!activeRef.current) return
    const id = requestAnimationFrame(() => fitAndSync.current())
    return () => cancelAnimationFrame(id)
  }, [layout])

  return (
    <>
      <div className="term" ref={ref} />
      {/* 自绘常驻滚动条:覆盖在 .term 右侧预留 lane(见 .xterm padding-right);thumb 由 syncBar 定位 */}
      <div className="term-scroll" ref={scrollRef}>
        <div className="term-scroll-thumb" ref={thumbRef} onPointerDown={onThumbDown} />
      </div>
    </>
  )
}
