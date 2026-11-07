"use client";
// TASKS-3: work Pulse found for the pool, in batches by where it came from (Drive, the usual steps of a client package,
// unowned tracker tasks). Leadership takes out what does not belong and approves the rest in one click (no value: INTEGRITY);
// nothing reaches the pool before that.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, FolderKanban, HardDrive, Inbox, ListChecks, RotateCcw, Sparkles, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { styles } from "../ui";
import css from "./work3.module.css";

export type PoolItem = { id: string; title: string; notes: string | null; categoryLabel: string | null; projectId: string | null; projectName: string | null; scope: string; ref: string | null;
  estimateMinutes: number | null; tasks: number; evidence: string[]; status: string; taskId: string | null };
export type PoolBatch = { id: string; source: "drive" | "steps" | "tracker"; title: string; summary: string | null; status: string; createdAt: string; createdBy: string | null; decidedBy: string | null; items: PoolItem[] };
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const ICON = { drive: HardDrive, steps: ListChecks, tracker: Inbox };
const where = (x: PoolItem) => x.scope === "company" ? "Company pool" : x.scope === "pod" ? `${x.ref} pool` : `${x.ref} department pool`;

function Item({ x, open }: { x: PoolItem; open: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function edit(body: Record<string, unknown>) { setBusy(true); try { await post(`work/pool/proposals/${x.id}`, body); router.refresh(); } catch (e) { notify({ id: "pool-edit", tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); } }
  const removed = x.status === "removed";
  return <li className={css.poolItem} data-removed={removed ? "" : undefined}>
    <span className={css.poolItemMain}>
      <b title={x.title}>{x.taskId ? <Link href={`/tasks/${x.taskId}`} title={x.title}>{x.title}</Link> : x.title}</b>
      <span className={css.poolFacts}><span className={css.fact}><Inbox size={11} aria-hidden="true" />{where(x)}</span>{x.projectName ? <span className={css.fact}><FolderKanban size={11} aria-hidden="true" />{x.projectName}</span> : null}
        {x.categoryLabel ? <span className={css.fact}>{x.categoryLabel}</span> : null}{x.tasks ? <span className={css.fact}>{x.tasks} existing tasks</span> : null}</span>
      <small>{x.evidence.join(" · ")}</small>
    </span>
    <span className={css.poolItemEnd}>
      {x.estimateMinutes ? <span className={css.fact}>about {x.estimateMinutes < 60 ? `${x.estimateMinutes} min` : `${Math.round(x.estimateMinutes / 6) / 10} h`}</span> : null}
      {open ? <button type="button" className={css.iconBtn} disabled={busy} onClick={() => void edit({ removed: !removed })} aria-label={removed ? `Put back “${x.title}”` : `Take out “${x.title}”`} title={removed ? "Put back" : "Take out"}>
        {removed ? <RotateCcw size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}</button> : x.status === "published" ? <Check size={14} aria-label="In the pool" /> : null}
    </span>
  </li>;
}

export function PoolProposals({ batches, canDecide }: { batches: PoolBatch[]; canDecide: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [shown, setShown] = useState<Record<string, boolean>>({});
  async function run(path: string, ok: (r: Record<string, number>) => string) {
    setBusy(true); try { const r = await post<Record<string, number>>(path, {}); notify({ id: "pool-batch", tone: "success", title: ok(r), timeout: 3800 }); router.refresh(); }
    catch (e) { notify({ id: "pool-batch", tone: "error", title: "Not done", message: msg(e) }); } finally { setBusy(false); }
  }
  const pending = batches.filter((b) => b.status === "pending");
  return <section className={css.poolProposals} aria-label="Proposed for the pool">
    <div className={css.cardHead}><h3><Sparkles size={15} aria-hidden="true" />Proposed for the pool</h3>
      {canDecide ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void run("work/pool/proposals/generate", (r) => r.batches ? `${r.items} proposals in ${r.batches} batch${r.batches === 1 ? "" : "es"}` : "Nothing new to propose")}>Look for work</button> : null}</div>
    {!pending.length ? <p className={css.line} style={{ padding: "0 16px 14px" }}>{canDecide ? "Pulse reads the Drive folders, the usual steps of a client package in the trackers, and unowned tracker tasks. Press Look for work." : "Leadership approves what Pulse proposes from Drive and the trackers."}</p> : null}
    {batches.map((b) => { const Icon = ICON[b.source] ?? Sparkles; const open = b.status === "pending" && canDecide; const live = b.items.filter((x) => x.status === "pending").length; const all = shown[b.id] || b.items.length <= 5;
      return <article key={b.id} className={css.batch} data-status={b.status}>
        <header className={css.batchHead}><span className={css.batchIcon} aria-hidden="true"><Icon size={16} /></span>
          <span><b>{b.title}</b><small>{b.status === "pending" ? b.summary : `${b.status === "approved" ? "Approved" : "Dismissed"}${b.decidedBy ? ` by ${b.decidedBy}` : ""}`}</small></span>
          {open ? <span className={css.batchActions}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !live} onClick={() => void run(`work/pool/batches/${b.id}/approve`, (r) => `${(r.made ?? 0) + (r.pooled ?? 0)} in the pool`)}><Check size={13} aria-hidden="true" />Approve {live}</button>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => void run(`work/pool/batches/${b.id}/dismiss`, () => "Dismissed")}>Dismiss</button></span> : null}</header>
        <ul className={css.poolItems}>{(all ? b.items : b.items.slice(0, 5)).map((x) => <Item key={x.id} x={x} open={open} />)}</ul>
        {!all ? <button type="button" className={css.more} onClick={() => setShown({ ...shown, [b.id]: true })}>Show all {b.items.length}</button> : null}
      </article>; })}
  </section>;
}
