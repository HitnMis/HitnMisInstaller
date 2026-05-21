use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModEntry {
    pub name: String,
    pub filename: String,
    pub url: String,
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
