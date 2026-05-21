import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

type ModEntry = { name: string; filename: string; url: string };
type Manifest = {
  schema_version: number;
  name: string;
  modpack: string;
  updated: string;
  cleanup: string[];
  mods: ModEntry[];
  notes?: string | null;
};
type InstallSummary = {
  will_install: ModEntry[];
  will_remove_cleanup: string[];
  will_remove_orphaned: string[];
  previously_managed: string[];
};

type ProgressEvent =
  | { kind: "started"; total_mods: number }
  | { kind: "cleanup_removed"; filename: string }
  | { kind: "download_start"; name: string; filename: string; index: number; total: number }
  | { kind: "download_progress"; filename: string; downloaded: number; total: number }
  | { kind: "download_done"; filename: string; size_bytes: number }
  | { kind: "download_failed"; filename: string; error: string }
  | { kind: "finished"; installed: number; removed: number };

type Screen = "home" | "detect" | "preview" | "installing" | "done" | "error";

type ModStatus = "pending" | "downloading" | "done" | "failed";
type ModRow = {
  name: string;
  filename: string;
  status: ModStatus;
  downloaded: number;
  total: number;
  error?: string;
};

const SERVER_ADDRESS = "create.hitnmis.gg";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [modsDir, setModsDir] = useState<string | null>(null);
  const [summary, setSummary] = useState<InstallSummary | null>(null);
  const [rows, setRows] = useState<ModRow[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Listen for install progress from Rust backend
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<ProgressEvent>("install-progress", (e) => {
      const ev = e.payload;
      switch (ev.kind) {
        case "started":
          break;
        case "cleanup_removed":
          setRemoved((prev) => [...prev, ev.filename]);
          break;
        case "download_start":
          setRows((prev) =>
            prev.map((r) =>
              r.filename === ev.filename ? { ...r, status: "downloading" } : r
            )
          );
          break;
        case "download_progress":
          setRows((prev) =>
            prev.map((r) =>
              r.filename === ev.filename
                ? { ...r, downloaded: ev.downloaded, total: ev.total }
                : r
            )
          );
          break;
        case "download_done":
          setRows((prev) =>
            prev.map((r) =>
              r.filename === ev.filename
                ? {
                    ...r,
                    status: "done",
                    downloaded: ev.size_bytes,
                    total: ev.size_bytes,
                  }
                : r
            )
          );
          break;
        case "download_failed":
          setRows((prev) =>
            prev.map((r) =>
              r.filename === ev.filename
                ? { ...r, status: "failed", error: ev.error }
                : r
            )
          );
          break;
        case "finished":
          setScreen("done");
          break;
      }
    }).then((u) => (unlisten = u));
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  async function startFlow() {
    setError(null);
    setBusy(true);
    try {
      const m = await invoke<Manifest>("fetch_manifest");
      setManifest(m);
      const detected = await invoke<string | null>("detect_mods_dir");
      if (detected) {
        setModsDir(detected);
        const plan = await invoke<InstallSummary>("plan_install", {
          modsDir: detected,
          manifest: m,
        });
        setSummary(plan);
        setScreen("preview");
      } else {
        setScreen("detect");
      }
    } catch (e) {
      setError(`${e}`);
      setScreen("error");
    } finally {
      setBusy(false);
    }
  }

  async function pickFolder() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Pick your modpack's mods/ folder",
    });
    if (!picked || Array.isArray(picked)) return;
    setBusy(true);
    try {
      const ok = await invoke<boolean>("validate_mods_dir", { path: picked });
      if (!ok) {
        setError(
          `That doesn't look like a valid mods folder. Make sure the folder is named "mods" and is inside your Create: Ultimate Selection 2 instance.`
        );
        return;
      }
      setModsDir(picked);
      if (manifest) {
        const plan = await invoke<InstallSummary>("plan_install", {
          modsDir: picked,
          manifest,
        });
        setSummary(plan);
        setScreen("preview");
      }
    } catch (e) {
      setError(`${e}`);
    } finally {
      setBusy(false);
    }
  }

  function startInstall() {
    if (!modsDir || !manifest) return;
    setRows(
      manifest.mods.map((m) => ({
        name: m.name,
        filename: m.filename,
        status: "pending",
        downloaded: 0,
        total: 0,
      }))
    );
    setRemoved([]);
    setScreen("installing");
    invoke("run_install", { modsDir, manifest }).catch((e) => {
      setError(`${e}`);
      setScreen("error");
    });
  }

  function resetToHome() {
    setScreen("home");
    setManifest(null);
    setSummary(null);
    setRows([]);
    setRemoved([]);
    setError(null);
  }

  return (
    <div className="app">
      <Header />
      <main className="content">
        {screen === "home" && (
          <HomeScreen onStart={startFlow} busy={busy} />
        )}
        {screen === "detect" && (
          <DetectScreen onPick={pickFolder} onRetry={startFlow} busy={busy} />
        )}
        {screen === "preview" && manifest && summary && modsDir && (
          <PreviewScreen
            manifest={manifest}
            summary={summary}
            modsDir={modsDir}
            onInstall={startInstall}
            onBack={resetToHome}
            onChangeFolder={pickFolder}
          />
        )}
        {screen === "installing" && (
          <InstallingScreen rows={rows} removed={removed} />
        )}
        {screen === "done" && modsDir && (
          <DoneScreen
            rows={rows}
            removed={removed}
            modsDir={modsDir}
            onAgain={resetToHome}
          />
        )}
        {screen === "error" && (
          <ErrorScreen message={error ?? "Unknown error"} onRetry={resetToHome} />
        )}
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="header">
      <div className="brand">
        <div className="brand-mark">HM</div>
        <div className="brand-text">
          <div className="brand-title">HitnMis Modpack Installer</div>
          <div className="brand-sub">
            Ascendancy extras for Create: Ultimate Selection 2
          </div>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <span className="footer-text">v0.1.0</span>
      <button
        className="link-button"
        onClick={() => openUrl("https://hitnmis.gg")}
      >
        hitnmis.gg
      </button>
    </footer>
  );
}

function HomeScreen({ onStart, busy }: { onStart: () => void; busy: boolean }) {
  return (
    <div className="screen home">
      <div className="hero">
        <h1>Ready to install?</h1>
        <p className="lead">
          This will add the server-side extras (Crafting on a Stick, Quark,
          Supplementaries, Relics, JAOPCA, and more) on top of your existing{" "}
          <strong>Create: Ultimate Selection 2</strong> install.
        </p>
        <p className="lead muted">
          You need the base modpack installed first (CurseForge or Prism). This
          tool just adds the extras on top.
        </p>
      </div>
      <div className="cta">
        <button
          className="btn primary large"
          onClick={onStart}
          disabled={busy}
        >
          {busy ? "Loading…" : "Install / Update"}
        </button>
      </div>
    </div>
  );
}

function DetectScreen({
  onPick,
  onRetry,
  busy,
}: {
  onPick: () => void;
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <div className="screen">
      <h2>Couldn't find your modpack</h2>
      <p>
        We checked the usual CurseForge and Prism Launcher paths but didn't find
        a <code>Create: Ultimate Selection 2</code> instance. Pick the{" "}
        <code>mods</code> folder manually below.
      </p>
      <p className="muted small">
        In your launcher, right-click the modpack instance and choose{" "}
        <strong>Open Folder</strong>, then point us at the <code>mods</code>{" "}
        subfolder.
      </p>
      <div className="cta">
        <button className="btn" onClick={onRetry} disabled={busy}>
          Try detect again
        </button>
        <button className="btn primary" onClick={onPick} disabled={busy}>
          Pick mods folder…
        </button>
      </div>
    </div>
  );
}

function PreviewScreen({
  manifest,
  summary,
  modsDir,
  onInstall,
  onBack,
  onChangeFolder,
}: {
  manifest: Manifest;
  summary: InstallSummary;
  modsDir: string;
  onInstall: () => void;
  onBack: () => void;
  onChangeFolder: () => void;
}) {
  const totalRemove =
    summary.will_remove_cleanup.length + summary.will_remove_orphaned.length;
  return (
    <div className="screen preview">
      <h2>Review changes</h2>
      <div className="meta">
        <div>
          <span className="label">Modpack</span>
          <span className="value">{manifest.modpack}</span>
        </div>
        <div>
          <span className="label">Manifest updated</span>
          <span className="value">{manifest.updated}</span>
        </div>
        <div className="meta-path">
          <span className="label">Mods folder</span>
          <span className="value path">{modsDir}</span>
          <button className="link-button inline" onClick={onChangeFolder}>
            change
          </button>
        </div>
      </div>

      <div className="diff">
        <section className="diff-section install">
          <div className="diff-header">
            <span className="diff-badge install">{summary.will_install.length}</span>
            <span>Will install / refresh</span>
          </div>
          <ul className="diff-list">
            {summary.will_install.map((m) => (
              <li key={m.filename}>
                <span className="mod-name">{m.name}</span>
                <span className="mod-file">{m.filename}</span>
              </li>
            ))}
          </ul>
        </section>

        {totalRemove > 0 && (
          <section className="diff-section remove">
            <div className="diff-header">
              <span className="diff-badge remove">{totalRemove}</span>
              <span>Will remove</span>
            </div>
            <ul className="diff-list">
              {summary.will_remove_cleanup.map((f) => (
                <li key={`cleanup-${f}`}>
                  <span className="mod-file">{f}</span>
                  <span className="reason">retired / replaced</span>
                </li>
              ))}
              {summary.will_remove_orphaned.map((f) => (
                <li key={`orphan-${f}`}>
                  <span className="mod-file">{f}</span>
                  <span className="reason">no longer in manifest</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="cta">
        <button className="btn" onClick={onBack}>
          Cancel
        </button>
        <button className="btn primary" onClick={onInstall}>
          Apply changes
        </button>
      </div>
    </div>
  );
}

function InstallingScreen({
  rows,
  removed,
}: {
  rows: ModRow[];
  removed: string[];
}) {
  const completed = rows.filter((r) => r.status === "done" || r.status === "failed").length;
  const total = rows.length;
  const overall = total > 0 ? (completed / total) * 100 : 0;
  return (
    <div className="screen installing">
      <h2>Installing…</h2>
      <div className="overall-progress">
        <div className="bar">
          <div className="fill" style={{ width: `${overall}%` }} />
        </div>
        <div className="overall-label">
          {completed} / {total} done
        </div>
      </div>
      {removed.length > 0 && (
        <div className="removed-banner">
          Removed {removed.length} retired mod{removed.length === 1 ? "" : "s"}
        </div>
      )}
      <ul className="mod-rows">
        {rows.map((r) => (
          <li key={r.filename} className={`mod-row status-${r.status}`}>
            <div className="mod-row-head">
              <span className="mod-row-name">{r.name}</span>
              <span className="mod-row-status">
                {r.status === "pending" && "queued"}
                {r.status === "downloading" &&
                  (r.total > 0
                    ? `${formatBytes(r.downloaded)} / ${formatBytes(r.total)}`
                    : formatBytes(r.downloaded))}
                {r.status === "done" && `${formatBytes(r.downloaded)} ✓`}
                {r.status === "failed" && `failed: ${r.error ?? ""}`}
              </span>
            </div>
            <div className="bar small">
              <div
                className="fill"
                style={{
                  width: `${r.total > 0 ? (r.downloaded / r.total) * 100 : 0}%`,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DoneScreen({
  rows,
  removed,
  modsDir,
  onAgain,
}: {
  rows: ModRow[];
  removed: string[];
  modsDir: string;
  onAgain: () => void;
}) {
  const installed = rows.filter((r) => r.status === "done").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  return (
    <div className="screen done">
      <div className="success-mark">✓</div>
      <h2>All set</h2>
      <p className="summary">
        Installed <strong>{installed}</strong> mod{installed === 1 ? "" : "s"}
        {removed.length > 0 && (
          <>
            , removed <strong>{removed.length}</strong>
          </>
        )}
        {failed > 0 && (
          <span className="failed-note">
            {" "}
            — {failed} failed (you can re-run to retry)
          </span>
        )}
        .
      </p>
      <div className="server-card">
        <div className="server-label">Connect to</div>
        <div className="server-address-row">
          <code className="server-address">{SERVER_ADDRESS}</code>
          <button
            className="btn small"
            onClick={() => navigator.clipboard.writeText(SERVER_ADDRESS)}
          >
            Copy
          </button>
        </div>
        <p className="hint">
          Launch <strong>Create: Ultimate Selection 2</strong> in your launcher,
          add a server with the address above, and you're in.
        </p>
      </div>
      <div className="cta">
        <button
          className="btn"
          onClick={() => invoke("open_mods_folder", { modsDir })}
        >
          Open mods folder
        </button>
        <button className="btn primary" onClick={onAgain}>
          Done
        </button>
      </div>
    </div>
  );
}

function ErrorScreen({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="screen error">
      <div className="error-mark">!</div>
      <h2>Something went wrong</h2>
      <p className="error-message">{message}</p>
      <div className="cta">
        <button className="btn primary" onClick={onRetry}>
          Back to start
        </button>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
