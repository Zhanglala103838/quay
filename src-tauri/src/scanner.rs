use crate::types::{Command, ScanResult};
use std::collections::HashSet;
use std::path::Path;

/// 深度 0：对绑定目录顶层跑一组检测器，合并命令。不递归(避 node_modules 炸)。
pub fn scan_directory(dir: &str) -> ScanResult {
    let p = Path::new(dir);
    if !p.is_dir() {
        return ScanResult { commands: vec![], dir_exists: false, detected_sources: vec![] };
    }
    let detectors: &[fn(&Path) -> Vec<Command>] = &[detect_npm];
    let mut commands: Vec<Command> = Vec::new();
    for d in detectors {
        commands.extend(d(p));
    }
    // 去重：同 name 冲突时给后者加 source 后缀，保证前端 label 唯一
    let mut seen: HashSet<String> = HashSet::new();
    for c in commands.iter_mut() {
        if !seen.insert(c.name.clone()) {
            c.name = format!("{} ({})", c.name, c.source);
        }
        seen.insert(c.name.clone());
    }
    let mut detected_sources: Vec<String> = Vec::new();
    for c in &commands {
        if !detected_sources.contains(&c.source) {
            detected_sources.push(c.source.clone());
        }
    }
    ScanResult { commands, dir_exists: true, detected_sources }
}

/// 按锁文件判断包管理器。无锁文件默认 npm。
fn detect_pm(dir: &Path) -> &'static str {
    if dir.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if dir.join("yarn.lock").is_file() {
        "yarn"
    } else if dir.join("bun.lockb").is_file() || dir.join("bun.lock").is_file() {
        "bun"
    } else {
        "npm"
    }
}

/// npm：读 package.json scripts，按锁文件用对 pm。category 留空交前端推断。
fn detect_npm(dir: &Path) -> Vec<Command> {
    let pkg = dir.join("package.json");
    if !pkg.is_file() {
        return vec![];
    }
    let text = match std::fs::read_to_string(&pkg) {
        Ok(t) => t,
        Err(_) => return vec![],
    };
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let pm = detect_pm(dir);
    let mut out = Vec::new();
    if let Some(obj) = v.get("scripts").and_then(|s| s.as_object()) {
        for name in obj.keys() {
            out.push(Command {
                name: name.clone(),
                command: format!("{pm} run {name}"),
                source: pm.to_string(),
                category: String::new(),
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("quay_test_{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn npm_default_when_no_lockfile() {
        let d = tmp("npm_default");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite","build":"vite build"}}"#).unwrap();
        let r = scan_directory(d.to_str().unwrap());
        assert!(r.dir_exists);
        assert_eq!(r.commands.len(), 2);
        let dev = r.commands.iter().find(|c| c.name == "dev").unwrap();
        assert_eq!(dev.command, "npm run dev");
        assert_eq!(dev.source, "npm");
        assert_eq!(r.detected_sources, vec!["npm"]);
    }

    #[test]
    fn pnpm_lockfile_picks_pnpm() {
        let d = tmp("npm_pnpm");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        fs::write(d.join("pnpm-lock.yaml"), "lockfileVersion: 9").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let dev = r.commands.iter().find(|c| c.name == "dev").unwrap();
        assert_eq!(dev.command, "pnpm run dev");
        assert_eq!(dev.source, "pnpm");
    }

    #[test]
    fn yarn_and_bun_lockfiles() {
        let d = tmp("npm_yarn");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"x"}}"#).unwrap();
        fs::write(d.join("yarn.lock"), "").unwrap();
        assert_eq!(scan_directory(d.to_str().unwrap()).commands[0].command, "yarn run dev");

        let d2 = tmp("npm_bun");
        fs::write(d2.join("package.json"), r#"{"scripts":{"dev":"x"}}"#).unwrap();
        fs::write(d2.join("bun.lockb"), "").unwrap();
        assert_eq!(scan_directory(d2.to_str().unwrap()).commands[0].command, "bun run dev");
    }

    #[test]
    fn malformed_json_yields_empty() {
        let d = tmp("npm_bad");
        fs::write(d.join("package.json"), "{not json").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        assert!(r.dir_exists && r.commands.is_empty());
    }

    #[test]
    fn nonexistent_dir_flags_missing() {
        let r = scan_directory("/no/such/quay/dir/xyz");
        assert!(!r.dir_exists && r.commands.is_empty() && r.detected_sources.is_empty());
    }
}
