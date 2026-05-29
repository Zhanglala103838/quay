use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub run_id: String,
    pub pid: u32,
    pub pgid: i32,
    pub command: String,
    pub cwd: String,
    pub start_time: u64,
    pub label: String,
}

fn ledger_path() -> PathBuf {
    let d = dirs::config_dir().unwrap_or_default().join("Quay");
    let _ = std::fs::create_dir_all(&d);
    d.join("running-procs.json")
}

pub fn load_ledger() -> Vec<LedgerEntry> {
    std::fs::read_to_string(ledger_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_ledger(entries: &[LedgerEntry]) {
    if let Ok(t) = serde_json::to_string_pretty(entries) {
        let _ = std::fs::write(ledger_path(), t);
    }
}

pub fn add_entry(e: LedgerEntry) {
    let mut v = load_ledger();
    v.push(e);
    save_ledger(&v);
}

pub fn remove_entry(run_id: &str) {
    let mut v = load_ledger();
    v.retain(|x| x.run_id != run_id);
    save_ledger(&v);
}
