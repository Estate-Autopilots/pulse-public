"use client";
// INSIGHTS-2 (1082): Insights → Patterns, the library PATTERNS mines from the chats and Pulse's records. Search, filter by
// family, area, confidence and value; each pattern a card with its numbers (effect with its interval, support, q),
// confidence, value with the arithmetic, the action, its chart and its evidence; one click to a task or an SOP step.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BadgeCheck, ChevronDown, FlaskConical, Search } from "lucide-react";
import { get } from "../chats/net";
import { count, rupees } from "../lib/insight-viz.mjs";
import { AREA_LABEL, FAMILY_LABEL, type Act, type Pattern, type PatternPage } from "./facts";
import { ActButtons, EvidenceLinks } from "./cards";
import { ChartFor, type Filters } from "./viz";
import s from "./insights2.module.css";

const EFFECT = /diff|ratio|lift|odds|hazard|shap|corr|effect/;
const num = (x: number | null | undefined, d = 1) => typeof x === "number" ? (Math.round(x * 10 ** d) / 10 ** d).toLocaleString("en-IN") : "–";

/** The effect and its interval on one small scale around zero (a dot, a whisker, the zero line). */
function EffectBar({ p }: { p: Pattern }) {
  if (typeof p.effect !== "number" || !EFFECT.test(p.effectKind ?? "diff")) return null;
  // ratios sit on a log scale around 1 (no change); differences on a straight scale around 0
  const ratio = /ratio|lift|odds|hazard/.test(p.effectKind ?? ""), f = (n: number) => ratio ? Math.log(Math.max(n, 1e-3)) : n;
  if (ratio && p.effect <= 0) return null;
  const ext = Math.max(Math.abs(f(p.effect)), Math.abs(f(p.ciLow ?? (ratio ? 1 : 0))), Math.abs(f(p.ciHigh ?? (ratio ? 1 : 0)))) * 1.15 || 1;
  const X = (n: number) => `${50 + (f(n) / ext) * 50}%`, dir = f(p.effect) < 0 ? "down" : "up";
  return <span className={s.effect} role="img" aria-label={`Effect ${num(p.effect, 2)}${typeof p.ciLow === "number" ? `, interval ${num(p.ciLow, 2)} to ${num(p.ciHigh, 2)}` : ""}`}>
    <svg width="100%" height="16" aria-hidden="true">
      <line x1="50%" x2="50%" y1="1" y2="15" className={s.effZero} />
      {typeof p.ciLow === "number" && typeof p.ciHigh === "number" ? <line x1={X(p.ciLow)} x2={X(p.ciHigh)} y1="8" y2="8" className={s.effCi} data-dir={dir} /> : null}
      <circle cx={X(p.effect)} cy="8" r="4.5" className={s.effDot} data-dir={dir} />
    </svg>
    <b>{p.effect > 0 && !ratio ? "+" : ""}{num(p.effect, 2)}{ratio ? "×" : ""}</b>
  </span>;
}

function PatternCard({ p, acts, lead, filters }: { p: Pattern; acts: Act[]; lead: boolean; filters: Filters }) {
  const [open, setOpen] = useState(false), [ev, setEv] = useState<Record<string, unknown> | null>(null);
  const expand = async () => { setOpen(!open); if (!ev && p.hasEvidence) { try { const r = await get<{ pattern: { evidence: Record<string, unknown> } }>(`insights/library/patterns/${encodeURIComponent(p.id)}`); setEv(r.pattern.evidence); } catch { setEv({}); } } };
  const confirmed = p.status === "confirmed";
  return <li className={s.pat} data-status={p.status}>
    <div className={s.patTop}>
      <span className={s.patTags}>
        <span className={s.tag} data-conf={confirmed ? "" : undefined}>{confirmed ? <BadgeCheck size={13} aria-hidden="true" /> : <FlaskConical size={13} aria-hidden="true" />}{confirmed ? "Confirmed" : "Candidate"}</span>
        <span className={s.tag}>{FAMILY_LABEL[p.family] ?? p.family}</span>
        <Link className={s.tag} href={`/insights?tab=patterns&area=${p.area}`}>{AREA_LABEL[p.area] ?? p.area}</Link>
      </span>
      {typeof p.valueInr === "number" || typeof p.valueDays === "number" ? <span className={s.value} title={p.valueBasis ?? undefined}>{typeof p.valueInr === "number" ? rupees(p.valueInr) : `${num(p.valueDays, 0)} days`}<small>value</small></span> : null}
    </div>
    <p className={s.statement}>{p.statement}</p>
    <div className={s.patNums}>
      <EffectBar p={p} />
      <span><b>{count(p.support ?? 0)}</b> {p.unit ?? "cases"}</span>
      {typeof p.q === "number" ? <span>q <b>{p.q < 0.001 ? "<0.001" : num(p.q, 3)}</b></span> : null}
      {p.replication && typeof p.replication.same_sign === "boolean" ? <span>{p.replication.same_sign ? "held on later data" : "did not hold later"}</span> : null}
    </div>
    {p.action ? <p className={s.patAction}><b>Do this:</b> {p.action}</p> : null}
    {open ? <div className={s.patMore}>
      {p.chart ? <ChartFor chart={p.chart} data={(p.chart as { data?: unknown }).data ?? p.data} filters={filters} /> : null}
      {p.valueBasis ? <p className={s.basis}><b>Value:</b> {p.valueBasis}</p> : null}
      {ev ? <div className={s.evRow}><EvidenceLinks ev={ev} /></div> : p.hasEvidence ? <p className={s.basis}>Loading the evidence…</p> : null}
    </div> : null}
    <div className={s.patFoot}>
      <button type="button" className={s.why} aria-expanded={open} onClick={() => void expand()}><ChevronDown size={14} aria-hidden="true" style={{ transform: open ? "rotate(180deg)" : undefined }} />{open ? "Less" : "Chart and evidence"}</button>
      {lead ? <ActButtons path={`insights/library/patterns/${encodeURIComponent(p.id)}/act`} acts={acts} /> : null}
    </div>
  </li>;
}

export function Patterns({ page, q, lead, filters, qs }: { page: PatternPage | null; q: Record<string, string | undefined>; lead: boolean; filters: Filters; qs: string }) {
  const router = useRouter(), [text, setText] = useState(q.q ?? "");
  const go = (k: string, val: string) => { const p = new URLSearchParams(qs); p.set("tab", "patterns"); if (val) p.set(k, val); else p.delete(k); p.delete("offset"); router.push(`/insights?${p.toString()}`); };
  if (!page || !page.all) return <section className={s.patEmpty}><FlaskConical size={22} aria-hidden="true" /><h3>The pattern library is filling</h3>
    <p>Pulse is mining the chats and its own records round after round. Confirmed patterns, each with its numbers and what to do, show here as rounds finish.</p></section>;
  const offset = Number(q.offset ?? 0) || 0, sel = (k: string, items: Record<string, number>, label: (x: string) => string, all: string) =>
    <select aria-label={all} value={q[k] ?? ""} onChange={(e) => go(k, e.target.value)}><option value="">{all}</option>{Object.entries(items).sort((a, b) => b[1] - a[1]).map(([x, n]) => <option key={x} value={x}>{label(x)} ({count(n)})</option>)}</select>;
  return <div className={s.stack}>
    <form className={s.patBar} role="search" onSubmit={(e) => { e.preventDefault(); go("q", text.trim()); }}>
      <label className={s.search}><Search size={15} aria-hidden="true" /><input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Search ${count(page.all)} patterns`} aria-label="Search patterns" /></label>
      {sel("area", page.facets.area, (x) => AREA_LABEL[x] ?? x, "Every area")}
      {sel("family", page.facets.family, (x) => FAMILY_LABEL[x] ?? x, "Every kind")}
      {sel("status", page.facets.status, (x) => x === "confirmed" ? "Confirmed" : "Candidates", "Any confidence")}
      <select aria-label="Sort" value={q.sort ?? ""} onChange={(e) => go("sort", e.target.value)}><option value="">Most valuable</option><option value="effect">Largest effect</option><option value="support">Most cases</option><option value="recent">Newest</option></select>
    </form>
    <p className={s.count}>{count(page.total)} of {count(page.all)} patterns{page.total > page.items.length ? ` · ${offset + 1}–${offset + page.items.length}` : ""}</p>
    <ul className={s.patList}>{page.items.map((p) => <PatternCard key={p.id} p={p} lead={lead} filters={filters} acts={page.actions.filter((a) => a.id === p.id)} />)}</ul>
    {page.total > offset + page.items.length || offset ? <nav className={s.pager} aria-label="Pages">
      {offset ? <button type="button" className={s.moreBtn} onClick={() => go("offset", String(Math.max(0, offset - 60)))}>Previous</button> : null}
      {page.total > offset + page.items.length ? <button type="button" className={s.moreBtn} onClick={() => go("offset", String(offset + 60))}>Next 60</button> : null}
    </nav> : null}
  </div>;
}
