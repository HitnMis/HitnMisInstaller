use crate::manifest::{Manifest, ModEntry};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

const SIDECAR: &str = ".ascendancy-managed.json";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Sidecar {
    pub schema_version: u32,
    pub last_run: String,
    pub manifest_url: String,
    pub manifest_updated: String,
    pub filenames: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstallSummary {
    pub will_install: Vec<ModEntry>,
    pub will_remove_cleanup: Vec<String>,
    pub will_remove_orphaned: Vec<String>,
    pub previously_managed: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstallProgress {
    Started { total_mods: usize },
    CleanupRemoved { filename: String },
    DownloadStart { name: String, filename: String, index: usize, total: usize },
    DownloadProgress { filename: String, downloaded: u64, total: u64 },
    DownloadDone { filename: String, size_bytes: u64 },
    DownloadFailed { filename: String, error: String },
    Finished { installed: usize, removed: usize },
}

fn read_sidecar(mods_dir: &Path) -> Option<Sidecar> {
    let path = mods_dir.join(SIDECAR);
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_sidecar(mods_dir: &Path, manifest: &Manifest) -> anyhow::Result<()> {
    let sidecar = Sidecar {
        schema_version: 1,
        last_run: chrono::Utc::now().to_rfc3339(),
        manifest_url: "https://www.hitnmis.gg/mc/extra-mods.json".into(),
        manifest_updated: manifest.updated.clone(),
        filenames: manifest.mods.iter().map(|m| m.filename.clone()).collect(),
    };
    let json = serde_json::to_string_pretty(&sidecar)?;
    std::fs::write(mods_dir.join(SIDECAR), json)?;
    Ok(())
}

/// Compute what install would do without executing it.
pub fn plan(mods_dir: &Path, manifest: &Manifest) -> anyhow::Result<InstallSummary> {
    let previously_managed = read_sidecar(mods_dir)
        .map(|s| s.filenames)
        .unwrap_or_default();

    let current_filenames: Vec<String> =
        manifest.mods.iter().map(|m| m.filename.clone()).collect();

    let will_remove_cleanup: Vec<String> = manifest
        .cleanup
        .iter()
        .filter(|f| mods_dir.join(f).exists())
        .cloned()
        .collect();

    let will_remove_orphaned: Vec<String> = previously_managed
        .iter()
        .filter(|f| !current_filenames.contains(f) && mods_dir.join(f).exists())
        .cloned()
        .collect();

    let will_install = manifest.mods.clone();

    Ok(InstallSummary {
        will_install,
        will_remove_cleanup,
        will_remove_orphaned,
        previously_managed,
    })
}

/// Execute the install. Calls `on_progress` for each lifecycle event.
pub async fn run<F>(
    mods_dir: &Path,
    manifest: &Manifest,
    on_progress: F,
) -> anyhow::Result<()>
where
    F: Fn(InstallProgress) + Send + 'static + Clone,
{
    let total_mods = manifest.mods.len();
    on_progress(InstallProgress::Started { total_mods });

    let mut removed_count = 0;

    // Phase 1: explicit cleanup list
    for filename in &manifest.cleanup {
        let path = mods_dir.join(filename);
        if path.exists() {
            std::fs::remove_file(&path)?;
            removed_count += 1;
            on_progress(InstallProgress::CleanupRemoved {
                filename: filename.clone(),
            });
        }
    }

    // Phase 2: auto-cleanup of orphaned previously-managed files
    let previously_managed = read_sidecar(mods_dir)
        .map(|s| s.filenames)
        .unwrap_or_default();
    let current_filenames: Vec<String> =
        manifest.mods.iter().map(|m| m.filename.clone()).collect();
    for filename in &previously_managed {
        if !current_filenames.contains(filename) {
            let path = mods_dir.join(filename);
            if path.exists() {
                std::fs::remove_file(&path)?;
                removed_count += 1;
                on_progress(InstallProgress::CleanupRemoved {
                    filename: filename.clone(),
                });
            }
        }
    }

    // Phase 3: download each mod from the manifest
    let client = reqwest::Client::builder()
        .user_agent("HitnMis-Installer/0.1")
        .timeout(std::time::Duration::from_secs(120))
        .build()?;

    let mut installed_count = 0;
    for (i, m) in manifest.mods.iter().enumerate() {
        on_progress(InstallProgress::DownloadStart {
            name: m.name.clone(),
            filename: m.filename.clone(),
            index: i + 1,
            total: total_mods,
        });

        match download_mod(&client, m, mods_dir, on_progress.clone()).await {
            Ok(size) => {
                installed_count += 1;
                on_progress(InstallProgress::DownloadDone {
                    filename: m.filename.clone(),
                    size_bytes: size,
                });
            }
            Err(e) => {
                on_progress(InstallProgress::DownloadFailed {
                    filename: m.filename.clone(),
                    error: e.to_string(),
                });
            }
        }
    }

    // Phase 4: write sidecar
    write_sidecar(mods_dir, manifest)?;

    on_progress(InstallProgress::Finished {
        installed: installed_count,
        removed: removed_count,
    });
    Ok(())
}

async fn download_mod<F>(
    client: &reqwest::Client,
    mod_entry: &ModEntry,
    mods_dir: &Path,
    on_progress: F,
) -> anyhow::Result<u64>
where
    F: Fn(InstallProgress) + Send + 'static,
{
    let response = client.get(&mod_entry.url).send().await?;
    if !response.status().is_success() {
        anyhow::bail!("HTTP {}", response.status());
    }

    let total = response.content_length().unwrap_or(0);
    let dest = mods_dir.join(&mod_entry.filename);
    let tmp = mods_dir.join(format!("{}.partial", mod_entry.filename));

    let mut file = tokio::fs::File::create(&tmp).await?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        downloaded += chunk.len() as u64;
        file.write_all(&chunk).await?;

        // Throttle progress emissions to ~every 64 KB to avoid event spam
        if downloaded - last_emit > 65_536 || downloaded == total {
            on_progress(InstallProgress::DownloadProgress {
                filename: mod_entry.filename.clone(),
                downloaded,
                total,
            });
            last_emit = downloaded;
        }
    }

    file.flush().await?;
    drop(file);

    // Atomic-ish rename: remove the existing file first (Windows can't rename onto existing)
    if dest.exists() {
        std::fs::remove_file(&dest)?;
    }
    std::fs::rename(&tmp, &dest)?;

    Ok(downloaded)
}
