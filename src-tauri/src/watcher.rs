//! 绑定目录的 package.json 文件监听:变更(防抖)后 emit `pkg-changed`,前端按 path 匹配重扫。
//!
//! 设计要点:
//! - 监听**目录**(非递归)而非 package.json 文件本身。编辑器/工具常用 atomic-save(写临时文件
//!   再 rename 覆盖),这会换掉 package.json 的 inode——直接 watch 文件会在第一次保存后失效。
//!   watch 目录则始终有效,事件里再挑 `package.json`。非递归避免递归进 node_modules/.git 炸资源。
//! - 防抖交给 notify-debouncer-full(自带 timeout 合并 + rename from/to 配对),不手写 sleep。
//! - 生命周期:引用计数。前端 DirNode 挂载 watch / 卸载 unwatch;同一 path 多次绑定(或 React
//!   StrictMode 双挂载)只起一个 watcher,refcount 归 0 时 drop debouncer——drop 即停监听线程,无孤儿。

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 防抖窗口:编辑器一次保存常爆出多个 fs 事件,300ms 内合并成一次重扫。
const DEBOUNCE_MS: u64 = 300;
/// 前端 listen 的事件名(Tauri 事件名禁含 '.',用连字符)。
const EVENT: &str = "pkg-changed";

type Deb = Debouncer<RecommendedWatcher, RecommendedCache>;

struct Entry {
    /// 持有 = 持续监听;drop 即停。下划线前缀表示只为生命周期持有,不直接读。
    _debouncer: Deb,
    refcount: usize,
}

#[derive(Default)]
pub struct WatchRegistry {
    inner: Mutex<HashMap<String, Entry>>,
}

#[derive(Clone, serde::Serialize)]
struct PkgChanged {
    path: String,
}

impl WatchRegistry {
    /// 开始监听 `path` 下的 package.json。已在监听则只加引用计数。
    pub fn watch(&self, app: AppHandle, path: String) -> Result<(), String> {
        let mut map = self.inner.lock().unwrap();
        if let Some(e) = map.get_mut(&path) {
            e.refcount += 1;
            return Ok(());
        }
        let dir = Path::new(&path);
        if !dir.is_dir() {
            return Err("目录不存在".into());
        }

        let emit_path = path.clone();
        let mut debouncer = new_debouncer(
            Duration::from_millis(DEBOUNCE_MS),
            None, // tick rate:None = 自动取 timeout 的 1/4
            move |res: DebounceEventResult| {
                let Ok(events) = res else { return };
                let hit = events.iter().any(|e| {
                    e.event
                        .paths
                        .iter()
                        .any(|p| p.file_name().is_some_and(|n| n == "package.json"))
                });
                if hit {
                    let _ = app.emit(
                        EVENT,
                        PkgChanged {
                            path: emit_path.clone(),
                        },
                    );
                }
            },
        )
        .map_err(|e| e.to_string())?;

        debouncer
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;

        map.insert(
            path,
            Entry {
                _debouncer: debouncer,
                refcount: 1,
            },
        );
        Ok(())
    }

    /// 解除一次引用。归 0 时 drop debouncer(停监听)。重复 unwatch 同一已停 path 是安全 no-op。
    pub fn unwatch(&self, path: &str) {
        let mut map = self.inner.lock().unwrap();
        if let Some(e) = map.get_mut(path) {
            e.refcount = e.refcount.saturating_sub(1);
            if e.refcount == 0 {
                map.remove(path);
            }
        }
    }
}
