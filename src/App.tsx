import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import heartLogo from "./assets/heart.png";
import "./App.css";

type ModEntry = { name: string; filename: string; url: string; size: number };
type Manifest = {
  schema_version: number;
  name: string;
  modpack: string;
  updated: string;
  cleanup: string[];
  mods: ModEntry[];
  notes?: string | null;
};

type FileStatus = "ok" | "needs_update" | "needs_install";
type ManagedRow = {
  name: string;
  filename: string;
  status: FileStatus;
  expected_size: number;
  actual_size: number | null;
};
type UnknownJar = { filename: string; size: number };
type ModAudit = {
  managed: ManagedRow[];
  will_remove_cleanup: string[];
  will_remove_retired: string[];
  unknown_jars: UnknownJar[];
  previously_managed: string[];
};

type ProgressEvent =
  | { kind: "started"; total_mods: number }
  | { kind: "cleanup_removed"; filename: string }
  | { kind: "download_start"; name: string; filename: string; index: number; total: number }
  | { kind: "download_skipped"; filename: string; reason: string }
  | { kind: "download_progress"; filename: string; downloaded: number; total: number }
  | { kind: "download_done"; filename: string; size_bytes: number }
  | { kind: "download_failed"; filename: string; error: string }
  | { kind: "finished"; installed: number; skipped: number; removed: number };

type Screen = "updating" | "home" | "detect" | "audit" | "installing" | "done" | "error";

type UpdateInfo = { version: string; downloaded: number; total: number };

type LiveRowStatus = "queued" | "skipped" | "downloading" | "done" | "failed";
type LiveRow = {
  name: string;
  filename: string;
  status: LiveRowStatus;
  downloaded: number;
  total: number;
  error?: string;
};

const SERVER_ADDRESS = "create.hitnmis.gg";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [modsDir, setModsDir] = useState<string | null>(null);
  const [audit, setAudit] = useState<ModAudit | null>(null);
  const [selectedUnknowns, setSelectedUnknowns] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<LiveRow[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  // On launch, check GitHub Releases for a newer installer build. If one exists,
  // download + install it and relaunch — no manual re-download. Any failure
  // (offline, dev build, no release yet) is non-fatal: we just fall through to
  // the normal home screen. Mod-list updates are separate (fetched at runtime).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const update = await check();
        if (!update || cancelled) return;
        setUpdateInfo({ version: update.version, downloaded: 0, total: 0 });
        setScreen("updating");
        let downloaded = 0;
        let total = 0;
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case "Started":
              total = event.data.contentLength ?? 0;
              setUpdateInfo((u) => (u ? { ...u, total } : u));
              break;
            case "Progress":
              downloaded += event.data.chunkLength;
              setUpdateInfo((u) => (u ? { ...u, downloaded } : u));
              break;
            case "Finished":
              break;
          }
        });
        await relaunch();
      } catch (e) {
        // Non-fatal — continue into the installer as normal.
        console.warn("update check skipped:", e);
        if (!cancelled) setScreen("home");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        case "download_skipped":
          setSkippedCount((n) => n + 1);
          setRows((prev) =>
            prev.map((r) =>
              r.filename === ev.filename ? { ...r, status: "skipped" } : r
            )
          );
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
                ? { ...r, status: "done", downloaded: ev.size_bytes, total: ev.size_bytes }
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
        const a = await invoke<ModAudit>("audit_mods_dir", { modsDir: detected, manifest: m });
        setAudit(a);
        setSelectedUnknowns(new Set());
        setScreen("audit");
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
    const picked = await open({ directory: true, multiple: false, title: "Pick your modpack's mods/ folder" });
    if (!picked || Array.isArray(picked)) return;
    setBusy(true);
    try {
      const ok = await invoke<boolean>("validate_mods_dir", { path: picked });
      if (!ok) {
        setError(`That doesn't look like a valid mods folder. Make sure the folder is named "mods" and is inside your Create: Ultimate Selection 2 instance.`);
        return;
      }
      setModsDir(picked);
      if (manifest) {
        const a = await invoke<ModAudit>("audit_mods_dir", { modsDir: picked, manifest });
        setAudit(a);
        setSelectedUnknowns(new Set());
        setScreen("audit");
      }
    } catch (e) {
      setError(`${e}`);
    } finally {
      setBusy(false);
    }
  }

  function toggleUnknown(filename: string) {
    setSelectedUnknowns((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }

  function startInstall() {
    if (!modsDir || !manifest || !audit) return;
    const skipFilenames = audit.managed
      .filter((r) => r.status === "ok")
      .map((r) => r.filename);

    setRows(
      manifest.mods.map((m) => {
        const a = audit.managed.find((row) => row.filename === m.filename);
        const isOk = a?.status === "ok";
        return {
          name: m.name,
          filename: m.filename,
          status: isOk ? "skipped" : "queued",
          downloaded: isOk ? m.size : 0,
          total: m.size,
        };
      })
    );
    setRemoved([]);
    setSkippedCount(0);
    setScreen("installing");
    invoke("run_install", {
      modsDir,
      manifest,
      skipFilenames,
      alsoDelete: Array.from(selectedUnknowns),
    }).catch((e) => {
      setError(`${e}`);
      setScreen("error");
    });
  }

  function resetToHome() {
    setScreen("home");
    setManifest(null);
    setAudit(null);
    setSelectedUnknowns(new Set());
    setRows([]);
    setRemoved([]);
    setSkippedCount(0);
    setError(null);
  }

  return (
    <div className="app">
      <Header />
      <main className="content">
        {screen === "updating" && updateInfo && <UpdatingScreen info={updateInfo} />}
        {screen === "home" && <HomeScreen onStart={startFlow} busy={busy} />}
        {screen === "detect" && <DetectScreen onPick={pickFolder} onRetry={startFlow} busy={busy} />}
        {screen === "audit" && manifest && audit && modsDir && (
          <AuditScreen
            manifest={manifest}
            audit={audit}
            modsDir={modsDir}
            selectedUnknowns={selectedUnknowns}
            toggleUnknown={toggleUnknown}
            onApply={startInstall}
            onBack={resetToHome}
            onChangeFolder={pickFolder}
          />
        )}
        {screen === "installing" && <InstallingScreen rows={rows} removed={removed} skipped={skippedCount} />}
        {screen === "done" && modsDir && (
          <DoneScreen rows={rows} removed={removed} skipped={skippedCount} modsDir={modsDir} onAgain={resetToHome} />
        )}
        {screen === "error" && <ErrorScreen message={error ?? "Unknown error"} onRetry={resetToHome} />}
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="header">
      <div className="brand">
        <img src={heartLogo} alt="HitnMis" className="brand-mark" />
        <div className="brand-text">
          <div className="brand-title">HitnMis Modpack Installer</div>
          <div className="brand-sub">Ascendancy extras for Create: Ultimate Selection 2</div>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <span className="footer-text">v0.3.2</span>
      <button className="link-button" onClick={() => openUrl("https://hitnmis.gg")}>hitnmis.gg</button>
    </footer>
  );
}

function UpdatingScreen({ info }: { info: UpdateInfo }) {
  const pct = info.total > 0 ? Math.round((info.downloaded / info.total) * 100) : 0;
  return (
    <div className="screen installing">
      <h2>Updating installer…</h2>
      <p className="lead muted">
        A newer version (<strong>v{info.version}</strong>) is available. Downloading it now —
        the app will restart automatically when it&apos;s done.
      </p>
      <div className="overall-progress">
        <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
        <div className="overall-label">
          {info.total > 0
            ? `${formatBytes(info.downloaded)} / ${formatBytes(info.total)} (${pct}%)`
            : "Starting download…"}
        </div>
      </div>
    </div>
  );
}

function HomeScreen({ onStart, busy }: { onStart: () => void; busy: boolean }) {
  return (
    <div className="screen home">
      <div className="hero">
        <img src={heartLogo} alt="" className="hero-mark" />
        <h1>Ready to install?</h1>
        <p className="lead">
          This will add the server-side extras (Crafting on a Stick, Quark, Supplementaries, Relics, JAOPCA, and more) on top of your existing <strong>Create: Ultimate Selection 2</strong> install.
        </p>
        <p className="lead muted">
          We&apos;ll scan your mods folder first and only download what&apos;s actually missing or outdated.
        </p>
      </div>
      <div className="cta">
        <button className="btn primary large" onClick={onStart} disabled={busy}>
          {busy ? "Scanning…" : "Scan + Install"}
        </button>
      </div>
    </div>
  );
}

function DetectScreen({ onPick, onRetry, busy }: { onPick: () => void; onRetry: () => void; busy: boolean }) {
  return (
    <div className="screen">
      <h2>Couldn&apos;t find your modpack</h2>
      <p>
        We checked the usual CurseForge and Prism Launcher paths but didn&apos;t find a <code>Create: Ultimate Selection 2</code> instance. Pick the <code>mods</code> folder manually below.
      </p>
      <p className="muted small">
        In your launcher, right-click the modpack instance, choose <strong>Open Folder</strong>, then point us at the <code>mods</code> subfolder.
      </p>
      <div className="cta">
        <button className="btn" onClick={onRetry} disabled={busy}>Try detect again</button>
        <button className="btn primary" onClick={onPick} disabled={busy}>Pick mods folder…</button>
      </div>
    </div>
  );
}

function AuditScreen({
  manifest, audit, modsDir, selectedUnknowns, toggleUnknown, onApply, onBack, onChangeFolder,
}: {
  manifest: Manifest;
  audit: ModAudit;
  modsDir: string;
  selectedUnknowns: Set<string>;
  toggleUnknown: (filename: string) => void;
  onApply: () => void;
  onBack: () => void;
  onChangeFolder: () => void;
}) {
  const counts = useMemo(() => {
    const ok = audit.managed.filter((r) => r.status === "ok").length;
    const update = audit.managed.filter((r) => r.status === "needs_update").length;
    const install = audit.managed.filter((r) => r.status === "needs_install").length;
    return {
      ok,
      update,
      install,
      removeRetired: audit.will_remove_retired.length,
      removeCleanup: audit.will_remove_cleanup.length,
      unknown: audit.unknown_jars.length,
    };
  }, [audit]);

  const ok = audit.managed.filter((r) => r.status === "ok");
  const updating = audit.managed.filter((r) => r.status === "needs_update");
  const installing = audit.managed.filter((r) => r.status === "needs_install");
  const nothingToDo =
    counts.update === 0 && counts.install === 0 && counts.removeCleanup === 0 && counts.removeRetired === 0 && selectedUnknowns.size === 0;

  return (
    <div className="screen audit">
      <h2>Mod folder audit</h2>
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
          <button className="link-button inline" onClick={onChangeFolder}>change</button>
        </div>
      </div>

      <div className="audit-grid">
        {counts.ok > 0 && (
          <AuditSection title="Already correct" count={counts.ok} variant="ok" defaultOpen={false}>
            {ok.map((r) => (
              <li key={r.filename} className="audit-row">
                <span className="dot dot-ok" />
                <span className="mod-name">{r.name}</span>
                <span className="mod-file">{r.filename}</span>
              </li>
            ))}
          </AuditSection>
        )}
        {counts.update > 0 && (
          <AuditSection title="Will update (wrong size)" count={counts.update} variant="update" defaultOpen>
            {updating.map((r) => (
              <li key={r.filename} className="audit-row">
                <span className="dot dot-update" />
                <span className="mod-name">{r.name}</span>
                <span className="mod-file">{r.filename}</span>
                <span className="size-info">{formatBytes(r.actual_size ?? 0)} → {formatBytes(r.expected_size)}</span>
              </li>
            ))}
          </AuditSection>
        )}
        {counts.install > 0 && (
          <AuditSection title="Will install (missing)" count={counts.install} variant="install" defaultOpen>
            {installing.map((r) => (
              <li key={r.filename} className="audit-row">
                <span className="dot dot-install" />
                <span className="mod-name">{r.name}</span>
                <span className="mod-file">{r.filename}</span>
                <span className="size-info">{formatBytes(r.expected_size)}</span>
              </li>
            ))}
          </AuditSection>
        )}
        {(counts.removeCleanup > 0 || counts.removeRetired > 0) && (
          <AuditSection
            title="Will remove (retired or replaced)"
            count={counts.removeCleanup + counts.removeRetired}
            variant="remove"
            defaultOpen
          >
            {audit.will_remove_cleanup.map((f) => (
              <li key={`c-${f}`} className="audit-row">
                <span className="dot dot-remove" />
                <span className="mod-file">{f}</span>
                <span className="reason">retired / replaced</span>
              </li>
            ))}
            {audit.will_remove_retired.map((f) => (
              <li key={`r-${f}`} className="audit-row">
                <span className="dot dot-remove" />
                <span className="mod-file">{f}</span>
                <span className="reason">no longer in manifest</span>
              </li>
            ))}
          </AuditSection>
        )}
        {counts.unknown > 0 && (
          <AuditSection
            title="Other mods in folder (base modpack)"
            count={counts.unknown}
            variant="unknown"
            defaultOpen={false}
            note="These are the mods that ship with Create: Ultimate Selection 2. We don't touch them. Only tick a box if you specifically want to remove that one jar from your folder."
          >
            {audit.unknown_jars.map((u) => (
              <li key={u.filename} className="audit-row interactive">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={selectedUnknowns.has(u.filename)}
                    onChange={() => toggleUnknown(u.filename)}
                  />
                  <span className="dot dot-unknown" />
                  <span className="mod-file">{u.filename}</span>
                  <span className="size-info">{formatBytes(u.size)}</span>
                </label>
              </li>
            ))}
          </AuditSection>
        )}
      </div>

      <div className="cta">
        <button className="btn" onClick={onBack}>Cancel</button>
        <button className="btn primary" onClick={onApply} disabled={nothingToDo}>
          {nothingToDo ? "Nothing to do" : "Apply changes"}
        </button>
      </div>
    </div>
  );
}

function AuditSection({
  title, count, variant, defaultOpen = true, note, children,
}: {
  title: string;
  count: number;
  variant: "ok" | "update" | "install" | "remove" | "unknown";
  defaultOpen?: boolean;
  note?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`audit-section variant-${variant} ${open ? "open" : "closed"}`}>
      <button type="button" className="audit-section-head" onClick={() => setOpen((o) => !o)}>
        <span className={`audit-badge badge-${variant}`}>{count}</span>
        <span className="audit-title">{title}</span>
        <span className="audit-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <>
          {note && <p className="audit-note">{note}</p>}
          <ul className="audit-list">{children}</ul>
        </>
      )}
    </section>
  );
}

function InstallingScreen({ rows, removed, skipped }: { rows: LiveRow[]; removed: string[]; skipped: number }) {
  const completed = rows.filter((r) => r.status === "done" || r.status === "failed" || r.status === "skipped").length;
  const total = rows.length;
  const overall = total > 0 ? (completed / total) * 100 : 0;
  const active = rows.filter((r) => r.status === "downloading" || r.status === "queued" || r.status === "failed" || r.status === "done");
  return (
    <div className="screen installing">
      <h2>Applying changes…</h2>
      <div className="overall-progress">
        <div className="bar"><div className="fill" style={{ width: `${overall}%` }} /></div>
        <div className="overall-label">
          {completed} / {total} processed{skipped > 0 && ` (${skipped} skipped, already correct)`}
        </div>
      </div>
      {removed.length > 0 && (
        <div className="removed-banner">Removed {removed.length} file{removed.length === 1 ? "" : "s"}</div>
      )}
      {active.length > 0 && (
        <ul className="mod-rows">
          {active.map((r) => (
            <li key={r.filename} className={`mod-row status-${r.status}`}>
              <div className="mod-row-head">
                <span className="mod-row-name">{r.name}</span>
                <span className="mod-row-status">
                  {r.status === "queued" && "queued"}
                  {r.status === "downloading" && (r.total > 0 ? `${formatBytes(r.downloaded)} / ${formatBytes(r.total)}` : formatBytes(r.downloaded))}
                  {r.status === "done" && `${formatBytes(r.downloaded)} ✓`}
                  {r.status === "failed" && `failed: ${r.error ?? ""}`}
                </span>
              </div>
              <div className="bar small">
                <div className="fill" style={{ width: `${r.total > 0 ? (r.downloaded / r.total) * 100 : 0}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DoneScreen({ rows, removed, skipped, modsDir, onAgain }: { rows: LiveRow[]; removed: string[]; skipped: number; modsDir: string; onAgain: () => void; }) {
  const installed = rows.filter((r) => r.status === "done").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  return (
    <div className="screen done">
      <div className="success-mark">✓</div>
      <h2>All set</h2>
      <p className="summary">
        {installed > 0 && (<>Installed/refreshed <strong>{installed}</strong>. </>)}
        {skipped > 0 && (<>Skipped <strong>{skipped}</strong> already-correct. </>)}
        {removed.length > 0 && (<>Removed <strong>{removed.length}</strong>. </>)}
        {failed > 0 && (<span className="failed-note"> {failed} failed — re-run to retry.</span>)}
      </p>
      <div className="server-card">
        <div className="server-label">Connect to</div>
        <div className="server-address-row">
          <code className="server-address">{SERVER_ADDRESS}</code>
          <button className="btn small" onClick={() => navigator.clipboard.writeText(SERVER_ADDRESS)}>Copy</button>
        </div>
        <p className="hint">Launch <strong>Create: Ultimate Selection 2</strong> in your launcher, add a server with the address above, and you&apos;re in.</p>
      </div>
      <div className="cta">
        <button className="btn" onClick={() => invoke("open_mods_folder", { modsDir })}>Open mods folder</button>
        <button className="btn" onClick={onAgain}>Done</button>
        <button className="btn primary" onClick={() => { invoke("launch_curseforge").catch(() => {}); }}>🚀 Launch CurseForge</button>
      </div>
    </div>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="screen error">
      <div className="error-mark">!</div>
      <h2>Something went wrong</h2>
      <p className="error-message">{message}</p>
      <div className="cta">
        <button className="btn primary" onClick={onRetry}>Back to start</button>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
