use crate::runner::{Registry, RunEvent};
use crate::types::*;
use crate::{config, reconcile, runner, scanner};
use tauri::ipc::Channel;
use tauri::State;

#[tauri::command]
pub fn scan_dir(path: String) -> ScanResult {
    scanner::scan_directory(&path)
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
    on_event: Channel<RunEvent>,
) -> Result<u32, String> {
    // 把 Tauri Channel 包成通用 sink,runner 不直接依赖 Channel(便于测试)。
    let sink: runner::Sink = std::sync::Arc::new(move |e: RunEvent| {
        let _ = on_event.send(e);
    });
    runner::spawn_run(&reg, run_id, label, cwd, command, sink)
}

#[tauri::command]
pub fn stop_command(reg: State<Registry>, run_id: String) -> Result<(), String> {
    runner::stop_run(&reg, &run_id)
}

#[tauri::command]
pub fn replay(reg: State<Registry>, run_id: String) -> String {
    runner::replay_ring(&reg, &run_id)
}

#[tauri::command]
pub fn list_orphans() -> Vec<reconcile::Orphan> {
    reconcile::find_orphans()
}

#[tauri::command]
pub fn kill_orphan(pgid: i32) {
    reconcile::kill_orphan(pgid);
}
