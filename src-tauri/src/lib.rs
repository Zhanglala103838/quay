mod commands;
mod config;
mod context;
mod git;
mod identity;
mod ledger;
mod platform;
mod reconcile;
mod runner;
mod scanner;
mod types;
mod watcher;

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

/// 标题栏中段的原生拖拽区:一个透明 NSView 子类,在 `mouseDown:` 里调用官方 API
/// `performWindowDragWithEvent:` 发起标准拖窗(纯原生、零 IPC,免疫上游 bug #12597)。
/// 只铺在标题栏中段,不命中的区域(终端、侧栏、按钮等)正常收事件——xterm 自绘的拖拽选区恢复。
///
/// 为何不用 `mouseDownCanMoveWindow`:它依赖窗口的可拖背景判定,在 `titleBarStyle: Overlay`
/// + 全尺寸内容视图下不可靠(实测标题栏整条拖不动);`performWindowDragWithEvent:` 与
/// `movableByWindowBackground` 无关,显式发起,必然生效。
/// 为何不用整窗 `movableByWindowBackground`:那会把整个 webview 背景都变成拖窗区,
/// WKWebView 无法按区域排除,于是吞掉 xterm 的拖拽选区——正是本次要修的问题。
#[cfg(target_os = "macos")]
use objc2::{define_class, MainThreadOnly};

#[cfg(target_os = "macos")]
define_class!(
    // SAFETY: 超类 NSView 无特殊子类化要求;本类不实现 Drop,不声明 ivars。
    #[unsafe(super(objc2_app_kit::NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "QuayTitlebarDragView"]
    struct TitlebarDragView;

    impl TitlebarDragView {
        // 在本 view 按下即发起标准拖窗(官方 API,不经 IPC、不依赖 movableByWindowBackground)。
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &objc2_app_kit::NSEvent) {
            if let Some(win) = self.window() {
                win.performWindowDragWithEvent(event);
            }
        }
    }
);

/// 在标题栏中段铺设原生拖拽区(替代曾经的整窗 `setMovableByWindowBackground(true)`)。
#[cfg(target_os = "macos")]
fn install_titlebar_drag(window: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSWindow};
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};

    let Some(mtm) = MainThreadMarker::new() else { return };
    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    let ns_window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
    let Some(content) = ns_window.contentView() else { return };

    // 标题栏几何(与 App.css .titlebar 对齐):高 38;左侧让出交通灯(<82)+折叠按钮,
    // 右侧让出设置按钮。中段(含居中品牌)作为拖拽区。
    const TITLEBAR_H: f64 = 38.0;
    const LEFT_INSET: f64 = 104.0;
    const RIGHT_INSET: f64 = 52.0;
    let cf = content.frame();
    let w = (cf.size.width - LEFT_INSET - RIGHT_INSET).max(0.0);
    // 非翻转坐标系原点在左下角,标题栏在顶部 → y = 内容高 - 标题栏高。
    let frame = NSRect::new(
        NSPoint::new(LEFT_INSET, cf.size.height - TITLEBAR_H),
        NSSize::new(w, TITLEBAR_H),
    );

    let drag: Retained<TitlebarDragView> =
        unsafe { msg_send![TitlebarDragView::alloc(mtm), initWithFrame: frame] };
    // 宽度随窗口伸缩、顶部固定(左右内边距固定),无需手动跟踪 resize。
    drag.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewMinYMargin,
    );
    content.addSubview(&drag);
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
        // 📁 原生目录/文件选择器:绑定目录时点「选择目录」拉起 Finder 选文件夹
        .plugin(tauri_plugin_dialog::init())
        .manage(runner::Registry::default())
        .manage(watcher::WatchRegistry::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                force_dark_appearance();
                // 标题栏中段原生拖区(绕开 data-tauri-drag-region 的 IPC 卡顿 #12597,
                // 同时不像整窗 movableByWindowBackground 那样吞掉终端的拖拽选区)。
                if let Some(win) = app.get_webview_window("main") {
                    install_titlebar_drag(&win);
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

            // ── 原生应用菜单栏(macOS only):标准 系统/编辑/窗口 菜单 + 自定义快捷键 ──
            // 自定义项发 emit 给前端处理(事件名禁含 '.',用连字符)。
            // Windows 不挂原生菜单栏:services/hide_others/show_all 等是 mac 专属项,且与自绘
            // 标题栏冲突;设置/清屏/切侧栏在 UI 内仍可点击,故仅缺这几个键盘快捷键。
            #[cfg(target_os = "macos")]
            {
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
            } // end #[cfg(target_os = "macos")] 应用菜单栏
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
            commands::collect_context,
            commands::watch_dir,
            commands::unwatch_dir,
            commands::get_config,
            commands::set_config,
            commands::run_command,
            commands::write_run,
            commands::open_with_app,
            commands::detect_apps,
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
            commands::git_brief,
            commands::git_detail,
            commands::dev_ports,
            commands::dev_port_busy,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Quay")
        .run(|app_handle, event| {
            // macOS:点 Dock 图标(Reopen)→ 恢复隐藏到托盘的主窗口。
            // 关窗口被拦成 hide(见 on_window_event),不处理 Reopen 的话 Dock 点击不会重开窗口,
            // 只能靠托盘菜单「打开 Quay」——这正是用户遇到的现象。
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(w) = app_handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
}
