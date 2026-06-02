use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub name: String,
    pub command: String,
    pub source: String,
    #[serde(default)]
    pub category: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMember {
    pub label: String,
    pub cwd: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub members: Vec<GroupMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub directories: Vec<Directory>,
    #[serde(default, rename = "manualCommands")]
    pub manual_commands: Vec<CommandEntry>,
    #[serde(default, rename = "commandGroups")]
    pub command_groups: Vec<CommandGroup>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub projects: Vec<Project>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub commands: Vec<Command>,
    #[serde(rename = "dirExists")]
    pub dir_exists: bool,
    #[serde(rename = "detectedSources")]
    pub detected_sources: Vec<String>,
}
