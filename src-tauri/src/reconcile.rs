use crate::identity::verify_identity;
use crate::ledger::{self, LedgerEntry};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Orphan {
    pub run_id: String,
    pub pid: u32,
    pub pgid: i32,
    pub command: String,
    pub cwd: String,
    pub label: String,
}

/// 启动时读台账,身份三重校验,返回确认存活的遗留进程;失活的清出台账(治台账残留)。
pub fn find_orphans() -> Vec<Orphan> {
    let entries = ledger::load_ledger();
    let mut alive = Vec::new();
    let mut keep: Vec<LedgerEntry> = Vec::new();
    for e in entries {
        if verify_identity(e.pid, e.start_time, &e.command) {
            alive.push(Orphan {
                run_id: e.run_id.clone(),
                pid: e.pid,
                pgid: e.pgid,
                command: e.command.clone(),
                cwd: e.cwd.clone(),
                label: e.label.clone(),
            });
            keep.push(e);
        }
    }
    ledger::save_ledger(&keep);
    alive
}

pub fn kill_orphan(pgid: i32) {
    // SAFETY: 负 pid = 进程组
    unsafe {
        libc::kill(-pgid, libc::SIGTERM);
    }
}
