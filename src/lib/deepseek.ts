import type { Command, ProjectContext, Proposal } from './types'
import { categorize, sortByCanon, CATEGORY_ORDER, type Category } from './grouping'
import { useSettings } from '../state/settings'

/// DeepSeek（OpenAI 兼容端点）客户端 + 两个智能能力：
///   smartGroup   —— LLM 智能分组命令
///   explainCommand —— LLM 解释命令用途
/// 全部带 localStorage 缓存 + 失败降级，离线/未配置 key 时回退启发式。

interface ChatMsg {
  role: 'system' | 'user'
  content: string
}

function endpoint(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  return `${base}/v1/chat/completions`
}

/// 调一次 DeepSeek，返回 assistant 文本。未配置 key 时抛错。
async function chat(messages: ChatMsg[], opts: { json?: boolean; signal?: AbortSignal } = {}) {
  const { baseUrl, model, apiKey } = useSettings.getState().deepseek
  if (!apiKey.trim()) throw new Error('未配置 DeepSeek API Key')

  const res = await fetch(endpoint(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.json ? 0 : 0.3,
      stream: false,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: opts.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let msg = text.slice(0, 200)
    try {
      msg = JSON.parse(text)?.error?.message ?? msg // 提取干净的错误信息
    } catch {
      /* 非 JSON，用原文 */
    }
    throw new Error(`DeepSeek ${res.status} · ${msg}`)
  }
  const data = await res.json()
  const content: string = data?.choices?.[0]?.message?.content ?? ''
  if (!content) throw new Error('DeepSeek 返回空内容')
  return content
}

/// 设置页「测试连接」用：发一条极短请求验证 key/model/baseUrl。
export async function testConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const reply = await chat([{ role: 'user', content: '回复一个字：好' }])
    return { ok: true, message: `连接成功 · 模型已响应（${reply.trim().slice(0, 20)}）` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

// ── 智能分组 ──────────────────────────────────────────────
function groupCacheKey(commands: Command[]) {
  const { model } = useSettings.getState().deepseek
  // v2：leaf 结构升级（Command 模型带 source + 完整执行串 `pnpm run dev`）。
  // 旧版本(v1)缓存的 leaf 无 source、command 是原始脚本体(如 `vite`)会跑错命令,故 bump 版本作废旧缓存。
  return `quay.aigroup.v2.${model}.${commands.map((s) => s.name).sort().join('|')}`
}

function stripFences(s: string) {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

/// 解析 LLM 提议为 Proposal[]。纯函数,便于单测。
/// 校验:name/command 非空; cwd 必须为空/.(归一为根)或 tree 里存在的目录; 去重。
export function parseProposals(raw: string, ctx: ProjectContext): Proposal[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(raw))
  } catch {
    return []
  }
  const obj = parsed as { commands?: unknown }
  const list: unknown[] = Array.isArray(obj?.commands)
    ? obj.commands
    : Array.isArray(parsed)
      ? (parsed as unknown[])
      : []
  const dirs = new Set(
    ctx.tree.filter((t) => t.endsWith('/')).map((t) => t.replace(/\/$/, '')),
  )
  const seen = new Set<string>()
  const out: Proposal[] = []
  for (const item of list) {
    const p = item as Record<string, unknown>
    const name = String(p?.name ?? '').trim()
    const command = String(p?.command ?? '').trim()
    let cwd = String(p?.cwd ?? '').trim()
    const why = String(p?.why ?? '').trim()
    if (cwd === '.') cwd = ''
    if (!name || !command) continue
    if (cwd !== '' && !dirs.has(cwd)) continue
    const key = `${name}|${command}|${cwd}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, command, cwd, why })
  }
  return out
}

/// LLM 智能分组 → Category[]。带缓存；失败/未配置回退启发式 categorize()。
export async function smartGroup(commands: Command[]): Promise<Category[]> {
  if (commands.length === 0) return []
  const cacheKey = groupCacheKey(commands)
  try {
    const cached = localStorage.getItem(cacheKey)
    if (cached) return sortByCanon(JSON.parse(cached) as Category[]) // 旧缓存也按规范顺序纠正
  } catch {
    /* ignore */
  }

  const names = commands.map((s) => s.name)
  const sys =
    '你是构建脚本组织专家。把开发/构建命令按用途分到中文大类。' +
    `大类标签只能从这个固定集合里选:${CATEGORY_ORDER.join('/')};不要新造其它标签。` +
    '每个大类内把语义相关、通常是相同前缀(冒号前同名,如 db:* / deploy:*)且≥2个的脚本收成子组(groups)，' +
    '其余单独脚本放 loose。每个脚本必须且只能出现一次,只能用我给的脚本名,不要新造。' +
    '只输出 JSON,形如 {"categories":[{"label":"开发","groups":[{"prefix":"app","items":["app:dev"]}],"loose":["dev"]}]}。'
  const user = `脚本名列表(JSON)：${JSON.stringify(names)}`

  const raw = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], { json: true })

  const parsed = JSON.parse(stripFences(raw)) as {
    categories?: { label?: string; groups?: { prefix?: string; items?: string[] }[]; loose?: string[] }[]
  }
  const cmdOf = new Map(commands.map((c) => [c.name, c]))
  const used = new Set<string>()
  const leaf = (n: string) => {
    used.add(n)
    const c = cmdOf.get(n)
    return { name: n, command: c?.command ?? '', source: c?.source ?? '' }
  }

  const categories: Category[] = (parsed.categories ?? [])
    .map((c, i) => {
      const groups = (c.groups ?? [])
        .map((g) => ({
          prefix: g.prefix ?? (g.items?.[0]?.split(':')[0] ?? '组'),
          items: (g.items ?? []).filter((n) => cmdOf.has(n) && !used.has(n)).map(leaf),
        }))
        .filter((g) => g.items.length > 0)
      const loose = (c.loose ?? []).filter((n) => cmdOf.has(n) && !used.has(n)).map(leaf)
      return { key: `ai-${i}`, label: c.label ?? '其他', groups, loose }
    })
    .filter((c) => c.groups.length > 0 || c.loose.length > 0)

  // LLM 漏掉的命令兜底进「其他」
  const leftover = commands.filter((c) => !used.has(c.name)).map((c) => leaf(c.name))
  if (leftover.length) {
    const other = categories.find((c) => c.label === '其他')
    if (other) other.loose.push(...leftover)
    else categories.push({ key: 'ai-other', label: '其他', groups: [], loose: leftover })
  }

  const result = categories.length ? sortByCanon(categories) : categorize(commands)
  try {
    localStorage.setItem(cacheKey, JSON.stringify(result))
  } catch {
    /* ignore */
  }
  return result
}

// ── AI 提议命令 ────────────────────────────────────────────
/// djb2 字符串哈希(无需加密强度,仅作缓存键)。
function digest(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function proposeCacheKey(ctx: ProjectContext): string {
  const { model } = useSettings.getState().deepseek
  const sig = ctx.root + ' ' + ctx.tree.join('|') + ' ' +
    ctx.files.map((f) => `${f.relPath}:${f.content.length}`).join('|')
  return `quay.aipropose.v1.${model}.${digest(sig)}`
}

/// 喂项目上下文给 DeepSeek,提议可运行命令。带 localStorage 缓存(context 不变不重复调)。
/// 未配置 key / 调用失败 → 抛错(UI 处理),不影响 L1。
export async function proposeCommands(ctx: ProjectContext): Promise<Proposal[]> {
  const cacheKey = proposeCacheKey(ctx)
  try {
    const cached = localStorage.getItem(cacheKey)
    if (cached) return JSON.parse(cached) as Proposal[]
  } catch {
    /* ignore */
  }
  const sys =
    '你是项目运行专家。根据给定的项目目录结构和关键文件内容,提议可以直接运行的开发/构建/启动命令。' +
    '只提议你有明确证据支撑的命令,宁缺毋滥,不要猜测。' +
    '每条给:name(中文短标签,如「后端 API」),command(完整可执行命令串,如 `mvn spring-boot:run`),' +
    'cwd(命令该在哪个子目录运行,用相对项目根的路径;就在根目录则空字符串),' +
    'why(为什么是这条,引用你看到的文件证据,一句话)。' +
    '只输出 JSON,形如 {"commands":[{"name":"后端 API","command":"mvn spring-boot:run","cwd":"gyj_admin/ch_backend","why":"该目录有 Spring Boot pom.xml"}]}。'
  const filesText = ctx.files
    .map((f) => `### ${f.relPath}${f.truncated ? '（已截断）' : ''}\n${f.content}`)
    .join('\n\n')
  const user =
    `项目根：${ctx.root}\n` +
    (ctx.detectedSources.length ? `L1 已探测工具链：${ctx.detectedSources.join(', ')}\n` : '') +
    `\n目录结构（相对根,目录以 / 结尾）：\n${ctx.tree.join('\n')}\n\n关键文件内容：\n${filesText}`

  const raw = await chat(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    { json: true },
  )
  const proposals = parseProposals(raw, ctx)
  try {
    localStorage.setItem(cacheKey, JSON.stringify(proposals))
  } catch {
    /* ignore */
  }
  return proposals
}

// ── 命令解释 ──────────────────────────────────────────────
export async function explainCommand(name: string, command: string): Promise<string> {
  const cacheKey = `quay.explain.${command}`
  try {
    const cached = localStorage.getItem(cacheKey)
    if (cached) return cached
  } catch {
    /* ignore */
  }
  const text = await chat([
    {
      role: 'system',
      content:
        '你是命令行助手。用简体中文解释这条命令的用途,1-2 句、不超过 60 字,直接说做什么,不要客套、不要复述命令本身。',
    },
    { role: 'user', content: `脚本标签：${name}\n实际执行：${command}` },
  ])
  const out = text.trim()
  try {
    localStorage.setItem(cacheKey, out)
  } catch {
    /* ignore */
  }
  return out
}
