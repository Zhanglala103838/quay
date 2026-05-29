/// GPU 渲染自检:确认 xterm WebGL addon 真的拿到硬件 WebGL2 上下文,而不是静默回退到
/// DOM/Canvas(CPU)。研究结论:WKWebView 里 WebGL2 在现代 macOS 上经 ANGLE→Metal 提交,
/// 所以只要 WebGL2 可用且 renderer 是硬件 GPU,就等于"已经在用 Metal",无需另接原生 Metal。
///
/// 全进程只探一次(开销极小但没必要重复),结果打到 console 供开发期确认。

let probed = false

export function probeGpuRenderer(): void {
  if (probed) return
  probed = true
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      console.warn('[quay/gpu] WebGL2 不可用 — 终端将退回 xterm DOM 渲染器(纯 CPU)')
      return
    }
    // UNMASKED_RENDERER 需 WEBGL_debug_renderer_info 扩展;WebKit 通常脱敏成 "Apple GPU" 之类,
    // 但能区分"硬件 GPU"还是"软件回退(SwiftShader/llvmpipe)"——后者出现即说明 GPU 加速没真生效。
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '(renderer 被屏蔽)'
    const vendor = ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : ''
    const soft = /swiftshader|llvmpipe|software|basic render/i.test(renderer)
    if (soft) {
      console.warn(
        `[quay/gpu] WebGL2 走的是软件渲染回退(renderer=${renderer}) — GPU 加速实际未生效`,
      )
    } else {
      console.info(
        `[quay/gpu] WebGL2 OK · renderer=${renderer}${vendor ? ` · vendor=${vendor}` : ''}` +
          ' — macOS 上经 ANGLE→Metal 提交,GPU 加速已生效',
      )
    }
    // 立即释放探测用上下文,别占着浏览器有限的 GL 上下文配额(~16 个)。
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch (e) {
    console.warn('[quay/gpu] GPU 探测异常:', e)
  }
}
