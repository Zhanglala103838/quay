import type { Terminal } from '@xterm/xterm'

/// runId → xterm 实例。TerminalView 挂载时注册,卸载时移除。
/// 供「拷贝日志」读取滚动缓冲(writers 只能写,这里能读)。
export const termRegistry: Record<string, Terminal> = {}

/// 隐藏(非激活)终端累积但尚未写入 xterm 的原始输出。
/// 多终端高吞吐时,只有激活终端实时 parse + 渲染;其余终端的输出先囤在这里,
/// 激活或拷贝前一次性回灌,避免看不见的终端持续抢占主线程解析。
export const termBuffers: Record<string, string> = {}

/// 隐藏期缓冲上限:只保留最近 256KB(够铺满激活时的可视屏 + 近期滚动)。
/// 完整历史由后端 ring(5000 行)兜底,拷贝「全部」时仍可经 replay 取回。
const BUF_MAX = 262144

/// 隐藏终端收到输出时调用:累加并裁剪到上限(丢最旧)。
export function appendBuffer(runId: string, s: string) {
  const cur = (termBuffers[runId] ?? '') + s
  termBuffers[runId] = cur.length > BUF_MAX ? cur.slice(cur.length - BUF_MAX) : cur
}

/// 把累积输出写入 xterm 并等待其解析完成,然后清空缓冲。
/// 无缓冲(或终端未挂载)时立即 resolve。激活前 / 拷贝前调用,保证 xterm buffer 是最新的。
export function flushBuffer(runId: string): Promise<void> {
  const term = termRegistry[runId]
  const buf = termBuffers[runId]
  if (!buf) return Promise.resolve()
  delete termBuffers[runId]
  if (!term) return Promise.resolve()
  return new Promise((resolve) => term.write(buf, () => resolve()))
}

/// 取某终端最近 n 行纯文本(n=Infinity 取全部)。含滚动缓冲。
/// 注意:读的是 xterm 已解析的「干净文本」(无 ANSI 转义),拷贝前需先 flushBuffer。
export function readTerminalText(runId: string, n: number): string {
  const term = termRegistry[runId]
  if (!term) return ''
  const buf = term.buffer.active
  const total = buf.length
  const start = n === Infinity ? 0 : Math.max(0, total - n)
  const lines: string[] = []
  for (let i = start; i < total; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  }
  // 去掉末尾连续空行
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}
