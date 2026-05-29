import type { Script } from './types'

/// 命令树两层分组：
///  Tier 1 语义类别（开发/测试/构建/部署/数据/其他）—— 按关键词匹配脚本名
///  Tier 2 前缀子分组 —— 同一首段(冒号前)且 ≥2 个的脚本收成一组(如 db:* / deploy:*)
///                      单独脚本直接平铺(loose)

export interface CmdLeaf {
  name: string
  command: string
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

function categoryOf(name: string): string {
  for (const r of CATEGORY_RULES) if (r.test.test(name)) return r.key
  return OTHER.key
}

/// 把脚本归类 → 每类内按首段前缀子分组。返回非空类别(保持规则顺序)。
export function categorize(scripts: Script[]): Category[] {
  const byCat = new Map<string, Script[]>()
  for (const s of scripts) {
    const c = categoryOf(s.name)
    ;(byCat.get(c) ?? byCat.set(c, []).get(c)!).push(s)
  }

  const order = [...CATEGORY_RULES.map((r) => ({ key: r.key, label: r.label })), OTHER]
  const result: Category[] = []

  for (const { key, label } of order) {
    const list = byCat.get(key)
    if (!list?.length) continue

    // 按首段前缀聚合
    const byPrefix = new Map<string, CmdLeaf[]>()
    for (const s of list) {
      const prefix = s.name.split(':')[0]
      const leaf: CmdLeaf = { name: s.name, command: s.command }
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

  return result
}
