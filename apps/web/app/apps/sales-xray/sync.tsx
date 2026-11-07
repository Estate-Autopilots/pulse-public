"use client";
// XRAY-LINK: the Sales X-Ray app's Sync tab. Lead sync's switch and rules (a Pulse admin who owns or runs the Sales
// X-Ray organisation turns it on and lends their connection), the last run, the company's copy of its leads with the
// client each is linked to, and the log of what each run did.
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, RefreshCw, Repeat2, UserRound } from "lucide-react";
import { Segmented } from "../../kit";
import { Badge, Empty, Panel, Skeleton, styles } from "../../ui";
import { sx, type LeadCopy } from "./linked";
import css from "./sales-xray.module.css";

type Sync = { enabled: boolean; runnerName: string | null; workspace: string; makeClients: "won" | "all"; pushClients: boolean; lastRunAt: string | null; lastOkAt: string | null;
  lastError: string | null; lastCounts: Record<string, number>; stages: { stage: string; n: number; linked: number }[]; canManage: boolean; canRun: boolean; mine: boolean;
  log: { at: string; direction: "in" | "out" | "run"; action: string; detail: string; clientId: string | null }[];
  connection: { workspace: string | null; kind: string; role: string | null } | null };
type Row = LeadCopy & { clientId: string | null; clientName: string | null; updatedAt: string };
const when = (iso?: string | null) => iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "never";
const COUNTS: [string, string][] = [["read", "read"], ["created", "new"], ["updated", "changed"], ["clientsMade", "clients made"], ["clientsLinked", "clients linked"], ["filled", "clients filled"], ["conflicts", "conflicts"], ["gone", "gone"], ["sent", "sent to Sales X-Ray"], ["failed", "failed"]];

export function SyncView({ admin }: { admin: boolean }) {
  const [s, setS] = useState<Sync | null>(null), [error, setError] = useState<string | null>(null), [n, setN] = useState(0), [busy, setBusy] = useState<string | null>(null), [said, setSaid] = useState<string | null>(null);
  useEffect(() => { let live = true; sx<Sync>("sync").then((r) => live && setS(r), (e: Error) => live && setError(e.message)); return () => { live = false; }; }, [n]);
  const save = (body: Record<string, unknown>) => { setBusy("save"); setSaid(null); sx<Sync>("sync", { method: "POST", body: JSON.stringify(body) }).then(() => { setBusy(null); setN((x) => x + 1); }, (e: Error) => { setBusy(null); setSaid(e.message); }); };
  const run = () => { setBusy("run"); setSaid(null); sx<{ error: string | null; counts: Record<string, number> }>("sync/run", { method: "POST", body: "{}" })
    .then((r) => { setBusy(null); setSaid(r.error ?? "Synced."); setN((x) => x + 1); }, (e: Error) => { setBusy(null); setSaid(e.message); }); };
  if (error) return <Panel title="Lead sync"><p className={css.error} role="alert">{error}</p></Panel>;
  if (!s) return <Panel title="Lead sync"><Skeleton height={80} /></Panel>;
  const counts = COUNTS.filter(([k]) => s.lastCounts?.[k]).map(([k, label]) => `${s.lastCounts[k]} ${label}`).join(" · ");
  return <div className={css.syncGrid}>
    <Panel title="Lead sync" sub={s.enabled ? `On · ${s.workspace}` : "Off"}
      tools={s.enabled && s.canManage ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={run} disabled={!!busy}><RefreshCw size={16} aria-hidden="true" />{busy === "run" ? "Syncing…" : "Sync now"}</button> : undefined}>
      <div className={css.syncBody}>
        <p className={css.text}>{s.enabled
          ? <>Every 10 minutes Pulse reads your Sales X-Ray leads with {s.mine ? "your" : `${s.runnerName ?? "an admin"}’s`} connection, keeps a copy here and links each lead to its client. Sales X-Ray owns a lead’s stage and salesperson; Pulse owns the client.</>
          : <>Keep Sales X-Ray’s leads and Pulse’s clients in step: won leads become clients, empty client details fill from the lead, and clients you send become leads. Sales X-Ray owns a lead’s stage; Pulse owns the client and never loses a value you set.</>}</p>
        <dl className={css.facts}>
          <div><dt>Last run</dt><dd>{when(s.lastRunAt)}{counts ? ` · ${counts}` : ""}</dd></div>
          {s.lastError ? <div><dt>Problem</dt><dd className={css.errorText}>{s.lastError}</dd></div> : null}
          <div><dt>Leads become clients</dt><dd>{s.canManage && admin ? <Segmented label="Leads become clients" size="sm" value={s.makeClients} onChange={(v) => save({ makeClients: v })}
            options={[{ value: "won", label: "When won" }, { value: "all", label: "Every lead, as a Prospect" }]} /> : s.makeClients === "all" ? "Every lead, as a Prospect" : "When won"}</dd></div>
          <div><dt>New Prospects in Pulse</dt><dd>{s.canManage && admin ? <label className={css.check}><input type="checkbox" checked={s.pushClients} onChange={(e) => save({ pushClients: e.target.checked })} />Send to Sales X-Ray as leads</label> : s.pushClients ? "Sent to Sales X-Ray as leads" : "Stay in Pulse"}</dd></div>
        </dl>
        {s.canManage ? <div className={css.syncActions}>
          {!s.enabled ? (s.canRun ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy} onClick={() => save({ enabled: true })}><Repeat2 size={16} aria-hidden="true" />Turn on lead sync</button>
            : <p className={css.small}>{!admin ? "A Pulse admin turns lead sync on." : !s.connection ? "Connect your Sales X-Ray account first (above)." : s.connection.kind !== "organisation" ? "Your connection is to a Personal workspace. Disconnect, connect again and choose your organisation." : "Lead sync needs an owner or admin of the Sales X-Ray organisation."}</p>)
            : <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={!!busy} onClick={() => save({ enabled: false })}>Turn off</button>}
          {s.enabled && !s.mine && s.canRun ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={!!busy} onClick={() => save({ enabled: true })}>Use my connection instead</button> : null}
        </div> : null}
        {said ? <p className={css.small} role="status">{said}</p> : null}
      </div>
    </Panel>
    <SyncedLeads stages={s.stages} key={n} />
    <Panel title="What each run did" sub="Newest first">
      {!s.log.length ? <Empty icon={Repeat2} compact title="Nothing yet" text="Each run’s changes show here: leads read, clients made or filled, conflicts and leads sent." />
        : <ul className={css.log}>{s.log.map((l, i) => <li key={i} data-action={l.action}>
          {l.direction === "out" ? <ArrowUpRight size={14} aria-label="To Sales X-Ray" /> : l.direction === "in" ? <ArrowDownLeft size={14} aria-label="From Sales X-Ray" /> : <RefreshCw size={14} aria-label="Run" />}
          <span>{l.clientId && l.direction !== "run" ? <Link className={styles.fill} href={`/clients/${l.clientId}?tab=salesxray`}>{l.detail}</Link> : l.detail}</span>
          <small>{l.action === "conflict" ? <Badge tone="warning">Conflict</Badge> : null} {when(l.at)}</small>
        </li>)}</ul>}
    </Panel>
  </div>;
}

function SyncedLeads({ stages }: { stages: Sync["stages"] }) {
  const [stage, setStage] = useState("all"), [rows, setRows] = useState<Row[] | null>(null), [error, setError] = useState<string | null>(null), [n, setN] = useState(0);
  useEffect(() => { let live = true; sx<{ leads: Row[] }>(`synced-leads${stage === "all" ? "" : `?stage=${stage}`}`).then((r) => live && setRows(r.leads), (e: Error) => live && setError(e.message)); return () => { live = false; }; }, [stage, n]);
  const make = (id: string) => sx(`synced-leads/${id}/client`, { method: "POST", body: JSON.stringify({ create: true }) }).then(() => setN((x) => x + 1), (e: Error) => setError(e.message));
  const total = stages.reduce((a, s) => a + s.n, 0);
  return <Panel title="Leads in Pulse" sub={total ? `${total} · ${stages.reduce((a, s) => a + s.linked, 0)} linked to clients` : undefined}
    tools={stages.length ? <Segmented label="Stage" size="sm" value={stage} onChange={(v) => { setStage(v); setRows(null); }} options={[{ value: "all", label: "All" }, ...stages.map((s) => ({ value: s.stage, label: `${s.stage.replace(/_/g, " ")} ${s.n}` }))]} /> : undefined}>
    {error ? <p className={css.error} role="alert">{error}</p> : !rows ? <div className={css.loading}><Skeleton height={40} /></div>
      : !rows.length ? <Empty icon={UserRound} compact title="No leads copied yet" text="Turn lead sync on; the first run copies your Sales X-Ray leads here." />
      : <ul className={css.rows}>{rows.map((l) => <li key={l.sxLeadId} className={css.leadRow}>
        <UserRound size={16} aria-hidden="true" />
        <span className={css.main}><b>{l.name || "Unnamed lead"}</b><small>{[l.company, l.city, l.ownerName, l.origin === "pulse" ? "sent from Pulse" : null, l.goneAt ? "no longer in Sales X-Ray" : null].filter(Boolean).join(" · ")}</small></span>
        <Badge tone={l.stage === "won" ? "success" : "neutral"}>{l.stageLabel ?? l.stage}</Badge>
        {l.clientId ? <Link className={styles.fill} href={`/clients/${l.clientId}?tab=salesxray`}>{l.clientName ?? "Client"}</Link>
          : <button type="button" className={`${styles.btn} ${styles.btnGhost} ${css.small}`} onClick={() => make(l.sxLeadId)}>Make client</button>}
      </li>)}</ul>}
  </Panel>;
}
