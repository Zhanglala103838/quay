use crate::scanner;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 3;
const MAX_TREE: usize = 400;
const MAX_FILES: usize = 40;
const MAX_FILE_BYTES: usize = 8 * 1024;
const MAX_TOTAL_BYTES: usize = 96 * 1024;

const SKIP_DIRS: &[&str] = &[
    "node_modules", "vendor", "target", ".git", "dist", "build", ".next", ".venv",
    "__pycache__", ".idea", ".vscode", "coverage",
];

/// 精确文件名白名单：跨生态的"构建/运行/依赖"清单与配置文件。只读这些 + WHITELIST_SUFFIX。
const WHITELIST: &[&str] = &[
    // JS / TS
    "package.json", "pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json", "rush.json",
    // Python
    "manage.py", "pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "setup.cfg", "tox.ini",
    // Ruby
    "Gemfile", "Rakefile", "config.ru",
    // PHP
    "composer.json", "artisan",
    // Rust / Go
    "Cargo.toml", "go.mod",
    // JVM (Maven / Gradle，含多模块聚合器 settings.gradle)
    "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
    // 通用任务运行器 / 进程声明 / 容器
    "Makefile", "Taskfile.yml", "Taskfile.yaml", "Justfile", "justfile",
    "Procfile", "Procfile.dev", "Dockerfile",
    "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
    // 文档
    "README", "README.md", "README.txt",
];

/// 后缀白名单：按扩展名匹配的清单文件(精确名列不全的，如 .NET 项目/解决方案)。小写比较。
const WHITELIST_SUFFIX: &[&str] = &[
    ".csproj", ".sln", ".fsproj", ".vbproj",
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
            let name_lower = name.to_lowercase();
            let is_marker = WHITELIST.contains(&name.as_str())
                || WHITELIST_SUFFIX.iter().any(|s| name_lower.ends_with(s));
            if !is_marker {
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
                        // 按字节截断,回退到最近的字符边界(避免切断多字节 UTF-8)
                        let mut end = MAX_FILE_BYTES;
                        while end > 0 && !raw.is_char_boundary(end) {
                            end -= 1;
                        }
                        raw[..end].to_string()
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

    #[test]
    fn truncates_large_cjk_file_by_bytes() {
        let d = tmp("trunc_cjk");
        // 每个中文字 3 字节, 1 万字 = 3 万字节 > 8KB
        let big = "中".repeat(10_000);
        fs::write(d.join("README.md"), &big).unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        let readme = ctx.files.iter().find(|f| f.rel_path == "README.md").unwrap();
        assert!(readme.truncated);
        // 不变式:截断后字节数不超上限(字符边界回退保证不切坏 UTF-8)
        assert!(readme.content.len() <= MAX_FILE_BYTES);
        // 内容仍是合法 UTF-8(能成功构成 String 即合法,这里再断言非空)
        assert!(!readme.content.is_empty());
    }

    #[test]
    fn collects_ruby_ecosystem() {
        let d = tmp("ruby");
        fs::write(d.join("Gemfile"), "source 'https://rubygems.org'").unwrap();
        fs::write(d.join("Rakefile"), "task :default").unwrap();
        fs::write(d.join("config.ru"), "run App").unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        for f in ["Gemfile", "Rakefile", "config.ru"] {
            assert!(ctx.files.iter().any(|x| x.rel_path == f), "missing {f}");
        }
    }

    #[test]
    fn collects_dotnet_by_suffix() {
        let d = tmp("dotnet");
        fs::write(d.join("Api.csproj"), "<Project/>").unwrap();
        fs::write(d.join("Solution.sln"), "Microsoft Visual Studio Solution").unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        assert!(ctx.files.iter().any(|x| x.rel_path == "Api.csproj"));
        assert!(ctx.files.iter().any(|x| x.rel_path == "Solution.sln"));
    }

    #[test]
    fn collects_monorepo_and_procfile() {
        let d = tmp("monorepo");
        fs::write(d.join("pnpm-workspace.yaml"), "packages:\n  - 'apps/*'").unwrap();
        fs::write(d.join("Procfile"), "web: node server.js").unwrap();
        fs::create_dir_all(d.join("apps/web")).unwrap();
        fs::write(d.join("apps/web/package.json"), r#"{"name":"web"}"#).unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        assert!(ctx.files.iter().any(|x| x.rel_path == "pnpm-workspace.yaml"));
        assert!(ctx.files.iter().any(|x| x.rel_path == "Procfile"));
        assert!(ctx.files.iter().any(|x| x.rel_path == "apps/web/package.json"));
    }

    #[test]
    fn collects_gradle_multimodule_settings() {
        let d = tmp("gradle_mm");
        fs::write(d.join("settings.gradle"), "include 'svc-a','svc-b'").unwrap();
        fs::write(d.join("build.gradle"), "plugins {}").unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        assert!(ctx.files.iter().any(|x| x.rel_path == "settings.gradle"));
    }

    #[test]
    fn sensitive_still_blocked_after_widening() {
        // 拓宽白名单后,敏感文件仍必须被硬拦截
        let d = tmp("sens_after_widen");
        fs::write(d.join("Gemfile"), "gem 'rails'").unwrap();
        fs::write(d.join(".env"), "SECRET=x").unwrap();
        fs::write(d.join("server.key"), "-----KEY-----").unwrap();
        let ctx = collect_context(d.to_str().unwrap());
        assert!(ctx.files.iter().any(|x| x.rel_path == "Gemfile"));
        assert!(!ctx.files.iter().any(|x| x.rel_path.contains(".env")));
        assert!(!ctx.files.iter().any(|x| x.rel_path.ends_with(".key")));
    }
}
