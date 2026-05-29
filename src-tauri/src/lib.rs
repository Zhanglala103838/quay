mod commands;
mod config;
mod identity;
mod ledger;
mod reconcile;
mod runner;
mod scanner;
mod types;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 🟠 单实例:第二个实例聚焦已有窗口,防两份台账互抢
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(runner::Registry::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 托盘:点菜单切换主窗口显隐 / 退出
            let quit = MenuItem::with_id(app, "quit", "退出 Quay", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "打开 Quay", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        // 关窗口 = 隐藏到托盘(后端不退,子进程继续活,天然无孤儿)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_dir,
            commands::get_config,
            commands::set_config,
            commands::run_command,
            commands::stop_command,
            commands::replay,
            commands::list_orphans,
            commands::kill_orphan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Quay");
}
