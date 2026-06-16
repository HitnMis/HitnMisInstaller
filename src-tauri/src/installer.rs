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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Ok,
    NeedsUpdate,
    NeedsInstall,
}

#[derive(Debug, Serialize, Clone)]
pub struct ManagedRow {
    pub name: String,
    pub filename: String,
    pub status: FileStatus,
    pub expected_size: u64,
    pub actual_size: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct UnknownJar {
    pub filename: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ModAudit {
    pub managed: Vec<ManagedRow>,
    pub will_remove_cleanup: Vec<String>,
    pub will_remove_retired: Vec<String>,
    /// Known-bad jars (matched a `foreign_mods.block` glob) — these stop you
    /// connecting to the server. Recommended for removal, pre-selected in the UI.
    pub blocked_jars: Vec<UnknownJar>,
    /// Jars not in the base-pack allowlist (`foreign_mods.expected`) and not
    /// explicitly allowed. Only populated when an allowlist is published.
    pub foreign_jars: Vec<UnknownJar>,
    /// Everything else in the folder (the base modpack — left untouched).
    pub unknown_jars: Vec<UnknownJar>,
    pub previously_managed: Vec<String>,
}

/// Case-insensitive wildcard match. Supports `*` (any run, incl. empty); every
/// other char is literal. Enough for the globs we ship (e.g. "ritchies*.jar").
fn glob_match(pattern: &str, name: &str) -> bool {
    let pat: Vec<char> = pattern.to_ascii_lowercase().chars().collect();
    let txt: Vec<char> = name.to_ascii_lowercase().chars().collect();
    // classic two-pointer wildcard matcher with backtracking on '*'
    let (mut p, mut t) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while t < txt.len() {
        if p < pat.len() && pat[p] != '*' && pat[p] == txt[t] {
            p += 1;
            t += 1;
        } else if p < pat.len() && pat[p] == '*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if let Some(sp) = star {
            p = sp + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pat.len() && pat[p] == '*' {
        p += 1;
    }
    p == pat.len()
}

fn matches_any(globs: &[String], name: &str) -> bool {
    globs.iter().any(|g| glob_match(g, name))
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
    DownloadSkipped { filename: String, reason: String },
    DownloadProgress { filename: String, downloaded: u64, total: u64 },
    DownloadDone { filename: String, size_bytes: u64 },
    DownloadFailed { filename: String, error: String },
    Finished { installed: usize, skipped: usize, removed: usize },
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

/// Plan the install (legacy path, kept for compat — UI now uses audit).
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

/// Audit the mods folder against the manifest.
/// Categorises every manifest entry by status and lists unrelated jars in the folder.
pub fn audit(mods_dir: &Path, manifest: &Manifest) -> anyhow::Result<ModAudit> {
    let previously_managed = read_sidecar(mods_dir)
        .map(|s| s.filenames)
        .unwrap_or_default();

    // Per-mod status
    let mut managed = Vec::new();
    for m in &manifest.mods {
        let path = mods_dir.join(&m.filename);
        let actual_size = std::fs::metadata(&path).ok().map(|md| md.len());
        let status = match actual_size {
            None => FileStatus::NeedsInstall,
            Some(sz) if m.size > 0 && sz != m.size => FileStatus::NeedsUpdate,
            Some(_) => FileStatus::Ok,
        };
        managed.push(ManagedRow {
            name: m.name.clone(),
            filename: m.filename.clone(),
            status,
            expected_size: m.size,
            actual_size,
        });
    }

    // Removal lists
    let will_remove_cleanup: Vec<String> = manifest
        .cleanup
        .iter()
        .filter(|f| mods_dir.join(f).exists())
        .cloned()
        .collect();

    let current_filenames: Vec<String> =
        manifest.mods.iter().map(|m| m.filename.clone()).collect();

    let will_remove_retired: Vec<String> = previously_managed
        .iter()
        .filter(|f| !current_filenames.contains(f) && mods_dir.join(f).exists())
        .cloned()
        .collect();

    // Unknown jars: any *.jar in the folder that isn't in manifest, cleanup,
    // retired list, or sidecar.
    let mut known: std::collections::HashSet<String> =
        current_filenames.iter().cloned().collect();
    for f in &manifest.cleanup {
        known.insert(f.clone());
    }
    for f in &previously_managed {
        known.insert(f.clone());
    }

    // Foreign-mod config (manifest schema v3+). Absent -> empty lists, so every
    // non-managed jar falls through to unknown_jars exactly like before.
    let fm = manifest.foreign_mods.clone().unwrap_or_default();
    let has_allowlist = !fm.expected.is_empty();
    let expected: std::collections::HashSet<&str> =
        fm.expected.iter().map(|s| s.as_str()).collect();

    let mut blocked_jars = Vec::new();
    let mut foreign_jars = Vec::new();
    let mut unknown_jars = Vec::new();
    if let Ok(entries) = std::fs::read_dir(mods_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            if !name.to_ascii_lowercase().ends_with(".jar") {
                continue;
            }
            if known.contains(name) {
                continue;
            }
            let size = path.metadata().map(|m| m.len()).unwrap_or(0);
            let jar = UnknownJar { filename: name.to_string(), size };
            // 1) known-bad glob -> always flagged as blocked
            if matches_any(&fm.block, name) {
                blocked_jars.push(jar);
            // 2) with an allowlist, anything not expected and not allowed is foreign
            } else if has_allowlist && !expected.contains(name) && !matches_any(&fm.allow, name) {
                foreign_jars.push(jar);
            // 3) otherwise it's part of the base modpack (left untouched)
            } else {
                unknown_jars.push(jar);
            }
        }
    }
    blocked_jars.sort_by(|a, b| a.filename.cmp(&b.filename));
    foreign_jars.sort_by(|a, b| a.filename.cmp(&b.filename));
    unknown_jars.sort_by(|a, b| a.filename.cmp(&b.filename));

    Ok(ModAudit {
        managed,
        will_remove_cleanup,
        will_remove_retired,
        blocked_jars,
        foreign_jars,
        unknown_jars,
        previously_managed,
    })
}

/// Execute the install based on user choices.
/// `skip_filenames` — files the audit said are OK (don't re-download).
/// `also_delete` — user-checked unknown jars to remove.
pub async fn run<F>(
    mods_dir: &Path,
    manifest: &Manifest,
    skip_filenames: Vec<String>,
    also_delete: Vec<String>,
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

    // Phase 3: user-selected unknown deletions
    for filename in &also_delete {
        let path = mods_dir.join(filename);
        if path.exists() {
            std::fs::remove_file(&path)?;
            removed_count += 1;
            on_progress(InstallProgress::CleanupRemoved {
                filename: filename.clone(),
            });
        }
    }

    // Phase 4: download each mod, skipping the ones marked OK
    let client = reqwest::Client::builder()
        .user_agent("HitnMis-Installer/0.2")
        .timeout(std::time::Duration::from_secs(120))
        .build()?;

    let skip_set: std::collections::HashSet<String> = skip_filenames.into_iter().collect();
    let mut installed_count = 0;
    let mut skipped_count = 0;

    for (i, m) in manifest.mods.iter().enumerate() {
        if skip_set.contains(&m.filename) {
            skipped_count += 1;
            on_progress(InstallProgress::DownloadSkipped {
                filename: m.filename.clone(),
                reason: "already correct".into(),
            });
            continue;
        }

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

    // Phase 5: write sidecar
    write_sidecar(mods_dir, manifest)?;

    on_progress(InstallProgress::Finished {
        installed: installed_count,
        skipped: skipped_count,
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

    if dest.exists() {
        std::fs::remove_file(&dest)?;
    }
    std::fs::rename(&tmp, &dest)?;

    Ok(downloaded)
}
