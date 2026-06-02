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
    port_listener(port).map(|(pid, process)| PortBusy { port, pid, process })
}

/// 用 lsof 查谁在 LISTEN 这个端口(取第一个)。lsof 缺失/端口空闲 → None。
/// -F pcn 按字段分行:p<pid> c<命令名> n<地址>。
fn port_listener(port: u16) -> Option<(u32, String)> {
    let output = std::process::Command::new("lsof")
        .args([
            "-nP",
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
            "-F",
            "pcn",
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut pid: Option<u32> = None;
    let mut name = String::new();
    for line in text.lines() {
        match line.split_at(1) {
            ("p", v) => pid = v.parse().ok(),
            ("c", v) => name = v.to_string(),
            _ => {}
        }
        if pid.is_some() && !name.is_empty() {
            break;
        }
    }
    pid.map(|p| (p, name))
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
