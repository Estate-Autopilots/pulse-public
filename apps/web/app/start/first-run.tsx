"use client";
import { Check, Circle, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { post } from "../orgs/client";
import css from "./start.module.css";

export type Guide = { org: string; lead: boolean; dismissed: boolean; seat: { key: string; label: string; sees: string[]; wont: string[]; tips: string[] };
  items: { key: string; label: string; href: string; note: string; done: boolean }[] };

/** ONBOARD-SELF: the first-run guide inside a company that started itself. Leadership gets the checklist (invite the
 *  team, a first project, targets, the phone app: each found done from the company's own work, or ticked by hand);
 *  everyone gets short tips for their seat. Put away with ✕ (per person). */
export function FirstRun({ initial, page }: { initial: Guide; page?: boolean }) {
  const [g, setG] = useState(initial); const [error, setError] = useState<string | null>(null);
  const mark = async (item: string, done: boolean) => {
    setError(null);
    try { setG((await post<{ guide: Guide }>("account/onboarding", { item, done })).guide); } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); }
  };
  if (g.dismissed && !page) return null;
  const n = g.items.filter((i) => i.done).length;
  return <section className={css.firstRun} aria-labelledby="first-run-h">
    <div className={css.firstRunHead}>
      <div><h2 id="first-run-h">{g.lead ? `Getting ${g.org} started` : `Welcome to ${g.org}`}</h2>
        <p className={css.muted}>{g.lead ? `${n} of ${g.items.length} done` : `You’re here as ${g.seat.label.toLowerCase()}.`}</p></div>
      {page ? null : <button type="button" className={css.close} onClick={() => void mark("dismissed", true)} aria-label="Hide the getting-started guide"><X size={18} aria-hidden="true" /></button>}
    </div>
    {g.lead ? <>
      <div className={css.bar} aria-hidden="true"><span style={{ width: `${(n / Math.max(1, g.items.length)) * 100}%` }} /></div>
      <ul className={css.check}>{g.items.map((i) => <li key={i.key} className={css.item} data-done={i.done ? "" : undefined}>
        <button type="button" className={css.box} onClick={() => void mark(i.key, !i.done)} aria-pressed={i.done} aria-label={`${i.label}: ${i.done ? "done" : "not done"}`}>
          {i.done ? <Check size={22} aria-hidden="true" /> : <Circle size={22} aria-hidden="true" />}</button>
        <span><b>{i.label}</b><small>{i.note}</small></span>
        {i.done ? null : <Link className={css.go} href={i.href}>Open</Link>}
      </li>)}</ul>
    </> : null}
    <div><p className={css.muted}><b>How to use Pulse as {g.seat.label.toLowerCase()}</b></p>
      <ul className={css.tips}>{g.seat.tips.map((t) => <li key={t}>{t}</li>)}</ul></div>
    {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
    {page && g.dismissed ? <button type="button" className={css.btn} onClick={() => void mark("dismissed", false)}>Show this on my home page again</button> : null}
  </section>;
}
