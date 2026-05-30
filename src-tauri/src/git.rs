use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBrief {
    pub is_repo: bool,
    pub branch: String,
    pub head_short: String,
    pub detached: bool,
    pub dirty: u32,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub status: String,
    pub path: String,
    /// 行数 sentinel：>=0 实际；-1 二进制；-2 未跟踪(numstat 无此行)。
    pub added: i64,
    pub deleted: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub rel_time: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDetail {
    pub is_repo: bool,
    pub repo_root: String,
    pub branch: String,
    pub head_short: String,
    pub detached: bool,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
    pub files: Vec<GitFile>,
    pub commits: Vec<GitCommit>,
}

/// 在 dir 下跑 `git <args>`。返回 (成功且退出码 0, stdout 去尾空白)。
/// git 没装 / 非零退出 → (false, "")。所有 git 交互的唯一入口。
/// `core.quotePath=false`：让中文/非 ASCII 路径原样输出(不转义成 \xxx)，
/// 既保证颜值，也保证 status 与 numstat 的 path 字符串能精确匹配。
fn git(dir: &str, args: &[&str]) -> (bool, String) {
    match Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "core.quotePath=false"])
        .args(args)
        .output()
    {
        Ok(out) if out.status.success() => (
            true,
            String::from_utf8_lossy(&out.stdout).trim_end().to_string(),
        ),
        _ => (false, String::new()),
    }
}

/// §3.0(a) 是否仓库 + repo_root。非仓库/无 git → None。
fn repo_root(dir: &str) -> Option<String> {
    let (ok, out) = git(dir, &["rev-parse", "--show-toplevel"]);
    if ok && !out.is_empty() {
        Some(out)
    } else {
        None
    }
}

/// §3.0(b) 分支名。返回 (branch, head_short, detached)。
/// 用 symbolic-ref —— 空仓库(刚 init 没 commit)也能返回 "main"；
/// 不用 rev-parse --abbrev-ref(空仓库返回字面量 "HEAD")。
fn branch_info(dir: &str) -> (String, String, bool) {
    let (ok, name) = git(dir, &["symbolic-ref", "--short", "HEAD"]);
    if ok && !name.is_empty() {
        return (name, String::new(), false);
    }
    // symbolic-ref 失败 = detached HEAD
    let (_ok, short) = git(dir, &["rev-parse", "--short", "HEAD"]);
    (String::new(), short, true)
}

/// §3.0(c) ahead/behind。`HEAD...@{u}` 输出 `<ahead>\t<behind>`(左=HEAD独有=ahead)。
/// 无 upstream / 无 commit → (0,0,false)。
fn ahead_behind(dir: &str) -> (u32, u32, bool) {
    let (ok, out) = git(dir, &["rev-list", "--count", "--left-right", "HEAD...@{u}"]);
    if !ok {
        return (0, 0, false);
    }
    let mut it = out.split_whitespace();
    let ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (ahead, behind, true)
}

pub fn git_brief(path: &str) -> GitBrief {
    let Some(_root) = repo_root(path) else {
        return GitBrief {
            is_repo: false,
            branch: String::new(),
            head_short: String::new(),
            detached: false,
            dirty: 0,
            ahead: 0,
            behind: 0,
            has_upstream: false,
        };
    };
    let (branch, head_short, detached) = branch_info(path);
    let (ahead, behind, has_upstream) = ahead_behind(path);
    // -uall：逐个未跟踪文件计数，与 detail 的逐项口径一致(避免 chip ●3 / 面板 5 行)。
    let (_ok, status) = git(path, &["status", "--porcelain", "-uall"]);
    let dirty = if status.is_empty() {
        0
    } else {
        status.lines().count() as u32
    };
    GitBrief {
        is_repo: true,
        branch,
        head_short,
        detached,
        dirty,
        ahead,
        behind,
        has_upstream,
    }
}

/// 读 numstat → {path: (added, deleted)}。二进制行 `-\t-\t` 记 (-1,-1)。
/// cached=true 读已暂存(`--cached`)，否则读工作区。
fn numstat_map(dir: &str, cached: bool) -> HashMap<String, (i64, i64)> {
    let args: &[&str] = if cached {
        &["diff", "--cached", "--numstat"]
    } else {
        &["diff", "--numstat"]
    };
    let (_ok, out) = git(dir, args);
    let mut m = HashMap::new();
    for line in out.lines() {
        let mut it = line.split('\t');
        let a = it.next().unwrap_or("");
        let d = it.next().unwrap_or("");
        let p = it.next().unwrap_or("");
        if p.is_empty() {
            continue;
        }
        let added = if a == "-" { -1 } else { a.parse().unwrap_or(0) };
        let deleted = if d == "-" { -1 } else { d.parse().unwrap_or(0) };
        m.insert(p.to_string(), (added, deleted));
    }
    m
}

/// 解析 `status --porcelain -uall` 每行 → GitFile。
/// 未跟踪(`??`)在 numstat 里没有对应行，显式记 (-2,-2)。
fn collect_files(dir: &str) -> Vec<GitFile> {
    let (_ok, status) = git(dir, &["status", "--porcelain", "-uall"]);
    if status.is_empty() {
        return vec![];
    }
    let unstaged = numstat_map(dir, false);
    let staged = numstat_map(dir, true);
    let mut files = Vec::new();
    for line in status.lines() {
        if line.len() < 3 {
            continue;
        }
        // 前两字节是 XY 状态码(ASCII)，第3字节是空格，其后是路径(可含 UTF-8)。
        let st = line[0..2].trim().to_string();
        let rest = &line[3..];
        // rename 形如 "old -> new"，取箭头后的新路径。
        let path = rest.rsplit(" -> ").next().unwrap_or(rest).to_string();
        let (added, deleted) = if st == "??" {
            (-2, -2)
        } else {
            unstaged
                .get(&path)
                .or_else(|| staged.get(&path))
                .copied()
                .unwrap_or((0, 0))
        };
        files.push(GitFile {
            status: st,
            path,
            added,
            deleted,
        });
    }
    files
}

/// 最近 30 条提交。用 \x1f(单元分隔符)切字段，免标题里的空格/符号干扰。
fn collect_commits(dir: &str) -> Vec<GitCommit> {
    let (ok, out) = git(
        dir,
        &["log", "-n", "30", "--pretty=format:%h\x1f%s\x1f%an\x1f%cr"],
    );
    if !ok || out.is_empty() {
        return vec![];
    }
    out.lines()
        .filter_map(|line| {
            let mut it = line.split('\x1f');
            let hash = it.next()?.to_string();
            Some(GitCommit {
                hash,
                subject: it.next().unwrap_or("").to_string(),
                author: it.next().unwrap_or("").to_string(),
                rel_time: it.next().unwrap_or("").to_string(),
            })
        })
        .collect()
}

pub fn git_detail(path: &str) -> GitDetail {
    let Some(repo_root) = repo_root(path) else {
        return GitDetail {
            is_repo: false,
            repo_root: String::new(),
            branch: String::new(),
            head_short: String::new(),
            detached: false,
            ahead: 0,
            behind: 0,
            has_upstream: false,
            files: vec![],
            commits: vec![],
        };
    };
    let (branch, head_short, detached) = branch_info(path);
    let (ahead, behind, has_upstream) = ahead_behind(path);
    GitDetail {
        is_repo: true,
        repo_root,
        branch,
        head_short,
        detached,
        ahead,
        behind,
        has_upstream,
        files: collect_files(path),
        commits: collect_commits(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("quay_git_test_{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 跑 git 并断言成功；统一注入身份 + 默认分支 main，不依赖宿主全局 config。
    fn g(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.email=t@quay.test",
                "-c",
                "user.name=quay",
                "-c",
                "init.defaultBranch=main",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&status.stderr)
        );
    }

    #[test]
    fn non_repo_dir() {
        let d = tmp("nonrepo");
        let b = git_brief(d.to_str().unwrap());
        assert!(!b.is_repo);
    }

    #[test]
    fn empty_repo_branch_is_main() {
        // 🔴 刚 init 没 commit：symbolic-ref 能拿到 main；rev-parse --abbrev-ref 会返回 "HEAD"。
        let d = tmp("empty");
        g(&d, &["init"]);
        let b = git_brief(d.to_str().unwrap());
        assert!(b.is_repo);
        assert_eq!(b.branch, "main");
        assert!(!b.detached);
        assert_eq!(b.dirty, 0);
        assert!(!b.has_upstream);
    }

    #[test]
    fn dirty_count_matches_files_uall() {
        let d = tmp("dirty");
        g(&d, &["init"]);
        fs::write(d.join("a.txt"), "1\n").unwrap();
        g(&d, &["add", "."]);
        g(&d, &["commit", "-m", "init"]);
        // 改已跟踪 + 暂存一个新文件 + 一个未跟踪
        fs::write(d.join("a.txt"), "1\n2\n").unwrap();
        fs::write(d.join("b.txt"), "x\n").unwrap();
        g(&d, &["add", "b.txt"]);
        fs::write(d.join("c.txt"), "y\n").unwrap();
        let b = git_brief(d.to_str().unwrap());
        assert_eq!(b.dirty, 3, "a(改) + b(暂存) + c(未跟踪) = 3");
    }

    #[test]
    fn detached_head() {
        let d = tmp("detached");
        g(&d, &["init"]);
        fs::write(d.join("a.txt"), "1\n").unwrap();
        g(&d, &["add", "."]);
        g(&d, &["commit", "-m", "c1"]);
        fs::write(d.join("a.txt"), "2\n").unwrap();
        g(&d, &["commit", "-am", "c2"]);
        // checkout 到 c1 的 hash → detached
        let out = Command::new("git")
            .arg("-C")
            .arg(&d)
            .args(["rev-parse", "HEAD~1"])
            .output()
            .unwrap();
        let c1 = String::from_utf8_lossy(&out.stdout).trim().to_string();
        g(&d, &["checkout", &c1]);
        let b = git_brief(d.to_str().unwrap());
        assert!(b.detached);
        assert!(!b.head_short.is_empty());
        assert_eq!(b.branch, "");
    }

    #[test]
    fn ahead_two_behind_one_direction() {
        // 🔴 验证 HEAD...@{u} 左=ahead 不搞反。
        let remote = tmp("ab_remote");
        g(&remote, &["init", "--bare"]);
        let remote_url = remote.to_str().unwrap();

        // local clone + 初始 commit + push -u
        let local = tmp("ab_local");
        g(&local, &["clone", remote_url, "."]);
        fs::write(local.join("a.txt"), "0\n").unwrap();
        g(&local, &["add", "."]);
        g(&local, &["commit", "-m", "base"]);
        g(&local, &["push", "-u", "origin", "main"]);

        // 另一个 clone 推进远程 +1（制造 behind 来源）
        let other = tmp("ab_other");
        g(&other, &["clone", remote_url, "."]);
        fs::write(other.join("r.txt"), "r\n").unwrap();
        g(&other, &["add", "."]);
        g(&other, &["commit", "-m", "remote-1"]);
        g(&other, &["push", "origin", "main"]);

        // local fetch（拿到 remote 新 commit = behind 1），本地再 +2 commit（ahead 2，不 push）
        g(&local, &["fetch"]);
        fs::write(local.join("a.txt"), "1\n").unwrap();
        g(&local, &["commit", "-am", "local-1"]);
        fs::write(local.join("a.txt"), "2\n").unwrap();
        g(&local, &["commit", "-am", "local-2"]);

        let b = git_brief(local.to_str().unwrap());
        assert!(b.has_upstream);
        assert_eq!(b.ahead, 2, "本地领先 2");
        assert_eq!(b.behind, 1, "落后远程 1");
    }

    #[test]
    fn untracked_file_has_sentinel_linecount() {
        // 🔴 numstat 不含未跟踪文件，必须显式 (-2,-2)，别落成 0/0。
        let d = tmp("untracked");
        g(&d, &["init"]);
        fs::write(d.join("a.txt"), "1\n2\n").unwrap();
        g(&d, &["add", "."]);
        g(&d, &["commit", "-m", "init"]);
        fs::write(d.join("a.txt"), "1\n2\n3\n4\n").unwrap(); // 已跟踪 +2
        fs::write(d.join("new.txt"), "n\n").unwrap(); // 未跟踪
        let det = git_detail(d.to_str().unwrap());
        let nf = det.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(nf.status, "??");
        assert_eq!(nf.added, -2);
        assert_eq!(nf.deleted, -2);
        let af = det.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert!(af.added >= 0, "已跟踪文件应有真实行数");
    }

    #[test]
    fn binary_file_has_minus_one() {
        let d = tmp("binary");
        g(&d, &["init"]);
        fs::write(d.join("bin.dat"), [0u8, 1, 2, 0, 3]).unwrap();
        g(&d, &["add", "."]);
        g(&d, &["commit", "-m", "init"]);
        fs::write(d.join("bin.dat"), [0u8, 9, 9, 0, 9, 9]).unwrap();
        let det = git_detail(d.to_str().unwrap());
        let bf = det.files.iter().find(|f| f.path == "bin.dat").unwrap();
        assert_eq!(bf.added, -1, "二进制 numstat 为 -");
        assert_eq!(bf.deleted, -1);
    }

    #[test]
    fn commit_subject_with_spaces_and_cjk_intact() {
        let d = tmp("log");
        g(&d, &["init"]);
        fs::write(d.join("a.txt"), "1\n").unwrap();
        g(&d, &["add", "."]);
        g(&d, &["commit", "-m", "修复 PTY kill 自杀 bug (含空格)"]);
        let det = git_detail(d.to_str().unwrap());
        assert_eq!(det.commits.len(), 1);
        assert_eq!(det.commits[0].subject, "修复 PTY kill 自杀 bug (含空格)");
        assert!(!det.commits[0].hash.is_empty());
        assert!(!det.commits[0].rel_time.is_empty());
    }

    #[test]
    fn empty_repo_detail_no_commits_no_panic() {
        let d = tmp("empty_detail");
        g(&d, &["init"]);
        let det = git_detail(d.to_str().unwrap());
        assert!(det.is_repo);
        assert_eq!(det.branch, "main");
        assert!(det.commits.is_empty());
        assert!(det.files.is_empty());
    }
}
