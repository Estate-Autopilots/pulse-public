"use client";
// KAZUK-REST slice 5: the routed reports, one row each (the company and its number, the masked title, the screen, the
// signals), with the dev team's status, its own task and the way back to the original in the admin console.
import { Bug, ExternalLink, ListPlus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { Badge, Empty } from "../../ui";
import css from "./inbox.module.css";

type Status = "new" | "triaged" | "fixing" | "fixed" | "wontfix";
export type DevRow = { id: string; sourceOrg: string; sourceOrgName: string; sourceReport: string; sourceNumber: number; kind: string; title: string; route: string;
  severity: string | null; blocksWork: boolean; platform: string; appVersion: string | null; browser: string | null; os: string | null; signedOut: boolean; byAgent: boolean;
  errorCount: number; callCount: number; stepCount: number; reportedAt: string; status: Status; statusAt: string; taskId: string | null; adminPath: string };
export type DevInboxData = { devOrg: boolean; status: string; rows: DevRow[]; counts: { new: number; handling: number; fixed: number; all: number; companies: number } | null };

const STATUS: Record<Status, { label: string; tone: "neutral" | "warning" | "success" | "accent" }> = {
  new: { label: "New", tone: "warning" }, triaged: { label: "Triaged", tone: "neutral" }, fixing: { label: "Being fixed", tone: "accent" }, fixed: { label: "Fixed", tone: "success" }, wontfix: { label: "Won’t fix", tone: "neutral" } };
const when = (zone: string, iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: zone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? "Not saved. Try again.");
  return data as T;
}

export function DevInbox({ data, zone, adminUrl }: { data: DevInboxData; zone: string; adminUrl: string }) {
  const [rows, setRows] = useState(data.rows);
  const [from, setFrom] = useState(data);
  const [busy, setBusy] = useState<string | null>(null);
  if (from !== data) { setFrom(data); setRows(data.rows); }
  const patch = (id: string, over: Partial<DevRow>) => setRows((xs) => xs.map((x) => x.id === id ? { ...x, ...over } : x));
  async function setStatus(row: DevRow, status: Status) {
    setBusy(row.id);
    try { const r = await post<DevRow>(`bug-reports/dev-inbox/${row.id}`, { status }); patch(row.id, { status: r.status, statusAt: r.statusAt }); }
    catch (e) { notify({ id: "dev-inbox", tone: "error", title: "Not saved", message: (e as Error).message }); }
    finally { setBusy(null); }
  }
  async function task(row: DevRow) {
    setBusy(row.id);
    try { const r = await post<{ taskId: string }>(`bug-reports/dev-inbox/${row.id}/task`); patch(row.id, { taskId: r.taskId, status: row.status === "new" ? "triaged" : row.status });
      notify({ id: "dev-inbox", tone: "success", title: "Task made", timeout: 2200 }); }
    catch (e) { notify({ id: "dev-inbox", tone: "error", title: "No task made", message: (e as Error).message }); }
    finally { setBusy(null); }
  }
  if (!rows.length) return <Empty icon={Bug} title="Nothing here" text="When someone in another company reports a bug, its summary shows here." />;
  return <ul className={css.list} aria-label="Bug reports from other companies">{rows.map((r) => <li key={r.id} className={css.row} data-status={r.status}>
    <div className={css.main}>
      <span className={css.from}><b>{r.sourceOrgName}</b> · #{r.sourceNumber} · {when(zone, r.reportedAt)}</span>
      <b className={css.title}>{r.title}</b>
      <small className={css.facts}>
        <code>{r.route}</code>
        {r.severity ? <span>{r.severity}</span> : null}
        {r.blocksWork ? <span className={css.stop}>Stopped their work</span> : null}
        <span>{r.platform}{r.browser ? ` · ${r.browser}` : ""}{r.os ? ` · ${r.os}` : ""}{r.appVersion ? ` · ${r.appVersion}` : ""}</span>
        <span>{r.errorCount} errors · {r.callCount} failed calls · {r.stepCount} steps</span>
        {r.signedOut ? <span>Signed out</span> : null}{r.byAgent ? <span>From an AI employee</span> : null}
      </small>
    </div>
    <div className={css.side}>
      <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
      <span className={css.pick}>
        <select title="The company sees the same status on its own report" value={r.status} disabled={busy === r.id} onChange={(e) => void setStatus(r, e.target.value as Status)} aria-label={`Status of ${r.sourceOrgName} #${r.sourceNumber}`}>
          {(Object.keys(STATUS) as Status[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
        </select></span>
      {r.taskId ? <Link className={css.action} href={`/tasks/${r.taskId}`}>Open the task</Link>
        : <button type="button" className={css.action} disabled={busy === r.id} onClick={() => void task(r)}><ListPlus size={14} aria-hidden="true" />Make a task</button>}
      {adminUrl ? <a className={css.action} href={`${adminUrl}${r.adminPath}`} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />Original report</a>
        : <small className={css.fine} title="Platform admins open the original in the admin console">Admin console: {r.adminPath}</small>}
    </div>
  </li>)}</ul>;
}
