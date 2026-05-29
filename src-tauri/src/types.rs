use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Script {
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Directory {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandEntry {
    pub id: String,
    pub label: String,
    pub cwd: String,
    pub command: String,
    #[serde(default)]
    pub long: bool,
    #[serde(default, rename = "confirmBeforeRun")]
    pub confirm_before_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub directories: Vec<Directory>,
    #[serde(default, rename = "manualCommands")]
    pub manual_commands: Vec<CommandEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub projects: Vec<Project>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub scripts: Vec<Script>,
    #[serde(rename = "dirExists")]
    pub dir_exists: bool,
    #[serde(rename = "hasPackageJson")]
    pub has_package_json: bool,
}
