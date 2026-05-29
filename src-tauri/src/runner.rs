use crate::identity;
use crate::ledger::{self, LedgerEntry};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
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
/// 抽象出来才能在无头测试里验证进程组/停止等 🔴 不变量。
pub type Sink = Arc<dyn Fn(RunEvent) + Send + Sync>;

pub struct RunHandle {
    #[allow(dead_code)] // 保留备用(诊断/未来按 pid 操作)
    pub pid: u32,
    pub pgid: i32,
    pub killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    // 持有 master 保持 PTY 开启;drop 即触发 reader EOF。
    pub _master: Box<dyn portable_pty::MasterPty + Send>,
    pub ring: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Default)]
pub struct Registry(pub Mutex<HashMap<String, RunHandle>>);

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
    // 取真实 pgid(PTY 下应等于 pid,但实测取一手更稳)
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
    let ring_r = ring.clone();
    let sink_r = sink.clone();

    // reader 线程:节流 ~30ms 合并 chunk 再推前端。
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut acc = String::new();
        let mut last = Instant::now();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if last.elapsed() >= Duration::from_millis(30) || acc.len() > 4096 {
                        flush(&sink_r, &ring_r, &mut acc);
                        last = Instant::now();
                    }
                }
                Err(_) => break,
            }
        }
        if !acc.is_empty() {
            flush(&sink_r, &ring_r, &mut acc);
        }
    });

    // waiter 线程:退出后推 Exit + 清台账。
    let sink_w = sink.clone();
    let rid = run_id.clone();
    std::thread::spawn(move || {
        let status = child.wait().ok();
        let code = status.map(|s| s.exit_code() as i32);
        sink_w(RunEvent::Exit { code });
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
        label,
    });

    reg.0.lock().unwrap().insert(
        run_id,
        RunHandle {
            pid,
            pgid,
            killer,
            _master: pair.master,
            ring,
        },
    );
    Ok(pid)
}

fn flush(sink: &Sink, ring: &Arc<Mutex<VecDeque<String>>>, acc: &mut String) {
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
    sink(RunEvent::Output { chunk });
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

        // 子进程进程组必须 ≠ 测试进程进程组(否则 kill(-pgid) 自杀)
        let my_pgid = unsafe { libc::getpgid(0) };
        let child_pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        assert!(child_pgid > 0, "child pgid should be valid");
        assert_ne!(
            child_pgid, my_pgid,
            "🔴 child MUST be in its own process group"
        );

        // 等输出流出
        std::thread::sleep(Duration::from_millis(400));
        assert!(
            collected.lock().unwrap().contains("QUAY_HELLO"),
            "output should stream through sink"
        );

        // stop 必须真杀死子进程
        stop_run(&reg, &run_id).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            !crate::identity::pid_alive(pid),
            "child should be dead after stop_run"
        );
    }
}
