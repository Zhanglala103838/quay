//! 平台抽象层:shell / 进程组 / 杀进程 / 存活探测 / 监听端口 / 内存归并。
//!
//! Quay 的核心(按"进程组整棵树"算内存 + 一键停整组)原本全建在 POSIX 之上
//! (`/bin/zsh`、`getpgid`、`kill(-pgid, SIGTERM)`、`lsof`)。Windows 无 POSIX 进程组,
//! 故这里做平台分叉:
//!   - unix  : 与重构前逐字节等价(只是搬进函数),mac 行为完全不变。
//!   - windows: 以"根 pid + 进程树(sysinfo parent 链)"等价 POSIX 进程组,
//!              杀进程用 `taskkill /T /F`(整树),端口用 `netstat -ano` 解析。
//!              全程不碰 unsafe winapi,降低无本地 Windows 环境时的编译风险。

use portable_pty::CommandBuilder;
use std::collections::{HashMap, HashSet};

// ───────────────────────────── shell ─────────────────────────────

/// 起 PTY 子进程用的 shell 命令(尚未设 cwd/env,由调用方补)。
/// interactive=true → 交互登录 shell(接 stdin,用户在 App 内直接打字);
/// false           → 跑完 `command` 即退(只读监控)。
#[cfg(unix)]
pub fn shell_command(interactive: bool, command: &str) -> CommandBuilder {
    // 经登录 shell 跑:继承 PATH;PTY 已让多数工具开色,env 兜底。
    let mut cmd = CommandBuilder::new("/bin/zsh");
    if interactive {
        cmd.args(["-li"]);
    } else {
        cmd.args(["-lc", command]);
    }
    cmd
}

/// Windows 用 PowerShell:Win10+ 必带,能力强于 cmd,且 ConPTY 下 ANSI/颜色正常。
#[cfg(windows)]
pub fn shell_command(interactive: bool, command: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("powershell.exe");
    if interactive {
        // -NoExit 保持交互会话;-NoLogo 去启动横幅。
        cmd.args(["-NoLogo", "-NoExit"]);
    } else {
        // 跑完即退;-NoProfile 提速并避免用户 profile 干扰;Bypass 免脚本策略拦路。
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ]);
    }
    cmd
}

// ─────────────────────────── 组标识 ───────────────────────────

/// 某 run 的"组标识"。
/// unix : 进程组 pgid(PTY slave 自带 setsid → 子进程成进程组首,pgid==pid)。
/// windows: 无 POSIX 进程组,直接用根 pid;内存/杀进程都按其进程树展开。
#[cfg(unix)]
pub fn group_id(pid: u32) -> i32 {
    let g = unsafe { libc::getpgid(pid as libc::pid_t) };
    if g > 0 {
        g
    } else {
        pid as i32
    }
}

#[cfg(windows)]
pub fn group_id(pid: u32) -> i32 {
    pid as i32
}

// ─────────────────────────── 存活探测 ───────────────────────────

/// 进程是否存活(只探测,不发任何信号)。
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 不发信号,只做权限/存活检查
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
        ProcessRefreshKind::new(),
    );
    sys.process(Pid::from_u32(pid)).is_some()
}

// ─────────────────────────── 杀进程组 ───────────────────────────

/// 终止某组的整棵进程树(不波及 Quay 自身)。
#[cfg(unix)]
pub fn kill_group(group: i32) {
    // SAFETY: 负 pid = 进程组;子进程在自己的新进程组,不波及 Quay
    unsafe {
        libc::kill(-group, libc::SIGTERM);
    }
}

#[cfg(windows)]
pub fn kill_group(group: i32) {
    if group <= 0 {
        return;
    }
    // taskkill /T 杀整棵进程树(group 即根 pid),/F 强制。CREATE_NO_WINDOW 避免控制台窗口闪烁。
    let _ = no_window(std::process::Command::new("taskkill").args([
        "/T",
        "/F",
        "/PID",
        &group.to_string(),
    ]))
    .output();
}

// ─────────────────────────── 内存归并 ───────────────────────────

/// 给定全量进程快照 + 受跟踪的组标识集合,返回:
///   - 每组的 RSS 之和(unix 返回全部 pgid 的累加,调用方只读受跟踪的;windows 只算受跟踪组)
///   - 每个受跟踪组内的全部 pid(供查端口)
#[cfg(unix)]
pub fn aggregate_group_memory(
    sys: &sysinfo::System,
    roots: &HashSet<i32>,
) -> (HashMap<i32, u64>, HashMap<i32, Vec<u32>>) {
    let mut by_pgid: HashMap<i32, u64> = HashMap::new();
    let mut pids_by_pgid: HashMap<i32, Vec<u32>> = HashMap::new();
    for (pid, proc_) in sys.processes() {
        let pg = unsafe { libc::getpgid(pid.as_u32() as libc::pid_t) };
        if pg > 0 {
            *by_pgid.entry(pg).or_insert(0) += proc_.memory();
            if roots.contains(&pg) {
                pids_by_pgid.entry(pg).or_default().push(pid.as_u32());
            }
        }
    }
    (by_pgid, pids_by_pgid)
}

#[cfg(windows)]
pub fn aggregate_group_memory(
    sys: &sysinfo::System,
    roots: &HashSet<i32>,
) -> (HashMap<i32, u64>, HashMap<i32, Vec<u32>>) {
    use sysinfo::Pid;
    // parent → children 邻接表(一次遍历建好,供按根 pid BFS 子孙)。
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, proc_) in sys.processes() {
        if let Some(parent) = proc_.parent() {
            children
                .entry(parent.as_u32())
                .or_default()
                .push(pid.as_u32());
        }
    }
    let mut mem: HashMap<i32, u64> = HashMap::new();
    let mut pids_map: HashMap<i32, Vec<u32>> = HashMap::new();
    for &root in roots {
        let root_pid = root as u32;
        let mut stack = vec![root_pid];
        let mut seen: HashSet<u32> = HashSet::new();
        let mut total = 0u64;
        let mut members: Vec<u32> = Vec::new();
        while let Some(p) = stack.pop() {
            if !seen.insert(p) {
                continue;
            }
            if let Some(proc_) = sys.process(Pid::from_u32(p)) {
                total += proc_.memory();
                members.push(p);
            }
            if let Some(kids) = children.get(&p) {
                stack.extend(kids.iter().copied());
            }
        }
        mem.insert(root, total);
        pids_map.insert(root, members);
    }
    (mem, pids_map)
}

// ─────────────────────────── 监听端口(多 pid) ───────────────────────────

/// 这些 pid 正在 LISTEN 的 TCP 端口,pid→ports。
#[cfg(unix)]
pub fn listening_ports(pids: &[u32]) -> HashMap<u32, Vec<u16>> {
    // 用 lsof 查这些 pid 正在 LISTEN 的 TCP 端口(同 uid 即可见,不需 sudo)。
    // 限定 -p <pids> 避免全量扫描;lsof 缺失/失败 → 返回空表(端口栏静默不显示)。
    // -F pn 输出按字段前缀分行:p<pid> 开一段进程,后续 n<地址> 是该进程的监听点。
    let mut out: HashMap<u32, Vec<u16>> = HashMap::new();
    if pids.is_empty() {
        return out;
    }
    let pid_arg = pids
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let output = std::process::Command::new("lsof")
        .args([
            "-nP", // 不反查 DNS / 端口名,直接给数字(更快、好解析)
            "-iTCP",
            "-sTCP:LISTEN",
            "-a", // -i 与 -p 取交集(否则是并集)
            "-p",
            &pid_arg,
            "-F",
            "pn",
        ])
        .output();
    let Ok(o) = output else { return out };
    let text = String::from_utf8_lossy(&o.stdout);
    let mut cur: Option<u32> = None;
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let (tag, val) = (&line[..1], &line[1..]);
        match tag {
            "p" => cur = val.parse::<u32>().ok(),
            "n" => {
                // 地址形如 *:3000 / 127.0.0.1:5173 / [::1]:8080,端口在最后一个 ':' 之后。
                if let Some(pid) = cur {
                    if let Some(port) = val.rsplit(':').next().and_then(|s| s.parse::<u16>().ok()) {
                        let v = out.entry(pid).or_default();
                        if !v.contains(&port) {
                            v.push(port);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(windows)]
pub fn listening_ports(pids: &[u32]) -> HashMap<u32, Vec<u16>> {
    let wanted: HashSet<u32> = pids.iter().copied().collect();
    let mut out: HashMap<u32, Vec<u16>> = HashMap::new();
    if wanted.is_empty() {
        return out;
    }
    for (pid, port) in netstat_listen() {
        if wanted.contains(&pid) {
            let v = out.entry(pid).or_default();
            if !v.contains(&port) {
                v.push(port);
            }
        }
    }
    out
}

// ─────────────────────────── 监听端口(单端口 → 占用者) ───────────────────────────

/// 谁在 LISTEN 这个端口(取第一个):返回 (pid, 进程名)。空闲/查不到 → None。
#[cfg(unix)]
pub fn port_listener(port: u16) -> Option<(u32, String)> {
    // -F pcn 按字段分行:p<pid> c<命令名> n<地址>。
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

#[cfg(windows)]
pub fn port_listener(port: u16) -> Option<(u32, String)> {
    let pid = netstat_listen()
        .into_iter()
        .find(|(_, p)| *p == port)
        .map(|(pid, _)| pid)?;
    let name = process_name(pid).unwrap_or_default();
    Some((pid, name))
}

// ─────────────────────────── windows 私有助手 ───────────────────────────

/// 给 Command 挂 CREATE_NO_WINDOW,避免 GUI 进程 spawn 控制台子进程时闪黑框。
#[cfg(windows)]
fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

/// `netstat -ano` 解析出所有 LISTENING 的 (pid, port)。状态/协议名不随语言区本地化。
#[cfg(windows)]
fn netstat_listen() -> Vec<(u32, u16)> {
    let out = no_window(std::process::Command::new("netstat").arg("-ano")).output();
    let Ok(o) = out else { return Vec::new() };
    let text = String::from_utf8_lossy(&o.stdout);
    let mut res = Vec::new();
    for line in text.lines() {
        // 形如:  TCP    0.0.0.0:3000     0.0.0.0:0     LISTENING     1234
        //        TCP    [::]:8080        [::]:0        LISTENING     1234
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() >= 5 && f[0].eq_ignore_ascii_case("TCP") && f[3].eq_ignore_ascii_case("LISTENING")
        {
            let port = f[1].rsplit(':').next().and_then(|s| s.parse::<u16>().ok());
            let pid = f[4].parse::<u32>().ok();
            if let (Some(port), Some(pid)) = (port, pid) {
                res.push((pid, port));
            }
        }
    }
    res
}

/// 取某 pid 的进程名(供端口占用提示)。
#[cfg(windows)]
fn process_name(pid: u32) -> Option<String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
        ProcessRefreshKind::new(),
    );
    sys.process(Pid::from_u32(pid))
        .map(|p| p.name().to_string_lossy().to_string())
}
