use crate::types::{ScanResult, Script};
use std::path::Path;

/// 深度 0：只读绑定目录顶层 package.json。不递归(避 node_modules 炸)。
pub fn scan_directory(dir: &str) -> ScanResult {
    let p = Path::new(dir);
    let dir_exists = p.is_dir();
    let pkg = p.join("package.json");
    let has_package_json = pkg.is_file();
    let mut scripts = Vec::new();
    if has_package_json {
        if let Ok(text) = std::fs::read_to_string(&pkg) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(obj) = v.get("scripts").and_then(|s| s.as_object()) {
                    for (name, cmd) in obj {
                        scripts.push(Script {
                            name: name.clone(),
                            command: cmd.as_str().unwrap_or("").to_string(),
                        });
                    }
                    scripts.sort_by(|a, b| a.name.cmp(&b.name));
                }
            }
        }
    }
    ScanResult {
        scripts,
        dir_exists,
        has_package_json,
    }
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
    fn scans_top_level_scripts() {
        let d = tmp("scan_ok");
        fs::write(
            d.join("package.json"),
            r#"{"scripts":{"dev":"vite","build":"vite build"}}"#,
        )
        .unwrap();
        let r = scan_directory(d.to_str().unwrap());
        assert!(r.dir_exists && r.has_package_json);
        assert_eq!(r.scripts.len(), 2);
        assert!(r.scripts.iter().any(|s| s.name == "dev" && s.command == "vite"));
    }

    #[test]
    fn missing_package_json_is_empty_not_error() {
        let d = tmp("scan_nopkg");
        let r = scan_directory(d.to_str().unwrap());
        assert!(r.dir_exists && !r.has_package_json && r.scripts.is_empty());
    }

    #[test]
    fn malformed_json_yields_empty_scripts() {
        let d = tmp("scan_bad");
        fs::write(d.join("package.json"), "{not json").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        assert!(r.has_package_json && r.scripts.is_empty());
    }

    #[test]
    fn nonexistent_dir_flags_dir_missing() {
        let r = scan_directory("/no/such/quay/dir/xyz");
        assert!(!r.dir_exists);
    }
}
