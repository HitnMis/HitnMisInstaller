use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModEntry {
    pub name: String,
    pub filename: String,
    pub url: String,
    #[serde(default)]
    pub size: u64,
}

/// Optional config (manifest schema v3+) controlling how the audit treats
/// jars that aren't part of the pack or our extras. `block` jars are known to
/// break the server connection (e.g. ritchiesprojectilelib*); `expected` is the
/// full base-pack jar list that lets us tell a legit base mod from a foreign one.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ForeignMods {
    #[serde(default)]
    pub mode: Option<u32>,
    #[serde(default)]
    pub allow_player_choice: Option<bool>,
    #[serde(default)]
    pub block: Vec<String>,
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub expected: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Manifest {
    pub schema_version: u32,
    pub name: String,
    pub modpack: String,
    pub updated: String,
    #[serde(default)]
    pub cleanup: Vec<String>,
    pub mods: Vec<ModEntry>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub foreign_mods: Option<ForeignMods>,
}

pub async fn fetch(url: &str) -> anyhow::Result<Manifest> {
    let client = reqwest::Client::builder()
        .user_agent("HitnMis-Installer/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let response = client.get(url).send().await?;
    if !response.status().is_success() {
        anyhow::bail!("manifest fetch failed: HTTP {}", response.status());
    }
    let manifest: Manifest = response.json().await?;
    Ok(manifest)
}
