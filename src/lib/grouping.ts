import type { Command } from './types'

/// 命令树两层分组：
///  Tier 1 语义类别（开发/测试/构建/部署/数据/其他）—— 按关键词匹配脚本名
///  Tier 2 前缀子分组 —— 同一首段(冒号前)且 ≥2 个的脚本收成一组(如 db:* / deploy:*)
///                      单独脚本直接平铺(loose)

export interface CmdLeaf {
  name: string
  command: string
  source: string
}
export interface PrefixGroup {
  prefix: string
  items: CmdLeaf[]
}
export interface Category {
  key: string
  label: string
  groups: PrefixGroup[]
  loose: CmdLeaf[]
}

// 顺序即展示顺序；首个命中的类别胜出
const CATEGORY_RULES: { key: string; label: string; test: RegExp }[] = [
  { key: 'dev', label: '开发', test: /(^|:)(dev|serve|start|watch|app|preview|run)(:|$)/ },
  { key: 'test', label: '测试', test: /(^|:)(test|check|lint|spec|e2e|tsc|typecheck|format)(:|$)/ },
  { key: 'build', label: '构建', test: /(^|:)(build|compile|bundle|gen|generate|pack)(:|$)/ },
  { key: 'deploy', label: '部署', test: /(^|:)(deploy|release|publish|ship|sink|push|upload)(:|$)/ },
  { key: 'data', label: '数据', test: /(^|:)(db|migrate|seed|prisma|sql|schema)(:|$)/ },
]
const OTHER = { key: 'other', label: '其他' }

// 软件流程固定顺序:启发式与 AI 分组都按此排,保证跨项目类别顺序一致。
export const CATEGORY_ORDER = ['开发', '测试', '代码质量', '构建', '部署', '数据', '文档', '其他']

function canonRank(label: string): number {
  if (label === '其他') return 999 // 其他永远垫底
  const i = CATEGORY_ORDER.indexOf(label)
  return i === -1 ? 900 : i // 未知类别排在「其他」之前
}

/// 按规范软件流程顺序排序类别(AI 返回顺序随机,统一收敛到此)。
export function sortByCanon(cats: Category[]): Category[] {
  return [...cats].sort((a, b) => canonRank(a.label) - canonRank(b.label))
}

function categoryOf(name: string): string {
  for (const r of CATEGORY_RULES) if (r.test.test(name)) return r.key
  return OTHER.key
}

function catKeyOf(c: Command): string {
  return c.category && c.category.length ? c.category : categoryOf(c.name)
}

/// 把命令归类 → 每类内按首段前缀子分组。返回非空类别(保持规则顺序)。
export function categorize(commands: Command[]): Category[] {
  const byCat = new Map<string, Command[]>()
  for (const c of commands) {
    const k = catKeyOf(c)
    ;(byCat.get(k) ?? byCat.set(k, []).get(k)!).push(c)
  }

  const order = [...CATEGORY_RULES.map((r) => ({ key: r.key, label: r.label })), OTHER]
  const result: Category[] = []

  for (const { key, label } of order) {
    const list = byCat.get(key)
    if (!list?.length) continue

    const byPrefix = new Map<string, CmdLeaf[]>()
    for (const c of list) {
      const prefix = c.name.split(':')[0]
      const leaf: CmdLeaf = { name: c.name, command: c.command, source: c.source }
      ;(byPrefix.get(prefix) ?? byPrefix.set(prefix, []).get(prefix)!).push(leaf)
    }

    const groups: PrefixGroup[] = []
    const loose: CmdLeaf[] = []
    for (const [prefix, items] of byPrefix) {
      if (items.length >= 2) {
        groups.push({ prefix, items: items.sort((a, b) => a.name.localeCompare(b.name)) })
      } else {
        loose.push(items[0])
      }
    }
    groups.sort((a, b) => a.prefix.localeCompare(b.prefix))
    loose.sort((a, b) => a.name.localeCompare(b.name))

    result.push({ key, label, groups, loose })
  }

  return sortByCanon(result)
}
