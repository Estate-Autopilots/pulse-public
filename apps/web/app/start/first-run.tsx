"use client";
import { Check, Circle, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { post } from "../orgs/client";
import css from "./start.module.css";

export type Step = { label: string; note: string; href: string };
export type Guide = { org: string; lead: boolean; dismissed: boolean; roleSteps?: boolean; seat: { key: string; label: string; sees: string[]; does?: string[]; wont: string[]; steps: Step[] };
  items: { key: string; label: string; href: string; note: string; done: boolean }[] };

/** ONBOARD-SELF: the first-run guide inside a company that started itself. Leadership gets the checklist (add people,
 *  a first project, targets, the phone app: each found done from the company's own work, or ticked by hand).
 *  CA-ACCESS (owner, 8 Nov 2026: "For each case there is onboarding, with things written in it"): everyone else, in any
 *  company, gets "Start here": 3 to 5 steps written for what they are (employee, manager, CA, client, vendor…), each
 *  opening the screen where it is done. Put away with ✕ (per person). */
export function FirstRun({ initial, page }: { initial: Guide; page?: boolean }) {
  const [g, setG] = useState(initial); const [error, setError] = useState<string | null>(null), [all, setAll] = useState(false);
  const mark = async (item: string, done: boolean) => {
    setError(null);
    try { setG((await post<{ guide: Guide }>("account/onboarding", { item, done })).guide); } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); }
  };
  if (g.dismissed && !page) return null;
  const n = g.items.filter((i) => i.done).length;
  // VITALS-SWEEP (22 Nov 2026; judge on the dashboard and My day: four steps with notes filled the phone's first screen):
  // on a home the first step shows, then "All N steps"; the guide page shows them all.
  const steps = page || all ? g.seat.steps : g.seat.steps.slice(0, 1);
  return <section className={css.firstRun} aria-labelledby="first-run-h">
    <div className={css.firstRunHead}>
      <div><h2 id="first-run-h">{g.lead ? `Getting ${g.org} started` : `Start here`}</h2>
        <p className={css.muted}>{g.lead ? `${n} of ${g.items.length} done` : `You’re in ${g.org} as ${g.seat.key === 'accountant' ? 'their CA' : g.seat.label.toLowerCase()}. ${g.seat.steps.length} short steps:`}</p></div>
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
    {g.lead ? null : <ol className={css.startSteps} aria-label="Start here">{steps.map((t, i) => <li key={t.label}>
      <Link href={t.href} className={css.startStep}><span className={css.startNo} aria-hidden="true">{i + 1}</span><span><b>{t.label}</b><small>{t.note}</small></span></Link>
    </li>)}</ol>}
    {g.lead || page || g.seat.steps.length < 2 ? null : <button type="button" className={css.allSteps} aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Fewer" : `All ${g.seat.steps.length} steps`}</button>}
    {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
    {page && g.dismissed ? <button type="button" className={css.btn} onClick={() => void mark("dismissed", false)}>Show this on my home page again</button> : null}
  </section>;
}
