"use client";
// R52: the company's own connectors (contract connector.v1). An admin previews what EA Connect or the company's own
// plugin asks for, installs it for this company only, selects the company's roots, grants scopes and entities with the
// reference where the approval is recorded, reviews an upgrade, and revokes. Each connector shows what is granted and
// missing, its credential's reference (never the secret) and each root's rights and cursor health.
import { useCallback, useEffect, useState } from "react";
import { Cable, CircleCheck, CircleDashed, KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { ago, dayTime } from "../lib/format";
import { post } from "../records";
import { Badge, Empty, Panel, Skeleton, styles } from "../ui";
import css from "./connectors.module.css";
import settings from "./settings.module.css";
import { SelectField } from "../kit/select-field";

type Scope = { scope: string; why: string; granted?: boolean; label?: string };
type Entity = { type: string; schema: number; granted?: boolean; label?: string };
type Cursor = { stored: boolean; reading: boolean; status?: string; errorCode?: string | null; lastCheckpointAt: string | null; lagSeconds?: number | null;
  files?: number; unavailable?: number; openGaps?: number; records?: number; duplicates?: number; refused?: number; lastBatchAt?: string | null } | null;
type Root = { id: string; kind: "shared_drive" | "folder"; ref: string; label: string; status: "selected" | "approved" | "stopped"; rights: string[]; notGranted: string[]; cursor: Cursor };
type Install = { id: string; implementation: "ea_connect" | "plugin"; key: string; label: string; name: string; publisher: string; version: string; status: "preview" | "active" | "revoked";
  approvedAt: string | null; approvalRef: string | null; revokedAt: string | null; revokeReason: string | null; lastBatchAt: string | null;
  credential: { ref: string | null; installed: boolean; id: string | null; delegated: boolean; kind: string };
  scopes: Scope[]; entities: Entity[]; missingScopes: string[]; missingEntities: string[]; proposed: { version: string; newScopes: string[]; newEntities: string[] } | null;
  sources: Root[]; health: string; next: string | null; upgrade: string | null };
type Preview = { ok: boolean; problems: string[]; connector?: { name: string; version: string; publisher: string; implementation: string }; scopes?: Scope[]; entities?: Entity[];
  sources?: string[]; grant?: string[]; never?: string[]; credential?: { kind: string; ref?: string; id?: string | null; where?: string; installedBy?: string } };
type Data = { contract: string; server: boolean; driveChanges: boolean; gates: { id: string; what: string }[]; installs: Install[]; eaConnect: Preview };

const HEALTH: Record<string, { label: string; tone: "success" | "warning" | "neutral" | "danger" }> = {
  ok: { label: "Reading", tone: "success" }, off: { label: "Off on this server", tone: "neutral" }, partial: { label: "Partly granted", tone: "success" },
  needs_secret: { label: "Waiting for the key", tone: "warning" }, needs_root: { label: "Choose a root", tone: "warning" }, needs_grant: { label: "Waiting for your approval", tone: "warning" },
  attention: { label: "Needs review", tone: "warning" }, revoked: { label: "Revoked", tone: "neutral" },
};
const KIND = { shared_drive: "Shared drive", folder: "Folder" } as const;
const WORDS: Record<string, string> = { "drive.file.created": "New files", "drive.file.updated": "Changed files", "drive.file.moved": "Moved files",
  "drive.file.renamed": "Renamed files", "drive.file.trashed": "Files moved to the bin", "drive.folder.created": "New folders" };
const word = (type: string) => WORDS[type] ?? type;
const fail = (title: string, e: unknown) => notify({ id: "connectors", tone: "error", title, message: e instanceof Error ? e.message : "Try again" });

function rootHealth(r: Root) {
  const c = r.cursor;
  if (r.status === "stopped") return "Stopped";
  if (r.status === "selected") return "Waiting for approval";
  if (!c || !c.stored) return "Not read yet";
  if (c.errorCode) return `Needs review (${c.errorCode.replaceAll("_", " ")})`;
  if (c.records !== undefined) return `${c.records} accepted · ${c.duplicates ?? 0} repeated · ${c.refused ?? 0} refused`;
  return `${(c.files ?? 0).toLocaleString("en-IN")} files${c.unavailable ? `, ${c.unavailable} gone from Drive` : ""}${c.openGaps ? ` · ${c.openGaps} gap to review` : ""}`;
}

function PreviewView({ p }: { p: Preview }) {
  if (!p.ok && !p.connector) return <ul className={css.problems}>{p.problems.map((x) => <li key={x}>{x}</li>)}</ul>;
  return <div className={css.preview}>
    {p.problems.length ? <ul className={css.problems}>{p.problems.map((x) => <li key={x}>{x}</li>)}</ul> : null}
    <div className={css.block}><h4>It asks for</h4><ul className={css.plain}>{p.scopes?.map((s) => <li key={s.scope}><b>{s.label}</b><small>{s.why}</small><code className={styles.mono}>{s.scope}</code></li>)}</ul></div>
    <div className={css.block}><h4>It may deliver</h4><div className={css.chips}>{p.entities?.map((e) => <span key={e.type} className={css.chip}>{e.label ?? word(e.type)}</span>)}</div>
      <small className={styles.muted}>From: {p.sources?.map((s) => KIND[s as keyof typeof KIND] ?? s).join(", ").toLowerCase()}s you select</small></div>
    {p.grant ? <div className={css.block}><h4>What your company grants</h4><ol className={settings.steps}>{p.grant.map((g) => <li key={g}><span>{g}</span></li>)}</ol></div> : null}
    {p.credential ? <div className={css.block}><h4>Its credential</h4><p className={styles.muted}>{p.credential.kind === "ed25519" ? `The plugin's own Ed25519 key${p.credential.id ? ` (id ${p.credential.id})` : ""}. Pulse keeps only the public key.`
      : `Kept in ${p.credential.where}, installed by ${p.credential.installedBy}.`}</p></div> : null}
    {p.never ? <div className={css.block}><h4>Pulse never takes</h4><ul className={css.never}>{p.never.map((n) => <li key={n}>{n}</li>)}</ul></div> : null}
  </div>;
}

function InstallCard({ i, reload }: { i: Install; reload: () => void }) {
  const [busy, setBusy] = useState(""), [root, setRoot] = useState({ kind: "shared_drive", ref: "", label: "" }), [ref, setRef] = useState(""), [reason, setReason] = useState("");
  const manifestEntities = i.proposed ? Array.from(new Set([...i.entities.map((e) => e.type), ...i.proposed.newEntities])) : i.entities.map((e) => e.type);
  const [grant, setGrant] = useState<string[]>(manifestEntities);
  const h = HEALTH[i.health] ?? HEALTH.needs_grant, live = i.status !== "revoked";
  const run = async (what: string, work: () => Promise<unknown>, done: string) => {
    setBusy(what);
    try { await work(); notify({ id: "connectors", tone: "success", title: done, timeout: 2500 }); reload(); return true; } catch (e) { fail("Not changed", e); return false; } finally { setBusy(""); }
  };
  const scopes = Array.from(new Set([...i.scopes.map((s) => s.scope), ...(i.proposed?.newScopes ?? [])]));
  return <section className={css.install} data-state={i.status} aria-label={i.label}>
    <header className={css.head}>
      <span className={css.icon}>{i.implementation === "plugin" ? <KeyRound size={16} aria-hidden="true" /> : <Cable size={16} aria-hidden="true" />}</span>
      <span className={css.title}><b>{i.label}</b><small>{i.name} {i.version} · {i.publisher} · {i.implementation === "plugin" ? "your company's plugin, pushes signed batches" : "Pulse reads with your company's Google key"}</small></span>
      <Badge tone={h.tone}>{h.label}</Badge>
    </header>
    {i.next ? <p className={settings.note} data-tone="neutral"><CircleDashed size={15} aria-hidden="true" /><span>Next: {i.next}</span></p> : null}
    <dl className={styles.facts}>
      <dt>Credential</dt><dd>{i.credential.kind === "ed25519" ? <>Plugin key <code className={styles.mono}>{i.credential.id}</code></>
        : <><code className={styles.mono}>{i.credential.ref}</code> in your company&apos;s secret store · {i.credential.installed ? <>installed (id <code className={styles.mono}>{i.credential.id}</code>)</> : "not installed yet"}{i.credential.delegated ? " · reads as a Workspace account you named" : ""}</>}</dd>
      <dt>Google access</dt><dd>{i.scopes.map((s) => <span key={s.scope} className={css.line}>{s.granted ? <ShieldCheck size={13} aria-hidden="true" /> : <ShieldAlert size={13} aria-hidden="true" />}{s.why} <span className={styles.muted}>({s.granted ? "granted" : "not granted"})</span></span>)}</dd>
      <dt>Delivers</dt><dd><div className={css.chips}>{i.entities.map((e) => <span key={e.type} className={css.chip} data-off={e.granted ? undefined : ""}>{word(e.type)}{e.granted ? "" : " · not granted"}</span>)}</div></dd>
      {i.approvedAt ? <><dt>Approved</dt><dd>{dayTime(i.approvedAt)} · {i.approvalRef}</dd></> : null}
      {i.revokedAt ? <><dt>Revoked</dt><dd>{dayTime(i.revokedAt)} · {i.revokeReason}</dd></> : null}
      {i.lastBatchAt ? <><dt>Last batch</dt><dd>{ago(i.lastBatchAt)}</dd></> : null}
    </dl>
    {i.proposed ? <p className={settings.note}><ShieldAlert size={15} aria-hidden="true" /><span>Version {i.proposed.version} waits for your approval{i.proposed.newEntities.length ? `: it adds ${i.proposed.newEntities.map(word).join(", ").toLowerCase()}` : ""}. Version {i.version} keeps applying until you approve.</span></p> : null}
    <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr><th>Root</th><th className={styles.hideSmall}>Kind</th><th>May carry</th><th>Reading</th></tr></thead>
      <tbody>{i.sources.length ? i.sources.map((r) => <tr key={r.id}>
        <td><b>{r.label}</b><br /><code className={styles.mono}>{r.ref}</code></td>
        <td className={styles.hideSmall}>{KIND[r.kind]}</td>
        <td>{r.rights.length ? r.rights.map(word).join(", ") : <span className={styles.muted}>Nothing granted yet</span>}{r.notGranted.length ? <><br /><small className={styles.muted}>Not granted: {r.notGranted.map(word).join(", ").toLowerCase()}</small></> : null}</td>
        <td>{rootHealth(r)}{r.cursor?.lastCheckpointAt ? <><br /><small className={styles.muted}>Checkpoint {ago(r.cursor.lastCheckpointAt)}</small></> : null}</td>
      </tr>) : <tr><td colSpan={4} className={styles.muted}>No root selected yet.</td></tr>}</tbody>
    </table></div>
    {live ? <div className={css.forms}>
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); void run("root", () => post(`connectors/${i.id}/sources`, root), "Root selected").then((ok) => { if (ok) setRoot({ ...root, ref: "", label: "" }); }); }}>
        <h4>Select a root</h4>
        <label className={styles.field}>Kind<SelectField value={root.kind} onChange={(e) => setRoot({ ...root, kind: e.target.value })}><option value="shared_drive">Shared drive</option><option value="folder">Folder</option></SelectField></label>
        <label className={styles.field}>Id from its Drive address<input value={root.ref} onChange={(e) => setRoot({ ...root, ref: e.target.value.trim() })} placeholder="0ABcD…" required /></label>
        <label className={styles.field}>Name<input value={root.label} onChange={(e) => setRoot({ ...root, label: e.target.value })} placeholder="Deliverables" required /></label>
        <button className={styles.btn} disabled={!!busy}>Select</button>
      </form>
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); void run("approve", () => post(`connectors/${i.id}/approve`, { scopes, entities: grant, approvalRef: ref }), "Approved"); }}>
        <h4>Approve{i.proposed ? ` version ${i.proposed.version}` : ""}</h4>
        <fieldset className={css.boxes}><legend className={styles.muted}>Grant</legend>{manifestEntities.map((t) => <label key={t}><input type="checkbox" checked={grant.includes(t)} onChange={(e) => setGrant(e.target.checked ? [...grant, t] : grant.filter((x) => x !== t))} />{word(t)}</label>)}</fieldset>
        <label className={styles.field}>Where your approval is recorded<input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="E13 / E18 reference" required minLength={3} /></label>
        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy || !grant.length}>Approve</button>
      </form>
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); if (!window.confirm(`Revoke ${i.label}? Nothing more is read or accepted from it; what it delivered stays. A revoked connector cannot be turned back on.`)) return; void run("revoke", () => post(`connectors/${i.id}/revoke`, { reason }), "Revoked"); }}>
        <h4>Revoke</h4>
        <label className={styles.field}>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it stops" required minLength={3} /></label>
        <button className={styles.btn} disabled={!!busy}>Revoke</button>
      </form>
      {i.upgrade ? <p className={css.upgrade}>EA Connect {i.upgrade} is available. <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!!busy} onClick={() => void run("upgrade", () => post(`connectors/${i.id}/upgrade`, {}), `Version ${i.upgrade} waits for your approval`)}>Review it</button></p> : null}
    </div> : null}
  </section>;
}

function InstallPanel({ data, reload }: { data: Data; reload: () => void }) {
  const hasEa = data.installs.some((i) => i.implementation === "ea_connect" && i.status !== "revoked");
  const [kind, setKind] = useState<"ea_connect" | "plugin">(hasEa ? "plugin" : "ea_connect");
  const [secretRef, setSecretRef] = useState("ea-connect"), [subject, setSubject] = useState(""), [manifest, setManifest] = useState(""), [publicKey, setPublicKey] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false);
  const body = () => {
    if (kind === "ea_connect") return { implementation: kind, secretRef, subject };
    let parsed: unknown = null; try { parsed = JSON.parse(manifest); } catch { /* the preview names the problem */ }
    return { implementation: kind, manifest: parsed, publicKey };
  };
  const check = async () => { setBusy(true); try { setPreview(await post<Preview>("connectors/preview", body())); } catch (e) { fail("No preview", e); } finally { setBusy(false); } };
  const install = async () => { setBusy(true); try { await post("connectors", body()); notify({ id: "connectors", tone: "success", title: "Installed. Nothing is read until you approve it", timeout: 3500 }); setPreview(null); reload(); } catch (e) { fail("Not installed", e); } finally { setBusy(false); } };
  const shown = kind === "ea_connect" && !preview ? data.eaConnect : preview;
  return <Panel title="Install a connector" sub="For this company only">
    <div className={css.installForm}>
      <div className={styles.segmented} role="group" aria-label="Connector">
        <button type="button" className={styles.segment} aria-current={kind === "ea_connect" ? "true" : undefined} disabled={hasEa} onClick={() => { setKind("ea_connect"); setPreview(null); }}>EA Connect{hasEa ? " (installed)" : ""}</button>
        <button type="button" className={styles.segment} aria-current={kind === "plugin" ? "true" : undefined} onClick={() => { setKind("plugin"); setPreview(null); }}>Your company&apos;s plugin</button>
      </div>
      {kind === "ea_connect" ? <div className={css.row2}>
        <label className={styles.field}>Credential reference<input value={secretRef} onChange={(e) => setSecretRef(e.target.value.trim())} /></label>
        <label className={styles.field}>Workspace account to read as (only for folders in someone&apos;s Drive)<input value={subject} onChange={(e) => setSubject(e.target.value.trim())} placeholder="Leave empty for shared drives" /></label>
      </div> : <div className={css.row2}>
        <label className={styles.field}>Manifest (connector.v1 JSON)<textarea value={manifest} onChange={(e) => setManifest(e.target.value)} rows={6} spellCheck={false} className={styles.mono} /></label>
        <label className={styles.field}>Ed25519 public key (base64)<input value={publicKey} onChange={(e) => setPublicKey(e.target.value.trim())} className={styles.mono} /></label>
      </div>}
      <div className={styles.actions}>
        <button type="button" className={styles.btn} disabled={busy} onClick={() => void check()}>Preview</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || (kind === "ea_connect" && hasEa) || (kind === "plugin" && !preview?.ok)} onClick={() => void install()}>Install</button>
        <small className={styles.muted}>Installing reads nothing. Your approval, the company&apos;s own key and the server switch come first.</small>
      </div>
    </div>
    {shown ? <PreviewView p={shown} /> : null}
  </Panel>;
}

/** Settings → Connected sources → Connectors. */
export function Connectors() {
  const [data, setData] = useState<Data | null | undefined>(undefined);
  const load = useCallback(() => { void fetch("/api/v0/connectors", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then(setData).catch(() => setData(null)); }, []);
  useEffect(load, [load]);
  if (data === undefined) return <Panel title="Company connectors"><div style={{ display: "grid", gap: 10, padding: 14 }} aria-busy="true"><Skeleton width="40%" /><Skeleton height={56} /><Skeleton height={56} /></div></Panel>;
  if (data === null) return <Panel title="Company connectors"><Empty icon={Cable} compact title="Connectors are not available" text="Company admins manage them. Nothing has been changed." /></Panel>;
  return <div className={css.stack}>
    <Panel title="Company connectors" sub={`${data.contract} · ${data.server ? "on on this server" : "off on this server"}`}>
      <p className={settings.note} data-tone={data.server ? "neutral" : undefined}>{data.server ? <CircleCheck size={15} aria-hidden="true" /> : <ShieldAlert size={15} aria-hidden="true" />}
        <span>Each company connects its own sources with its own Google access; nothing of another company is used. {data.server ? "Approved connectors read now." : "Nothing is read on this server yet:"}</span></p>
      {!data.server ? <ul className={css.gates}>{data.gates.map((g) => <li key={g.id}><b>{g.id}</b><span>{g.what}</span></li>)}</ul> : null}
      {data.installs.length ? <div className={css.installs}>{data.installs.map((i) => <InstallCard key={`${i.id}:${i.status}:${i.version}:${i.proposed?.version ?? ""}`} i={i} reload={load} />)}</div>
        : <Empty icon={Cable} compact title="No connector yet" text="Install EA Connect, or register your company's own plugin, below." />}
    </Panel>
    <InstallPanel data={data} reload={load} />
  </div>;
}
