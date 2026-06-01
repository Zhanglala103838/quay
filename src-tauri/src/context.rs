use crate::scanner;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 3;
const MAX_TREE: usize = 400;
const MAX_FILES: usize = 30;
const MAX_FILE_BYTES: usize = 8 * 1024;
const MAX_TOTAL_BYTES: usize = 64 * 1024;

const SKIP_DIRS: &[&str] = &[
    "node_modules", "vendor", "target", ".git", "dist", "build", ".next", ".venv",
    "__pycache__", ".idea", ".vscode", "coverage",
];

const WHITELIST: &[&str] = &[
    "package.json", "composer.json", "pom.xml", "build.gradle", "build.gradle.kts",
    "go.mod", "Cargo.toml", "Makefile", "docker-compose.yml", "docker-compose.yaml",
    "compose.yml", "manage.py", "pyproject.toml", "requirements.txt", "artisan",
    "README", "README.md", "README.txt",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextFile {
    #[serde(rename = "relPath")]
    pub rel_path: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectContext {
    pub root: String,
    pub tree: Vec<String>,
    pub files: Vec<ContextFile>,
    #[serde(rename = "detectedSources")]
    pub detected_sources: Vec<String>,
}

/// 敏感文件硬跳过：绝不读取/外发（即使在白名单也不读）。
fn is_sensitive(name: &str) -> bool {
    let l = name.to_lowercase();
    l.starts_with(".env")
        || l.ends_with(".pem")
        || l.ends_with(".key")
        || l.starts_with("id_rsa")
        || l.contains("secret")
        || l.contains("credential")
        || l.ends_with(".p12")
        || l.ends_with(".keystore")
}

/// L2 的"眼睛"：有界浅递归(深度≤3)收集目录树 + 白名单关键文件内容(截断)。
/// 跳过噪声目录与敏感文件。root 不存在 → 空 context。
pub fn collect_context(dir: &str) -> ProjectContext {
    let root = Path::new(dir);
    let mut ctx = ProjectContext {
        root: dir.to_string(),
        tree: Vec::new(),
        files: Vec::new(),
        detected_sources: scanner::scan_directory(dir).detected_sources,
    };
    if !root.is_dir() {
        return ctx;
    }
    let mut total = 0usize;
    walk(root, root, 0, &mut ctx, &mut total);
    ctx
}

fn walk(root: &Path, dir: &Path, depth: usize, ctx: &mut ProjectContext, total: &mut usize) {
    if depth > MAX_DEPTH {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut items: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
    items.sort();
    for path in items {
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if ctx.tree.len() < MAX_TREE {
                if let Ok(rel) = path.strip_prefix(root) {
                    ctx.tree.push(format!("{}/", rel.to_string_lossy()));
                }
            }
            walk(root, &path, depth + 1, ctx, total);
        } else if path.is_file() {
            if is_sensitive(&name) {
                continue;
            }
            if !WHITELIST.contains(&name.as_str()) {
                continue;
            }
            if ctx.tree.len() < MAX_TREE {
                if let Ok(rel) = path.strip_prefix(root) {
                    ctx.tree.push(rel.to_string_lossy().to_string());
                }
            }
            if ctx.files.len() < MAX_FILES && *total < MAX_TOTAL_BYTES {
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    let truncated = raw.len() > MAX_FILE_BYTES;
                    let content: String = if truncated {
                        raw.chars().take(MAX_FILE_BYTES).collect()
                    } else {
                        raw
                    };
                    *total += content.len();
                    if let Ok(rel) = path.strip_prefix(root) {
                        ctx.files.push(ContextFile {
                            rel_path: rel.to_string_lossy().to_string(),
                            content,
                            truncated,
                        });
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("quay_ctx_test_{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_dir_returns_empty() {
        let ctx = collect_context("/no/such/dir/xyz");
        assert!(ctx.tree.is_empty());
        assert!(ctx.files.is_empty());
    }

    #[test]
    fn reads_whitelisted_and_skips_sensitive() {
        let d = tmp("whitelist");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        fs::write(d.join(".env"), "SECRET=topsecret").unwrap();
        fs::write(d.join("private.key"), "-----BEGIN KEY-----").unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        assert!(ctx.files.iter().any(|f| f.rel_path == "package.json"));
        assert!(!ctx.files.iter().any(|f| f.rel_path.contains(".env")));
        assert!(!ctx.files.iter().any(|f| f.rel_path.ends_with(".key")));
        assert!(ctx.files.iter().all(|f| !f.content.contains("topsecret")));
    }

    #[test]
    fn skips_noise_dirs() {
        let d = tmp("noise");
        fs::create_dir_all(d.join("node_modules/foo")).unwrap();
        fs::write(d.join("node_modules/foo/package.json"), "{}").unwrap();
        fs::write(d.join("package.json"), r#"{"name":"root"}"#).unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        assert!(ctx.tree.iter().all(|t| !t.contains("node_modules")));
        assert_eq!(ctx.files.iter().filter(|f| f.rel_path.ends_with("package.json")).count(), 1);
    }

    #[test]
    fn nested_marker_visible_in_tree() {
        let d = tmp("nested");
        fs::create_dir_all(d.join("java-api/gyj_admin/ch_backend")).unwrap();
        fs::write(d.join("java-api/gyj_admin/ch_backend/pom.xml"), "<project/>").unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        assert!(ctx.tree.iter().any(|t| t == "java-api/gyj_admin/ch_backend/pom.xml"));
        assert!(ctx.files.iter().any(|f| f.rel_path == "java-api/gyj_admin/ch_backend/pom.xml"));
    }

    #[test]
    fn does_not_descend_past_max_depth() {
        let d = tmp("depth");
        fs::create_dir_all(d.join("a/b/c/d")).unwrap();
        fs::write(d.join("a/b/c/pom.xml"), "<c/>").unwrap();
        fs::write(d.join("a/b/c/d/pom.xml"), "<d/>").unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        assert!(ctx.files.iter().any(|f| f.rel_path == "a/b/c/pom.xml"));
        assert!(!ctx.files.iter().any(|f| f.rel_path == "a/b/c/d/pom.xml"));
    }

    #[test]
    fn truncates_large_file() {
        let d = tmp("trunc");
        let big = "x".repeat(20 * 1024);
        fs::write(d.join("README.md"), &big).unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        let readme = ctx.files.iter().find(|f| f.rel_path == "README.md").unwrap();
        assert!(readme.truncated);
        assert!(readme.content.len() <= MAX_FILE_BYTES);
    }
}
