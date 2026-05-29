use crate::identity;
use crate::ledger::{self, LedgerEntry};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RunEvent {
    Output { chunk: String },
    Exit { code: Option<i32> },
}

/// 输出口抽象:生产环境是 Tauri Channel,测试环境是闭包 sink。
pub type Sink = Arc<dyn Fn(RunEvent) + Send + Sync>;

/// 可重新订阅的输出口(前端 reload 后换新 Channel)。None = 当前无订阅者。
type SinkHolder = Arc<Mutex<Option<Sink>>>;
/// None = 运行中;Some(code) = 已退出。
type ExitHolder = Arc<Mutex<Option<Option<i32>>>>;

pub struct RunHandle {
    #[allow(dead_code)] // 保留备用(诊断/未来按 pid 操作)
    pub pid: u32,
    pub pgid: i32,
    pub label: String,
    pub cwd: String,
    pub command: String,
    pub killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    // 持有 master 保持 PTY 开启(drop 即触发 reader EOF);并用于 resize_run 调整 PTY 尺寸。
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub ring: Arc<Mutex<VecDeque<String>>>,
    pub sink: SinkHolder,
    pub exited: ExitHolder,
}

#[derive(Default)]
pub struct Registry(pub Mutex<HashMap<String, RunHandle>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub run_id: String,
    pub label: String,
    pub cwd: String,
    pub command: String,
    pub status: String, // "running" | "exited"
    pub exit_code: Option<i32>,
}

const RING_MAX: usize = 5000;

/// 🔴 PTY 开 slave 自带 setsid → 子进程成会话/进程组首,pgid==pid,
/// 故 kill(-pgid) 只杀子进程树,绝不误杀 Quay 自己。
pub fn spawn_run(
    reg: &Registry,
    run_id: String,
    label: String,
    cwd: String,
    command: String,
    sink: Sink,
) -> Result<u32, String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // 经登录 shell 跑命令,继承 PATH;PTY 已让多数工具开色,env 兜底。
    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.args(["-lc", &command]);
    cmd.cwd(&cwd);
    cmd.env("FORCE_COLOR", "1");
    cmd.env("CLICOLOR_FORCE", "1");
    cmd.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let pid = child.process_id().unwrap_or(0);
    let pgid = {
        let g = unsafe { libc::getpgid(pid as libc::pid_t) };
        if g > 0 {
            g
        } else {
            pid as i32
        }
    };
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let ring = Arc::new(Mutex::new(VecDeque::<String>::new()));
    let sink_holder: SinkHolder = Arc::new(Mutex::new(Some(sink)));
    let exited: ExitHolder = Arc::new(Mutex::new(None));

    // reader 线程:30ms 定时器主导合并 chunk → 写 ring + 推当前订阅者。
    // 🔴 字节上限是「内存安全阀」而非主刷新触发器:之前 4KB 会把 node/vite/构建器的
    // MB 级突发打散成几百条 IPC 消息(每条都要 JSON 序列化 + 跨桥 + 一次 term.write),
    // 多终端同启时主线程直接卡死。抬到 64KB → 30ms 定时器成为唯一节奏,单终端 IPC
    // 速率封顶 ~33 条/秒;64KB 仅在「单个 30ms 窗口吐超 64KB」时兜底,防单条消息过大。
    let ring_r = ring.clone();
    let holder_r = sink_holder.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut acc = String::new();
        let mut last = Instant::now();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if last.elapsed() >= Duration::from_millis(30) || acc.len() > 65536 {
                        flush(&holder_r, &ring_r, &mut acc);
                        last = Instant::now();
                    }
                }
                Err(_) => break,
            }
        }
        if !acc.is_empty() {
            flush(&holder_r, &ring_r, &mut acc);
        }
    });

    // waiter 线程:退出后标记 exited + 推 Exit + 清台账(进程已死,非孤儿)。
    // 单锁纪律:任意时刻只持一把锁,避免与 attach 死锁。
    let holder_w = sink_holder.clone();
    let exited_w = exited.clone();
    let rid = run_id.clone();
    std::thread::spawn(move || {
        let status = child.wait().ok();
        let code = status.map(|s| s.exit_code() as i32);
        *exited_w.lock().unwrap() = Some(code);
        if let Some(s) = &*holder_w.lock().unwrap() {
            s(RunEvent::Exit { code });
        }
        ledger::remove_entry(&rid);
    });

    ledger::add_entry(LedgerEntry {
        run_id: run_id.clone(),
        pid,
        pgid,
        command: command.clone(),
        cwd: cwd.clone(),
        start_time: identity::process_snapshot(pid)
            .map(|s| s.start_time)
            .unwrap_or(0),
        label: label.clone(),
    });

    reg.0.lock().unwrap().insert(
        run_id,
        RunHandle {
            pid,
            pgid,
            label,
            cwd,
            command,
            killer,
            master: pair.master,
            ring,
            sink: sink_holder,
            exited,
        },
    );
    Ok(pid)
}

/// 锁序固定:先 ring 后 sink(与 attach 一致),防死锁。
fn flush(holder: &SinkHolder, ring: &Arc<Mutex<VecDeque<String>>>, acc: &mut String) {
    let chunk = std::mem::take(acc);
    {
        let mut r = ring.lock().unwrap();
        for line in chunk.split_inclusive('\n') {
            r.push_back(line.to_string());
        }
        while r.len() > RING_MAX {
            r.pop_front();
        }
    }
    if let Some(s) = &*holder.lock().unwrap() {
        s(RunEvent::Output { chunk });
    }
}

/// 前端 reload 后重新订阅:回放 ring 历史 + 续接实时。锁序 ring→sink(同 flush)。
pub fn attach_run(reg: &Registry, run_id: &str, sink: Sink) {
    let map = reg.0.lock().unwrap();
    if let Some(h) = map.get(run_id) {
        let exit_snapshot = *h.exited.lock().unwrap(); // 单独 lock+release,避免与 holder 嵌套
        let ring = h.ring.lock().unwrap(); // ring 先
        let mut holder = h.sink.lock().unwrap(); // sink 后
        let hist: String = ring.iter().cloned().collect();
        if !hist.is_empty() {
            sink(RunEvent::Output { chunk: hist });
        }
        if let Some(code) = exit_snapshot {
            sink(RunEvent::Exit { code });
        }
        *holder = Some(sink);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemStat {
    pub run_id: String,
    pub mem_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemReport {
    /// Quay 主进程 RSS(不含 WKWebView helper 进程,故偏小,仅作参考)。
    pub app_bytes: u64,
    pub runs: Vec<MemStat>,
}

/// 采集内存:每条 running 命令 = 其进程组(pgid)整棵树的 RSS 之和
/// (zsh + node + node 的子进程全算);app = Quay 主进程 RSS。
/// 前端有命令在跑时 ~2s 轮询一次;无 running 不调用。
pub fn runs_memory(reg: &Registry) -> MemReport {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    // 只刷内存(不拉 cmd/exe),全量进程——按 pgid 归并需要看到子进程。
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_memory(),
    );

    let app_pid = std::process::id();
    let app_bytes = sys
        .process(Pid::from_u32(app_pid))
        .map(|p| p.memory())
        .unwrap_or(0);

    // 收集 running run 的 pgid(单独 lock,尽快释放)。
    let running: Vec<(String, i32)> = {
        let map = reg.0.lock().unwrap();
        map.iter()
            .filter(|(_, h)| h.exited.lock().unwrap().is_none())
            .map(|(id, h)| (id.clone(), h.pgid))
            .collect()
    };

    // 把每个进程的 RSS 累加到它所属的进程组。
    let mut by_pgid: HashMap<i32, u64> = HashMap::new();
    for (pid, proc_) in sys.processes() {
        let pg = unsafe { libc::getpgid(pid.as_u32() as libc::pid_t) };
        if pg > 0 {
            *by_pgid.entry(pg).or_insert(0) += proc_.memory();
        }
    }

    let runs = running
        .into_iter()
        .map(|(run_id, pgid)| MemStat {
            run_id,
            mem_bytes: *by_pgid.get(&pgid).unwrap_or(&0),
        })
        .collect();

    MemReport { app_bytes, runs }
}

pub fn list_runs(reg: &Registry) -> Vec<RunInfo> {
    reg.0
        .lock()
        .unwrap()
        .iter()
        .map(|(id, h)| {
            let ex = *h.exited.lock().unwrap();
            RunInfo {
                run_id: id.clone(),
                label: h.label.clone(),
                cwd: h.cwd.clone(),
                command: h.command.clone(),
                status: if ex.is_some() { "exited" } else { "running" }.to_string(),
                exit_code: ex.flatten(),
            }
        })
        .collect()
}

/// 停止:SIGTERM 进程组(负 pgid),killer 兜底。
pub fn stop_run(reg: &Registry, run_id: &str) -> Result<(), String> {
    let mut map = reg.0.lock().unwrap();
    if let Some(h) = map.get_mut(run_id) {
        // SAFETY: 负 pid = 进程组;子进程在自己的新进程组,不波及 Quay
        unsafe {
            libc::kill(-h.pgid, libc::SIGTERM);
        }
        let _ = h.killer.kill();
    }
    map.remove(run_id);
    ledger::remove_entry(run_id);
    Ok(())
}

/// 关掉某个已结束 run 的 tab(从 registry 移除,不发信号)。
pub fn close_run(reg: &Registry, run_id: &str) {
    reg.0.lock().unwrap().remove(run_id);
    ledger::remove_entry(run_id);
}

/// 调整某 run 的 PTY 尺寸,让生产者(webpack/vite 等)按真实显示宽度重排新输出。
/// PTY 初始固定 120×40,但前端 xterm 的实际列数随分屏布局变化;不同步会导致
/// 生产者按 120 列排版、xterm 按显示宽度软折行,两者永远错位。resize 会向进程组发
/// SIGWINCH,多数 TUI/进度条工具据此重绘。run 已退出或尺寸非法时静默忽略。
pub fn resize_run(reg: &Registry, run_id: &str, cols: u16, rows: u16) {
    if cols == 0 || rows == 0 {
        return;
    }
    let map = reg.0.lock().unwrap();
    if let Some(h) = map.get(run_id) {
        let _ = h.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

pub fn replay_ring(reg: &Registry, run_id: &str) -> String {
    reg.0
        .lock()
        .unwrap()
        .get(run_id)
        .map(|h| h.ring.lock().unwrap().iter().cloned().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 核心不变量验证:PTY 子进程必须在独立进程组,
    /// 否则 stop_run 的 kill(-pgid) 会连 Quay 自己一起干掉。
    /// 同时验证:输出能流出 + stop 真能杀死子进程。
    #[test]
    fn child_in_own_process_group_streams_and_stops() {
        let reg = Registry::default();
        let collected = Arc::new(Mutex::new(String::new()));
        let c2 = collected.clone();
        let sink: Sink = Arc::new(move |e: RunEvent| {
            if let RunEvent::Output { chunk } = e {
                c2.lock().unwrap().push_str(&chunk);
            }
        });

        let run_id = "test_pg".to_string();
        let pid = spawn_run(
            &reg,
            run_id.clone(),
            "t".into(),
            "/tmp".into(),
            "echo QUAY_HELLO; sleep 30".into(),
            sink,
        )
        .expect("spawn");

        let my_pgid = unsafe { libc::getpgid(0) };
        let child_pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        assert!(child_pgid > 0, "child pgid should be valid");
        assert_ne!(
            child_pgid, my_pgid,
            "🔴 child MUST be in its own process group"
        );

        std::thread::sleep(Duration::from_millis(400));
        assert!(
            collected.lock().unwrap().contains("QUAY_HELLO"),
            "output should stream through sink"
        );

        stop_run(&reg, &run_id).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            !crate::identity::pid_alive(pid),
            "child should be dead after stop_run"
        );
    }

    /// 重新订阅:reload 后 list_runs 看得到、attach 能回放历史。
    #[test]
    fn reattach_replays_history_to_new_sink() {
        let reg = Registry::default();
        let dummy: Sink = Arc::new(|_| {});
        let run_id = "test_attach".to_string();
        spawn_run(
            &reg,
            run_id.clone(),
            "t".into(),
            "/tmp".into(),
            "echo QUAY_REPLAY; sleep 30".into(),
            dummy,
        )
        .expect("spawn");

        std::thread::sleep(Duration::from_millis(400));

        // list_runs 应看到这个 running 的 run
        let runs = list_runs(&reg);
        assert!(runs.iter().any(|r| r.run_id == run_id && r.status == "running"));

        // 模拟前端 reload:换一个新 sink attach,应收到历史回放
        let got = Arc::new(Mutex::new(String::new()));
        let g2 = got.clone();
        let new_sink: Sink = Arc::new(move |e: RunEvent| {
            if let RunEvent::Output { chunk } = e {
                g2.lock().unwrap().push_str(&chunk);
            }
        });
        attach_run(&reg, &run_id, new_sink);
        assert!(
            got.lock().unwrap().contains("QUAY_REPLAY"),
            "attach should replay ring history to the new sink"
        );

        stop_run(&reg, &run_id).unwrap();
    }
}
