use crate::runner::{Registry, RunEvent};
use crate::types::*;
use crate::{config, context, reconcile, runner, scanner, watcher};
use tauri::ipc::Channel;
use tauri::State;

#[tauri::command]
pub fn scan_dir(path: String) -> ScanResult {
    scanner::scan_directory(&path)
}

/// L2：采集项目上下文(浅递归 + 白名单文件)，喂给前端 AI 提议命令。
#[tauri::command]
pub fn collect_context(path: String) -> context::ProjectContext {
    context::collect_context(&path)
}

/// 开始监听该目录 package.json,变更时后端 emit `pkg-changed`(前端按 path 匹配重扫)。
/// 同一 path 多次调用走引用计数,只起一个 watcher。
#[tauri::command]
pub fn watch_dir(
    app: tauri::AppHandle,
    reg: State<watcher::WatchRegistry>,
    path: String,
) -> Result<(), String> {
    reg.watch(app, path)
}

/// 解除一次监听引用(与 watch_dir 配对)。引用归 0 时真正停监听。
#[tauri::command]
pub fn unwatch_dir(reg: State<watcher::WatchRegistry>, path: String) {
    reg.unwatch(&path);
}

#[tauri::command]
pub fn get_config() -> Config {
    config::load_config()
}

#[tauri::command]
pub fn set_config(cfg: Config) -> Result<(), String> {
    config::save_config(&cfg)
}

/// 某绑定目录声明的 Tauri dev 端口(来自 tauri.conf devUrl)。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPort {
    pub project_id: String,
    pub project_name: String,
    pub path: String,
    pub port: u16,
}

/// 扫描所有已配置目录,收集各自声明的 Tauri dev 端口。
/// 前端据此做"不同项目同端口"静态体检(同端口 ≥2 个不同项目 → 挂警告徽标)。
/// 只返回真有 tauri.conf devUrl 端口的目录,无则跳过(不猜)。
#[tauri::command]
pub fn dev_ports() -> Vec<DevPort> {
    let cfg = config::load_config();
    let mut out = Vec::new();
    for p in &cfg.projects {
        for d in &p.directories {
            if let Some(port) = scanner::dev_url_port(std::path::Path::new(&d.path)) {
                out.push(DevPort {
                    project_id: p.id.clone(),
                    project_name: p.name.clone(),
                    path: d.path.clone(),
                    port,
                });
            }
        }
    }
    out
}

/// 端口被谁占了:pid + 进程名(lsof 实测,系统级,含非 Quay 启动的进程)。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBusy {
    pub port: u16,
    pub pid: u32,
    pub process: String,
}

/// 启动前探测:该 cwd 的 Tauri 项目声明的 dev 端口此刻是否已被占用。
/// 返回 Some → 占用者信息(前端弹一次性确认,防加载到错应用);
/// 返回 None → 没声明端口 / 端口空闲(完全不打扰,这是边界关键)。
#[tauri::command]
pub fn dev_port_busy(cwd: String) -> Option<PortBusy> {
    let port = scanner::dev_url_port(std::path::Path::new(&cwd))?;
    crate::platform::port_listener(port).map(|(pid, process)| PortBusy { port, pid, process })
}

#[tauri::command]
pub fn run_command(
    reg: State<Registry>,
    run_id: String,
    label: String,
    cwd: String,
    command: String,
    interactive: bool,
    on_event: Channel<RunEvent>,
) -> Result<u32, String> {
    // 把 Tauri Channel 包成通用 sink,runner 不直接依赖 Channel(便于测试)。
    let sink: runner::Sink = std::sync::Arc::new(move |e: RunEvent| {
        let _ = on_event.send(e);
    });
    runner::spawn_run(&reg, run_id, label, cwd, command, interactive, sink)
}

/// 把键盘输入写进交互终端的 PTY stdin。
#[tauri::command]
pub fn write_run(reg: State<Registry>, run_id: String, data: String) -> Result<(), String> {
    runner::write_run(&reg, &run_id, &data)
}

/// 经 LaunchServices 按 bundle id 打开某目录(编辑器把它当 workspace 打开;
/// 终端 app —— Terminal/Ghostty/cmux 等均声明了 folder 文档类型 —— 则在该目录开会话)。
/// 无需任何 CLI。按 `bundle_ids` 顺序尝试,命中第一个即成功;一个都没装(或都启动失败)
/// 返回 Err,前端据此弹「未检测到 X」。async = 在线程池跑,`open` 阻塞时不卡 UI 主线程。
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn open_with_app(path: String, bundle_ids: Vec<String>) -> Result<(), String> {
    use std::process::Command;
    for bid in &bundle_ids {
        let ok = Command::new("open")
            .args(["-b", bid, &path])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Ok(());
        }
    }
    Err("未检测到目标应用".into())
}

/// Windows:`bundle_ids` 实为启动 argv(见前端 launchers.win.argv):argv[0]=程序,其余为参数,
/// 字面量 "{dir}" 替换为目标目录。编辑器走 `cmd /c <cli> <dir>`(cli 多为 .cmd 垫片,
/// CreateProcess 不能直接执行,必须经 cmd);终端走 `cmd /c start … <dir>` 在新窗口开会话。
/// platform::command 已挂 CREATE_NO_WINDOW,中转的 cmd 不闪黑框(被启动的编辑器/终端自带窗口)。
#[cfg(windows)]
#[tauri::command]
pub async fn open_with_app(path: String, bundle_ids: Vec<String>) -> Result<(), String> {
    let mut it = bundle_ids.into_iter();
    let program = it.next().ok_or("空启动命令")?;
    let args: Vec<String> = it
        .map(|a| if a == "{dir}" { path.clone() } else { a })
        .collect();
    let status = crate::platform::command(&program)
        .args(&args)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("未检测到目标应用".into())
    }
}

/// 其它平台(Linux):暂不支持按应用打开,优雅降级。
#[cfg(not(any(target_os = "macos", windows)))]
#[tauri::command]
pub async fn open_with_app(_path: String, _bundle_ids: Vec<String>) -> Result<(), String> {
    Err("当前平台暂不支持按应用打开".into())
}

/// 扫描给定 bundle id 哪些已安装,返回已装子集。用 `mdfind`(Spotlight 元数据查询):
/// 只读索引,**绝不启动 app**。这点至关重要 —— 早期版本用 `osascript 'path to application id'`,
/// 在本机会真把被解析到的 todesktop/Electron 应用(Cursor、cmux 等)启动起来(打开设置即弹一堆窗口)。
/// mdfind 命中即返回路径(stdout 非空),未装则 stdout 为空。bundle id 仅含 [A-Za-z0-9.-],无引号注入风险。
/// **设为 async**:本机要顺序 spawn 多达十几个 mdfind 进程,同步 command 会跑在 UI 主线程上把窗口卡住
/// (打开设置时「点击像没生效」)。async command 由 Tauri 丢到线程池跑,主线程不阻塞(同 git_brief 的处理)。
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn detect_apps(bundle_ids: Vec<String>) -> Vec<String> {
    use std::process::Command;
    bundle_ids
        .into_iter()
        .filter(|bid| {
            Command::new("mdfind")
                .arg(format!("kMDItemCFBundleIdentifier == '{bid}'"))
                .output()
                .map(|o| o.status.success() && !o.stdout.is_empty())
                .unwrap_or(false)
        })
        .collect()
}

/// Windows:`bundle_ids` 实为 PATH 探测名(见前端 launchers.win.probe);用 `where <name>`
/// 判断是否在 PATH(code/cursor/wt/powershell/cmd…),返回命中的子集。platform::command 已挂
/// CREATE_NO_WINDOW,逐个 where 不闪黑框。
#[cfg(windows)]
#[tauri::command]
pub async fn detect_apps(bundle_ids: Vec<String>) -> Vec<String> {
    bundle_ids
        .into_iter()
        .filter(|name| {
            crate::platform::command("where")
                .arg(name)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
        .collect()
}

/// 其它平台(Linux):无统一应用探测机制,返回空集(前端显示"未检测到")。
#[cfg(not(any(target_os = "macos", windows)))]
#[tauri::command]
pub async fn detect_apps(_bundle_ids: Vec<String>) -> Vec<String> {
    Vec::new()
}

#[tauri::command]
pub fn stop_command(reg: State<Registry>, run_id: String) -> Result<(), String> {
    runner::stop_run(&reg, &run_id)
}

#[tauri::command]
pub fn close_command(reg: State<Registry>, run_id: String) {
    runner::close_run(&reg, &run_id)
}

/// 前端 fit 出真实列/行后调用,把 PTY 尺寸同步到显示宽度(生产者据此重排新输出)。
#[tauri::command]
pub fn resize_run(reg: State<Registry>, run_id: String, cols: u16, rows: u16) {
    runner::resize_run(&reg, &run_id, cols, rows);
}

#[tauri::command]
pub fn replay(reg: State<Registry>, run_id: String) -> String {
    runner::replay_ring(&reg, &run_id)
}

/// 打开 WebView 开发者工具(右键菜单「检查元素」调用)。
/// `open_devtools()` 方法由 tauri 的 `devtools` feature 门控,已在 Cargo.toml 开启,
/// 故 debug/release 均可用 —— 无条件调用即可。
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// 前端 reload 后:拉回后端仍在跑(及最近退出)的 run 列表。
#[tauri::command]
pub fn list_runs(reg: State<Registry>) -> Vec<runner::RunInfo> {
    runner::list_runs(&reg)
}

/// 前端 reload 后:给已有 run 重新挂一个 Channel(回放历史 + 续接实时)。
#[tauri::command]
pub fn attach_run(reg: State<Registry>, run_id: String, on_event: Channel<RunEvent>) {
    let sink: runner::Sink = std::sync::Arc::new(move |e: RunEvent| {
        let _ = on_event.send(e);
    });
    runner::attach_run(&reg, &run_id, sink);
}

/// 采集内存:app 主进程 RSS + 每条 running 命令的进程组树 RSS。
#[tauri::command]
pub fn runs_memory(reg: State<Registry>) -> runner::MemReport {
    runner::runs_memory(&reg)
}

#[tauri::command]
pub fn list_orphans() -> Vec<reconcile::Orphan> {
    reconcile::find_orphans()
}

#[tauri::command]
pub fn kill_orphan(pgid: i32) {
    reconcile::kill_orphan(pgid);
}

// git 命令设 async：Tauri 在线程池跑，大仓库不阻塞 UI 主线程(区别于同步 scan_dir)。
#[tauri::command]
pub async fn git_brief(path: String) -> crate::git::GitBrief {
    crate::git::git_brief(&path)
}

#[tauri::command]
pub async fn git_detail(path: String, rev: Option<String>) -> crate::git::GitDetail {
    crate::git::git_detail(&path, rev.as_deref().unwrap_or(""))
}
