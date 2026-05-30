mod commands;
mod config;
mod git;
mod identity;
mod ledger;
mod reconcile;
mod runner;
mod scanner;
mod types;

use tauri::menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WindowEvent};

/// 强制整个 app 为深色外观(NSAppearance = darkAqua)。
/// 全屏时系统菜单栏(顶部 Apple/应用菜单条)的外观跟随 NSApp.appearance——
/// 不强制就会跟随系统浅色,与 Quay 的深色玻璃 UI 割裂。系统菜单栏无法自绘,这是唯一对齐手段。
#[cfg(target_os = "macos")]
fn force_dark_appearance() {
    use objc2_app_kit::{NSAppearance, NSAppearanceNameDarkAqua, NSApplication};
    use objc2_foundation::MainThreadMarker;
    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    let appearance = unsafe { NSAppearance::appearanceNamed(NSAppearanceNameDarkAqua) };
    app.setAppearance(appearance.as_deref());
}

/// 开启 AppKit 原生「按背景拖动窗口」(等价 Electron 的 -webkit-app-region: drag,纯原生、零 IPC)。
/// 背景:Tauri 的 `data-tauri-drag-region` 是 JS+IPC(每次 mousedown 调 startDragging IPC),命中
/// 上游 bug #12597——拖完窗口后 IPC 卡几秒,导致放手即拖不动、循环。原生 movableByWindowBackground
/// 由 AppKit 直接处理 mousedown→拖窗、不经 IPC,故免疫。代价:整个 webview 背景都可拖窗
/// (WKWebView 无法按区域排除),故必须移除会与拖窗冲突的内容拖拽手势(如侧栏分栏条 Resizer)。
#[cfg(target_os = "macos")]
fn enable_native_window_drag(window: &tauri::WebviewWindow) {
    use objc2_app_kit::NSWindow;
    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    let ns_window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
    ns_window.setMovableByWindowBackground(true);
}

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
        // 🔔 原生通知:命令在后台跑完时提醒(前端在窗口失焦时发)
        .plugin(tauri_plugin_notification::init())
        .manage(runner::Registry::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                force_dark_appearance();
                // 原生窗口拖动(绕开 data-tauri-drag-region 的 IPC 卡顿 #12597)。
                // 配套:已移除侧栏分栏条拖拽,避免内容拖拽手势与原生拖窗冲突。
                if let Some(win) = app.get_webview_window("main") {
                    enable_native_window_drag(&win);
                }
            }

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

            // ── 原生应用菜单栏(macOS):标准 系统/编辑/窗口 菜单 + 自定义快捷键 ──
            // 自定义项发 emit 给前端处理(事件名禁含 '.',用连字符)。
            let settings_item = MenuItemBuilder::with_id("menu-open-settings", "设置…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let clear_item = MenuItemBuilder::with_id("menu-clear-term", "清屏当前终端")
                .accelerator("CmdOrCtrl+K")
                .build(app)?;
            let toggle_sidebar_item =
                MenuItemBuilder::with_id("menu-toggle-sidebar", "显示/隐藏侧栏")
                    .accelerator("CmdOrCtrl+B")
                    .build(app)?;

            // App 菜单(macOS 第一项,系统自动用 app 名作标题):关于/设置/隐藏/退出
            let app_menu = SubmenuBuilder::new(app, "Quay")
                .about(None)
                .separator()
                .item(&settings_item)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            // 编辑菜单:标准 撤销/重做/剪切/复制/粘贴/全选(对设置面板输入框生效)
            let edit_menu = SubmenuBuilder::new(app, "编辑")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            // 视图菜单:清屏 / 切侧栏(自定义)
            let view_menu = SubmenuBuilder::new(app, "视图")
                .item(&clear_item)
                .item(&toggle_sidebar_item)
                .build()?;
            // 窗口菜单:标准 最小化/缩放
            let window_menu = SubmenuBuilder::new(app, "窗口")
                .minimize()
                .maximize()
                .build()?;

            let app_menu_bar = MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
                .build()?;
            app.set_menu(app_menu_bar)?;
            // 自定义菜单项 → emit 给前端(标准 role 项由系统直接处理,不会进这里)
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id.starts_with("menu-") {
                    let _ = app.emit(id, ());
                }
            });
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
            commands::close_command,
            commands::resize_run,
            commands::replay,
            commands::open_devtools,
            commands::list_runs,
            commands::attach_run,
            commands::runs_memory,
            commands::list_orphans,
            commands::kill_orphan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Quay");
}
