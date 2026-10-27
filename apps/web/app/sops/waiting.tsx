"use client";
// WORKFLOW BUILDER: what waits for a person, block by block. Each block shows its SOP checklist (tick the lines while
// doing it), the run's values it takes in, and its one next step: in a live run, the task, the form or the module's
// page and Mark done (an approval answers here); in a test run, Done as that person, with the values the block gives out.
import Link from "next/link";
import { Fragment, useState } from "react";
import { CircleCheck, ExternalLink, PenLine } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { dayTime } from "../lib/format";
import { post } from "../records";
import { Avatar, styles } from "../ui";
import { ENGINE_WORD, type WaitingItem } from "./board-types";
import css from "./blocks.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

export function WaitingList({ items, mode, empty, onChanged }: { items: WaitingItem[]; mode: "live" | "test"; empty: string; onChanged: () => void }) {
  if (!items.length) return <p className={css.note}>{empty}</p>;
  return <ul className={css.items}>{items.map((i) => <WaitingCard key={i.id} item={i} mode={mode} onChanged={onChanged} />)}</ul>;
}

function WaitingCard({ item, mode, onChanged }: { item: WaitingItem; mode: "live" | "test"; onChanged: () => void }) {
  const [checks, setChecks] = useState<number[]>(item.checks), [values, setValues] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function act(run: () => Promise<unknown>, done: string) {
    setBusy(true); setError("");
    try { await run(); notify({ id: `wf-${item.id}`, tone: "success", title: done, timeout: 2500 }); onChanged(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  async function tick(i: number, on: boolean) {
    const before = checks; setChecks(on ? [...checks, i] : checks.filter((x) => x !== i));
    try { const r = await post<{ checks: number[] }>(`workflows/steps/${item.id}/check`, { index: i, done: on }); setChecks(r.checks); } catch (e) { setChecks(before); setError(msg(e)); }
  }
  const first = item.person?.split(" ")[0] ?? "them";
  const testDone = (choice?: string) => act(() => post(`workflows/steps/${item.id}/test-done`, { choice: choice ?? null, values: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())) }),
    choice ? `${choice}: the test moves on` : `Done as ${first}: the test moves on`);
  const href = item.link ? `${item.link}${item.projectId ? `&project=${item.projectId}` : ""}` : null;
  return <li id={`step-${item.id}`} className={css.item} data-late={item.late ? "" : undefined}>
    <div className={css.itemHead}>
      {item.person ? <Avatar name={item.person} id={item.personId ?? undefined} photoAt={item.photoAt} size={30} /> : null}
      <div><small>{item.block}{item.engine === "stub" ? ` · ${ENGINE_WORD.stub}` : ""} · {item.workflow}{item.board ? ` · ${item.board}` : ""}</small><b>{item.title}</b>
        <small>{item.run}{item.dueAt ? ` · due ${dayTime(item.dueAt)}` : ""}{item.late ? " · late" : ""}{mode === "test" ? ` · ${item.kind === "wait" ? "a wait: Done skips it" : item.person ? `would go to ${item.person}` : "nobody to give it to yet"}` : ""}</small></div>
    </div>
    {item.checklist.length ? <ul className={css.checklist} aria-label="Checklist">{item.checklist.map((l, i) => <li key={i}><label>
      <input type="checkbox" checked={checks.includes(i)} disabled={busy} onChange={(e) => void tick(i, e.target.checked)} />{l}</label></li>)}</ul> : null}
    {item.values.length ? <dl className={css.values}>{item.values.slice(0, 8).map((v) => <Fragment key={v.key}><dt>{v.key}</dt><dd>{v.value}</dd></Fragment>)}</dl> : null}
    {mode === "test" && item.outputs.length && !item.choices.length ? <div className={css.row2}>{item.outputs.slice(0, 4).map((o) => <label key={o.key} className={css.field}><span>{o.label} (what the block gives out)</span>
      <input value={values[o.key] ?? ""} maxLength={500} onChange={(e) => setValues({ ...values, [o.key]: e.target.value })} placeholder="Optional in a test" /></label>)}</div> : null}
    <div className={css.actions}>
      {mode === "test" ? item.choices.length ? item.choices.map((c) => <button key={c} type="button" className={`${styles.btn} ${c === item.choices[0] ? styles.btnPrimary : ""}`} disabled={busy} onClick={() => void testDone(c)}>{c}</button>)
        : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void testDone()}><CircleCheck size={14} aria-hidden="true" />{item.kind === "wait" ? "Skip the wait" : item.person ? `Done as ${first}` : "Done"}</button> : <>
        {item.choices.length ? item.choices.map((c) => <button key={c} type="button" className={`${styles.btn} ${c === item.choices[0] ? styles.btnPrimary : ""}`} disabled={busy}
          onClick={() => void act(() => post(`workflows/steps/${item.id}/decide`, { choice: c }), `${c}: the run moves on`)}>{c}</button>) : null}
        {item.canFill ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href={`/sops/fill/${item.id}`}><PenLine size={14} aria-hidden="true" />Fill the form</Link> : null}
        {href ? <Link className={styles.btn} href={href}><ExternalLink size={14} aria-hidden="true" />{item.module === "tax_invoice" ? "Make the invoice" : "Make the quotation"}</Link> : null}
        {item.taskId ? <Link className={styles.btn} href={`/tasks/${item.taskId}`}><ExternalLink size={14} aria-hidden="true" />Open the task</Link> : null}
        {item.taskId && !item.choices.length && !item.canFill ? <button type="button" className={`${styles.btn} ${item.canFill || href ? "" : styles.btnPrimary}`} disabled={busy}
          onClick={() => void act(() => post(`tasks/${item.taskId}/move`, { status: "done" }), "Done: the run moves on")}><CircleCheck size={14} aria-hidden="true" />Mark done</button> : null}</>}
    </div>
    {error ? <p className={css.note} role="alert" style={{ color: "var(--theme-danger)" }}>{error}</p> : null}
  </li>;
}
