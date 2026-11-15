import Link from "next/link";
import { ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { InfoDrawer } from "../records";
import { Avatar, Badge, Empty } from "../ui";
import css from "./people.module.css";

/** LIFECYCLE part 2: each person's value to the company against their cost, for founders and HR. Sorted by name, never
 *  ranked; the band compares with the company's median for the month, with the method and confidence beside it. */
export type ValueRow = { person: { id: string; name: string; role: string | null; pod: string | null; department: string | null; joinedOn: string | null; photoAt: string | null; stage: string };
  cost: number | null; value: number; linked: number; pooled: number; ratio: number | null; units: number; points: number; tasks: number; accepted: number; deliveries: number; returned: number;
  acceptRate: number | null; onTimeRate: number | null; withDue: number; tenureDays: number | null; band: { band: Band; allowance: number }; confidence: "high" | "medium" | "low";
  trend: { month: string; ratio: number | null }[] };
type Band = "strong" | "on_par" | "below" | "ramp" | "not_measured" | "no_cost";
export type ValueData = { month: string; rows: ValueRow[]; company: { revenue: number | null; linkedRevenue: number | null; coverage: number | null; cost: number | null; value: number | null; median: number | null; people: number; withCost: number };
  method: Record<"value" | "units" | "cost" | "band" | "confidence", string> };

export const BAND: Record<Band, { label: string; tone: "success" | "neutral" | "warning" | "accent" }> = {
  strong: { label: "Strong", tone: "success" }, on_par: { label: "On par", tone: "neutral" }, below: { label: "Below", tone: "warning" },
  ramp: { label: "Ramping up", tone: "accent" }, not_measured: { label: "No work recorded", tone: "neutral" }, no_cost: { label: "No salary on record", tone: "neutral" },
};
const CONF = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" } as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const shift = (m: string, n: number) => { const d = new Date(`${m.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
// UI-POLISH-3: lakh and crore as Finance writes them ("₹12.5 L", "₹1.2 Cr"), one format across Pulse.
export const inr = (n: number | null | undefined) => n === null || n === undefined ? "–" : n >= 1e7 ? `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, "")} Cr` : n >= 100000 ? `₹${(n / 100000).toFixed(n >= 1000000 ? 1 : 2).replace(/\.?0+$/, "")} L` : `₹${Math.round(n).toLocaleString("en-IN")}`;
const pct = (x: number | null) => x === null ? "–" : `${Math.round(x * 100)}%`;

export function ValueBoard({ data, base, band }: { data: ValueData; base: string; band?: string }) {
  const sep = base.includes("?") ? "&" : "?";
  const href = (q: Record<string, string | undefined>) => `${base}${sep}${new URLSearchParams(Object.entries({ month: data.month.slice(0, 7), band, ...q }).filter(([, v]) => v) as [string, string][])}`;
  const counts = Object.fromEntries(Object.keys(BAND).map((b) => [b, data.rows.filter((r) => r.band.band === b).length])) as Record<Band, number>;
  const shown = band && band in BAND ? data.rows.filter((r) => r.band.band === band) : data.rows;
  const c = data.company;
  const filters: [string | undefined, string, number][] = [[undefined, "Everyone", data.rows.length], ["strong", "Strong", counts.strong], ["on_par", "On par", counts.on_par], ["below", "Below", counts.below],
    ["ramp", "Ramping up", counts.ramp], ["not_measured", "No work recorded", counts.not_measured + counts.no_cost]];
  return <div className={css.board} data-grow="" data-value-board="">
    <ul className={css.strip} aria-label="The month for the company">
      <li><b>{inr(c.revenue)}</b><span>Invoiced in {monthLabel(data.month)}</span></li>
      <li><b>{pct(c.coverage)}</b><span>of it linked to people’s client work</span></li>
      <li><b>{inr(c.cost)}</b><span>Salaries ({c.withCost} on record)</span></li>
      <li><b>{c.median === null ? "–" : `${c.median}×`}</b><span>Median value ÷ cost</span></li>
      <li><b>{counts.strong} · {counts.on_par} · {counts.below}</b><span>Strong · on par · below</span></li>
    </ul>
    <div className={css.toolbar}>
      <nav className={css.filters} aria-label="Show">{filters.map(([key, label, n]) => <Link key={label} href={href({ band: key })} aria-current={(band ?? undefined) === key ? "true" : undefined} scroll={false}>{label}<span>{n}</span></Link>)}</nav>
      <span className={css.month}><Link href={href({ month: shift(data.month, -1) })} aria-label="Previous month" scroll={false}><ChevronLeft size={14} aria-hidden="true" /></Link><b>{monthLabel(data.month)}</b>
        <Link href={href({ month: shift(data.month, 1) })} aria-label="Next month" scroll={false}><ChevronRight size={14} aria-hidden="true" /></Link></span>
      <InfoDrawer label="How it is worked out" title="Value against cost" sub="Founders and HR, like salaries. Every view is logged.">
        <ul className={css.method}>{(["value", "units", "cost", "band", "confidence"] as const).map((k) => <li key={k}><b>{{ value: "Value created", units: "Work units", cost: "Cost", band: "Band", confidence: "Confidence" }[k]}</b>{data.method[k]}</li>)}</ul>
      </InfoDrawer>
    </div>
    {shown.length ? <div className={css.tableWrap}><table className={css.table}>
      <thead><tr><th>Person</th><th className={css.num}>Cost</th><th className={css.num}>Value created</th><th>Value ÷ cost</th><th>Work</th><th>Six months</th><th>Confidence</th></tr></thead>
      <tbody>{shown.map((r) => { const b = BAND[r.band.band]; const vals = r.trend.map((t) => t.ratio ?? 0); const max = Math.max(0.01, ...vals);
        return <tr key={r.person.id} data-person={r.person.id}>
          <td data-label="Person"><Link href={`/people/${r.person.id}`} className={css.who}><Avatar name={r.person.name} id={r.person.id} photoAt={r.person.photoAt} size={28} />
            <span><b>{r.person.name}</b><small>{[r.person.role, r.person.pod].filter(Boolean).join(" · ")}{r.person.stage === "left" ? " · alumni" : r.person.stage === "notice" ? " · on notice" : ""}</small></span></Link></td>
          <td data-label="Cost" className={css.num}>{inr(r.cost)}</td>
          <td data-label="Value created" className={css.num}>{inr(r.value)}<small className={css.sub} style={{ display: "block" }}>{r.linked ? `${inr(r.linked)} from their clients` : "shared by work units"}</small></td>
          <td data-label="Value ÷ cost"><span className={css.band}>{r.ratio !== null && ["strong", "on_par", "below", "ramp"].includes(r.band.band) ? <b>{r.ratio}×</b> : null}<Badge tone={b.tone}>{b.label}</Badge></span>
            {r.band.allowance > 0 && r.band.allowance < 1 ? <small className={css.sub} style={{ display: "block" }}>new joiner: bar at {Math.round(r.band.allowance * 100)}%</small> : null}</td>
          <td data-label="Work"><span>{r.tasks} tasks · {r.deliveries} deliveries</span><small className={css.sub} style={{ display: "block" }}>{r.tasks ? `${pct(r.acceptRate)} accepted` : "nothing finished"}{r.withDue ? ` · ${pct(r.onTimeRate)} on time (${r.withDue})` : ""}{r.returned ? ` · ${r.returned} sent back` : ""}</small></td>
          <td data-label="Six months"><span className={css.trend} role="img" aria-label={`Value ÷ cost: ${r.trend.map((t) => `${monthLabel(t.month)} ${t.ratio ?? "none"}`).join(", ")}`}>{vals.map((v, i) => <i key={i} style={{ height: `${Math.max(v ? 8 : 0, (v / max) * 100)}%` }} />)}</span></td>
          <td data-label="Confidence"><small className={css.sub}>{CONF[r.confidence]}</small></td>
        </tr>; })}</tbody></table></div>
      : <Empty icon={Lock} title="Nobody in this view" text="Pick another band or month. People appear when they have a salary on record or finished work in the month." />}
    <p className={css.note}><Lock size={12} aria-hidden="true" /> Founders and HR only, like salaries; never shown on dashboards or rankings. Each person sees their own work and value on My Pulse, never anyone’s cost.</p>
  </div>;
}
