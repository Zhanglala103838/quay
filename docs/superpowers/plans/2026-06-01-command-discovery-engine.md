# 命令发现引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Quay 跨语言识别项目命令、按锁文件用对包管理器，去掉写死的 `npm run`。

**Architecture:** 把 `scanner.rs` 重构为「检测器注册表」——每个检测器认一种标记文件、产出带 `source`/`category` 的 `Command`。前端按语义类别分组、命令直接用检测器拼好的完整执行串。

**Tech Stack:** Rust（Tauri 后端，`cargo test`）+ React/TS（`pnpm test` = vitest）。

参考 spec：`docs/superpowers/specs/2026-06-01-command-discovery-engine-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `src-tauri/src/types.rs` | Rust 数据模型 | 新增 `Command`，重写 `ScanResult` |
| `src-tauri/src/scanner.rs` | 检测器注册表 + 9 个检测器 | 重写 |
| `src/lib/types.ts` | TS 数据模型 | 新增 `Command`，重写 `ScanResult` |
| `src/lib/grouping.ts` | 按 category 分组，吃 `Command[]` | 改 `categorize` 签名 + `CmdLeaf` 加 `source` |
| `src/lib/grouping.test.ts` | 分组单测 | 改写为 `Command[]` |
| `src/lib/deepseek.ts` | AI 分组吃 `Command[]` | 改 `smartGroup` 签名 |
| `src/components/Sidebar.tsx` | 消费 scan、运行命令、source 标签 | `scripts`→`commands`、去 `npm run`、加 source badge、改 warn |

执行顺序：先 Rust（Task 1）→ 前端类型+分组（Task 2）→ 前端消费（Task 3，此后端到端可用且多语言就绪）→ 增量加检测器（Task 4-8，纯追加，App 持续可用）→ 手动验收（Task 9）。

---

### Task 1: Rust 数据模型 + npm 检测器（包管理器识别）

**Files:**
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/scanner.rs`（整文件重写）

- [ ] **Step 1: 改数据模型 `types.rs`**

把 `types.rs` 末尾的 `Script` 与 `ScanResult` 两个 struct 替换为：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub name: String,
    pub command: String,
    pub source: String,
    #[serde(default)]
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub commands: Vec<Command>,
    #[serde(rename = "dirExists")]
    pub dir_exists: bool,
    #[serde(rename = "detectedSources")]
    pub detected_sources: Vec<String>,
}
```

（删掉旧 `Script` struct。`commands` 用默认 camelCase 即 `commands`，无需 rename。）

- [ ] **Step 2: 重写 `scanner.rs` 顶部 + npm 检测器 + 聚合，先写失败测试**

把 `scanner.rs` 全文替换为下面内容（本任务只含 npm 检测器 + 聚合骨架；后续任务往 `DETECTORS` 加函数）：

```rust
use crate::types::{Command, ScanResult};
use std::collections::HashSet;
use std::path::Path;

/// 深度 0：对绑定目录顶层跑一组检测器，合并命令。不递归(避 node_modules 炸)。
pub fn scan_directory(dir: &str) -> ScanResult {
    let p = Path::new(dir);
    if !p.is_dir() {
        return ScanResult { commands: vec![], dir_exists: false, detected_sources: vec![] };
    }
    let detectors: &[fn(&Path) -> Vec<Command>] = &[detect_npm];
    let mut commands: Vec<Command> = Vec::new();
    for d in detectors {
        commands.extend(d(p));
    }
    // 去重：同 name 冲突时给后者加 source 后缀，保证前端 label 唯一
    let mut seen: HashSet<String> = HashSet::new();
    for c in commands.iter_mut() {
        if !seen.insert(c.name.clone()) {
            c.name = format!("{} ({})", c.name, c.source);
        }
        seen.insert(c.name.clone());
    }
    let mut detected_sources: Vec<String> = Vec::new();
    for c in &commands {
        if !detected_sources.contains(&c.source) {
            detected_sources.push(c.source.clone());
        }
    }
    ScanResult { commands, dir_exists: true, detected_sources }
}

/// 按锁文件判断包管理器。无锁文件默认 npm。
fn detect_pm(dir: &Path) -> &'static str {
    if dir.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if dir.join("yarn.lock").is_file() {
        "yarn"
    } else if dir.join("bun.lockb").is_file() || dir.join("bun.lock").is_file() {
        "bun"
    } else {
        "npm"
    }
}

/// npm：读 package.json scripts，按锁文件用对 pm。category 留空交前端推断。
fn detect_npm(dir: &Path) -> Vec<Command> {
    let pkg = dir.join("package.json");
    if !pkg.is_file() {
        return vec![];
    }
    let text = match std::fs::read_to_string(&pkg) {
        Ok(t) => t,
        Err(_) => return vec![],
    };
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let pm = detect_pm(dir);
    let mut out = Vec::new();
    if let Some(obj) = v.get("scripts").and_then(|s| s.as_object()) {
        for name in obj.keys() {
            out.push(Command {
                name: name.clone(),
                command: format!("{pm} run {name}"),
                source: pm.to_string(),
                category: String::new(),
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("quay_test_{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn npm_default_when_no_lockfile() {
        let d = tmp("npm_default");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite","build":"vite build"}}"#).unwrap();
        let r = scan_directory(d.to_str().unwrap());
        assert!(r.dir_exists);
        assert_eq!(r.commands.len(), 2);
        let dev = r.commands.iter().find(|c| c.name == "dev").unwrap();
        assert_eq!(dev.command, "npm run dev");
        assert_eq!(dev.source, "npm");
        assert_eq!(r.detected_sources, vec!["npm"]);
    }

    #[test]
    fn pnpm_lockfile_picks_pnpm() {
        let d = tmp("npm_pnpm");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        fs::write(d.join("pnpm-lock.yaml"), "lockfileVersion: 9").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let dev = r.commands.iter().find(|c| c.name == "dev").unwrap();
        assert_eq!(dev.command, "pnpm run dev");
        assert_eq!(dev.source, "pnpm");
    }

    #[test]
    fn yarn_and_bun_lockfiles() {
        let d = tmp("npm_yarn");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"x"}}"#).unwrap();
        fs::write(d.join("yarn.lock"), "").unwrap();
        assert_eq!(scan_directory(d.to_str().unwrap()).commands[0].command, "yarn run dev");

        let d2 = tmp("npm_bun");
        fs::write(d2.join("package.json"), r#"{"scripts":{"dev":"x"}}"#).unwrap();
        fs::write(d2.join("bun.lockb"), "").unwrap();
        assert_eq!(scan_directory(d2.to_str().unwrap()).commands[0].command, "bun run dev");
    }

    #[test]
    fn malformed_json_yields_empty() {
        let d = tmp("npm_bad");
        fs::write(d.join("package.json"), "{not json").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        assert!(r.dir_exists && r.commands.is_empty());
    }

    #[test]
    fn nonexistent_dir_flags_missing() {
        let r = scan_directory("/no/such/quay/dir/xyz");
        assert!(!r.dir_exists && r.commands.is_empty() && r.detected_sources.is_empty());
    }
}
```

- [ ] **Step 3: 跑测试确认编译失败（types 未更新前）→ 更新后通过**

Run: `cd src-tauri && cargo test scanner 2>&1 | tail -20`
Expected: 先因 `types.rs` 旧引用编译失败；改完 Step 1 后 5 个测试全 PASS。
注意：`commands.rs:8` 的 `scan_dir` 返回 `ScanResult` 不需改（字段名变了但类型名没变，自动适配）。

- [ ] **Step 4: 确认全 crate 编译**

Run: `cd src-tauri && cargo build 2>&1 | tail -15`
Expected: 编译通过（`scan_dir` 命令签名不变）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/types.rs src-tauri/src/scanner.rs
git commit -m "feat(scanner): 检测器注册表 + npm 包管理器识别（按锁文件选 pnpm/yarn/bun）"
```

---

### Task 2: 前端类型 + 分组（吃 Command）

**Files:**
- Modify: `src/lib/types.ts:1`、`:18`
- Modify: `src/lib/grouping.ts`
- Modify: `src/lib/grouping.test.ts`

- [ ] **Step 1: 改 `types.ts`**

`src/lib/types.ts` 第 1 行 `Script` 保留，第 18 行 `ScanResult` 替换，并在 `Script` 下新增 `Command`：

```ts
export interface Script { name: string; command: string }
export interface Command { name: string; command: string; source: string; category: string }
```

第 18 行 `ScanResult` 改为：

```ts
export interface ScanResult { commands: Command[]; dirExists: boolean; detectedSources: string[] }
```

- [ ] **Step 2: 改 `grouping.ts` 先写失败测试**

把 `src/lib/grouping.test.ts` 改写为（断言新签名 + category 透传 + 跨 source 同类别共存）：

```ts
import { describe, it, expect } from 'vitest'
import { categorize } from './grouping'
import type { Command } from './types'

const cmd = (name: string, command: string, source: string, category = ''): Command => ({
  name, command, source, category,
})

describe('categorize', () => {
  it('infers category from name when category empty (npm scripts)', () => {
    const cats = categorize([cmd('dev', 'pnpm run dev', 'pnpm'), cmd('test', 'pnpm run test', 'pnpm')])
    expect(cats.find((c) => c.label === '开发')?.loose.some((l) => l.name === 'dev')).toBe(true)
    expect(cats.find((c) => c.label === '测试')?.loose.some((l) => l.name === 'test')).toBe(true)
  })

  it('honors explicit category from detector', () => {
    const cats = categorize([cmd('cargo run', 'cargo run', 'cargo', 'dev')])
    const dev = cats.find((c) => c.label === '开发')!
    expect(dev.loose[0].command).toBe('cargo run')
    expect(dev.loose[0].source).toBe('cargo')
  })

  it('mixes sources within one semantic category', () => {
    const cats = categorize([
      cmd('dev', 'pnpm run dev', 'pnpm'),
      cmd('cargo run', 'cargo run', 'cargo', 'dev'),
    ])
    const dev = cats.find((c) => c.label === '开发')!
    const names = dev.loose.map((l) => l.name).sort()
    expect(names).toEqual(['cargo run', 'dev'])
  })

  it('groups same-prefix npm scripts (>=2) into a prefix group', () => {
    const cats = categorize([
      cmd('db:migrate', 'pnpm run db:migrate', 'pnpm'),
      cmd('db:seed', 'pnpm run db:seed', 'pnpm'),
    ])
    const data = cats.find((c) => c.label === '数据')!
    expect(data.groups[0].prefix).toBe('db')
    expect(data.groups[0].items.length).toBe(2)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test grouping 2>&1 | tail -20`
Expected: FAIL（`categorize` 仍要 `Script[]`，`CmdLeaf` 无 `source`）。

- [ ] **Step 4: 改 `grouping.ts` 实现**

`grouping.ts` 第 1 行 import 改为：

```ts
import type { Command } from './types'
```

`CmdLeaf` 接口（第 8-11 行）加 `source`：

```ts
export interface CmdLeaf {
  name: string
  command: string
  source: string
}
```

在 `categoryOf`（第 47-50 行）下方新增按命令取 category-key 的辅助：

```ts
function catKeyOf(c: Command): string {
  return c.category && c.category.length ? c.category : categoryOf(c.name)
}
```

`categorize` 函数（第 53 行起）签名与内部改为吃 `Command[]`、按 `catKeyOf` 分桶、leaf 带 `source`：

```ts
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test grouping 2>&1 | tail -20`
Expected: PASS（4 个用例）。

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/grouping.ts src/lib/grouping.test.ts
git commit -m "feat(grouping): categorize 吃 Command[]，按 category 分组，CmdLeaf 带 source"
```

---

### Task 3: 前端消费迁移（Sidebar + deepseek，端到端可用）

**Files:**
- Modify: `src/lib/deepseek.ts:1`、`:67`、`:77`、`:88-94`、`:104`
- Modify: `src/components/Sidebar.tsx`（多处，见下）

- [ ] **Step 1: 改 `deepseek.ts` —— smartGroup 吃 Command[]**

第 1 行 import 改为：

```ts
import type { Command } from './types'
```

`groupCacheKey`（第 67 行）参数类型 `Script[]`→`Command[]`（函数体不变，仍用 `s.name`）。

`smartGroup`（第 77 行）签名 `scripts: Script[]`→`commands: Command[]`，并把函数体内所有 `scripts` 引用改为 `commands`：
- 第 78 行 `if (commands.length === 0) return []`
- 第 79 行 `groupCacheKey(commands)`
- 第 87 行 `const names = commands.map((s) => s.name)`
- 第 104 行 `cmdOf` 改为保留 command+source：

```ts
  const cmdOf = new Map(commands.map((c) => [c.name, c]))
  const used = new Set<string>()
  const leaf = (n: string) => {
    used.add(n)
    const c = cmdOf.get(n)
    return { name: n, command: c?.command ?? '', source: c?.source ?? '' }
  }
```

- 第 125 行 leftover 改为 `commands.filter((c) => !used.has(c.name)).map((c) => leaf(c.name))`
- 第 132 行 `categorize(scripts)`→`categorize(commands)`

第 89 行系统提示词把 “npm scripts” 改为通用措辞：

```ts
    '你是构建脚本组织专家。把开发/构建命令按用途分到中文大类。' +
```

- [ ] **Step 2: 改 `Sidebar.tsx` —— import 与状态**

第 6 行 import 把 `Script` 换成 `Command`：

```ts
import type { Command, ScanResult, CommandEntry } from '../lib/types'
```

第 432 行状态改名并改类型：

```ts
  const [commands, setCommands] = useState<Command[]>([])
```

- [ ] **Step 3: 改 `Sidebar.tsx` —— applyScan（warn 文案 + setCommands）**

第 453-465 行 `applyScan` 替换为：

```ts
    const applyScan = (r: ScanResult) => {
      if (!active) return
      setCommands(r.commands)
      if (!r.dirExists) {
        setWarn('目录不存在或无访问权限(检查 macOS 系统设置 → 隐私与安全性 → 文件和文件夹 / 完整磁盘访问)')
      } else if (r.detectedSources.length === 0) {
        setWarn('此目录无可识别的项目（package.json / Cargo.toml / Makefile / go.mod / pom.xml 等）')
      } else if (r.commands.length === 0) {
        setWarn('检测到项目但无可运行命令')
      } else {
        setWarn('')
      }
    }
```

- [ ] **Step 4: 改 `Sidebar.tsx` —— 其余 `scripts` 引用改 `commands`**

- 第 489 行：`if (!aiMode || commands.length === 0) return`
- 第 492 行：`smartGroup(commands)`
- 第 506 行依赖数组：`}, [aiMode, commands])`
- 第 509 行：`const categories = aiMode && aiCats ? aiCats : categorize(commands)`
- 第 510 行：`const dirRunning = commands.filter((s) => runningLabels.has(`${dirName}:${s.name}`)).length`
- 第 519 行：`{commands.length > 0 && <span className="dir-count">{commands.length}</span>}`
- 第 550 行：`{configured && commands.length > 0 && (`

- [ ] **Step 5: 改 `Sidebar.tsx` —— 去掉写死的 npm run（两处）**

第 405 行（PrefixGroupNode 内 CmdRow）：

```ts
              onRun={() => onRun(`${dirName}:${it.name}`, path, it.command)}
```

第 591 行（loose CmdRow）：

```ts
                  onRun={() => onRun(`${dirName}:${it.name}`, path, it.command)}
```

- [ ] **Step 6: 改 `Sidebar.tsx` —— CmdRow 加 source 标签**

CmdRow props 类型（第 257-265 行）加可选 `source`：

```ts
}: {
  display: string
  command: string
  running: boolean
  source?: string
  onRun: () => void
  onView?: () => void
  onEdit?: () => void
  onRemove?: () => void
}) {
```

并在解构形参列表里加入 `source`（与 `display, command, running, ...` 同级）。

在 CmdRow 渲染（第 331 行 `cmd-name` 之后）插入 source 标签：

```tsx
        <span className="cmd-name">{display}</span>
        {source && <span className="cmd-source">{source}</span>}
```

两处使用 CmdRow 的地方传入 source：
- 第 400-407 行 PrefixGroupNode 的 `<CmdRow>` 加一行：`source={it.source}`
- 第 585-593 行 loose 的 `<CmdRow>` 加一行：`source={it.source}`

- [ ] **Step 7: 跑前端检查 + 测试**

Run: `pnpm tsc -b && pnpm test 2>&1 | tail -20`
Expected: 无类型错误；全部测试 PASS。

- [ ] **Step 8: Commit**

```bash
git add src/lib/deepseek.ts src/components/Sidebar.tsx
git commit -m "feat(sidebar): 消费 Command 模型，命令直接用完整执行串，去掉写死 npm run，加 source 标签"
```

---

### Task 4: cargo + go 检测器

**Files:**
- Modify: `src-tauri/src/scanner.rs`

- [ ] **Step 1: 先写失败测试（加到 `scanner.rs` 的 `mod tests`）**

```rust
    #[test]
    fn cargo_project_offers_run_build_test() {
        let d = tmp("cargo");
        fs::write(d.join("Cargo.toml"), "[package]\nname=\"x\"").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"cargo run") && cmds.contains(&"cargo test"));
        let run = r.commands.iter().find(|c| c.command == "cargo run").unwrap();
        assert_eq!(run.category, "dev");
        assert_eq!(run.source, "cargo");
    }

    #[test]
    fn go_project_offers_run_build_test() {
        let d = tmp("go");
        fs::write(d.join("go.mod"), "module x\n").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"go run .") && cmds.contains(&"go test ./..."));
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test scanner::tests::cargo_project 2>&1 | tail -10`
Expected: FAIL（检测器未注册）。

- [ ] **Step 3: 加检测器 + 注册**

在 `scanner.rs` 的 `detect_npm` 函数后新增：

```rust
/// 固定约定命令的小工具：批量造 Command。
fn fixed(source: &str, items: &[(&str, &str)]) -> Vec<Command> {
    items
        .iter()
        .map(|(cmd, cat)| Command {
            name: cmd.to_string(),
            command: cmd.to_string(),
            source: source.to_string(),
            category: cat.to_string(),
        })
        .collect()
}

fn detect_cargo(dir: &Path) -> Vec<Command> {
    if !dir.join("Cargo.toml").is_file() {
        return vec![];
    }
    fixed("cargo", &[
        ("cargo run", "dev"),
        ("cargo build", "build"),
        ("cargo test", "test"),
        ("cargo check", "test"),
        ("cargo clippy", "test"),
    ])
}

fn detect_go(dir: &Path) -> Vec<Command> {
    if !dir.join("go.mod").is_file() {
        return vec![];
    }
    fixed("go", &[
        ("go run .", "dev"),
        ("go build ./...", "build"),
        ("go test ./...", "test"),
    ])
}
```

把 `scan_directory` 里的 `detectors` 数组改为：

```rust
    let detectors: &[fn(&Path) -> Vec<Command>] = &[detect_npm, detect_cargo, detect_go];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test scanner 2>&1 | tail -15`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/scanner.rs
git commit -m "feat(scanner): cargo / go 检测器"
```

---

### Task 5: make 检测器（解析 Makefile 顶层 target）

**Files:**
- Modify: `src-tauri/src/scanner.rs`

- [ ] **Step 1: 先写失败测试**

```rust
    #[test]
    fn make_parses_top_level_targets() {
        let d = tmp("make");
        fs::write(
            d.join("Makefile"),
            "VAR := 1\n.PHONY: build\nbuild:\n\tgo build\ntest:\n\tgo test\n\t@echo done\n",
        )
        .unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let names: Vec<&str> = r.commands.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"make build") && names.contains(&"make test"));
        // 不把变量/伪目标/缩进配方行当成 target
        assert!(!names.iter().any(|n| n.contains("VAR") || n.contains(".PHONY") || n.contains("echo")));
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test scanner::tests::make_parses 2>&1 | tail -10`
Expected: FAIL。

- [ ] **Step 3: 加检测器 + 注册**

新增：

```rust
fn detect_make(dir: &Path) -> Vec<Command> {
    let path = ["Makefile", "makefile"]
        .iter()
        .map(|f| dir.join(f))
        .find(|p| p.is_file());
    let path = match path {
        Some(p) => p,
        None => return vec![],
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return vec![],
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for line in text.lines() {
        // 配方行(以 tab/空格开头)、注释、无冒号行跳过
        if line.starts_with(|c: char| c.is_whitespace()) || line.starts_with('#') {
            continue;
        }
        let colon = match line.find(':') {
            Some(i) => i,
            None => continue,
        };
        let name = line[..colon].trim();
        let after = &line[colon..];
        // 变量赋值(:=)、伪目标(.xxx)、模式(%)、含空白或变量引用的多目标 → 跳过
        if name.is_empty()
            || name.starts_with('.')
            || name.contains('=')
            || name.contains('%')
            || name.contains('$')
            || name.contains(char::is_whitespace)
            || after.starts_with(":=")
        {
            continue;
        }
        if !seen.insert(name.to_string()) {
            continue;
        }
        out.push(Command {
            name: format!("make {name}"),
            command: format!("make {name}"),
            source: "make".to_string(),
            category: String::new(),
        });
    }
    out
}
```

`detectors` 数组追加 `detect_make`：

```rust
    let detectors: &[fn(&Path) -> Vec<Command>] = &[detect_npm, detect_cargo, detect_go, detect_make];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test scanner 2>&1 | tail -15`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/scanner.rs
git commit -m "feat(scanner): make 检测器（解析 Makefile 顶层 target）"
```

---

### Task 6: docker compose 检测器

**Files:**
- Modify: `src-tauri/src/scanner.rs`

- [ ] **Step 1: 先写失败测试**

```rust
    #[test]
    fn compose_offers_up_down_logs() {
        let d = tmp("compose");
        fs::write(d.join("docker-compose.yml"), "services: {}\n").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"docker compose up") && cmds.contains(&"docker compose down"));
        assert_eq!(
            r.commands.iter().find(|c| c.command == "docker compose up").unwrap().category,
            "dev"
        );
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test scanner::tests::compose 2>&1 | tail -10`
Expected: FAIL。

- [ ] **Step 3: 加检测器 + 注册**

```rust
fn detect_compose(dir: &Path) -> Vec<Command> {
    let has = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]
        .iter()
        .any(|f| dir.join(f).is_file());
    if !has {
        return vec![];
    }
    fixed("compose", &[
        ("docker compose up", "dev"),
        ("docker compose up -d", "dev"),
        ("docker compose down", "other"),
        ("docker compose logs -f", "other"),
        ("docker compose ps", "other"),
    ])
}
```

`detectors` 数组追加 `detect_compose`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test scanner 2>&1 | tail -15`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/scanner.rs
git commit -m "feat(scanner): docker compose 检测器"
```

---

### Task 7: composer + maven + gradle 检测器（含跨 source 去重验证）

**Files:**
- Modify: `src-tauri/src/scanner.rs`

- [ ] **Step 1: 先写失败测试**

```rust
    #[test]
    fn composer_scripts_and_artisan() {
        let d = tmp("composer");
        fs::write(d.join("composer.json"), r#"{"scripts":{"lint":"phpcs"}}"#).unwrap();
        fs::write(d.join("artisan"), "#!/usr/bin/env php").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"composer run lint"));
        assert!(cmds.contains(&"php artisan serve"));
    }

    #[test]
    fn maven_springboot_adds_run() {
        let d = tmp("maven");
        fs::write(d.join("pom.xml"), "<project><dependency>spring-boot-starter</dependency></project>").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"mvn spring-boot:run") && cmds.contains(&"mvn test"));
    }

    #[test]
    fn gradle_uses_wrapper_when_present() {
        let d = tmp("gradle");
        fs::write(d.join("build.gradle"), "plugins { id 'org.springframework.boot' }").unwrap();
        fs::write(d.join("gradlew"), "#!/bin/sh").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"./gradlew bootRun") && cmds.contains(&"./gradlew build"));
    }

    #[test]
    fn name_collision_gets_source_suffix() {
        // npm 与 composer 同名脚本 → 第二个加 source 后缀，label 唯一
        let d = tmp("collide");
        fs::write(d.join("package.json"), r#"{"scripts":{"lint":"eslint"}}"#).unwrap();
        fs::write(d.join("composer.json"), r#"{"scripts":{"lint":"phpcs"}}"#).unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let names: Vec<&str> = r.commands.iter().map(|c| c.name.as_str()).collect();
        let lint_count = names.iter().filter(|n| n.starts_with("lint")).count();
        assert_eq!(lint_count, 2);
        // 唯一性：无重复 name
        let uniq: HashSet<&str> = names.iter().copied().collect();
        assert_eq!(uniq.len(), names.len());
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test scanner::tests::composer 2>&1 | tail -10`
Expected: FAIL。

- [ ] **Step 3: 加三个检测器 + 注册**

```rust
fn detect_composer(dir: &Path) -> Vec<Command> {
    let mut out = Vec::new();
    let cj = dir.join("composer.json");
    if cj.is_file() {
        if let Ok(text) = std::fs::read_to_string(&cj) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(obj) = v.get("scripts").and_then(|s| s.as_object()) {
                    for name in obj.keys() {
                        out.push(Command {
                            name: name.clone(),
                            command: format!("composer run {name}"),
                            source: "composer".to_string(),
                            category: String::new(),
                        });
                    }
                }
            }
        }
    }
    if dir.join("artisan").is_file() {
        out.push(Command { name: "php artisan serve".into(), command: "php artisan serve".into(), source: "composer".into(), category: "dev".into() });
        out.push(Command { name: "php artisan migrate".into(), command: "php artisan migrate".into(), source: "composer".into(), category: "data".into() });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn detect_maven(dir: &Path) -> Vec<Command> {
    if !dir.join("pom.xml").is_file() {
        return vec![];
    }
    let mut out = fixed("maven", &[
        ("mvn clean install", "build"),
        ("mvn test", "test"),
    ]);
    if let Ok(text) = std::fs::read_to_string(dir.join("pom.xml")) {
        if text.contains("spring-boot") {
            out.insert(0, Command { name: "mvn spring-boot:run".into(), command: "mvn spring-boot:run".into(), source: "maven".into(), category: "dev".into() });
        }
    }
    out
}

fn detect_gradle(dir: &Path) -> Vec<Command> {
    let has = dir.join("build.gradle").is_file() || dir.join("build.gradle.kts").is_file();
    if !has {
        return vec![];
    }
    let g = if dir.join("gradlew").is_file() { "./gradlew" } else { "gradle" };
    let mut out = vec![
        Command { name: format!("{g} build"), command: format!("{g} build"), source: "gradle".into(), category: "build".into() },
        Command { name: format!("{g} test"), command: format!("{g} test"), source: "gradle".into(), category: "test".into() },
    ];
    let bootish = [dir.join("build.gradle"), dir.join("build.gradle.kts")]
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .any(|t| t.contains("org.springframework.boot"));
    if bootish {
        out.insert(0, Command { name: format!("{g} bootRun"), command: format!("{g} bootRun"), source: "gradle".into(), category: "dev".into() });
    }
    out
}
```

`detectors` 数组追加：`detect_composer, detect_maven, detect_gradle`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test scanner 2>&1 | tail -20`
Expected: 全部 PASS（含 `name_collision_gets_source_suffix`）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/scanner.rs
git commit -m "feat(scanner): composer/artisan + maven/spring-boot + gradle 检测器"
```

---

### Task 8: python 检测器（Django / poetry / 兜底）

**Files:**
- Modify: `src-tauri/src/scanner.rs`

- [ ] **Step 1: 先写失败测试**

```rust
    #[test]
    fn python_django_manage_py() {
        let d = tmp("py_django");
        fs::write(d.join("manage.py"), "# django").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"python manage.py runserver"));
    }

    #[test]
    fn python_poetry_scripts() {
        let d = tmp("py_poetry");
        fs::write(d.join("pyproject.toml"), "[tool.poetry.scripts]\nserve = \"app:main\"\n").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"poetry run serve"));
    }

    #[test]
    fn python_fallback_main_py() {
        let d = tmp("py_main");
        fs::write(d.join("requirements.txt"), "flask\n").unwrap();
        fs::write(d.join("main.py"), "print(1)").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        // requirements.txt 不触发；main.py 兜底
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"python main.py"));
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test scanner::tests::python 2>&1 | tail -10`
Expected: FAIL。

- [ ] **Step 3: 加检测器 + 注册**

```rust
fn detect_python(dir: &Path) -> Vec<Command> {
    // Django
    if dir.join("manage.py").is_file() {
        return vec![
            Command { name: "python manage.py runserver".into(), command: "python manage.py runserver".into(), source: "python".into(), category: "dev".into() },
            Command { name: "python manage.py migrate".into(), command: "python manage.py migrate".into(), source: "python".into(), category: "data".into() },
            Command { name: "python manage.py test".into(), command: "python manage.py test".into(), source: "python".into(), category: "test".into() },
        ];
    }
    // poetry scripts（best-effort 行解析）
    let pp = dir.join("pyproject.toml");
    if pp.is_file() {
        if let Ok(text) = std::fs::read_to_string(&pp) {
            let mut out = Vec::new();
            let mut in_section = false;
            for line in text.lines() {
                let t = line.trim();
                if t.starts_with('[') {
                    in_section = t == "[tool.poetry.scripts]";
                    continue;
                }
                if in_section {
                    if let Some(eq) = t.find('=') {
                        let key = t[..eq].trim().trim_matches('"');
                        if !key.is_empty() {
                            out.push(Command {
                                name: format!("poetry run {key}"),
                                command: format!("poetry run {key}"),
                                source: "python".into(),
                                category: String::new(),
                            });
                        }
                    }
                }
            }
            if !out.is_empty() {
                return out;
            }
        }
    }
    // 兜底：单文件入口
    for f in ["main.py", "app.py"] {
        if dir.join(f).is_file() {
            return vec![Command {
                name: format!("python {f}"),
                command: format!("python {f}"),
                source: "python".into(),
                category: "dev".into(),
            }];
        }
    }
    vec![]
}
```

`detectors` 数组追加 `detect_python`（最终 9 个）：

```rust
    let detectors: &[fn(&Path) -> Vec<Command>] = &[
        detect_npm, detect_cargo, detect_go, detect_make, detect_compose,
        detect_composer, detect_maven, detect_gradle, detect_python,
    ];
```

- [ ] **Step 4: 跑测试 + 全 crate clippy**

Run: `cd src-tauri && cargo test scanner 2>&1 | tail -20 && cargo build 2>&1 | tail -5`
Expected: 全部 PASS，编译通过。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/scanner.rs
git commit -m "feat(scanner): python 检测器（Django/poetry/单文件兜底）"
```

---

### Task 9: 端到端手动验收

**Files:** 无（运行 + 观察）

- [ ] **Step 1: 起 dev 跑真实多语言目录**

Run: `pnpm tauri dev`
操作：绑定 ① 本仓库（pnpm 项目）② 一个 PHP composer 项目 ③ 一个含 Makefile / Cargo.toml 的目录。

- [ ] **Step 2: 逐项核对**

- [ ] 本仓库的 `dev` 点击后，监控终端实际执行 **`pnpm run dev`**（不是 `npm run dev`）。
- [ ] PHP 项目出现 `composer run ...`，命令行尾显示 `composer` source 标签。
- [ ] Makefile 目录出现 `make <target>`，变量/`.PHONY` 行没被当成命令。
- [ ] 命令按「开发/测试/构建/数据/其他」语义类别分组，Rust+Make 混合目录的 `cargo run` 与 `make dev` 同在「开发」组。
- [ ] 无任何标记文件的空目录显示「无可识别的项目」提示。

- [ ] **Step 3: 回归既有功能**

- [ ] AI 智能分组开关仍工作（配了 DeepSeek key 时）。
- [ ] 运行中状态点 / 双击再开 / `?` 解释命令均正常。

- [ ] **Step 4: 收尾提交（如手动验收期间有微调）**

```bash
git add -A && git commit -m "chore: 命令发现引擎手动验收微调"
```

---

## Self-Review 结论

- **Spec 覆盖**：①包管理器识别→Task1；②多语言检测器→Task4-8；③去掉 npm run→Task3 Step5；④按 category 分组→Task2；⑤detectedSources/warn 迁移→Task3 Step3；⑥source 标签→Task3 Step6；⑦去重唯一性→Task1 聚合 + Task7 验证。全部有对应任务。
- **类型一致性**：Rust `Command{name,command,source,category}` 与 TS `Command` 字段一致；`ScanResult{commands,dirExists,detectedSources}` 两端一致；`CmdLeaf` 加 `source` 在 grouping/deepseek/Sidebar 三处同步。
- **无占位符**：每步含完整代码与可执行命令。
- **已知取舍**：source 标签暂直接渲染 source 字符串（composer 显示 "composer" 而非 "php"），样式 `.cmd-source` 需在 CSS 里补一条（验收时若觉得丑再调，不阻塞功能）。
