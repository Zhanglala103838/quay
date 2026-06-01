import type { Command } from './types'
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
  return `quay.aigroup.${model}.${commands.map((s) => s.name).sort().join('|')}`
}

function stripFences(s: string) {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
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
