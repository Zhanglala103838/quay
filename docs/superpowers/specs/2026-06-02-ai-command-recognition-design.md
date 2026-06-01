# L2「AI 识别命令」设计

> 日期：2026-06-02 · 分支：`feat/ai-command-recognition`
> 前置：L1 命令发现引擎（九检测器 + 项目级工具链标识 + PHP 框架识别）已合入 master。

## 1. 背景与目标

Quay 的定位升维：从「AI 辅助的进程码头」→「读得懂每个项目、替你跑起来的 AI 开发指挥官」。
架构铁律：**确定性优先 + AI 增强**，不是 AI 取代。

- **Layer 1（已建）**：`scanner.rs` 九个确定性检测器，快、免费、离线、可靠，覆盖 ~80% 常见项目。核心可用性**不依赖 API key**。
- **Layer 2（本设计）**：当 L1 空手 / 有歧义、或用户主动点「让 AI 识别」时，用已接入的 DeepSeek 读项目结构 + 关键文件，**提议**可运行命令 `{name, command, cwd, why}`，用户**确认后**落为普通命令（可编辑、缓存）。

L2 一举覆盖的存量痛点：
- **嵌套 / monorepo 多模块**（如 `java-api/gyj_admin/ch_backend/pom.xml`，深度 2，需 cwd）—— L1 深度 0 检测不到。
- **冷门启动**（Workerman `php think worker` 等检测器猜不到的）。
- **自定义脚本**。

## 2. 不可违背的铁律（设计约束）

1. **确定性优先，AI 只兜长尾**：不让每次扫描都调 LLM（成本/离线/延迟）；无 API key 时 L1 核心照常可用。L2 **纯手动触发**。
2. **绝不盲跑**：AI 提议的命令必须带「为什么」+ 用户点确认后才能落地；落地前的 review 弹窗 = 安全闸口。绝不盲跑 AI 推断的 shell。
3. **结果缓存、可编辑**；DeepSeek key 仅存本机 localStorage。
4. **隐私边界**：喂给外部 LLM 的文件走白名单制，敏感文件（.env / 密钥 / 凭证）硬跳过，绝不外发。

## 3. 已决策项（brainstorming 结论）

| 决策 | 选定 | 理由 |
|---|---|---|
| 触发模型 | **纯手动 · 按目录** | 每个 DirNode 一个「让 AI 识别」入口；L1 空手/歧义时按钮更醒目。绝不自动调 LLM，成本完全可控（铁律1）。 |
| 确认 UI | **一次性清单 · 勾选 + 内联编辑** | 一个弹窗列全部提议，每条带复选框、why、可改 name/command/cwd，底部「落地选中」。一次决策、可挑可改（铁律2 闸口）。 |
| 落地展示 | **并入「手动」区 + ✨ 小标** | 落为 `project.manualCommands`，复用现有持久化/编辑/删除；`CmdRow` 已显示 `命令 · cwd`，嵌套归属天然可见。AI 来的加 ✨ 小标区分来源。 |
| confirmBeforeRun | **不强制** | 「确认」发生在落地前的 review 一次；落地后即用户确认过的普通命令，与手敲命令一致运行，避免每次跑都二次确认的烦扰。 |

## 4. 架构（5 个隔离单元）

| 单元 | 位置 | 职责 |
|---|---|---|
| `collect_context` | 新增 `src-tauri/src/context.rs` | 有界浅递归 + 白名单文件读取 + 截断 → `ProjectContext` |
| `proposeCommands` | 扩展 `src/lib/deepseek.ts` | 喂 context 给 LLM → 解析 + 校验 + 缓存 → `Proposal[]` |
| `AiProposeModal` | 新增 `src/components/AiProposeModal.tsx` | 提议清单：勾选 + 内联编辑 + why，返回选中项 |
| wiring | `src/components/Sidebar.tsx`（DirNode） | 「让 AI 识别」按钮 → collect → propose → modal → 批量落地 |
| 模型 | `src/lib/types.ts` + `src-tauri/src/types.rs` | `CommandEntry` 加可选 `origin?: 'ai'`（驱动 ✨ 小标） |

**L1 保持不动**：`scan_dir` 仍深度 0、确定性、免 key。`collect_context` 是 L2 独立的「眼睛」，浅递归只为喂 AI，不改 L1 行为（守铁律1）。

## 5. 数据流

```
用户点 DirNode「✨ 让 AI 识别」(仅 configured 时显示，L1 空手时更醒目)
  → invoke collect_context(path)            [Rust 读盘]
  → ProjectContext { root, tree[], files[{relPath, content截断}], detectedSources }
  → proposeCommands(ctx)                     [前端 → DeepSeek，内容哈希缓存]
  → Proposal[] { name, command, cwd(相对 root), why }
  → AiProposeModal 展示 → 用户勾选/编辑 → 「落地选中」
  → 逐条 addManualCommand(projectId, name, join(root, cwd)→绝对, command, origin:'ai')
  → 落入「手动」区，✨ 小标 + cwd 天然可见
```

**cwd 解析**：context 里子目录一律**相对 root 路径**，LLM 提议相对 cwd，前端 `join(boundPath, cwd)` 解析为绝对路径后落库（`manualCommands.cwd` 一向是绝对路径）。避免 LLM 编造绝对路径。提议 cwd 为空/`.` 时即绑定根目录本身。

## 6. 数据结构

### Rust（`context.rs` + `types.rs`）

```rust
// context.rs
pub struct ProjectContext {
    pub root: String,            // 绑定目录绝对路径
    pub tree: Vec<String>,       // 相对 root 的目录/标记文件清单（浅递归结果）
    pub files: Vec<ContextFile>, // 命中白名单的关键文件（截断后内容）
    pub detected_sources: Vec<String>, // 复用 L1 在 root 顶层的探测结果（提示 LLM）
}
pub struct ContextFile {
    pub rel_path: String,        // 相对 root
    pub content: String,         // 截断后内容
    pub truncated: bool,
}
```

```rust
// types.rs — CommandEntry 增量
pub struct CommandEntry {
    pub id: String,
    pub label: String,
    pub cwd: String,
    pub command: String,
    pub long: bool,
    pub confirm_before_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,  // "ai" | None；驱动前端 ✨ 小标
}
```

### 前端（`types.ts`）

```ts
export interface CommandEntry {
  id: string
  label: string
  cwd: string
  command: string
  long?: boolean
  confirmBeforeRun?: boolean
  origin?: 'ai'           // 新增
}
export interface ContextFile { relPath: string; content: string; truncated: boolean }
export interface ProjectContext {
  root: string
  tree: string[]
  files: ContextFile[]
  detectedSources: string[]
}
export interface Proposal { name: string; command: string; cwd: string; why: string }
```

## 7. `collect_context` 行为细则

- **递归**：从 root 起，深度 ≤ 3。
- **跳过目录**：`node_modules`、`vendor`、`target`、`.git`、`dist`、`build`、`.next`、`.venv`、`__pycache__`、`.idea`、`.vscode`、`coverage`。
- **tree**：收集每个未跳过子目录的相对路径，外加命中的标记文件（package.json / pom.xml / Cargo.toml / go.mod / Makefile / docker-compose / composer.json / build.gradle / manage.py / pyproject.toml 等），让 LLM 看清嵌套结构。tree 总条数设上限（如 400 条）防爆。
- **files 白名单**（只读这些文件名 / 模式）：
  `package.json`、`composer.json`、`pom.xml`、`build.gradle`、`build.gradle.kts`、`go.mod`、`Cargo.toml`、`Makefile`、`docker-compose.yml`、`docker-compose.yaml`、`compose.yml`、`manage.py`、`pyproject.toml`、`requirements.txt`、`artisan`、`README`/`README.md`/`README.txt`。
- **硬跳过文件**（即使白名单也不读）：`.env*`、`*.pem`、`*.key`、`id_rsa*`、`*secret*`、`*credential*`、`*.p12`、`*.keystore`。
- **截断**：每文件读取上限 ~8KB（`truncated=true` 标记）；files 总数上限（如 30 个）+ 总字节预算（如 64KB）防止 context 过大烧 token。
- **dirExists 失败**：root 不存在/无权限 → 返回空 `ProjectContext`（tree/files 空），前端据此提示。

## 8. `proposeCommands` 行为细则

- **入参**：`ProjectContext`。**出参**：`Proposal[]`。
- **prompt**：system 说明「你是项目运行专家，根据项目结构和关键文件，提议**可直接运行**的开发/构建/启动命令。每条给 name（中文短标签）、command（完整可执行串）、cwd（相对项目根，根目录用空串）、why（为什么是这条，引用看到的证据）。只提议你有证据支撑的命令，宁缺毋滥。输出严格 JSON」。
- **解析**：抽出**纯函数** `parseProposals(raw: string, ctx: ProjectContext): Proposal[]`：
  - 去 fence（复用 `stripFences`）。
  - 校验每条：name/command 非空；cwd 必须是空串、`.`、或 tree 里出现过的相对目录——**否则整条丢弃**（防 LLM 编造不存在的路径，落地后在不存在目录运行会失败；宁可丢一条也不落坏命令）。why 可空但建议有。
  - 非法/重复（同 name+command+cwd）条目过滤。
- **缓存**：key = `quay.aipropose.v1.${model}.${hash(context 摘要)}`，localStorage，沿用现有「命中即返回、失败降级、写入忽略异常」风格。context 内容没变 → 不重复调 LLM。
- **未配置 key / 调用失败**：抛错，UI 显示错误（与 `smartGroup`/`explainCommand` 一致），不影响 L1。

## 9. `AiProposeModal` 行为细则

- props：`proposals: Proposal[]`、`onConfirm(selected: Proposal[])`、`onCancel()`。
- 每条：复选框（默认勾选）、name、`command · cwd`、why（小字）、编辑入口（内联或弹出小表单改 name/command/cwd）。
- 底部：`[取消]`、`[落地选中 N 条]`（N 随勾选变化；N=0 时禁用）。
- 空提议（LLM 没给出任何命令）：显示「AI 未能从该项目推断出可运行命令」空态。

## 10. wiring（DirNode）

- 在 `DirNode` 工具条增「✨ 让 AI 识别」按钮，仅 `configured` 时显示；L1 `commands.length === 0`（空手）时按钮更醒目（主色/提示文案）。
- 点击：`collect_context(path)` → `proposeCommands(ctx)`（loading 态）→ 打开 `AiProposeModal`。
- 确认：对选中项逐条 `join(path, cwd)` 解析绝对 cwd → `addManualCommand(projectId, name, absCwd, command, origin:'ai')`。
  - **归属**：命令落到**该 DirNode 所属的 project**（不是 activeProject）。当前 `DirNode` 未接收 `projectId`，wiring 要从 `Sidebar` 的 `p.directories.map` 把 `p.id` 透传给 `DirNode`。
  - 注意：`addManualCommand` 当前签名 `(projectId, label, cwd, command)`，需扩展支持可选 `origin`。
- 失败：toast/inline 错误，不崩溃。

## 11. IPC

- `src/lib/ipc.ts` 新增：`export const collectContext = (path: string) => invoke<ProjectContext>('collect_context', { path })`。
- `lib.rs` `invoke_handler` 注册 `commands::collect_context`。

## 12. 测试策略（沿用上分支 TDD 范式）

### Rust（`context.rs` 单测）
- 浅递归深度（深度 3 命中、深度 4 不下钻）。
- 噪声目录跳过（node_modules/vendor/target 不进入）。
- 白名单文件命中读取 + 内容截断标记。
- **`.env` / `*.key` 等敏感文件被排除**（隐私边界硬验证）。
- 嵌套子项目（`a/b/pom.xml`）出现在 tree。
- root 不存在 → 空 context。

### 前端（`parseProposals` 纯函数单测）
- 合法 JSON → Proposal[]。
- 带 ```json fence → 正确剥离。
- 字段缺失（无 name / 无 command）→ 该条丢弃。
- cwd 不在 tree 中且非空/`.` → 整条丢弃。
- 空数组 / 非 JSON → 返回 []（不抛）。

## 13. 非目标（YAGNI）

- 不改 L1 `scan_dir` 行为（仍深度 0）。
- 不做自动触发 / 后台预扫。
- 不引入新的命令持久化模型（复用 `manualCommands`）。
- 不做多 LLM provider 抽象（沿用现有 DeepSeek/OpenAI 兼容端点）。
- 不做提议命令的「一键全部运行」（逐条由用户运行，安全）。

## 14. 实现顺序建议（交 writing-plans 细化）

1. 模型增量（`CommandEntry.origin` 双端 + store `addManualCommand` 扩展）。
2. Rust `collect_context` + 单测 + IPC 注册。
3. 前端 `parseProposals` 纯函数 + 单测，再包成 `proposeCommands`（带缓存）。
4. `AiProposeModal` 组件。
5. DirNode wiring + ✨ 小标展示。
6. 实机验收（嵌套 Java 多模块 / Workerman 场景）。
