"use client";
// COMPANY-OPS (owner, 10 Nov 2026: "Backup to Google Drive … extremely important"): Settings → Connected apps, admins.
// One status box first (all safe / needs a look with its fix / backing up with progress / not backed up yet), three
// numbered steps that unlock in order (Google connected by the owner → the Drive folder → every night), ONE main button
// (whatever helps now: Copy a note for the owner, Try again, or Back up now), three tiles and the last backups.
// API: /api/v0/settings/drive-backup (services/api/src/drive-backup.ts). The words never name the product.
import { CheckCircle2, CloudOff, CloudUpload, Copy, ExternalLink, FileText, Folder, MessageSquareText, Paperclip, RotateCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { post } from "../records";
import { Switch } from "../kit/switch";
import { ActionButton, celebrate, Chip, GameCard, StatTile, StatTiles } from "../kit/game";
import { Skeleton } from "../ui";
import { ago } from "../lib/format";
import css from "./drive-backup.module.css";

type Counts = { folders?: number; docs?: number; docsSkipped?: number; files?: number; filesSkipped?: number; notCopied?: number; total?: number };
type Run = { id: string; reason: "nightly" | "on_demand"; startedAt: string; finishedAt: string | null; ok: boolean | null; counts: Counts; problems: string[]; error: string | null; startedBy: string | null };
type State = { connected: boolean; account: string | null; enabled: boolean; folderId: string | null; folderUrl: string | null; runAs: { id: string; name: string } | null;
  running: boolean; runs: Run[]; copied: { folders: number; docs: number; files: number; lastAt: string | null }; nightly: boolean };

async function load(): Promise<State> {
  const r = await fetch("/api/v0/settings/drive-backup", { cache: "no-store" });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(typeof d?.error === "string" ? d.error : "The backup couldn’t load just now.");
  return d as State;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n}\u00a0${n === 1 ? one : many}`;
const runWords = (r: Run) => {
  if (!r.ok) return `${plural(r.counts.notCopied || r.problems.length || 1, "item")} not copied`;
  const docs = r.counts.docs ?? 0, files = r.counts.files ?? 0;
  if (!docs && !files) return "Nothing had changed";
  return `Copied ${plural(docs, "doc")}${files ? ` and ${plural(files, "file")}` : ""}`;
};
const OWNER_NOTE = "Please connect Google for our Docs backup (Settings → Connected apps → Backup to Google Drive). It is a one-time set-up on the server.";

/** "Doc “Price list”: reason" → the names, and whether someone must act (sharing) or the next backup retries (busy). */
function sortProblems(problems: string[]) {
  const names: string[] = [];
  let share = false, other = "";
  for (const p of problems) {
    const at = p.indexOf(": ");
    const name = at > 0 ? p.slice(0, at).replace(/^(Doc|File|Folder) /, "") : "", why = at > 0 ? p.slice(at + 2) : p;
    if (name) names.push(name);
    if (/Content manager|can't see|shared drive/.test(why)) share = true;
    else if (!/busy/.test(why) && !other) other = why;
  }
  return { names, share, other };
}

function Step({ n, done, locked, current, title, side, children }: { n: number; done: boolean; locked?: boolean; current?: boolean; title: string; side?: ReactNode; children?: ReactNode }) {
  return <li className={css.step} data-done={done ? "" : undefined} data-locked={locked ? "" : undefined} data-current={current ? "" : undefined}>
    <span className={css.tick} aria-hidden="true">{done ? <CheckCircle2 size={22} /> : <span className={css.num}>{n}</span>}</span>
    <div className={css.stepBody}>
      <div className={css.stepHead}><b><span className={css.sr}>Step {n}{done ? ", done" : locked ? ", after the step before" : ""}: </span>{title}</b>{side}</div>
      {children}
    </div>
  </li>;
}

/** One tap copies a text; the button says "Copied" for a moment. `primary` makes it the card's main button. */
function CopyButton({ text, label, icon: Icon = Copy, primary }: { text: string; label: string; icon?: typeof Copy; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }, () => {}); };
  if (primary) return <ActionButton primary action={{ label: copied ? "Copied" : label, icon: copied ? CheckCircle2 : Icon, onClick: copy }} />;
  return <button type="button" className={css.copy} onClick={copy}>{copied ? <CheckCircle2 size={14} aria-hidden="true" /> : <Icon size={14} aria-hidden="true" />}{copied ? "Copied" : label}</button>;
}

export function DriveBackup() {
  const [s, setS] = useState<State | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState(""), [editing, setEditing] = useState(false), [note, setNote] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const top = useRef<HTMLDivElement>(null), wasRunning = useRef(false);
  const refresh = useCallback(() => load().then((x) => { setS(x); setError(""); return x; }, (e: Error) => { setError(e.message); return null; }), []);
  useEffect(() => { const t = setTimeout(() => void refresh(), 0); return () => clearTimeout(t); }, [refresh]);
  // While a backup runs, look again every 4 seconds; when it ends well, a small celebration.
  useEffect(() => {
    if (!s?.running) return;
    wasRunning.current = true;
    const t = setInterval(() => void refresh().then((x) => {
      if (x && !x.running && wasRunning.current) { wasRunning.current = false; const r = x.runs[0]; if (r?.ok) celebrate(top.current); setNote(r?.ok ? null : { tone: "bad", text: r?.error ?? "Some items were not copied." }); }
    }), 4000);
    return () => clearInterval(t);
  }, [s?.running, refresh]);

  async function save(body: { folder?: string; enabled?: boolean }) {
    setBusy(true); setNote(null);
    try { await post("settings/drive-backup", body); setEditing(false); setFolder(""); await refresh(); if (body.folder) setNote({ tone: "good", text: "Folder saved. Copies can go there now." }); }
    catch (e) { setNote({ tone: "bad", text: e instanceof Error ? e.message : "That couldn’t be saved." }); }
    finally { setBusy(false); }
  }
  async function runNow() {
    setBusy(true); setNote(null);
    try { await post("settings/drive-backup/run", {}); await refresh(); }
    catch (e) { setNote({ tone: "bad", text: e instanceof Error ? e.message : "The backup couldn’t start." }); }
    finally { setBusy(false); }
  }

  if (error && !s) return <GameCard title="Backup to Google Drive" icon={CloudUpload}>
    <p className={css.lead} role="alert">{error}</p>
    <ActionButton primary action={{ label: "Try again", icon: RotateCw, onClick: () => void refresh() }} />
  </GameCard>;
  if (!s) return <GameCard title="Backup to Google Drive" icon={CloudUpload}><div className={css.loading} aria-busy="true"><Skeleton height={18} width="70%" /><Skeleton height={64} /><Skeleton height={44} /><Skeleton height={44} /></div></GameCard>;

  const finished = s.runs.filter((r) => r.finishedAt), last = finished[0] ?? null, current = s.running ? s.runs.find((r) => !r.finishedAt) ?? null : null;
  const problems = last && !last.ok ? (last.problems.length ? last.problems : last.error ? [last.error] : []) : [];
  const issue = sortProblems(problems);
  const ready = s.connected && !!s.folderId, needsLook = !s.running && problems.length > 0;
  const done = (current?.counts.docs ?? 0) + (current?.counts.docsSkipped ?? 0), total = current?.counts.total ?? 0;
  const tryAgain = <ActionButton primary action={{ label: "Try again", icon: RotateCw, onClick: () => void runNow(), busy }} />;
  const backUpNow = <div className={css.fixRow}><ActionButton primary action={{ label: "Back up now", icon: CloudUpload, onClick: () => void runNow(), busy }} />
    {note ? <span className={css.note} data-tone={note.tone} role={note.tone === "bad" ? "alert" : "status"}>{note.text}</span> : null}</div>;

  const pct = total ? Math.max(4, Math.round((done / total) * 100)) : 8;
  const hasRight = !!(s.copied.docs || s.copied.files || finished.length);
  const current2 = s.connected && !s.folderId, current3 = ready && !s.enabled;
  return <GameCard title="Backup to Google Drive" icon={CloudUpload}>
   <div className={css.wrap}>
    <p className={css.lead}>Each night we copy your Docs to your Google Drive as PDF and Word files, in the same folders, with their files.</p>
    <div ref={top}>
      {s.running ? <div className={css.hero} data-tone="run" role="status">
        <CloudUpload size={26} aria-hidden="true" />
        <div><b>Backing up{total ? `: ${done} of ${plural(total, "doc")}` : "…"}</b><small>{total ? `${total - done} to go. ` : ""}You can close this page.</small></div>
        <span className={css.bar} aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
      </div> : needsLook ? <div className={css.hero} data-tone="warn" role="status">
        <TriangleAlert size={26} aria-hidden="true" />
        <div>
          <b>{issue.share || issue.other ? `${plural(problems.length, "item")} ${problems.length === 1 ? "wasn’t" : "weren’t"} copied` : "Google Drive was busy"}</b>
          {issue.names.length ? <details className={css.which}><summary>See the {issue.names.length === 1 ? "item" : `${issue.names.length} items`}</summary><ul>{issue.names.slice(0, 10).map((n) => <li key={n}>{n}</li>)}</ul></details> : null}
          {issue.share ? <>
            <span className={css.why}>Why: our backup account isn’t allowed to add files to that folder.</span>
            <ol className={css.fixSteps}>
              <li><span className={css.fixNum}>1</span>{s.account ? <CopyButton text={s.account} label="Copy e-mail" /> : null}<span className={css.fixText}>Copy our backup e-mail.</span></li>
              {s.folderUrl ? <li><span className={css.fixNum}>2</span><a className={css.copy} href={s.folderUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />Open folder to share</a><span className={css.fixText}>Share it with that e-mail and choose “Content manager”, so we can add files.</span></li> : null}
              <li><span className={css.fixNum}>{s.folderUrl ? 3 : 2}</span>{tryAgain}<span className={css.fixText}>Then press Try again.</span></li>
            </ol>
          </> : <><small>{issue.other || "Nothing to do: the next backup tries again by itself."}</small><div className={css.fixRow}>{tryAgain}</div></>}
        </div>
      </div> : last ? <div className={css.hero} data-tone="good" role="status">
        <CheckCircle2 size={26} aria-hidden="true" />
        <div><b>All safe in Drive</b><small>Backed up {ago(last.finishedAt!)}.{s.enabled ? " Next copy: tonight." : ""}</small>{backUpNow}</div>
      </div> : <div className={css.hero} data-tone="none" role="status">
        <CloudOff size={26} aria-hidden="true" />
        <div><b>Not backed up yet</b><small>{!s.connected ? "Google isn’t connected yet." : !s.folderId ? "Choose the Drive folder below." : "Press Back up now for the first copy."}</small>
          {!s.connected ? <div className={css.fixRow}><CopyButton primary text={OWNER_NOTE} label="Copy note for owner" icon={MessageSquareText} /></div> : ready ? backUpNow : null}</div>
      </div>}
    </div>
    <div className={css.cols} data-two={hasRight ? "" : undefined}>
     <div className={css.col}>
      <ol className={css.steps}>
        <Step n={1} done={s.connected} title={s.connected ? "Google is connected" : "Connect Google"}>
          <small>{s.connected ? "We copy through a backup account of your own in Google." : "The owner connects Google one time. Until then, nothing is copied."}</small>
          {s.connected ? null : <details className={css.which}><summary>Owner? How to connect</summary><ol>
            <li>In Google Cloud, turn on the Drive API and make a service account with a JSON key.</li>
            <li>Put the key on the server as PULSE_DRIVE_BACKUP_SA_JSON (base64), then restart.</li>
            <li>Make a shared drive and add the account’s e-mail as “Content manager”.</li>
          </ol></details>}
        </Step>
        <Step n={2} done={!!s.folderId && !editing} locked={!s.connected} current={current2 || editing} title="Choose the Drive folder" side={!s.connected ? <span className={css.later}>Later</span> : null}>
          {!s.connected ? <small>After Google is connected.</small>
            : s.folderId && !editing ? <div className={css.folderRow}>
              <a className={css.folderChip} href={s.folderUrl ?? "#"} target="_blank" rel="noopener noreferrer"><Folder size={14} aria-hidden="true" />Open folder<ExternalLink size={12} aria-hidden="true" /></a>
              <button type="button" className={css.link} onClick={() => { setEditing(true); setNote(null); }}>Change</button>
            </div> : <form className={css.folderForm} onSubmit={(e) => { e.preventDefault(); void save({ folder }); }}>
              <small>Use a folder in a shared drive. In Google’s Share box, add the backup account’s e-mail and pick “Content manager”.</small>
              {s.account ? <CopyButton text={s.account} label="Copy e-mail" /> : null}
              <label className={css.field}><span>Paste the folder link</span>
                <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="drive.google.com/…" inputMode="url" autoComplete="off" disabled={busy} /></label>
              <div className={css.formButtons}>
                <ActionButton small action={{ label: "Save folder", onClick: () => void save({ folder }), disabled: !folder.trim(), busy }} />
                {editing ? <button type="button" className={css.link} onClick={() => { setEditing(false); setFolder(""); }}>Cancel</button> : null}
              </div>
            </form>}
        </Step>
        <Step n={3} done={s.enabled} locked={!ready} current={current3} title="Back up every night"
          side={ready ? <Switch hideLabel label="Back up every night" checked={s.enabled} disabled={busy} onChange={(on) => void save({ enabled: on })} /> : <span className={css.later}>Later</span>}>
          <small>{!ready ? "After the folder is chosen." : `${s.enabled ? "On, every night from 2 a.m." : "Off."} Copies what ${s.runAs?.name ?? "you"} can open in Docs.`}</small>
        </Step>
      </ol>
      {note && !(last && !needsLook && !s.running) && !(ready && !last && !s.running) ? <p className={css.note} data-tone={note.tone} role={note.tone === "bad" ? "alert" : "status"}>{note.text}</p> : null}
     </div>
     {hasRight ? <div className={css.col}>
      {s.copied.docs || s.copied.files ? <StatTiles label="In your Drive" min={88}>
        <StatTile label="Docs" value={s.copied.docs} icon={FileText} />
        <StatTile label="Folders" value={s.copied.folders} icon={Folder} />
        <StatTile label="Files" value={s.copied.files} icon={Paperclip} />
      </StatTiles> : null}
      {finished.length ? <p className={css.subhead}>Recent backups</p> : null}
      {finished.length ? <ul className={css.runs} aria-label="Recent backups">{finished.slice(0, 3).map((r) => <li key={r.id}>
        <span className={css.chipCell}><Chip tone={r.ok ? "good" : "warn"}>{r.reason === "nightly" ? "Nightly" : "By hand"}</Chip></span>
        <span className={css.runText}>{runWords(r)}<time className={css.when} dateTime={r.startedAt}>{ago(r.startedAt)}</time></span>
      </li>)}</ul> : null}
     </div> : null}
    </div>
    <p className={css.foot}>We never delete anything in your Drive. Anyone with that folder can read the copies.</p>
   </div>
  </GameCard>;
}
