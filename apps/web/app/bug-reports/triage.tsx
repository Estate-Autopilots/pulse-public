"use client";
// BUG-REPORT (owner, 27 Oct 2026): the triage list and one report's panel. Leadership and admins set the status (new,
// triaged, fixing, fixed, won't fix), the severity and who fixes it, mark a report as a duplicate of another (reports on
// the same screen with the same first error are offered as "Similar"), add a note, and make a Pulse task from it. The
// reporter sees the status change under Your reports, and a note in Pulse when it is fixed.
import { Bug, CheckSquare, ExternalLink, Film, Image as ImageIcon, Layers, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { notify } from "@pulse/ui-shell";
import { Drawer, DrawerSection } from "../kit";
import { STATUS_WORDS, TRIAGE_WORDS } from "../lib/bug-report.mjs";
import { Badge, Empty, QueryTabs, styles as ui } from "../ui";
import css from "./triage.module.css";

type Status = "new" | "triaged" | "fixing" | "fixed" | "wontfix";
export type BugRow = { id: string; number: number; words: string; route: string; status: Status; severity: string | null; blocksWork: boolean; platform: string; appVersion: string | null;
  reporterId: string | null; reporterName: string | null; signedOut: boolean; reporterContact: string | null; assigneeId: string | null; assigneeName: string | null; duplicateOf: string | null; duplicateNumber: number | null; taskId: string | null;
  createdAt: string; statusAt: string; hasScreenshot: boolean; hasRecording: boolean; errorCount: number; callCount: number; stepCount: number; similar: number };
export type BugList = { status: string; q: string; rows: BugRow[]; counts: Record<Status | "all", number>; people: { id: string; name: string }[] };
export type MineRow = { id: string; number: number; words: string; route: string; status: Status; statusAt: string; createdAt: string; duplicateNumber: number | null };
type Detail = BugRow & { context: Record<string, string | number | boolean>; errors: { at: string; kind: string; message?: string; source?: string; count?: number }[];
  network: { at: string; method: string; path: string; status: number; ms?: number }[]; trail: { at: string; kind: string; name?: string; page?: string; ms?: number; status?: number }[];
  events: { kind: string; value: string | null; note: string | null; at: string; actorName: string | null }[]; similar: { id: string; number: number; words: string; status: Status; createdAt: string }[];
  files: { kind: string; contentType: string; bytes: number; seconds: number | null }[]; canTriage: boolean };

const TONE: Record<string, "neutral" | "warning" | "success" | "danger" | "accent"> = { new: "warning", triaged: "neutral", fixing: "accent", fixed: "success", wontfix: "neutral",
  blocker: "danger", high: "danger", medium: "warning", low: "neutral" };
const SEVERITY: Record<string, string> = { blocker: "Blocker", high: "High", medium: "Medium", low: "Low" };
const TABS: { key: string; label: string }[] = [{ key: "open", label: "Open" }, { key: "new", label: "New" }, { key: "triaged", label: "Triaged" }, { key: "fixing", label: "Fixing" },
  { key: "fixed", label: "Fixed" }, { key: "wontfix", label: "Won’t fix" }, { key: "all", label: "All" }];
// The company's time zone, so the server's render and the browser's agree (no hydration mismatch).
const formats = (zone: string) => ({
  when: (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)),
  clock: (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(iso)),
});
const firstLine = (s: string) => s.split("\n")[0];

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? "Could not load");
  return data as T;
}

export function MyBugReports({ rows, zone }: { rows: MineRow[]; zone: string }) {
  const { when } = formats(zone);
  if (!rows.length) return <Empty icon={Bug} title="Nothing reported yet" text="When something in Pulse goes wrong, press Ctrl+B (⌘B), or shake the phone in the Pulse app, and tell us. We’ll tell you when it’s fixed." />;
  return <ul className={css.list}>{rows.map((r) => <li key={r.id} className={css.row} data-status={r.status}>
    <span className={css.num}>#{r.number}</span>
    <span className={css.main}><b>{firstLine(r.words)}</b><small className={ui.mono}>{r.route}</small></span>
    <span className={css.meta}><Badge tone={TONE[r.status]}>{r.duplicateNumber ? `Same as #${r.duplicateNumber}` : STATUS_WORDS[r.status]}</Badge><small>{when(r.statusAt)}</small></span>
  </li>)}</ul>;
}

export function BugTriage({ data, openId, zone }: { data: BugList; openId: string | null; zone: string }) {
  const { when } = formats(zone);
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(openId);
  const [q, setQ] = useState(data.q);
  const keep = [data.status !== "open" ? `status=${data.status}` : "", data.q ? `q=${encodeURIComponent(data.q)}` : ""].filter(Boolean).join("&");
  return <>
    <div className={css.bar}>
      <QueryTabs base="/bug-reports" param="status" keep={data.q ? `q=${encodeURIComponent(data.q)}` : undefined} current={data.status} sub
        items={TABS.map((t) => ({ ...t, count: t.key === "open" ? data.counts.new + data.counts.triaged + data.counts.fixing : data.counts[t.key as Status | "all"] }))} />
      <form className={css.search} onSubmit={(e) => { e.preventDefault(); router.push(`/bug-reports?${[data.status !== "open" ? `status=${data.status}` : "", q.trim() ? `q=${encodeURIComponent(q.trim())}` : ""].filter(Boolean).join("&")}`); }}>
        <Search size={14} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search words, screen, #number or person" aria-label="Search bug reports" />
      </form>
    </div>
    {data.rows.length ? <ul className={css.list}>{data.rows.map((r) => <li key={r.id}>
      <button type="button" className={css.row} data-status={r.status} onClick={() => setOpen(r.id)} aria-label={`Bug #${r.number}: ${firstLine(r.words)}`}>
        <span className={css.num}>#{r.number}</span>
        <span className={css.main}>
          <b>{firstLine(r.words)}</b>
          <small><span className={ui.mono}>{r.route}</span> · {r.reporterName ?? "Someone"}{r.signedOut ? " (signed out)" : ""} · {when(r.createdAt)} · {r.platform}</small>
        </span>
        <span className={css.signals}>
          {r.hasScreenshot ? <ImageIcon size={14} aria-label="Picture" /> : null}{r.hasRecording ? <Film size={14} aria-label="Recording" /> : null}
          {r.similar ? <span className={css.similar} title="Reports that look like the same problem"><Layers size={13} aria-hidden="true" />{r.similar}</span> : null}
          {r.taskId ? <CheckSquare size={14} aria-label="Has a task" /> : null}
        </span>
        <span className={css.meta}>
          {r.duplicateNumber ? <Badge>Duplicate of #{r.duplicateNumber}</Badge> : <Badge tone={TONE[r.status]}>{TRIAGE_WORDS[r.status]}</Badge>}
          {r.signedOut ? <Badge>Signed out</Badge> : null}
          {r.severity ? <Badge tone={TONE[r.severity]}>{SEVERITY[r.severity]}</Badge> : r.blocksWork ? <Badge tone="danger">Stops work</Badge> : null}
          <small>{r.assigneeName ?? "Nobody yet"}</small>
        </span>
      </button>
    </li>)}</ul> : <Empty icon={Bug} title={data.q ? "No report matches" : data.status === "open" ? "No open bug reports" : "Nothing here"} text="Anyone in the team reports a bug with Ctrl+B (⌘B), a phone shake or the account menu." />}
    {open ? <ReportPanel key={open} id={open} people={data.people} onClose={() => { setOpen(null); if (openId) router.replace(`/bug-reports${keep ? `?${keep}` : ""}`, { scroll: false }); }}
      onChanged={() => router.refresh()} onOpen={setOpen} zone={zone} /> : null}
  </>;
}

function ReportPanel({ id, people, onClose, onChanged, onOpen, zone }: { zone: string; id: string; people: { id: string; name: string }[]; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void }) {
  const router = useRouter();
  const { when, clock } = formats(zone);
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [dup, setDup] = useState("");
  useEffect(() => {
    let alive = true;
    call<Detail>(`bug-reports/${id}`).then((x) => { if (alive) setD(x); }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [id]);
  const change = async (body: Record<string, unknown>, done?: string) => {
    setBusy(true); setError(null);
    try { const x = await call<Detail>(`bug-reports/${id}`, body); setD((old) => ({ ...(old ?? x), ...x })); onChanged(); if (done) notify({ id: "bug-triage", tone: "success", title: done, timeout: 2500 }); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  const makeTask = async () => {
    setBusy(true); setError(null);
    try { const r = await call<{ taskId: string }>(`bug-reports/${id}/task`, {}); setD((old) => (old ? { ...old, taskId: r.taskId, status: old.status === "new" ? "triaged" : old.status } : old)); onChanged();
      notify({ id: "bug-task", tone: "success", title: "Task made", action: { label: "Open it", run: () => router.push(`/tasks/${r.taskId}`) } }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const ctx = d?.context ?? {};
  return <Drawer title={d ? `Bug #${d.number}` : "Bug report"} onClose={onClose} size="xl" icon={<Bug size={18} aria-hidden="true" />}
    context={d ? <span className={css.ctx}>{d.reporterName ?? "Someone"} · {when(d.createdAt)} · <span className={ui.mono}>{d.route}</span></span> : undefined}
    footer={<footer className={css.foot}><p className={css.error} role="alert">{error}</p></footer>}>
    {!d ? <p className={css.fine}>{error ? "" : "Loading…"}</p> : <div className={css.detail}>
      <DrawerSection title="What went wrong">
        <p className={css.words}>{d.words}</p>
        {d.signedOut ? <p className={css.fine}>Sent signed out{d.reporterName ? ` by ${d.reporterName}` : ""}{d.reporterContact ? ` · reach them on ${d.reporterContact}` : " · no contact given"}.</p> : null}
        <p className={css.fine}>{d.blocksWork ? "It stops their work. " : ""}{d.platform} · {d.appVersion ?? "unknown version"}{ctx.browser ? ` · ${ctx.browser}` : ""}{ctx.os ? ` · ${ctx.os}` : ""}{ctx.viewport ? ` · ${ctx.viewport}` : ""}</p>
      </DrawerSection>
      {d.canTriage ? <DrawerSection title="Triage">
        <div className={css.controls}>
          <label>Status<select value={d.status} disabled={busy} onChange={(e) => void change({ status: e.target.value }, `Marked ${TRIAGE_WORDS[e.target.value]}`)}>
            {Object.entries(TRIAGE_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Severity<select value={d.severity ?? ""} disabled={busy} onChange={(e) => void change({ severity: e.target.value || null })}>
            <option value="">Not set</option>{Object.entries(SEVERITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Who fixes it<select value={d.assigneeId ?? ""} disabled={busy} onChange={(e) => void change({ assigneeId: e.target.value || null }, "Assigned")}>
            <option value="">Nobody yet</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        </div>
        <div className={css.controls}>
          {d.taskId ? <Link className={ui.btn} href={`/tasks/${d.taskId}`}><CheckSquare size={14} aria-hidden="true" />Open the Pulse task</Link>
            : <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} disabled={busy} onClick={() => void makeTask()}><CheckSquare size={14} aria-hidden="true" />Make a Pulse task</button>}
          {d.duplicateOf ? <span className={css.dup}>Duplicate of <button type="button" className={css.link} onClick={() => onOpen(d.duplicateOf!)}>#{d.duplicateNumber}</button>
            <button type="button" className={`${ui.btn} ${ui.btnSmall}`} disabled={busy} onClick={() => void change({ duplicateOf: null }, "No longer a duplicate")}>Undo</button></span>
            : <form className={css.dupForm} onSubmit={(e) => { e.preventDefault(); if (dup.trim()) void change({ duplicateOf: dup.trim() }, "Marked as a duplicate").then((ok) => ok && setDup("")); }}>
              <input value={dup} onChange={(e) => setDup(e.target.value)} placeholder="#12" aria-label="Duplicate of report number" inputMode="numeric" />
              <button type="submit" className={`${ui.btn} ${ui.btnSmall}`} disabled={busy || !dup.trim()}>Mark duplicate</button></form>}
        </div>
        <form className={css.noteForm} onSubmit={(e) => { e.preventDefault(); if (note.trim()) void change({ note: note.trim() }, "Note added").then((ok) => ok && setNote("")); }}>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="A note for the team (the reporter does not see it)" aria-label="Note" />
          <button type="submit" className={`${ui.btn} ${ui.btnSmall}`} disabled={busy || !note.trim()}>Add note</button>
        </form>
      </DrawerSection> : <DrawerSection title="Status"><Badge tone={TONE[d.status]}>{STATUS_WORDS[d.status]}</Badge></DrawerSection>}
      {d.files.some((f) => f.kind === "screenshot") ? <DrawerSection title="Picture of the screen">
        <a href={`/api/v0/bug-reports/${d.id}/screenshot`} target="_blank" rel="noreferrer" className={css.shot}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a private picture streamed by the API */}
          <img src={`/api/v0/bug-reports/${d.id}/screenshot`} alt={`The screen when bug #${d.number} was reported`} /></a>
      </DrawerSection> : null}
      {d.files.some((f) => f.kind === "recording") ? <DrawerSection title="Screen recording">
        <video className={css.clip} src={`/api/v0/bug-reports/${d.id}/recording`} controls muted playsInline preload="metadata" />
      </DrawerSection> : null}
      {d.similar.length ? <DrawerSection title={`Looks like the same problem (${d.similar.length})`} help="Reports on the same screen with the same first error. Mark one as a duplicate to group it under the original.">
        <ul className={css.mini}>{d.similar.map((s) => <li key={s.id}><button type="button" className={css.link} onClick={() => onOpen(s.id)}>#{s.number}</button> {firstLine(s.words)} <Badge tone={TONE[s.status]}>{TRIAGE_WORDS[s.status]}</Badge>
          {d.canTriage && !d.duplicateOf ? <button type="button" className={`${ui.btn} ${ui.btnSmall}`} disabled={busy} onClick={() => void change({ duplicateOf: String(s.number) }, `Grouped under #${s.number}`)}>Duplicate of this</button> : null}</li>)}</ul>
      </DrawerSection> : null}
      <DrawerSection title={`Recent errors (${d.errors.length})`}>
        {d.errors.length ? <ol className={css.lines}>{d.errors.map((e, i) => <li key={i}>{clock(e.at)} · {e.kind} · {e.message}{e.source ? ` (${e.source})` : ""}{e.count ? ` ×${e.count}` : ""}</li>)}</ol> : <p className={css.fine}>None sent.</p>}
      </DrawerSection>
      <DrawerSection title={`Failed network calls (${d.network.length})`}>
        {d.network.length ? <ol className={css.lines}>{d.network.map((c, i) => <li key={i}>{clock(c.at)} · {c.method} {c.path} → {c.status || "no connection"}{c.ms !== undefined ? ` · ${c.ms} ms` : ""}</li>)}</ol> : <p className={css.fine}>None sent.</p>}
      </DrawerSection>
      <DrawerSection title={`Recent steps (${d.trail.length})`} help="From Pulse's usage telemetry: the clicks, pages and calls just before the report. Open the whole session on Telemetry.">
        {d.trail.length ? <ol className={css.lines}>{d.trail.map((s, i) => <li key={i}>{clock(s.at)} · {s.kind}{s.name ? ` ${s.name}` : ""}{s.page ? ` on ${s.page}` : ""}{s.ms !== undefined ? ` · ${s.ms} ms` : ""}{s.status !== undefined ? ` · ${s.status}` : ""}</li>)}</ol> : <p className={css.fine}>None sent.</p>}
      </DrawerSection>
      <DrawerSection title="Screen, app and device">
        <dl className={css.facts}>{[["Screen", d.route], ["Platform", d.platform], ["App version", d.appVersion ?? "–"], ...Object.entries(ctx).map(([k, v]) => [k, String(v)])].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      </DrawerSection>
      {d.events.length ? <DrawerSection title="History">
        <ol className={css.history}>{d.events.map((e, i) => <li key={i}><small>{when(e.at)}</small> {e.actorName ?? "Someone"} {e.kind === "note" ? <>noted: <i>{e.note}</i></> : e.kind === "task" ? <>made a <Link href={`/tasks/${e.value}`}>Pulse task <ExternalLink size={11} aria-hidden="true" /></Link></>
          : e.kind === "status" ? `marked it ${TRIAGE_WORDS[e.value ?? ""] ?? e.value}` : e.kind === "severity" ? `set severity ${SEVERITY[e.value ?? ""] ?? "off"}` : e.kind === "assignee" ? `assigned ${people.find((p) => p.id === e.value)?.name ?? (e.value ? "someone" : "nobody")}`
          : e.kind === "duplicate" ? (e.value ? `marked it a duplicate of ${e.value}` : "ungrouped it") : e.kind}</li>)}</ol>
      </DrawerSection> : null}
    </div>}
  </Drawer>;
}
