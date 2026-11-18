"use client";
// UI-SWEEP (owner, 10 Nov 2026: "HR's list is just too long and looks ugly, with the three sections"). The HR desk's
// overview, summary first (Codex concept "Summary first", with concept 2's segmented "Who is out" and inline decisions):
//   - AskRow: a waiting request as one compact row (face, name, what, when, Approve / Reject in the row); the reason, the
//     balance and when it was asked open under it on demand.
//   - WhoIsOut: Not in yet / On leave / From home as segmented tabs with counts; the first five people, then "Show all".
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleCheck } from "lucide-react";
import { Segmented } from "../../kit";
import { Avatar } from "../../ui";
import { Decide } from "../actions";
import css from "./overview.module.css";

export type Ask = { kind: "leave" | "regularisation"; id: string; personId: string; name: string; photoAt: string | null; what: string; when: string; whenTitle?: string;
  reason: string | null; impact: string; over?: boolean; asked: string; own: boolean };

/** One solid Approve on the view: the open request's, or the first one's while none is open (`lead`). */
export function AskRow({ ask: a, lead, onOpen }: { ask: Ask; lead?: boolean; onOpen?: (id: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const body = `ask-${a.id}`;
  return <li className={css.ask} data-open={open ? "" : undefined}>
    <div className={css.askLine}>
      <button type="button" className={css.askToggle} aria-expanded={open} aria-controls={body} aria-label={open ? `Hide the details of ${a.name}'s request` : `Show the reason for ${a.name}'s request`} onClick={() => { setOpen(!open); onOpen?.(open ? null : a.id); }}>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <Avatar name={a.name} id={a.personId} photoAt={a.photoAt} size={28} />
      <span className={css.askWho}>
        <Link href={`/people/${a.personId}?tab=attendance`} className={css.askName}>{a.name}</Link>
        <span className={css.askMeta}><span className={css.askWhat}>{a.what}</span><span title={a.whenTitle}>{a.when}</span></span>
      </span>
      <span className={css.askDo}>{a.own ? <span className={css.askOwn} title="Nobody can decide their own request">Someone else decides</span> : <Decide kind={a.kind} id={a.id} name={a.name} quiet={!lead} />}</span>
    </div>
    {open ? <div id={body} className={css.askMore}>
      {a.reason ? <p className={css.askReason}>“{a.reason}”</p> : null}
      <p className={css.askImpact} data-over={a.over ? "" : undefined}>{a.impact}</p>
      <p className={css.askAgo}>Asked {a.asked}</p>
    </div> : null}
  </li>;
}

export type OutPerson = { id: string; name: string; photoAt: string | null; what: ReactNode };
export type OutGroup = { key: string; label: string; people: OutPerson[]; empty: string };
const TOP = 5;

export function WhoIsOut({ groups }: { groups: OutGroup[] }) {
  const [tab, setTab] = useState(groups.find((g) => g.people.length)?.key ?? groups[0]?.key ?? "");
  const [all, setAll] = useState(false);
  const g = groups.find((x) => x.key === tab) ?? groups[0];
  if (!g) return null;
  const shown = all ? g.people : g.people.slice(0, TOP);
  return <div className={css.out}>
    <Segmented label="Who is out" size="sm" fill value={tab} onChange={(v) => { setTab(v); setAll(false); }}
      options={groups.map((x) => ({ value: x.key, label: x.label, count: x.people.length }))} />
    {g.people.length ? <ul className={css.outList} data-all={all ? "" : undefined}>
      {shown.map((p) => <li key={p.id} className={css.outRow}>
        <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={28} />
        {/* Name over its line (a role, a leave type, a time): a long role never squeezes the name. */}
        <span className={css.outMain}><Link href={`/people/${p.id}?tab=attendance`} className={css.outName}>{p.name}</Link>{p.what ? <span className={css.outWhat}>{p.what}</span> : null}</span>
      </li>)}
    </ul> : <p className={css.outNone}><CircleCheck size={15} aria-hidden="true" />{g.empty}</p>}
    {g.people.length > TOP ? <button type="button" className={css.showAll} aria-expanded={all} onClick={() => setAll(!all)}>
      {all ? "Show fewer" : `Show all ${g.people.length}`}<ChevronRight size={14} aria-hidden="true" data-open={all ? "" : undefined} />
    </button> : null}
  </div>;
}

/** The requests waiting for a decision. Exactly one solid Approve: the open one's, or the first one's. */
export function AskList({ asks, className }: { asks: Ask[]; className?: string }) {
  const [opened, setOpened] = useState<string | null>(null);
  const lead = opened ?? asks.find((a) => !a.own)?.id ?? null;
  return <ul className={className}>{asks.map((a) => <AskRow key={a.id} ask={a} lead={a.id === lead} onOpen={setOpened} />)}</ul>;
}
