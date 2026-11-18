"use client";
// INSIGHTS-2 (1082): the cards and patterns about one colleague or one client, on their own page. The database decides
// who reads them (leaders everything; a colleague only what is about them and marked for them); nothing shows when
// there is nothing the viewer may read.
import Link from "next/link";
import { useEffect, useState } from "react";
import { BadgeCheck, FlaskConical } from "lucide-react";
import { get } from "../chats/net";
import { count, delta, minutes, pct, rupees } from "../lib/insight-viz.mjs";
import { WAIT_BINS, WEEK, type Card, type Pattern } from "./facts";
import { InsightCard, Story } from "./cards";
import { Distribution, Heatmap, Kpis, Line } from "./viz";
import s from "./insights2.module.css";

export function SubjectInsights({ kind, id, first }: { kind: "person" | "client"; id: string; first?: string }) {
  const [cards, setCards] = useState<Card[]>([]), [pats, setPats] = useState<Pattern[]>([]), [total, setTotal] = useState(0);
  useEffect(() => {
    const a = new AbortController();
    get<{ cards: Card[] }>(`insights/library/cards?${kind}=${id}`, a.signal).then((d) => { if (!a.signal.aborted) setCards(d.cards ?? []); }).catch(() => {});
    get<{ items: Pattern[]; total: number }>(`insights/library/patterns?${kind}=${id}&limit=6`, a.signal).then((d) => { if (!a.signal.aborted) { setPats(d.items ?? []); setTotal(d.total ?? 0); } }).catch(() => {});
    return () => a.abort();
  }, [kind, id]);
  if (!cards.length && !pats.length) return null;
  const who = kind === "person" ? (first ? `${first}'s` : "Their") : "This client's";
  return <div className={s.stack} style={{ marginTop: 16 }}>
    {pats.length ? <Story title={`${who} patterns`} sub={`${count(total)} found in the chats and Pulse's records`}>
      <ul className={s.subjList}>{pats.map((p) => <li key={p.id}>
        <span className={s.tag} data-conf={p.status === "confirmed" ? "" : undefined}>{p.status === "confirmed" ? <BadgeCheck size={13} aria-hidden="true" /> : <FlaskConical size={13} aria-hidden="true" />}{p.status === "confirmed" ? "Confirmed" : "Candidate"}</span>
        <span className={s.subjText}><b>{p.statement}</b>{p.action ? <small>Do this: {p.action}</small> : null}</span>
        {typeof p.valueInr === "number" ? <span className={s.value}>{rupees(p.valueInr)}<small>value</small></span> : null}
      </li>)}</ul>
      {total > pats.length ? <Link className={s.more} href={`/insights?tab=patterns`}>All patterns</Link> : null}
    </Story> : null}
    {cards.map((c) => <InsightCard key={c.id} card={c} filters={{}} acts={[]} lead={false} />)}
  </div>;
}

type Answers = { personId: string; groups: number; messages: number; answers: number; p50: number | null; p90: number | null; teamP50: number | null; afterHours: number | null;
  hist: { lo: number; hi: number | null; n: number; team: number }[]; heat: { dow: number; hour: number; n: number }[]; months: { month: string; n: number; p50: number | null }[] };
const HOURS = Array.from({ length: 24 }, (_, h) => String(h));
const hourLabel = (h: string) => { const n = Number(h); return n === 0 ? "12a" : n < 12 ? `${n}a` : n === 12 ? "12p" : `${n - 12}p`; };

/** INSIGHTS-2 (1086): how fast a colleague answers clients and when they write, against the whole team. Leaders see
 *  anyone's; a colleague their own; nothing for anyone else or when the chats hold nothing of theirs. */
export function PersonAnswers({ id, first, self }: { id: string; first: string; self?: boolean }) {
  const [a, setA] = useState<Answers | null>(null);
  useEffect(() => { const c = new AbortController(); get<{ answers: Answers | null }>(`insights/people/${id}/answers`, c.signal).then((d) => { if (!c.signal.aborted) setA(d.answers); }).catch(() => {}); return () => c.abort(); }, [id]);
  if (!a || !a.messages) return null;
  const who = self ? "you" : first;
  const d = delta(a.p50, a.teamP50, "down");
  const mineTot = a.hist.reduce((x, b) => x + b.n, 0);
  return <div className={s.stack} style={{ marginTop: 16 }}>
    <Kpis items={[
      ...(a.answers ? [] : [{ label: "Answers to clients", value: "None", note: "no answer to a client recorded in the groups" }]),
      ...(!a.answers ? [] : [{ label: `${self ? "You answer" : `${first} answers`} clients in`, value: minutes(a.p50), note: `median, working time · team ${minutes(a.teamP50)}`,
        delta: d ? { ...d, text: `${d.text} vs team` } : null, s: "team" as const },
      { label: "1 in 10 answers take over", value: minutes(a.p90), note: `${count(a.answers)} answers` }]),
      { label: "After hours", value: pct(a.afterHours), note: "before 10:00, after 19:00, Sundays" },
      { label: "Groups", value: count(a.groups), note: `${count(a.messages)} messages` },
    ]} />
    <div className={s.grid}>
      {mineTot >= 5 ? <Story title={`How fast ${who} answer${self ? "" : "s"} clients`} sub="share of answers by time taken, against the whole team" rows={a.hist.map((b, i) => ({ bin: WAIT_BINS[i]?.label, mine: b.n, team: b.team }))}>
        <Distribution bins={WAIT_BINS.map((b) => b.label)} series={[{ key: "me", label: self ? "You" : first, s: "team", counts: a.hist.map((b) => b.n) }, { key: "team", label: "The whole team", s: "muted", counts: a.hist.map((b) => b.team) }]} label="Answer times" />
      </Story> : null}
      <Story title={`When ${who} write${self ? "" : "s"}`} sub="messages in the groups by weekday and hour" rows={a.heat.map((h) => ({ weekday: WEEK[h.dow - 1], hour: h.hour, messages: h.n }))}>
        <Heatmap rows={a.heat.map((h) => ({ row: String(h.dow), col: String(h.hour), value: h.n }))} rowKeys={["1", "2", "3", "4", "5", "6", "7"]} colKeys={HOURS} rowLabel={(k) => WEEK[Number(k) - 1]} colLabel={hourLabel} hue="team" unitWord="Messages" colEvery={3} label="Messages by weekday and hour" />
      </Story>
      {a.months.length >= 3 ? <Story title="Is it getting faster?" sub="median answer by month (working minutes)" rows={a.months} wide>
        <Line rows={a.months.map((m) => ({ x: m.month.slice(2).replace("-", "/"), value: m.p50 }))} unit="m" label="Median answer by month" refLine={typeof a.teamP50 === "number" ? { value: a.teamP50, label: "team median" } : undefined} />
      </Story> : null}
    </div>
  </div>;
}

/** A colleague's page: their answer times and hours, then their patterns and cards, as one view ("title" names it in
 *  the page's Workspace). */
export function PersonInsights({ id, first }: { id: string; first: string; title?: string }) {
  return <><PersonAnswers id={id} first={first} /><SubjectInsights kind="person" id={id} first={first} /></>;
}
