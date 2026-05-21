mod installer;
mod manifest;
mod modpack;

use installer::{InstallProgress, InstallSummary, ModAudit};
use manifest::Manifest;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

const MANIFEST_URL: &str = "https://www.hitnmis.gg/mc/extra-mods.json";

#[tauri::command]
async fn fetch_manifest() -> Result<Manifest, String> {
    manifest::fetch(MANIFEST_URL).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn detect_mods_dir() -> Result<Option<String>, String> {
    Ok(modpack::detect_mods_dir().map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn validate_mods_dir(path: String) -> Result<bool, String> {
    Ok(modpack::is_valid_mods_dir(&PathBuf::from(path)))
}

#[tauri::command]
async fn plan_install(mods_dir: String, manifest: Manifest) -> Result<InstallSummary, String> {
    installer::plan(&PathBuf::from(mods_dir), &manifest).map_err(|e| e.to_string())
}

#[tauri::command]
async fn audit_mods_dir(mods_dir: String, manifest: Manifest) -> Result<ModAudit, String> {
    installer::audit(&PathBuf::from(mods_dir), &manifest).map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_install(
    app: AppHandle,
    mods_dir: String,
    manifest: Manifest,
    skip_filenames: Vec<String>,
    also_delete: Vec<String>,
) -> Result<(), String> {
    let app_clone = app.clone();
    installer::run(
        &PathBuf::from(mods_dir),
        &manifest,
        skip_filenames,
        also_delete,
        move |progress: InstallProgress| {
            let _ = app_clone.emit("install-progress", &progress);
        },
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_mods_folder(mods_dir: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&mods_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&mods_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&mods_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            fetch_manifest,
            detect_mods_dir,
            validate_mods_dir,
            plan_install,
            run_install,
            open_mods_folder,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
