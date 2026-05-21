use std::path::{Path, PathBuf};

/// Try the well-known launcher paths to find a Create: Ultimate Selection 2 mods folder.
/// Returns the first one whose parent instance directory matches the modpack name.
pub fn detect_mods_dir() -> Option<PathBuf> {
    let candidates = build_search_patterns();
    for pattern in candidates {
        if let Ok(paths) = glob::glob(&pattern) {
            for path in paths.flatten() {
                if path.is_dir() {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// Check whether a given path is plausibly a Minecraft `mods/` folder.
/// Heuristic: directory exists, is named "mods", parent has typical MC files.
pub fn is_valid_mods_dir(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    if path.file_name().and_then(|n| n.to_str()) != Some("mods") {
        return false;
    }
    if let Some(parent) = path.parent() {
        if parent.join("options.txt").exists()
            || parent.join("config").is_dir()
            || parent.join("saves").is_dir()
            || parent.join("minecraftinstance.json").exists()
            || parent.join("instance.cfg").exists()
        {
            return true;
        }
    }
    // Looser fallback: bare directory named "mods" — let user override
    true
}

fn build_search_patterns() -> Vec<String> {
    let mut patterns = Vec::new();

    if let Some(user_dirs) = directories::UserDirs::new() {
        let home = user_dirs.home_dir().to_path_buf();
        patterns.push(format!(
            "{}/curseforge/minecraft/Instances/*Ultimate Selection 2*/mods",
            home.display()
        ));
        patterns.push(format!(
            "{}/Documents/curseforge/minecraft/Instances/*Ultimate Selection 2*/mods",
            home.display()
        ));
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        patterns.push(format!(
            "{}/PrismLauncher/instances/*Ultimate Selection 2*/.minecraft/mods",
            appdata
        ));
        patterns.push(format!(
            "{}/PrismLauncher/instances/*Ultimate Selection 2*/minecraft/mods",
            appdata
        ));
        patterns.push(format!(
            "{}/PolyMC/instances/*Ultimate Selection 2*/.minecraft/mods",
            appdata
        ));
    }

    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        patterns.push(format!(
            "{}/.curseforge/minecraft/Instances/*Ultimate Selection 2*/mods",
            localappdata
        ));
        patterns.push(format!(
            "{}/Programs/overwolf/overwolf-2/app-storage/Game Library/Minecraft/Instances/*Ultimate Selection 2*/mods",
            localappdata
        ));
    }

    patterns
}
