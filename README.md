# HitnMis Modpack Installer

A tiny desktop app that installs the **Ascendancy** server-side extras on top of an existing **Create: Ultimate Selection 2** modpack install. Built with [Tauri](https://tauri.app/) (Rust + WebView).

## What it does

The modded MC server at `create.hitnmis.gg` runs a stock copy of [Create: Ultimate Selection 2](https://www.curseforge.com/minecraft/modpacks/create-ultimate-selection-2) (MC 1.21.1 / NeoForge) plus ~12 extra mods we picked to round out the experience. This app drops those extras into a player's existing modpack install so they can connect.

On every run, the app:
1. Fetches the live mod manifest from `https://www.hitnmis.gg/mc/extra-mods.json`
2. Auto-detects the player's Create: Ultimate Selection 2 mods folder (CurseForge / Prism Launcher / custom path)
3. Shows a **diff preview** — what will be installed, what will be removed, why
4. Applies the changes with live progress bars
5. Writes a sidecar tracker so future runs can auto-remove retired mods

Mod list lives in [`extra-mods.json`](https://github.com/HitnMis/HitnMisWebsite/blob/main/public/mc/extra-mods.json) on the website repo — editing the JSON is the only thing maintainers do to ship a mod change.

## Releases

Download the latest installer from [Releases](https://github.com/HitnMis/HitnMisInstaller/releases/latest).

The app auto-updates itself on launch when a new version is published.

## Development

Prereqs:
- Node.js 20+ and npm
- Rust toolchain (rustup + cargo) — only needed for local desktop builds; CI handles release builds without local Rust
- On Windows, you also need the **MSVC Build Tools** (~6 GB) for local Rust compilation

Setup:
```bash
npm install
npm run tauri dev    # local dev build with hot reload (requires Rust)
```

If you don't have Rust locally, you can still:
- Edit and type-check the TypeScript / React frontend (`npm run build`)
- Edit Rust modules under `src-tauri/src/` — CI will compile on push

## Architecture

```
HitnMisInstaller/
├── src/                  # React frontend (TypeScript + Vite)
│   ├── App.tsx           # single-file state machine: home → detect → preview → installing → done
│   └── App.css
└── src-tauri/            # Rust backend
    ├── src/
    │   ├── lib.rs        # Tauri commands exposed to JS
    │   ├── manifest.rs   # fetch + types for extra-mods.json
    │   ├── modpack.rs    # auto-detect CurseForge/Prism instance
    │   └── installer.rs  # plan + execute install, write sidecar
    ├── Cargo.toml
    └── tauri.conf.json   # app metadata + updater config
```

The Rust side handles every operation that needs filesystem or network. The React side renders state and listens for `install-progress` events emitted from Rust.

## License

MIT
