use crate::types::{Command, ScanResult};
use std::collections::HashSet;
use std::path::Path;

/// 深度 0：对绑定目录顶层跑一组检测器，合并命令。不递归(避 node_modules 炸)。
pub fn scan_directory(dir: &str) -> ScanResult {
    let p = Path::new(dir);
    if !p.is_dir() {
        return ScanResult { commands: vec![], dir_exists: false, detected_sources: vec![] };
    }
    let detectors: &[fn(&Path) -> Vec<Command>] = &[
        detect_npm, detect_cargo, detect_go, detect_make, detect_compose,
        detect_php, detect_maven, detect_gradle, detect_python,
    ];
    let mut commands: Vec<Command> = Vec::new();
    for d in detectors {
        commands.extend(d(p));
    }
    // 去重：同 name 冲突时给后者加 source 后缀，仍冲突则追加序号，保证前端 label 唯一。
    let mut seen: HashSet<String> = HashSet::new();
    for c in commands.iter_mut() {
        if seen.contains(&c.name) {
            let base = format!("{} ({})", c.name, c.source);
            let mut name = base.clone();
            let mut n = 2;
            while seen.contains(&name) {
                name = format!("{base} {n}");
                n += 1;
            }
            c.name = name;
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

/// 读 `<dir>/src-tauri/tauri.conf.json` 的 build.devUrl,抽出端口号。
/// 用于"不同项目同端口"检测:Tauri 窗口 dev 时死命加载这个 devUrl,
/// 两个项目声明同端口 → 谁先占住端口,另一个的窗口就加载错应用。
/// 无 tauri 项目 / 无 devUrl / 解析失败 → None(静默,不猜)。
pub fn dev_url_port(dir: &Path) -> Option<u16> {
    let conf = dir.join("src-tauri").join("tauri.conf.json");
    let text = std::fs::read_to_string(conf).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let url = v.get("build")?.get("devUrl")?.as_str()?;
    port_of_url(url)
}

/// 从 URL 抽端口:`http://localhost:5173/` → 5173。无显式端口 → None(不臆测 80/443)。
fn port_of_url(url: &str) -> Option<u16> {
    let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    // 去掉 userinfo,取 host:port 的最后一段冒号后内容;IPv6 不在 dev 场景考虑。
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    host_port.rsplit_once(':').and_then(|(_, p)| p.parse::<u16>().ok())
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

/// 已知"透传脚本"(passthrough)：脚本体只是一个 CLI 二进制名，本身必须再带子命令才有意义。
/// 典型如 `"tauri": "tauri"` —— 裸跑 `pnpm run tauri` 没意义，得 `pnpm run tauri dev`。
/// 子命令是运行时追加的参数，package.json 里推不出来，故按 CLI 惯例展开常用子命令。
/// 返回 (子命令, category) 列表。
fn passthrough_subcommands(bin: &str) -> Option<&'static [(&'static str, &'static str)]> {
    match bin {
        "tauri" => Some(&[("dev", "dev"), ("build", "build")]),
        "expo" => Some(&[("start", "dev"), ("prebuild", "build")]),
        "cap" => Some(&[("run ios", "dev"), ("run android", "dev"), ("sync", "build")]),
        _ => None,
    }
}

/// npm：读 package.json scripts，按锁文件用对 pm。category 留空交前端推断。
/// 透传脚本(见 passthrough_subcommands)展开为常用子命令并带显式 category。
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
        for (name, val) in obj {
            // 按脚本体匹配，故 `"desktop": "tauri"` 这种改名写法也能命中。
            let body = val.as_str().unwrap_or("").trim();
            if let Some(subs) = passthrough_subcommands(body) {
                for (sub, cat) in subs {
                    out.push(Command {
                        name: format!("{name} {sub}"),
                        command: format!("{pm} run {name} {sub}"),
                        source: pm.to_string(),
                        category: cat.to_string(),
                    });
                }
                continue;
            }
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

/// 固定约定命令的小工具：批量造 Command。
fn fixed(source: &str, items: &[(&str, &str)]) -> Vec<Command> {
    items
        .iter()
        .map(|(cmd, cat)| Command {
            name: cmd.to_string(),
            command: cmd.to_string(),
            source: source.to_string(),
            category: cat.to_string(),
        })
        .collect()
}

/// 单条固定命令（name == command）。
fn one(command: &str, source: &str, category: &str) -> Command {
    Command {
        name: command.to_string(),
        command: command.to_string(),
        source: source.to_string(),
        category: category.to_string(),
    }
}

fn detect_cargo(dir: &Path) -> Vec<Command> {
    if !dir.join("Cargo.toml").is_file() {
        return vec![];
    }
    fixed("cargo", &[
        ("cargo run", "dev"),
        ("cargo build", "build"),
        ("cargo test", "test"),
        ("cargo check", "test"),
        ("cargo clippy", "test"),
    ])
}

fn detect_go(dir: &Path) -> Vec<Command> {
    if !dir.join("go.mod").is_file() {
        return vec![];
    }
    fixed("go", &[
        ("go run .", "dev"),
        ("go build ./...", "build"),
        ("go test ./...", "test"),
    ])
}

fn detect_compose(dir: &Path) -> Vec<Command> {
    let has = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]
        .iter()
        .any(|f| dir.join(f).is_file());
    if !has {
        return vec![];
    }
    fixed("compose", &[
        ("docker compose up", "dev"),
        ("docker compose up -d", "dev"),
        ("docker compose down", "other"),
        ("docker compose logs -f", "other"),
        ("docker compose ps", "other"),
    ])
}

/// PHP 项目。source 统一 "php"(语言级身份,比 "composer" 对用户更直观)。
/// PHP 的启动命令是框架特定的(Laravel artisan / ThinkPHP think / 通用 php -S),
/// 而非像 npm 那样写在 composer.json scripts——故框架识别优先,composer 脚本仅作补充且过滤生命周期钩子。
fn detect_php(dir: &Path) -> Vec<Command> {
    let mut out = Vec::new();

    // composer.json 自定义脚本:排除生命周期钩子(pre-*/post-*,由 composer 自动触发,不是用户启动命令)。
    let cj = dir.join("composer.json");
    if cj.is_file() {
        if let Ok(text) = std::fs::read_to_string(&cj) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(obj) = v.get("scripts").and_then(|s| s.as_object()) {
                    for name in obj.keys() {
                        if name.starts_with("pre-") || name.starts_with("post-") {
                            continue;
                        }
                        out.push(Command {
                            name: name.clone(),
                            command: format!("composer run {name}"),
                            source: "php".to_string(),
                            category: String::new(),
                        });
                    }
                }
            }
        }
    }

    // Laravel(artisan 控制台入口)
    if dir.join("artisan").is_file() {
        out.push(one("php artisan serve", "php", "dev"));
        out.push(one("php artisan migrate", "php", "data"));
    }
    // ThinkPHP(根目录 think 控制台入口)
    if dir.join("think").is_file() {
        out.push(one("php think run", "php", "dev"));
    }

    // 兜底:有 PHP 入口但未命中框架 → 内建开发服务器
    if out.is_empty() {
        if dir.join("public/index.php").is_file() {
            out.push(one("php -S localhost:8000 -t public", "php", "dev"));
        } else if dir.join("index.php").is_file() {
            out.push(one("php -S localhost:8000", "php", "dev"));
        }
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn detect_maven(dir: &Path) -> Vec<Command> {
    if !dir.join("pom.xml").is_file() {
        return vec![];
    }
    let mut out = fixed("maven", &[
        ("mvn clean install", "build"),
        ("mvn test", "test"),
    ]);
    if let Ok(text) = std::fs::read_to_string(dir.join("pom.xml")) {
        if text.contains("spring-boot") {
            out.insert(0, Command { name: "mvn spring-boot:run".into(), command: "mvn spring-boot:run".into(), source: "maven".into(), category: "dev".into() });
        }
    }
    out
}

fn detect_gradle(dir: &Path) -> Vec<Command> {
    let has = dir.join("build.gradle").is_file() || dir.join("build.gradle.kts").is_file();
    if !has {
        return vec![];
    }
    let g = if dir.join("gradlew").is_file() { "./gradlew" } else { "gradle" };
    let mut out = vec![
        Command { name: format!("{g} build"), command: format!("{g} build"), source: "gradle".into(), category: "build".into() },
        Command { name: format!("{g} test"), command: format!("{g} test"), source: "gradle".into(), category: "test".into() },
    ];
    let bootish = [dir.join("build.gradle"), dir.join("build.gradle.kts")]
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .any(|t| t.contains("org.springframework.boot"));
    if bootish {
        out.insert(0, Command { name: format!("{g} bootRun"), command: format!("{g} bootRun"), source: "gradle".into(), category: "dev".into() });
    }
    out
}

fn detect_python(dir: &Path) -> Vec<Command> {
    // Django
    if dir.join("manage.py").is_file() {
        return vec![
            Command { name: "python manage.py runserver".into(), command: "python manage.py runserver".into(), source: "python".into(), category: "dev".into() },
            Command { name: "python manage.py migrate".into(), command: "python manage.py migrate".into(), source: "python".into(), category: "data".into() },
            Command { name: "python manage.py test".into(), command: "python manage.py test".into(), source: "python".into(), category: "test".into() },
        ];
    }
    // poetry scripts（best-effort 行解析）
    let pp = dir.join("pyproject.toml");
    if pp.is_file() {
        if let Ok(text) = std::fs::read_to_string(&pp) {
            let mut out = Vec::new();
            let mut in_section = false;
            for line in text.lines() {
                let t = line.trim();
                if t.starts_with('[') {
                    in_section = t == "[tool.poetry.scripts]";
                    continue;
                }
                if in_section {
                    if let Some(eq) = t.find('=') {
                        let key = t[..eq].trim().trim_matches('"');
                        if !key.is_empty() {
                            out.push(Command {
                                name: format!("poetry run {key}"),
                                command: format!("poetry run {key}"),
                                source: "python".into(),
                                category: String::new(),
                            });
                        }
                    }
                }
            }
            if !out.is_empty() {
                return out;
            }
        }
    }
    // 兜底：单文件入口
    for f in ["main.py", "app.py"] {
        if dir.join(f).is_file() {
            return vec![Command {
                name: format!("python {f}"),
                command: format!("python {f}"),
                source: "python".into(),
                category: "dev".into(),
            }];
        }
    }
    vec![]
}

fn detect_make(dir: &Path) -> Vec<Command> {
    let path = ["Makefile", "makefile"]
        .iter()
        .map(|f| dir.join(f))
        .find(|p| p.is_file());
    let path = match path {
        Some(p) => p,
        None => return vec![],
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return vec![],
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for line in text.lines() {
        // 配方行(以 tab/空格开头)、注释、无冒号行跳过
        if line.starts_with(|c: char| c.is_whitespace()) || line.starts_with('#') {
            continue;
        }
        let colon = match line.find(':') {
            Some(i) => i,
            None => continue,
        };
        let name = line[..colon].trim();
        let after = &line[colon..];
        // 变量赋值(:=)、伪目标(.xxx)、模式(%)、含空白或变量引用的多目标 → 跳过
        if name.is_empty()
            || name.starts_with('.')
            || name.contains('=')
            || name.contains('%')
            || name.contains('$')
            || name.contains(char::is_whitespace)
            || after.starts_with(":=")
        {
            continue;
        }
        if !seen.insert(name.to_string()) {
            continue;
        }
        out.push(Command {
            name: format!("make {name}"),
            command: format!("make {name}"),
            source: "make".to_string(),
            category: String::new(),
        });
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
    fn port_of_url_extracts_explicit_port() {
        assert_eq!(port_of_url("http://localhost:5173"), Some(5173));
        assert_eq!(port_of_url("http://localhost:1420/"), Some(1420));
        assert_eq!(port_of_url("http://127.0.0.1:3000/app?x=1"), Some(3000));
        assert_eq!(port_of_url("http://localhost"), None); // 无显式端口不臆测
        assert_eq!(port_of_url("https://example.com/path"), None);
    }

    #[test]
    fn dev_url_port_reads_tauri_conf() {
        let d = tmp("devport");
        fs::create_dir_all(d.join("src-tauri")).unwrap();
        fs::write(
            d.join("src-tauri").join("tauri.conf.json"),
            r#"{"build":{"devUrl":"http://localhost:5173"}}"#,
        )
        .unwrap();
        assert_eq!(dev_url_port(&d), Some(5173));

        // 非 tauri 目录 → None
        let d2 = tmp("devport_none");
        assert_eq!(dev_url_port(&d2), None);
    }

    #[test]
    fn passthrough_tauri_expands_subcommands() {
        let d = tmp("npm_tauri");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite","tauri":"tauri"}}"#).unwrap();
        fs::write(d.join("pnpm-lock.yaml"), "lockfileVersion: 9").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        // 裸 `pnpm run tauri` 不应出现；应展开为 dev/build 子命令
        assert!(!r.commands.iter().any(|c| c.command == "pnpm run tauri"));
        let dev = r.commands.iter().find(|c| c.name == "tauri dev").unwrap();
        assert_eq!(dev.command, "pnpm run tauri dev");
        assert_eq!(dev.category, "dev");
        let build = r.commands.iter().find(|c| c.name == "tauri build").unwrap();
        assert_eq!(build.command, "pnpm run tauri build");
        assert_eq!(build.category, "build");
        // 普通脚本不受影响
        assert!(r.commands.iter().any(|c| c.command == "pnpm run dev"));
    }

    #[test]
    fn passthrough_matches_body_not_name() {
        // `"desktop": "tauri"` —— 脚本名是 desktop，但体是 tauri，应按体展开
        let d = tmp("npm_renamed_passthrough");
        fs::write(d.join("package.json"), r#"{"scripts":{"desktop":"tauri"}}"#).unwrap();
        let r = scan_directory(d.to_str().unwrap());
        assert!(r.commands.iter().any(|c| c.command == "npm run desktop dev"));
        assert!(!r.commands.iter().any(|c| c.command == "npm run desktop"));
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

    #[test]
    fn cargo_project_offers_run_build_test() {
        let d = tmp("cargo");
        fs::write(d.join("Cargo.toml"), "[package]\nname=\"x\"").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"cargo run") && cmds.contains(&"cargo test"));
        let run = r.commands.iter().find(|c| c.command == "cargo run").unwrap();
        assert_eq!(run.category, "dev");
        assert_eq!(run.source, "cargo");
    }

    #[test]
    fn go_project_offers_run_build_test() {
        let d = tmp("go");
        fs::write(d.join("go.mod"), "module x\n").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"go run .") && cmds.contains(&"go test ./..."));
    }

    #[test]
    fn make_parses_top_level_targets() {
        let d = tmp("make");
        fs::write(
            d.join("Makefile"),
            "VAR := 1\n.PHONY: build\nbuild:\n\tgo build\ntest:\n\tgo test\n\t@echo done\n",
        )
        .unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let names: Vec<&str> = r.commands.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"make build") && names.contains(&"make test"));
        // 不把变量/伪目标/缩进配方行当成 target
        assert!(!names.iter().any(|n| n.contains("VAR") || n.contains(".PHONY") || n.contains("echo")));
    }

    #[test]
    fn compose_offers_up_down_logs() {
        let d = tmp("compose");
        fs::write(d.join("docker-compose.yml"), "services: {}\n").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"docker compose up") && cmds.contains(&"docker compose down"));
        assert_eq!(
            r.commands.iter().find(|c| c.command == "docker compose up").unwrap().category,
            "dev"
        );
    }

    #[test]
    fn composer_scripts_and_artisan() {
        let d = tmp("composer");
        fs::write(d.join("composer.json"), r#"{"scripts":{"lint":"phpcs"}}"#).unwrap();
        fs::write(d.join("artisan"), "#!/usr/bin/env php").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"composer run lint"));
        assert!(cmds.contains(&"php artisan serve"));
        assert_eq!(r.detected_sources, vec!["php"]);
    }

    #[test]
    fn composer_lifecycle_hooks_filtered() {
        // post-autoload-dump / pre-install-cmd 是 composer 自动触发的钩子,不是用户命令,应过滤掉
        let d = tmp("composer_hooks");
        fs::write(
            d.join("composer.json"),
            r#"{"scripts":{"post-autoload-dump":["@php think service:discover"],"test":"phpunit"}}"#,
        )
        .unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"composer run test"));
        assert!(!cmds.iter().any(|c| c.contains("post-autoload-dump")));
    }

    #[test]
    fn thinkphp_think_offers_run() {
        // ThinkPHP 项目:根目录有 think 控制台入口,且 composer scripts 只有钩子 → 应给出 php think run
        let d = tmp("thinkphp");
        fs::write(d.join("composer.json"), r#"{"scripts":{"post-autoload-dump":["@php think service:discover"]}}"#).unwrap();
        fs::write(d.join("think"), "#!/usr/bin/env php").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"php think run"));
        assert!(!cmds.iter().any(|c| c.contains("post-autoload-dump")));
    }

    #[test]
    fn php_generic_fallback_built_in_server() {
        // 无框架但有 public/index.php → php -S 兜底
        let d = tmp("php_generic");
        fs::create_dir_all(d.join("public")).unwrap();
        fs::write(d.join("public/index.php"), "<?php").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"php -S localhost:8000 -t public"));
    }

    #[test]
    fn maven_springboot_adds_run() {
        let d = tmp("maven");
        fs::write(d.join("pom.xml"), "<project><dependency>spring-boot-starter</dependency></project>").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"mvn spring-boot:run") && cmds.contains(&"mvn test"));
    }

    #[test]
    fn gradle_uses_wrapper_when_present() {
        let d = tmp("gradle");
        fs::write(d.join("build.gradle"), "plugins { id 'org.springframework.boot' }").unwrap();
        fs::write(d.join("gradlew"), "#!/bin/sh").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"./gradlew bootRun") && cmds.contains(&"./gradlew build"));
    }

    #[test]
    fn python_django_manage_py() {
        let d = tmp("py_django");
        fs::write(d.join("manage.py"), "# django").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"python manage.py runserver"));
    }

    #[test]
    fn python_poetry_scripts() {
        let d = tmp("py_poetry");
        fs::write(d.join("pyproject.toml"), "[tool.poetry.scripts]\nserve = \"app:main\"\n").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"poetry run serve"));
    }

    #[test]
    fn python_fallback_main_py() {
        let d = tmp("py_main");
        fs::write(d.join("requirements.txt"), "flask\n").unwrap();
        fs::write(d.join("main.py"), "print(1)").unwrap();
        let r = scan_directory(d.to_str().unwrap());
        // requirements.txt 不触发；main.py 兜底
        let cmds: Vec<&str> = r.commands.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"python main.py"));
    }

    #[test]
    fn name_collision_gets_source_suffix() {
        // npm 与 composer 同名脚本 → 第二个加 source 后缀，label 唯一
        let d = tmp("collide");
        fs::write(d.join("package.json"), r#"{"scripts":{"lint":"eslint"}}"#).unwrap();
        fs::write(d.join("composer.json"), r#"{"scripts":{"lint":"phpcs"}}"#).unwrap();
        let r = scan_directory(d.to_str().unwrap());
        let names: Vec<&str> = r.commands.iter().map(|c| c.name.as_str()).collect();
        let lint_count = names.iter().filter(|n| n.starts_with("lint")).count();
        assert_eq!(lint_count, 2);
        // 唯一性：无重复 name
        let uniq: HashSet<&str> = names.iter().copied().collect();
        assert_eq!(uniq.len(), names.len());
    }
}
