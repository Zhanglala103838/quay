# 聚合命令组（Command Group）设计

> 状态：已批准 · 2026-06-02 · 分支 feat/ai-command-recognition

## 1. 问题 / 目标

控制塔现在「一条命令 = 一个终端 tab」，没有「把几条命令打包成一组、一键一起跑」的能力。
用户需要在**手动/AI 命令区**新增一个**聚合模式**：挑选几条命令组成一组，一键一起执行。

## 2. 已确认的决策

| 维度 | 决策 |
|------|------|
| 执行语义 | **并行 · 各开各的 tab**（一键同时启动，每条仍在自己 cwd 开独立终端 tab） |
| 成员范围 | **手动/AI 命令 + 扫描命令** 都可选入 |
| 成员存储 | **快照**（self-contained `{label, cwd, command}`），非引用 |
| 已运行成员 | 一键全跑时**跳过**已在运行的成员，避免撞 EADDRINUSE |
| 放置位置 | **项目级**手动/AI 区（成员跨目录、并行，不挂单个目录） |

### 2.1 为什么快照而非引用

扫描命令来自 `scan_dir` 动态结果，**没有稳定 ID**（rename / 删 script 即丢）；手动命令也可能被删。
引用会产生悬空指针。快照让组永远可跑、自包含。
**代价**：之后编辑某条手动命令的文本，组里旧快照不会自动跟变——需「编辑组」重选。符合「打包成一捆」的心智，可接受。

## 3. 数据模型

### 3.1 前端（src/lib/types.ts）

```ts
export interface GroupMember { label: string; cwd: string; command: string }
export interface CommandGroup { id: string; name: string; members: GroupMember[] }
export interface Project {
  id: string
  name: string
  directories: Directory[]
  manualCommands: CommandEntry[]
  commandGroups: CommandGroup[]   // 新增
}
```

### 3.2 Rust（src-tauri/src/types.rs）—— 必须同步

**关键约束**：Rust `Project` 是强类型 struct，无 catch-all。前端若只加 `commandGroups`，
会在 `get_config` / `set_config` 往返时被 serde **静默丢弃**、落不了盘。所以必须同步加 Rust 类型。

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMember {
    pub label: String,
    pub cwd: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub members: Vec<GroupMember>,
}

// Project 新增字段:
//   #[serde(default, rename = "commandGroups")]
//   pub command_groups: Vec<CommandGroup>,
```

`GroupMember` 字段名 `label/cwd/command` 全小写、TS/Rust 一致，无需 rename。
`commandGroups` 用 `#[serde(default)]` → 旧 config 读出 `[]`，向后兼容。

## 4. Store 动作（src/state/store.ts）

沿用现有 `structuredClone(get().config)` → 改 → `set` → `get().persist()` 模式。

- `addCommandGroup(pid, name, members)` —— push `{ id: uuid(), name, members }`
- `updateCommandGroup(pid, gid, name, members)` —— 改名 + 换成员
- `removeCommandGroup(pid, gid)` —— filter 删除

类型声明加进 `Store` interface。渲染处对 `p.commandGroups` 用 `?? []` 兜底（防极旧 config）。

## 5. 执行（src/App.tsx + Sidebar）

新增 `runGroup(group: CommandGroup)`：

```
对 group.members 逐条:
  若 runningLabels.has(member.label) → 跳过(计数 skipped)
  否则 onRun(member.label, member.cwd, member.command)(计数 started)
启动后 toast: `组「name」: 已启动 {started} · 跳过 {skipped} 运行中`(skipped>0 才提跳过)
```

`onRun` 非阻塞 → 逐条 fire 即并行，各开各的 tab。
`runGroup` 在 App.tsx 定义并经 props 传到 Sidebar（与 `onRun` 同路径）。

## 6. UI

### 6.1 入口

项目工具条 `project-actions` 在 `+目录 / +命令` 旁加 **`+组`** pill 按钮 →
`setPending({ kind: 'group', projectId })`。

### 6.2 组渲染（项目级）

在 orphanManual 区附近新增「组」category 块，每组一行 `GroupRow`：

- ⚡ 图标 + 组名 + `n` 条徽标
- 单击 = 一键全跑（`runGroup`）
- 展开 caret → 只读列出成员（`label · cwd`）
- ✎ 编辑（重开选择器，预填）
- 删除（askConfirm）
- 若有成员运行中 → 显示「运行中 k/n」

### 6.3 新建/编辑弹窗 `CommandGroupModal`（新组件）

现有 `InputModal` 是字段表单，做不了多选清单，故新建组件。

打开时：
1. 对项目所有绑定目录并发 `scanDir(path)`
2. 合并候选 = 扫描命令 + 手动/AI 命令，按目录分组：
   - 扫描：`{ label: `${dirName}:${name}`, cwd: dirPath, command }`
   - 手动/AI：`{ label: m.label, cwd: m.cwd, command: m.command }`
   - 按 (label+cwd+command) 去重
3. 渲染：组名输入框 + 按目录分组的可勾选清单 + 已选计数
4. 编辑态预填组名 + 勾选已有成员（按 label+cwd+command 匹配）
5. 保存 → `addCommandGroup` / `updateCommandGroup`（空名或零成员禁止保存）

候选构建抽成纯函数 `buildGroupCandidates(manualCommands, scansByDir)` 便于单测。

## 7. 测试

- **单测**：
  - store `addCommandGroup/updateCommandGroup/removeCommandGroup`（若已有 store 测试则对齐，否则纯逻辑断言）
  - `buildGroupCandidates` 合并 + 去重
  - `runGroup` 跳过运行中的过滤
- **实机**：
  - 跨 2 目录建组 → 一键开 N 个 tab
  - 组内含已运行命令 → 跳过、toast 正确
  - reload 后组仍在（Rust 往返保留 `commandGroups`）
  - 编辑组、删除组

## 8. YAGNI（明确不做）

- 顺序/串行执行模式
- 成员排序 / 启动间延时
- 嵌套组
- 引用自动同步（仅快照）

## 9. 涉及文件

- `src/lib/types.ts` —— 新增 GroupMember/CommandGroup + Project 字段
- `src-tauri/src/types.rs` —— 同步 Rust 类型
- `src/state/store.ts` —— 3 个 action + Store 接口
- `src/lib/group.ts`（新）—— `buildGroupCandidates` 纯函数（+ test）
- `src/components/CommandGroupModal.tsx`（新）
- `src/components/Sidebar.tsx` —— `+组` 入口 + GroupRow + 弹窗挂载 + runGroup 透传
- `src/App.tsx` —— `runGroup` 定义 + 传入 Sidebar
- `src/App.css` / 相关样式 —— 组行样式
