"use client";
// BUGKIT-TELEMETRY (owner, 6 Nov 2026): Insights → App friction. Where people get stuck in Pulse, found from how the app
// is used before anyone reports it: friction alerts (open a bug task, dismiss, watch a replay), rage/dead/error hotspots
// per screen with a heatmap, funnels and where they lose people, forms left half-done, time per screen (active and
// idle), the slowest actions, session replays, and, for admins only, adoption per person with its purpose said.
// Leadership and admins (the API refuses everyone else). Numbers, screens and element names only; never typed text.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Flame, Gauge, MousePointerClick, PlayCircle, Settings2, TriangleAlert } from "lucide-react";
import { duration, share } from "../lib/friction-dashboard.mjs";
import { Badge, Kpi, PageHeader, Panel, QueryTabs, Tiles, styles } from "../ui";
import { TABS } from "./facts";
import { Heatmap } from "./heatmap";
import css from "./friction.module.css";

type Step = { label: string; sessions: number; dropPct: number | null };
type Alert = { id: string; kind: string; route: string; target: string; label: string | null; hits: number; people: number; sampleSession: string | null; firstAt: string; lastAt: string; status: "open" | "task"; taskId: string | null };
type Hotspot = { route: string; rage: number; dead: number; stuck: number; back: number; errors: number; toasts: number; people: number; targets: { kind: string; sel: string; label: string | null; n: number }[] };
export type FrictionData = {
  days: number; zone: string; autoTasks: number; canSeeAdoption: boolean;
  settings: { autoTask: boolean; replay: boolean; enabled: boolean; retentionDays: number };
  timePerScreen: { page: string; views: number; totalMs: number; activeMs: number; idleMs: number; medianActiveMs: number | null }[];
  slowestActions: { page: string | null; name: string | null; kind: string; n: number; p50: number | null; p75: number | null }[];
  funnels: { key: string; label: string; steps: Step[] }[];
  dropOffs: { forms: { page: string | null; name: string | null; starts: number; abandons: number; errors: number }[]; exits: { page: string; sessions: number }[] };
  hotspots: Hotspot[]; alerts: Alert[];
  replays: { sid: string; who: string | null; route: string | null; started: string; ended: string; chunks: number; reason: string; friction: number }[];
};
export type AdoptionData = { days: number; zone: string; purpose: string; people: { personId: string; name: string | null; role: string | null; sessions: number; activeMinutes: number; screens: number; features: number; featureList: string[]; lastSeen: string }[]; notSeen: { personId: string; name: string }[] };

const KIND_WORDS: Record<string, string> = { rage: "Rage clicks", dead: "Dead clicks", error: "Script errors", abandon: "Forms left half-done", stuck: "Stuck on a form with errors", back: "Back and forth" };
const ACTION_WORDS: Record<string, string> = { "ui.click": "Click", "ui.submit": "Submit" };

function Table({ head, rows, label, empty }: { head: { label: string; right?: boolean }[]; rows: ReactNode[][]; label: string; empty: string }) {
  if (!rows.length) return <p className={css.empty}>{empty}</p>;
  return <div className={styles.tableWrap}><table className={`${styles.table} ${styles.tableDense}`} aria-label={label}>
    <thead><tr>{head.map((h) => <th key={h.label} className={h.right ? styles.right : undefined}>{h.label}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={head[j]?.right ? styles.right : undefined}>{c}</td>)}</tr>)}</tbody>
  </table></div>;
}
const mono = (s: string | null | undefined) => <span className={styles.mono}>{s || "–"}</span>;
const replayHref = (sid: string) => `/telemetry/replay/${encodeURIComponent(sid)}`;

export function FrictionInsights({ data: d, adoption, highlight }: { data: FrictionData; adoption: AdoptionData | null; highlight?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [heat, setHeat] = useState<string | null>(null);
  const when = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: d.zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  const act = async (id: string, body: Record<string, unknown>, done: string) => {
    setBusy(id); setStatus(null);
    try {
      const r = await fetch(`/api/v0/telemetry/friction/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const answer = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(answer.error ?? "That didn’t go through. Try again.");
      setStatus(done); router.refresh();
    } catch (error) { setStatus((error as Error).message); } finally { setBusy(null); }
  };
  const total = (k: "rage" | "dead" | "errors") => d.hotspots.reduce((n, h) => n + h[k], 0);
  const open = d.alerts.filter((a) => a.status === "open").length;
  const abandons = d.dropOffs.forms.reduce((n, f) => n + f.abandons, 0);
  const tabs = TABS.map((t) => ({ key: t.key, label: t.label }));

  return <>
    <PageHeader title="Insights" context={["App friction · where people get stuck in Pulse", d.days === 30 ? "Last 30 days" : "Last 7 days"]}
      actions={<><Link className={styles.btn} href="/telemetry"><Gauge size={14} aria-hidden="true" />Speed</Link><Link className={styles.btn} href="/settings?tab=privacy"><Settings2 size={14} aria-hidden="true" />What Pulse records</Link></>} />
    <QueryTabs base="/insights" items={tabs} current="friction" />
    <div className={css.page}>
      <QueryTabs base="/insights" param="days" sub label="Period" current={String(d.days)} keep="tab=friction" items={[{ key: "7", label: "7 days" }, { key: "30", label: "30 days" }]} />
      {!d.settings.enabled ? <p className={css.note} role="status">Usage recording is off for this company, so nothing new is found. An admin can switch it on in Settings → Privacy.</p> : null}
      <Tiles count={6} dense>
        <Kpi label="Open alerts" value={open} tone={open ? "warning" : "success"} note={d.settings.autoTask ? "Bug tasks open by themselves" : "Found hourly"} />
        <Kpi label="Rage clicks" value={total("rage")} tone={total("rage") ? "danger" : "success"} note="3+ fast clicks on one spot" />
        <Kpi label="Dead clicks" value={total("dead")} tone={total("dead") ? "warning" : "success"} note="Nothing happened" />
        <Kpi label="Errors" value={total("errors")} tone={total("errors") ? "warning" : "success"} note="Script errors and failed calls" />
        <Kpi label="Forms left" value={abandons} note="Started, then left" />
        <Kpi label="Replays" value={d.replays.length} note={d.settings.replay ? `Kept ${d.settings.retentionDays} days` : "Replay is off"} />
      </Tiles>
      {status ? <p className={css.note} role="status">{status}</p> : null}

      <Panel title="Friction alerts" sub="Screens and elements where people got stuck in the last 7 days, before anyone reported it">
        {d.alerts.length ? <ul className={css.alerts}>{d.alerts.map((a) => <li key={a.id} className={css.alert} data-highlight={highlight === a.id ? "" : undefined} data-kind={a.kind}>
          <span className={css.alertIcon} aria-hidden="true">{a.kind === "rage" ? <Flame size={16} /> : a.kind === "dead" ? <MousePointerClick size={16} /> : <TriangleAlert size={16} />}</span>
          <span className={css.alertText}>
            <b>{KIND_WORDS[a.kind] ?? a.kind} on {mono(a.route)}</b>
            <small>{a.label || a.target ? <>{mono(a.label || a.target)} · </> : null}{a.hits} times by {a.people} {a.people === 1 ? "person" : "people"} · last {when(a.lastAt)}</small>
          </span>
          <span className={css.alertActions}>
            {a.status === "task" ? <Badge tone="accent">Bug task open</Badge>
              : <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={busy === a.id} onClick={() => void act(a.id, { task: true }, "A bug task is open for it.")}>Open a bug task</button>}
            {a.sampleSession ? <Link className={`${styles.btn} ${styles.btnSmall}`} href={replayHref(a.sampleSession)}><PlayCircle size={13} aria-hidden="true" />Watch a replay</Link> : null}
            {a.status === "open" ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy === a.id} onClick={() => void act(a.id, { status: "dismissed" }, "Dismissed. It won’t show again unless it gets worse.")}>Dismiss</button> : null}
          </span>
        </li>)}</ul> : <p className={css.empty}>No alerts. Pulse checks every hour for screens where people rage-click, click with no result, hit errors or leave forms.</p>}
      </Panel>

      <Panel title="Hotspots by screen" sub="Rage clicks, dead clicks, errors and stuck moments; open a heatmap to see where">
        <Table label="Hotspots by screen" empty="Nothing went wrong in this period."
          head={[{ label: "Screen" }, { label: "Rage", right: true }, { label: "Dead", right: true }, { label: "Errors", right: true }, { label: "Stuck", right: true }, { label: "Back & forth", right: true }, { label: "People", right: true }, { label: "Worst element" }, { label: "" }]}
          rows={d.hotspots.map((h) => [mono(h.route), h.rage || "–", h.dead || "–", h.errors || "–", h.stuck || "–", h.back || "–", h.people,
            h.targets[0] ? <span key="t">{mono(h.targets[0].label || h.targets[0].sel)} <small className={styles.muted}>×{h.targets[0].n}</small></span> : "–",
            <button key="h" type="button" className={`${styles.btn} ${styles.btnSmall}`} aria-pressed={heat === h.route} onClick={() => setHeat(heat === h.route ? null : h.route)}>{heat === h.route ? "Hide heatmap" : "Heatmap"}</button>])} />
        {heat ? <div className={css.heat}><h3 className={css.heatTitle}>Heatmap of {mono(heat)}</h3><Heatmap key={heat} route={heat} days={d.days} /></div> : null}
      </Panel>

      <div className={css.two}>
        <Panel title="Funnels" sub="Sessions that reached each step, in order, and the share lost">
          <div className={css.funnels}>{d.funnels.map((f) => {
            const top = Math.max(1, f.steps[0]?.sessions ?? 0);
            return <figure key={f.key} className={css.funnel}><figcaption>{f.label}</figcaption>
              <ol>{f.steps.map((s) => <li key={s.label}>
                <span className={css.stepLabel}>{s.label}</span>
                <span className={css.bar} aria-hidden="true"><span style={{ width: `${Math.max(2, share(s.sessions, top))}%` }} /></span>
                <span className={css.stepNum}>{s.sessions}{s.dropPct !== null ? <small data-bad={s.dropPct >= 50 ? "" : undefined}> −{s.dropPct}%</small> : null}</span>
              </li>)}</ol></figure>;
          })}</div>
        </Panel>
        <Panel title="Drop-off points" sub="Forms started and left, and the screens where sessions end">
          <Table label="Forms left half-done" empty="No form was left half-done."
            head={[{ label: "Form" }, { label: "Screen" }, { label: "Started", right: true }, { label: "Left", right: true }, { label: "With errors", right: true }]}
            rows={d.dropOffs.forms.map((f) => [mono(f.name), mono(f.page), f.starts || "–", <b key="a">{f.abandons}</b>, f.errors || "–"])} />
          <Table label="Where sessions end" empty="No sessions yet."
            head={[{ label: "Last screen" }, { label: "Sessions", right: true }]} rows={d.dropOffs.exits.map((x) => [mono(x.page), x.sessions])} />
        </Panel>
      </div>

      <div className={css.two}>
        <Panel title="Time per screen" sub="Active (moving, clicking, typing) and idle time on each screen">
          <Table label="Time per screen" empty="No screen views recorded yet."
            head={[{ label: "Screen" }, { label: "Views", right: true }, { label: "Active", right: true }, { label: "Idle", right: true }, { label: "Typical visit", right: true }]}
            rows={d.timePerScreen.map((t) => [mono(t.page), t.views, duration(t.activeMs), duration(t.idleMs), duration(t.medianActiveMs)])} />
        </Panel>
        <Panel title="Slowest actions" sub="From the click or submit until the screen settled">
          <Table label="Slowest actions" empty="No actions timed yet."
            head={[{ label: "Action" }, { label: "Screen" }, { label: "Count", right: true }, { label: "Typical", right: true }, { label: "Slow (p75)", right: true }]}
            rows={d.slowestActions.map((a) => [<span key="a">{ACTION_WORDS[a.kind] ?? a.kind} {mono(a.name)}</span>, mono(a.page), a.n, duration(a.p50), <b key="p">{duration(a.p75)}</b>])} />
        </Panel>
      </div>

      <Panel title="Session replays" sub={d.settings.replay ? `What people saw, with typed values and private areas hidden; kept ${d.settings.retentionDays} days` : "Session replay is off for this company (Settings → Privacy)"}>
        <Table label="Session replays" empty="No replays in this period."
          head={[{ label: "Replay" }, { label: "Person" }, { label: "First screen" }, { label: "Started" }, { label: "Length", right: true }, { label: "Friction", right: true }]}
          rows={d.replays.map((r) => [<Link key="r" className={styles.cellLink} href={replayHref(r.sid)}><PlayCircle size={13} aria-hidden="true" /> Watch{r.reason === "report" ? " (bug report)" : ""}</Link>,
            r.who ?? "–", mono(r.route), when(r.started), duration(new Date(r.ended).getTime() - new Date(r.started).getTime()), r.friction ? <Badge key="f" tone="warning">{r.friction}</Badge> : "–"])} />
      </Panel>

      {adoption ? <Panel title="Adoption by person" sub="Admins only">
        <p className={css.purpose}><b>Why this is here:</b> {adoption.purpose}</p>
        <Table label="Adoption by person" empty="Nobody used Pulse in this period."
          head={[{ label: "Person" }, { label: "Role" }, { label: "Sessions", right: true }, { label: "Active", right: true }, { label: "Screens", right: true }, { label: "Areas used" }, { label: "Last seen" }]}
          rows={adoption.people.map((p) => [p.name ?? "–", p.role ?? "–", p.sessions, `${p.activeMinutes} min`, p.screens, p.featureList.join(", ") || "–", when(p.lastSeen)])} />
        {adoption.notSeen.length ? <p className={css.empty}>Not seen in this period ({adoption.notSeen.length}): {adoption.notSeen.slice(0, 30).map((p) => p.name).join(", ")}{adoption.notSeen.length > 30 ? "…" : ""}. They may need a hand getting started.</p> : null}
      </Panel> : null}
    </div>
  </>;
}
