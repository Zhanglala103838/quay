# 设计：命令发现引擎（子项目 A）

- 日期：2026-06-01
- 状态：设计待评审
- 范围：本 spec 只覆盖**子项目 A — 多语言命令发现 + 包管理器识别**。子项目 B（AI/终端工具启动器）单独立 spec。

---

## 产品背景（为什么做这个）

**ICP（目标用户）**：同时推进多个项目、且已用 AI agent 写代码的开发者——独立开发者、工作室、AI-first 工程师。这类人一个人并行驱动多个 repo（在 A repo 跑 agent、切到 B repo 起 dev），同时在跑的进程数量远超传统单项目开发。

**北极星**：把 Quay 做成「并行 AI 编程的指挥塔」——一键把命令/agent 丢进任意 repo，一眼看清谁在跑、谁卡住、谁吃内存。

**A 在其中的角色**：桌面票（table stakes）。控制塔必须能启动任意语言的项目，否则只是 npm 脚本启动器。A 不是差异化卖点，但它是一切的基础，必须扎实、正确。

## 要解决的具体问题

当前 `scanner.rs` 只读 `package.json` 的 `scripts`，且前端 `Sidebar.tsx:405/591` **写死 `npm run <name>`**。导致：

1. **包管理器识别错**：pnpm/yarn/bun 项目被用 `npm run` 启动（本仓库自身用 pnpm 即受害）。
2. **非脚本命令看不到**：`pnpm tauri dev` 这种「依赖二进制 + 参数」不在 `scripts{}` 里，无法识别。
3. **非 JS 项目完全裸奔**：cargo / go / make / docker compose / composer / maven / gradle / python 一个都不认。

用户机器实测分布（YAGNI 边界）：package.json 33（锁文件 npm 28 / pnpm 3）、composer 7、python 13、maven 3、make 3、compose 2、cargo 2、go 1。

---

## 架构

### 1. 数据模型

Rust `types.rs` 与 TS `types.ts` 同步：

```
Command {
  name:     String   // 显示名: "dev" / "cargo run" / "make build" / "spring-boot:run"
  command:  String   // 完整执行串: "pnpm run dev" / "cargo run" / "make build"（不再前端拼接）
  source:   String   // 工具链: npm|pnpm|yarn|bun|cargo|go|make|compose|composer|maven|gradle|python
  category: String   // 语义类别: dev|test|build|deploy|data|other；用户自定义名字的命令置 ""，由前端推断
}

ScanResult {
  commands:        Vec<Command>
  dirExists:       bool
  detectedSources: Vec<String>   // 该目录命中的工具链，供 UI 显示 badge；替代旧的 hasPackageJson
}
```

迁移：旧 `Script{name,command}` 全量替换为 `Command`。`hasPackageJson` 的所有消费点改读 `detectedSources`（非空即"可运行"）。

### 2. 检测器注册表（`scanner.rs` 核心重构）

`scan_directory(dir)` 改为依次运行一组检测器，每个检测器：认一种标记文件 → 产出 `Vec<Command>`（自带 `source` + `category`）。合并去重后按 category 排序返回。新增语言 = 新增一个检测器函数，不影响其他检测器。

| 检测器 | 触发标记 | 产出命令（category） |
|---|---|---|
| **npm** | `package.json` | 按锁文件选 pm：`pnpm-lock.yaml`→pnpm / `yarn.lock`→yarn / `bun.lockb`\|`bun.lock`→bun / 否则 npm。每个 script → `<pm> run <name>`。category 置 `""`（脚本名用户自定义，交前端推断） |
| **cargo** | `Cargo.toml` | `cargo run`(dev) / `cargo build`(build) / `cargo test`(test) / `cargo check`(test) / `cargo clippy`(test) |
| **go** | `go.mod` | `go run ./...`(dev) / `go build ./...`(build) / `go test ./...`(test) |
| **make** | `Makefile`\|`makefile` | 解析顶层 target（正则 `^([a-zA-Z0-9_.-]+)\s*:`，排除 `.PHONY` 等以 `.` 开头的伪目标 + 含 `=` 的变量行）→ `make <target>`。category 置 `""`（target 名自定义，交前端推断） |
| **compose** | `docker-compose.yml`\|`docker-compose.yaml`\|`compose.yml`\|`compose.yaml` | `docker compose up`(dev) / `up -d`(dev) / `down`(other) / `logs -f`(other) / `ps`(other) |
| **composer** | `composer.json` | `scripts` 对象 → `composer run <name>`（category 置 `""`，交前端推断）。若同目录存在 `artisan` → 追加 `php artisan serve`(dev) / `php artisan migrate`(data) |
| **maven** | `pom.xml` | `mvn clean install`(build) / `mvn test`(test)。若 pom 含 `spring-boot` → 追加 `mvn spring-boot:run`(dev) |
| **gradle** | `build.gradle`\|`build.gradle.kts` | 有 `gradlew` 用 `./gradlew`，否则 `gradle`：`build`(build) / `test`(test)。含 spring-boot 插件 → `bootRun`(dev) |
| **python** | `manage.py`\|`pyproject.toml` | Django(`manage.py`)→`python manage.py runserver`(dev)/`migrate`(data)/`test`(test)。`pyproject.toml` 含 `[tool.poetry.scripts]`→`poetry run <name>`。兜底：有 `main.py`\|`app.py`→`python <file>`(dev)。**best-effort，识别不出就不产出，不报错** |

通用约束：所有检测器对**缺失/损坏的标记文件**必须返回空 `Vec`、不 panic（沿用现有 `scanner.rs` 对 malformed json 的容错语义）。深度 0，不递归子目录。

### 3. 前端分组（`grouping.ts`）

- **一级按语义类别**分组（`开发/测试/构建/部署/数据/其他`，沿用 `CATEGORY_ORDER`），不按语言。理由：用户心智是"我要启动开发"，跨语言统一。
- 固定约定的命令（cargo/go/compose/maven/gradle/python）由检测器在 Rust 侧直接标注 `category`。
- 用户自定义名字的命令（npm/composer scripts、make targets）`category=""`，前端 `categorize` 用现有 `categoryOf` 正则推断（正则只此一处、留在 TS）。
- 二级前缀子分组逻辑保留（同首段 `:` 前缀 ≥2 收成组）。
- 渲染时命令行尾显示 `source` 小图标/标签（rust/go/php/docker…），让用户一眼知道这条来自哪个工具链。

### 4. 删除写死的 `npm run`

`Sidebar.tsx:405` 与 `:591`：`onRun(label, path, \`npm run ${it.name}\`)` → 改为 `onRun(label, path, it.command)`，直接用检测器拼好的完整命令。

---

## 数据流

```
绑定目录 / package.json 变更
  → watcher 触发 rescan
  → scanner.scan_directory(dir)
      └ 依次跑检测器 → 合并 Command[] + detectedSources[]
  → ScanResult 回传前端
  → grouping.categorize(commands)（按 category 一级分组）
  → Sidebar 渲染（命令带 source 图标）
  → 点击 → onRun(label, cwd, command) → runner 执行完整命令串
```

## 错误处理

- 目录不存在：`dirExists=false`，`commands=[]`，UI 维持现有"目录缺失"提示。
- 标记文件损坏（json/toml 解析失败）：该检测器静默返回空，其他检测器照常。
- 无任何标记文件：`commands=[]`、`detectedSources=[]`，UI 显示"无检测到的命令，可手动添加命令"（沿用现有手动命令入口）。
- 命令本身执行失败：归 runner/终端的既有错误处理，不在本 spec 范围。

## 测试

- `scanner.rs` 单测：每个检测器一组用例——正常标记文件产出预期命令；锁文件矩阵（pnpm/yarn/bun/npm/无锁→npm）；损坏文件返回空；混合目录（如 Cargo.toml + Makefile）合并产出。
- `grouping.test.ts`：带 `category` 的 Command 直接按类别分组；混合 source 在同一类别内共存；前缀子分组不回归。
- 现有 `scanner` 测试改写为新模型（`scripts`→`commands`、断言 `command` 含正确 pm 前缀）。

## 不做（YAGNI / 留给后续）

- 子项目 B：AI/终端工具启动器（含 claude/codex 自动注入）——单独 spec。
- 递归扫描子目录 / monorepo workspace 包发现。
- 自定义检测器配置文件（`quay.toml`）。
- Python 复杂场景（tox/nox/pdm/uv/Makefile 之外的任务系统）——本期只到 Django + poetry + 兜底。
- Taskfile / justfile / Gemfile / Ruby / .NET 等当前机器上没有的工具链。

## 影响文件

- `src-tauri/src/types.rs`（Command / ScanResult）
- `src-tauri/src/scanner.rs`（检测器注册表，核心）
- `src/lib/types.ts`（Command / ScanResult）
- `src/lib/grouping.ts`（按 category 分组，吃 Command）
- `src/components/Sidebar.tsx`（去掉 npm run 写死 + source 图标）
- 测试：`scanner.rs` tests、`grouping.test.ts`
- 排查 `hasPackageJson` 其余消费点（store/Sidebar）一并迁移到 `detectedSources`
