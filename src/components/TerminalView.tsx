import { useEffect, useRef, type MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { termRegistry, appendBuffer, flushBuffer } from '../lib/termRegistry'
import { useSettings } from '../state/settings'
import { useStore } from '../state/store'
import { probeGpuRenderer } from '../lib/gpuProbe'

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
}: {
  runId: string
  writers: Writers
  active: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  // GPU 渲染加速开关(设置项)。关闭则不挂 WebGL,退回 xterm 默认 DOM 渲染器。
  const gpuAccel = useSettings((s) => s.render.gpuAcceleration)
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
    // 刚 fit 完布局稳定:量一次轨道高度缓存 + 刷新自绘滚动条 thumb。
    const track = scrollRef.current
    if (track) trackHRef.current = track.clientHeight
    syncBar.current()
  }

  useEffect(() => {
    const term = new Terminal({
      scrollback: 5000,
      fontSize: 13,
      // 英文 JetBrains Mono(与 Ghostty 默认同款),中文回退 PingFang SC 苹方(Ghostty 在 macOS
      // 的 CJK 回退也是苹方)。字体名须与 @fontsource-variable 实际注册的家族名一致(见 index.css
      // --font-mono),否则始终回退 Menlo;字体加载完字符宽度会变,挂载后会再补一次 fit。
      fontFamily: "'JetBrains Mono Variable', 'PingFang SC', Menlo, Monaco, 'Courier New', monospace",
      letterSpacing: 0,
      lineHeight: 1.25,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
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
      if (activeRef.current) term.write(s)
      else appendBuffer(runId, s)
    }

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

    return () => {
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
  }, [runId, writers])

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

    if (gpuAccel) {
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
      flushBuffer(runId).then(() => {
        if (cancelled) return
        term.refresh(0, term.rows - 1)
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [active, runId, gpuAccel])

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
