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
        detect_composer, detect_maven, detect_gradle, detect_python,
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

fn detect_composer(dir: &Path) -> Vec<Command> {
    let mut out = Vec::new();
    let cj = dir.join("composer.json");
    if cj.is_file() {
        if let Ok(text) = std::fs::read_to_string(&cj) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(obj) = v.get("scripts").and_then(|s| s.as_object()) {
                    for name in obj.keys() {
                        out.push(Command {
                            name: name.clone(),
                            command: format!("composer run {name}"),
                            source: "composer".to_string(),
                            category: String::new(),
                        });
                    }
                }
            }
        }
    }
    if dir.join("artisan").is_file() {
        out.push(Command { name: "php artisan serve".into(), command: "php artisan serve".into(), source: "composer".into(), category: "dev".into() });
        out.push(Command { name: "php artisan migrate".into(), command: "php artisan migrate".into(), source: "composer".into(), category: "data".into() });
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
