# L2 AI 识别命令 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Quay 加 L2「AI 识别命令」——L1 检测器空手/歧义或用户主动点击时，用 DeepSeek 读项目结构+关键文件，提议可运行命令（带 cwd + 为什么），用户在清单里勾选/编辑确认后落为普通手动命令。

**Architecture:** 后端新增 `collect_context`（有界浅递归 + 白名单文件读取 + 截断，敏感文件硬跳过）作为 L2 的"眼睛"，顺带吃掉嵌套多模块缺口；前端扩展 `deepseek.ts` 的 `proposeCommands`（纯函数 `parseProposals` + 缓存）；新增 `AiProposeModal` 清单弹窗；DirNode 挂「✨ 让 AI 识别」按钮，确认后批量 `addManualCommand(origin:'ai')`。L1 `scan_dir` 完全不动。

**Tech Stack:** Rust（Tauri 2 command）+ React 19 + TypeScript + Zustand + Vitest + cargo test。

参考 spec：`docs/superpowers/specs/2026-06-02-ai-command-recognition-design.md`

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src-tauri/src/context.rs` | 创建 | `collect_context` 浅递归 + 白名单 + 截断 → `ProjectContext` |
| `src-tauri/src/lib.rs` | 修改 | 声明 `mod context;`，注册 `commands::collect_context` |
| `src-tauri/src/commands.rs` | 修改 | `#[tauri::command] collect_context` 包装 |
| `src-tauri/src/types.rs` | 修改 | `CommandEntry` 加 `origin: Option<String>` |
| `src/lib/types.ts` | 修改 | `CommandEntry.origin`、`ProjectContext`、`ContextFile`、`Proposal` |
| `src/lib/ipc.ts` | 修改 | `collectContext` invoke 包装 |
| `src/state/store.ts` | 修改 | `addManualCommand` 加可选 `origin` 参数 |
| `src/lib/deepseek.ts` | 修改 | `parseProposals`（纯函数，导出）+ `proposeCommands`（缓存） |
| `src/lib/deepseek.test.ts` | 创建 | `parseProposals` 单测 |
| `src/components/AiProposeModal.tsx` | 创建 | 提议清单弹窗：勾选 + 内联编辑 + why |
| `src/components/Sidebar.tsx` | 修改 | DirNode 接 `projectId` + 「✨ 让 AI 识别」按钮 + 落地；CmdRow 显示 ✨ |
| `src/App.css` | 修改 | AiProposeModal 与 ✨ 小标样式 |

---

## Task 1: 模型增量（CommandEntry.origin 双端 + store）

**Files:**
- Modify: `src-tauri/src/types.rs:18-28`
- Modify: `src/lib/types.ts:3-10`
- Modify: `src/state/store.ts:57`、`:128-135`

- [ ] **Step 1: Rust 加 origin 字段**

`src-tauri/src/types.rs` 的 `CommandEntry` 末尾加字段：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandEntry {
    pub id: String,
    pub label: String,
    pub cwd: String,
    pub command: String,
    #[serde(default)]
    pub long: bool,
    #[serde(default, rename = "confirmBeforeRun")]
    pub confirm_before_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}
```

- [ ] **Step 2: 前端类型加 origin**

`src/lib/types.ts` 的 `CommandEntry`：

```ts
export interface CommandEntry {
  id: string
  label: string
  cwd: string
  command: string
  long?: boolean
  confirmBeforeRun?: boolean
  origin?: 'ai'
}
```

- [ ] **Step 3: store.addManualCommand 加可选 origin**

`src/state/store.ts` 接口签名（约 :57）改为：

```ts
  addManualCommand: (projectId: string, label: string, cwd: string, command: string, origin?: 'ai') => void
```

实现（约 :128-135）改为：

```ts
  addManualCommand: (pid, label, cwd, command, origin) => {
    const c = structuredClone(get().config)
    c.projects
      .find((p) => p.id === pid)
      ?.manualCommands.push({ id: uuid(), label, cwd, command, long: true, ...(origin ? { origin } : {}) })
    set({ config: c })
    get().persist()
  },
```

- [ ] **Step 4: 编译 + 既有测试回归**

Run: `cd src-tauri && cargo build 2>&1 | tail -3 && cd .. && npm test 2>&1 | tail -5`
Expected: cargo build 无错误；vitest 22 passed（既有测试不受影响）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/types.rs src/lib/types.ts src/state/store.ts
git commit -m "feat(types): CommandEntry 加 origin 字段（标记 AI 识别来源）"
```

---

## Task 2: 后端 collect_context（浅递归 + 白名单 + 截断）

**Files:**
- Create: `src-tauri/src/context.rs`
- Modify: `src-tauri/src/lib.rs:1-10`（mod 声明）、`:220-241`（注册）
- Modify: `src-tauri/src/commands.rs:1-10`（use）、追加命令

- [ ] **Step 1: 写 context.rs（实现 + 测试一起，TDD 单文件惯例同 scanner.rs）**

创建 `src-tauri/src/context.rs`：

```rust
use crate::scanner;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 3;
const MAX_TREE: usize = 400;
const MAX_FILES: usize = 30;
const MAX_FILE_BYTES: usize = 8 * 1024;
const MAX_TOTAL_BYTES: usize = 64 * 1024;

const SKIP_DIRS: &[&str] = &[
    "node_modules", "vendor", "target", ".git", "dist", "build", ".next", ".venv",
    "__pycache__", ".idea", ".vscode", "coverage",
];

const WHITELIST: &[&str] = &[
    "package.json", "composer.json", "pom.xml", "build.gradle", "build.gradle.kts",
    "go.mod", "Cargo.toml", "Makefile", "docker-compose.yml", "docker-compose.yaml",
    "compose.yml", "manage.py", "pyproject.toml", "requirements.txt", "artisan",
    "README", "README.md", "README.txt",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextFile {
    #[serde(rename = "relPath")]
    pub rel_path: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectContext {
    pub root: String,
    pub tree: Vec<String>,
    pub files: Vec<ContextFile>,
    #[serde(rename = "detectedSources")]
    pub detected_sources: Vec<String>,
}

/// 敏感文件硬跳过：绝不读取/外发（即使在白名单也不读）。
fn is_sensitive(name: &str) -> bool {
    let l = name.to_lowercase();
    l.starts_with(".env")
        || l.ends_with(".pem")
        || l.ends_with(".key")
        || l.starts_with("id_rsa")
        || l.contains("secret")
        || l.contains("credential")
        || l.ends_with(".p12")
        || l.ends_with(".keystore")
}

/// L2 的"眼睛"：有界浅递归(深度≤3)收集目录树 + 白名单关键文件内容(截断)。
/// 跳过噪声目录与敏感文件。root 不存在 → 空 context。
pub fn collect_context(dir: &str) -> ProjectContext {
    let root = Path::new(dir);
    let mut ctx = ProjectContext {
        root: dir.to_string(),
        tree: Vec::new(),
        files: Vec::new(),
        // 复用 L1 在顶层的探测结果，给 LLM 一个先验提示
        detected_sources: scanner::scan_directory(dir).detected_sources,
    };
    if !root.is_dir() {
        return ctx;
    }
    let mut total = 0usize;
    walk(root, root, 0, &mut ctx, &mut total);
    ctx
}

fn walk(root: &Path, dir: &Path, depth: usize, ctx: &mut ProjectContext, total: &mut usize) {
    if depth > MAX_DEPTH {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    // 排序保证确定性输出
    let mut items: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
    items.sort();
    for path in items {
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if ctx.tree.len() < MAX_TREE {
                if let Ok(rel) = path.strip_prefix(root) {
                    ctx.tree.push(format!("{}/", rel.to_string_lossy()));
                }
            }
            walk(root, &path, depth + 1, ctx, total);
        } else if path.is_file() {
            if is_sensitive(&name) {
                continue;
            }
            if !WHITELIST.contains(&name.as_str()) {
                continue;
            }
            if ctx.tree.len() < MAX_TREE {
                if let Ok(rel) = path.strip_prefix(root) {
                    ctx.tree.push(rel.to_string_lossy().to_string());
                }
            }
            if ctx.files.len() < MAX_FILES && *total < MAX_TOTAL_BYTES {
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    let truncated = raw.len() > MAX_FILE_BYTES;
                    let content: String = if truncated {
                        raw.chars().take(MAX_FILE_BYTES).collect()
                    } else {
                        raw
                    };
                    *total += content.len();
                    if let Ok(rel) = path.strip_prefix(root) {
                        ctx.files.push(ContextFile {
                            rel_path: rel.to_string_lossy().to_string(),
                            content,
                            truncated,
                        });
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("quay_ctx_test_{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_dir_returns_empty() {
        let ctx = collect_context("/no/such/dir/xyz");
        assert!(ctx.tree.is_empty());
        assert!(ctx.files.is_empty());
    }

    #[test]
    fn reads_whitelisted_and_skips_sensitive() {
        let d = tmp("whitelist");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        fs::write(d.join(".env"), "SECRET=topsecret").unwrap();
        fs::write(d.join("private.key"), "-----BEGIN KEY-----").unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        assert!(ctx.files.iter().any(|f| f.rel_path == "package.json"));
        // .env / *.key 绝不被读取
        assert!(!ctx.files.iter().any(|f| f.rel_path.contains(".env")));
        assert!(!ctx.files.iter().any(|f| f.rel_path.ends_with(".key")));
        // 敏感文件名也不应进 files 内容
        assert!(ctx.files.iter().all(|f| !f.content.contains("topsecret")));
    }

    #[test]
    fn skips_noise_dirs() {
        let d = tmp("noise");
        fs::create_dir_all(d.join("node_modules/foo")).unwrap();
        fs::write(d.join("node_modules/foo/package.json"), "{}").unwrap();
        fs::write(d.join("package.json"), r#"{"name":"root"}"#).unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        assert!(ctx.tree.iter().all(|t| !t.contains("node_modules")));
        assert_eq!(ctx.files.iter().filter(|f| f.rel_path.ends_with("package.json")).count(), 1);
    }

    #[test]
    fn nested_marker_visible_in_tree() {
        let d = tmp("nested");
        fs::create_dir_all(d.join("java-api/gyj_admin/ch_backend")).unwrap();
        fs::write(d.join("java-api/gyj_admin/ch_backend/pom.xml"), "<project/>").unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        assert!(ctx.tree.iter().any(|t| t == "java-api/gyj_admin/ch_backend/pom.xml"));
        assert!(ctx.files.iter().any(|f| f.rel_path == "java-api/gyj_admin/ch_backend/pom.xml"));
    }

    #[test]
    fn does_not_descend_past_max_depth() {
        let d = tmp("depth");
        // a/b/c/ = 深度3 目录,其 pom 应读到; a/b/c/d/ = 深度4,其 pom 不读
        fs::create_dir_all(d.join("a/b/c/d")).unwrap();
        fs::write(d.join("a/b/c/pom.xml"), "<c/>").unwrap();
        fs::write(d.join("a/b/c/d/pom.xml"), "<d/>").unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        assert!(ctx.files.iter().any(|f| f.rel_path == "a/b/c/pom.xml"));
        assert!(!ctx.files.iter().any(|f| f.rel_path == "a/b/c/d/pom.xml"));
    }

    #[test]
    fn truncates_large_file() {
        let d = tmp("trunc");
        let big = "x".repeat(20 * 1024);
        fs::write(d.join("README.md"), &big).unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        let readme = ctx.files.iter().find(|f| f.rel_path == "README.md").unwrap();
        assert!(readme.truncated);
        assert!(readme.content.len() <= MAX_FILE_BYTES);
    }
}
```

- [ ] **Step 2: 注册 mod + 跑测试看通过**

`src-tauri/src/lib.rs` 在 `mod commands;` 一组里按字母序加一行：

```rust
mod context;
```

Run: `cd src-tauri && cargo test context 2>&1 | tail -12`
Expected: 6 个 context::tests 全 PASS。

- [ ] **Step 3: commands.rs 加 tauri 命令包装**

`src-tauri/src/commands.rs` 顶部 `use crate::{...}` 一行加入 `context`（与现有 `config, reconcile, runner, scanner, watcher` 并列）。在 `scan_dir` 命令附近追加：

```rust
/// L2：采集项目上下文(浅递归 + 白名单文件)，喂给前端 AI 提议命令。
#[tauri::command]
pub fn collect_context(path: String) -> crate::context::ProjectContext {
    crate::context::collect_context(&path)
}
```

- [ ] **Step 4: lib.rs 注册到 invoke_handler**

`src-tauri/src/lib.rs` 的 `generate_handler!` 列表里，`commands::scan_dir,` 下一行加：

```rust
            commands::collect_context,
```

- [ ] **Step 5: 整体编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -3`
Expected: 无错误（命令签名匹配，serde 派生正常）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/context.rs src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "feat(context): collect_context 浅递归采集项目上下文（白名单+截断+敏感文件硬跳过）"
```

---

## Task 3: 前端类型 + IPC 包装

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/ipc.ts:1-3`、追加

- [ ] **Step 1: 加 ProjectContext / ContextFile / Proposal 类型**

`src/lib/types.ts` 末尾追加：

```ts
export interface ContextFile { relPath: string; content: string; truncated: boolean }
export interface ProjectContext {
  root: string
  tree: string[]
  files: ContextFile[]
  detectedSources: string[]
}
export interface Proposal { name: string; command: string; cwd: string; why: string }
```

- [ ] **Step 2: ipc.ts 加 collectContext**

`src/lib/ipc.ts` 顶部 import 的 type 列表加入 `ProjectContext`。在 `scanDir` 下一行追加：

```ts
/// L2：采集项目上下文(浅递归 + 白名单关键文件)，供前端喂给 DeepSeek 提议命令。
export const collectContext = (path: string) => invoke<ProjectContext>('collect_context', { path })
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc -b 2>&1 | tail -5`
Expected: 无类型错误。

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/ipc.ts
git commit -m "feat(ipc): collectContext 包装 + ProjectContext/Proposal 类型"
```

---

## Task 4: parseProposals 纯函数 + 单测（TDD）

**Files:**
- Create: `src/lib/deepseek.test.ts`
- Modify: `src/lib/deepseek.ts`（顶部 import 加 ProjectContext/Proposal；导出 parseProposals）

- [ ] **Step 1: 写失败测试**

创建 `src/lib/deepseek.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseProposals } from './deepseek'
import type { ProjectContext } from './types'

const ctx = (tree: string[]): ProjectContext => ({
  root: '/r', tree, files: [], detectedSources: [],
})

describe('parseProposals', () => {
  it('解析合法 {commands:[...]} JSON', () => {
    const raw = JSON.stringify({
      commands: [{ name: '开发', command: 'pnpm dev', cwd: '', why: 'vite 项目' }],
    })
    const out = parseProposals(raw, ctx([]))
    expect(out).toEqual([{ name: '开发', command: 'pnpm dev', cwd: '', why: 'vite 项目' }])
  })

  it('剥离 ```json fence', () => {
    const raw = '```json\n{"commands":[{"name":"x","command":"go run .","cwd":"","why":""}]}\n```'
    expect(parseProposals(raw, ctx([])).length).toBe(1)
  })

  it('cwd 必须在 tree 里（目录以 / 结尾），否则整条丢弃', () => {
    const raw = JSON.stringify({
      commands: [
        { name: 'a', command: 'mvn', cwd: 'api', why: '' },        // tree 里有 api/ → 保留
        { name: 'b', command: 'mvn', cwd: 'ghost', why: '' },      // 不在 tree → 丢弃
      ],
    })
    const out = parseProposals(raw, ctx(['api/', 'api/pom.xml']))
    expect(out.map((p) => p.name)).toEqual(['a'])
  })

  it('cwd 为 . 归一为根空串', () => {
    const raw = JSON.stringify({ commands: [{ name: 'a', command: 'make', cwd: '.', why: '' }] })
    expect(parseProposals(raw, ctx([]))[0].cwd).toBe('')
  })

  it('缺 name 或 command 的条目丢弃', () => {
    const raw = JSON.stringify({
      commands: [{ name: '', command: 'x', cwd: '', why: '' }, { name: 'y', command: '', cwd: '', why: '' }],
    })
    expect(parseProposals(raw, ctx([]))).toEqual([])
  })

  it('去重相同 name+command+cwd', () => {
    const raw = JSON.stringify({
      commands: [
        { name: 'a', command: 'x', cwd: '', why: '' },
        { name: 'a', command: 'x', cwd: '', why: '重复' },
      ],
    })
    expect(parseProposals(raw, ctx([])).length).toBe(1)
  })

  it('非 JSON → 返回 []，不抛', () => {
    expect(parseProposals('抱歉我无法回答', ctx([]))).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试看失败**

Run: `npx vitest run src/lib/deepseek.test.ts 2>&1 | tail -10`
Expected: FAIL —— `parseProposals` 未导出 / 不存在。

- [ ] **Step 3: 实现 parseProposals**

`src/lib/deepseek.ts` 顶部 import 加上类型：

```ts
import type { Command, ProjectContext, Proposal } from './types'
```

在 `stripFences` 函数下方新增并导出：

```ts
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
  // tree 里以 / 结尾的是目录,去掉尾斜杠得到合法 cwd 集合
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
```

- [ ] **Step 4: 跑测试看通过**

Run: `npx vitest run src/lib/deepseek.test.ts 2>&1 | tail -10`
Expected: 7 passed。

- [ ] **Step 5: Commit**

```bash
git add src/lib/deepseek.ts src/lib/deepseek.test.ts
git commit -m "feat(deepseek): parseProposals 纯函数 + 单测（cwd 校验/去重/兜底）"
```

---

## Task 5: proposeCommands（缓存 + 调用）

**Files:**
- Modify: `src/lib/deepseek.ts`（追加 hash + proposeCommands）

- [ ] **Step 1: 加内容哈希 + proposeCommands**

`src/lib/deepseek.ts` 末尾追加：

```ts
// ── AI 提议命令 ────────────────────────────────────────────
/// djb2 字符串哈希(无需加密强度,仅作缓存键)。
function digest(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function proposeCacheKey(ctx: ProjectContext): string {
  const { model } = useSettings.getState().deepseek
  const sig = ctx.root + ' ' + ctx.tree.join('|') + ' ' +
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
```

- [ ] **Step 2: 类型检查 + 既有测试回归**

Run: `npx tsc -b 2>&1 | tail -5 && npx vitest run 2>&1 | tail -5`
Expected: 无类型错误；全部测试 passed（新增 7 + 既有 22 = 29）。

- [ ] **Step 3: Commit**

```bash
git add src/lib/deepseek.ts
git commit -m "feat(deepseek): proposeCommands 喂上下文提议命令（内容哈希缓存）"
```

---

## Task 6: AiProposeModal 提议清单弹窗

**Files:**
- Create: `src/components/AiProposeModal.tsx`
- Modify: `src/App.css`（追加样式）

- [ ] **Step 1: 写 AiProposeModal 组件**

创建 `src/components/AiProposeModal.tsx`：

```tsx
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { BorderBeam } from './ui/BorderBeam'
import type { Proposal } from '../lib/types'

interface Row extends Proposal {
  checked: boolean
  editing: boolean
}

/// AI 提议命令的确认清单:勾选 + 内联编辑 + why。落地选中项。
export function AiProposeModal({
  proposals,
  onConfirm,
  onCancel,
}: {
  proposals: Proposal[]
  onConfirm: (selected: Proposal[]) => void
  onCancel: () => void
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    proposals.map((p) => ({ ...p, checked: true, editing: false })),
  )
  const patch = (i: number, d: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...d } : r)))
  const selected = rows.filter((r) => r.checked && r.name.trim() && r.command.trim())

  return createPortal(
    <div className="modal" onMouseDown={onCancel}>
      <div className="modal-box ai-propose" onMouseDown={(e) => e.stopPropagation()}>
        <BorderBeam duration={7} />
        <h3>✨ AI 识别到 {proposals.length} 条可运行命令</h3>
        {proposals.length === 0 && (
          <div className="ai-empty">AI 未能从该项目推断出可运行命令。</div>
        )}
        <div className="ai-propose-list">
          {rows.map((r, i) => (
            <div className={'ai-row' + (r.checked ? '' : ' off')} key={i}>
              <label className="ai-row-head">
                <input
                  type="checkbox"
                  checked={r.checked}
                  onChange={(e) => patch(i, { checked: e.target.checked })}
                />
                {r.editing ? (
                  <input
                    className="ai-edit"
                    value={r.name}
                    placeholder="标签"
                    onChange={(e) => patch(i, { name: e.target.value })}
                  />
                ) : (
                  <span className="ai-row-name">{r.name}</span>
                )}
                <button
                  type="button"
                  className="ai-edit-btn"
                  onClick={(e) => {
                    e.preventDefault()
                    patch(i, { editing: !r.editing })
                  }}
                >
                  {r.editing ? '完成' : '✎'}
                </button>
              </label>
              {r.editing ? (
                <div className="ai-edit-fields">
                  <input
                    className="ai-edit"
                    value={r.command}
                    placeholder="命令"
                    onChange={(e) => patch(i, { command: e.target.value })}
                  />
                  <input
                    className="ai-edit"
                    value={r.cwd}
                    placeholder="cwd（相对根，空=根目录）"
                    onChange={(e) => patch(i, { cwd: e.target.value })}
                  />
                </div>
              ) : (
                <div className="ai-row-cmd">
                  <code>{r.command}</code>
                  <span className="ai-row-cwd">{r.cwd || '（根目录）'}</span>
                </div>
              )}
              {r.why && <div className="ai-row-why">为什么：{r.why}</div>}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button
            className="modal-btn primary"
            disabled={selected.length === 0}
            onClick={() => onConfirm(selected.map(({ name, command, cwd, why }) => ({ name, command, cwd, why })))}
          >
            落地选中 {selected.length} 条
          </button>
          <button className="modal-btn ghost" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
```

- [ ] **Step 2: 追加样式到 App.css**

`src/App.css` 末尾追加：

```css
/* AI 提议清单弹窗 */
.modal-box.ai-propose { width: min(560px, 92vw); }
.ai-empty { padding: 16px 4px; color: var(--muted, #8a8a8a); font-size: 13px; }
.ai-propose-list { max-height: 52vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin: 8px 0; }
.ai-row { border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 8px 10px; }
.ai-row.off { opacity: 0.45; }
.ai-row-head { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.ai-row-name { font-weight: 600; font-size: 13px; }
.ai-edit-btn { margin-left: auto; background: none; border: none; color: var(--muted, #8a8a8a); cursor: pointer; font-size: 12px; }
.ai-row-cmd { display: flex; align-items: baseline; gap: 8px; margin-top: 4px; }
.ai-row-cmd code { font-family: 'JetBrains Mono Variable', monospace; font-size: 12px; }
.ai-row-cwd { color: var(--muted, #8a8a8a); font-size: 11px; }
.ai-row-why { margin-top: 4px; color: var(--muted, #8a8a8a); font-size: 11px; line-height: 1.4; }
.ai-edit-fields { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.ai-edit { width: 100%; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 4px 8px; color: inherit; font-size: 12px; }
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc -b 2>&1 | tail -5`
Expected: 无类型错误。

- [ ] **Step 4: Commit**

```bash
git add src/components/AiProposeModal.tsx src/App.css
git commit -m "feat(ui): AiProposeModal 提议清单弹窗（勾选+内联编辑+why）"
```

---

## Task 7: DirNode wiring + ✨ 小标

**Files:**
- Modify: `src/components/Sidebar.tsx`（DirNode 接 projectId、按钮、落地；CmdRow 显示 origin；DirNode 调用处传 p.id）

- [ ] **Step 1: 给 DirNode 传 projectId**

`src/components/Sidebar.tsx` 中现有的 `<DirNode key={d.id} path={d.path} ... />` 调用（约 :124-141），**只新增一行 `projectId={p.id}`**（建议加在 `key={d.id}` 之后），其余所有 props（`path` / `onRun` / `onView` / `onOpenTerminal` / `onOpenVscode` / `runningLabels` / 含 askConfirm 的 `onRemove`）一律保持不动。

`DirNode` 函数签名与解构加 `projectId`：

```tsx
function DirNode({
  projectId,
  path,
  onRun,
  onView,
  onOpenTerminal,
  onOpenVscode,
  runningLabels,
  onRemove,
}: {
  projectId: string
  path: string
  onRun: RunFn
  onView: (label: string) => void
  onOpenTerminal: (cwd: string) => void
  onOpenVscode: (path: string) => void
  runningLabels: Set<string>
  onRemove?: () => void
}) {
```

- [ ] **Step 2: DirNode 引入依赖 + AI 识别状态**

`Sidebar.tsx` 顶部 import 补充：

```tsx
import { collectContext } from '../lib/ipc'
import { smartGroup, explainCommand, proposeCommands } from '../lib/deepseek'
import { AiProposeModal } from './AiProposeModal'
import type { Command, ScanResult, CommandEntry, Proposal } from '../lib/types'
```

> 注：`scanDir, watchDir, unwatchDir` 原本从 `'../lib/ipc'` 导入，合并 import 行即可；`Proposal` 加入 types 导入。

`DirNode` 内、与 `useStore` 取用并列处加（用于落地）：

```tsx
  const addManualCommand = useStore((s) => s.addManualCommand)
  const [proposing, setProposing] = useState(false)
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [proposeErr, setProposeErr] = useState('')

  const runAiRecognize = async () => {
    setProposing(true)
    setProposeErr('')
    try {
      const ctx = await collectContext(path)
      const list = await proposeCommands(ctx)
      setProposals(list)
    } catch (e) {
      setProposeErr(e instanceof Error ? e.message : String(e))
    } finally {
      setProposing(false)
    }
  }

  // 把相对 cwd 解析为绝对路径(空=绑定根)。
  const joinCwd = (rel: string) => {
    const r = rel.trim().replace(/^\.?\/?/, '')
    if (!r) return path
    return `${path.replace(/\/+$/, '')}/${r}`
  }

  const landProposals = (selected: Proposal[]) => {
    for (const p of selected) {
      addManualCommand(projectId, p.name, joinCwd(p.cwd), p.command, 'ai')
    }
    setProposals(null)
  }
```

- [ ] **Step 3: 工具条加「✨ 让 AI 识别」按钮 + 错误 + 弹窗挂载**

`DirNode` 的 `dir-toolbar` 区块（现有 AI 智能分组按钮所在 div）里，在智能分组按钮**之后**追加 AI 识别按钮；注意 `dir-toolbar` 当前条件是 `configured && commands.length > 0`，需放宽为 `configured` 也显示识别按钮（空手时正是要用它）。改为：

```tsx
          {configured && (
            <div className="dir-toolbar">
              {commands.length > 0 && (
                <button
                  className={'ai-btn' + (aiMode ? ' active' : '')}
                  disabled={aiState === 'loading'}
                  onClick={toggleAi}
                  aria-label="用 DeepSeek 智能重新分组命令"
                >
                  {aiState === 'loading' ? (
                    <>
                      <span className="ai-spinner" /> 分组中…
                    </>
                  ) : aiMode ? (
                    '✨ AI 分组 · 开'
                  ) : (
                    '✨ AI 智能分组'
                  )}
                </button>
              )}
              <button
                className={'ai-btn' + (commands.length === 0 ? ' suggest' : '')}
                disabled={proposing}
                onClick={runAiRecognize}
                aria-label="用 AI 读项目结构,提议可运行命令"
              >
                {proposing ? (
                  <>
                    <span className="ai-spinner" /> AI 识别中…
                  </>
                ) : (
                  '✨ 让 AI 识别'
                )}
              </button>
            </div>
          )}
          {proposeErr && <div className="warn">{proposeErr}</div>}
```

并在 `DirNode` 返回 JSX 末尾（`</div>` 关闭 `.dir` 前）挂载弹窗：

```tsx
      {proposals !== null && (
        <AiProposeModal
          proposals={proposals}
          onConfirm={landProposals}
          onCancel={() => setProposals(null)}
        />
      )}
```

- [ ] **Step 4: CmdRow 显示 ✨ 小标 + 手动命令传 origin**

`CmdRow` 加可选 `origin` prop 并渲染小标。签名加 `origin`：

```tsx
function CmdRow({
  display,
  command,
  source,
  origin,
  running,
  onRun,
  onView,
  onEdit,
  onRemove,
}: {
  display: string
  command: string
  source?: string
  origin?: 'ai'
  running: boolean
  onRun: () => void
  onView?: () => void
  onEdit?: () => void
  onRemove?: () => void
}) {
```

在 `cmd-name` span 之后、`source` 之前加：

```tsx
        {origin === 'ai' && <span className="cmd-ai-tag" title="AI 识别">✨</span>}
```

手动命令渲染处（`p.manualCommands.map((m) => <CmdRow ... />)`）加 `origin={m.origin}`：

```tsx
                  <CmdRow
                    key={m.id}
                    display={m.label}
                    command={`${m.command} · ${m.cwd}`}
                    origin={m.origin}
                    running={runningLabels.has(m.label)}
                    onRun={() => onRun(m.label, m.cwd, m.command)}
                    onView={() => viewRun(m.label)}
                    onEdit={() => setPending({ kind: 'manual-edit', projectId: p.id, cmd: m })}
                    onRemove={() =>
                      askConfirm({
                        title: `删除手动命令「${m.label}」?`,
                        confirmText: '删除',
                        onConfirm: () => removeManualCommand(p.id, m.id),
                      })
                    }
                  />
```

`src/App.css` 末尾加 ✨ 小标样式：

```css
.cmd-ai-tag { font-size: 10px; margin-left: 2px; opacity: 0.85; }
```

- [ ] **Step 5: 类型检查 + 全量测试回归**

Run: `npx tsc -b 2>&1 | tail -5 && npx vitest run 2>&1 | tail -5`
Expected: 无类型错误；29 passed。

- [ ] **Step 6: Commit**

```bash
git add src/components/Sidebar.tsx src/App.css
git commit -m "feat(sidebar): DirNode「让 AI 识别」按钮 + 提议落地 + ✨ 小标"
```

---

## Task 8: 全量验证 + 实机验收准备

- [ ] **Step 1: 全量测试 + 编译**

Run:
```bash
npx vitest run 2>&1 | tail -5
cd src-tauri && cargo test 2>&1 | tail -5 && cargo build 2>&1 | tail -3
```
Expected: 前端 29 passed；Rust 全 passed（含 6 个新 context 测试）；cargo build 无错误。

- [ ] **Step 2: lint**

Run: `npm run lint 2>&1 | tail -10`
Expected: 无新增 error（既有 warning 不阻塞）。

- [ ] **Step 3: 实机验收清单（交用户在 `npm run tauri dev` 里点）**

- 绑定一个含**嵌套 Java 多模块**的目录（如 `gyj-city-service.../backend/java-api`），L1 应空手；点「✨ 让 AI 识别」→ 弹窗应提议 `mvn spring-boot:run` 且 cwd 指向 `gyj_admin/ch_backend`。
- 勾选/取消勾选、编辑某条 command/cwd、落地 → 出现在「手动」区带 ✨ 小标，`命令 · cwd` 显示嵌套绝对路径。
- 落地的命令点击可正常运行（在正确 cwd）。
- 未配置 DeepSeek key 时「✨ 让 AI 识别」不显示，L1 正常。
- 含 `.env` 的项目识别后，确认 DeepSeek 请求体不含 .env 内容（可在 devtools network 或后端日志侧验，spec 已有 Rust 单测兜底）。

- [ ] **Step 4: 收尾 commit（如有 lint 修复）**

```bash
git add -A
git commit -m "chore: L2 AI 识别命令收尾（lint/微调）"
```

---

## 自检对照（spec 覆盖）

- spec §4 五单元 → Task 2/4/5/6/7 + Task 1 模型 ✓
- spec §7 collect_context 细则（深度/跳过/白名单/敏感/截断/树上限）→ Task 2 实现 + 6 单测 ✓
- spec §8 parseProposals（fence/校验/cwd/去重/兜底）→ Task 4 + 7 单测 ✓
- spec §8 缓存（内容哈希）→ Task 5 ✓
- spec §9 AiProposeModal（勾选/编辑/why/空态/N 计数）→ Task 6 ✓
- spec §10 wiring（按钮、configured 门控、空手更醒目、归属 projectId、joinCwd）→ Task 7 ✓
- spec §3 confirmBeforeRun 不强制（落地走普通 addManualCommand）→ Task 7 landProposals ✓
- spec §13 非目标（L1 不动 / 复用 manualCommands / 不自动触发）→ 全程遵守 ✓
