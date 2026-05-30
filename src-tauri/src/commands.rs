use crate::runner::{Registry, RunEvent};
use crate::types::*;
use crate::{config, reconcile, runner, scanner, watcher};
use tauri::ipc::Channel;
use tauri::State;

#[tauri::command]
pub fn scan_dir(path: String) -> ScanResult {
    scanner::scan_directory(&path)
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

/// 用 VSCode 打开某目录。优先经 LaunchServices 按 bundle id 启动(无需安装 `code` CLI);
/// 未注册任何 VSCode bundle(没装)时返回 Err,前端据此弹「未检测到 VSCode」。
#[tauri::command]
pub fn open_in_vscode(path: String) -> Result<(), String> {
    use std::process::Command;
    let open_bundle = |bid: &str| -> bool {
        Command::new("open")
            .args(["-b", bid, &path])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    if open_bundle("com.microsoft.VSCode") || open_bundle("com.microsoft.VSCodeInsiders") {
        Ok(())
    } else {
        Err("未检测到 VSCode".into())
    }
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
