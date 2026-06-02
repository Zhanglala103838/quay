use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Debug, Clone)]
pub struct ProcSnapshot {
    pub start_time: u64,
    pub cmd: String,
    pub exe: String,
}

/// 存活探测(unix=kill(pid,0) / windows=sysinfo 单 pid 刷新),平台细节见 platform。
pub fn pid_alive(pid: u32) -> bool {
    crate::platform::pid_alive(pid)
}

pub fn process_snapshot(pid: u32) -> Option<ProcSnapshot> {
    let mut sys = System::new();
    // macOS 上默认 refresh 不含 cmd/exe,必须显式拉(底层走 KERN_PROCARGS2)。
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
        ProcessRefreshKind::new()
            .with_cmd(UpdateKind::Always)
            .with_exe(UpdateKind::Always),
    );
    sys.process(Pid::from_u32(pid)).map(|p| ProcSnapshot {
        start_time: p.start_time(),
        cmd: p
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" "),
        exe: p
            .exe()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default(),
    })
}

/// 身份三重校验:存活 + 启动时间一致 + 命令行/exe 包含原命令片段。
/// 启动时间是 PID 复用的主防线;cmd/exe 拿不到时(macOS 偶发)回退到仅启动时间。
/// marker(env)不可靠(macOS 读不到别进程 env),故不用。
pub fn verify_identity(pid: u32, expected_start: u64, expected_cmd: &str) -> bool {
    if !pid_alive(pid) {
        return false;
    }
    match process_snapshot(pid) {
        Some(s) => {
            // 启动时间允许 ±2s 漂移(sysinfo 秒级)
            let t_ok = (s.start_time as i64 - expected_start as i64).abs() <= 2;
            if !t_ok {
                return false;
            }
            // 命令行/exe 第一个有意义 token 匹配(强化防 PID 复用)
            let haystack = format!("{} {}", s.cmd, s.exe);
            match expected_cmd.split_whitespace().next() {
                // 拿不到任何进程信息时,只凭启动时间判定(已足够强)
                Some(_) if s.cmd.is_empty() && s.exe.is_empty() => true,
                Some(tok) => haystack.contains(tok),
                None => true,
            }
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_is_alive() {
        let me = std::process::id();
        assert!(pid_alive(me));
    }

    #[test]
    fn absurd_pid_not_alive() {
        assert!(!pid_alive(4_000_000_000));
    }

    #[test]
    fn snapshot_of_self_has_starttime_and_some_identity() {
        let me = std::process::id();
        let snap = process_snapshot(me).expect("self snapshot");
        assert!(snap.start_time > 0);
        // macOS 上 cmd 或 exe 至少有一个能拿到
        assert!(!snap.cmd.is_empty() || !snap.exe.is_empty());
    }
}
