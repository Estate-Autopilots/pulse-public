"use client";

// COMP-B: What if… — leadership's sandbox. A scenario is a list of steps (hire, raise, pause, drop a planned role, a
// bonus, someone leaving); its effect on people cost, burn, runway and the budget shows beside the base. Scenarios are
// saved and compared; they never touch a record: each step links to the People & pay flow that would make it real.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { Panel, styles } from "../../ui";
import { rupees } from "../../people/pay/model";
import { runwayText } from "./views";
import { monthFull, podName, short, type Outlook, type PeopleCost, type Scenario, type Step } from "./model";
import c from "./cost.module.css";

type Draft = Record<string, string | boolean>;
const KIND: Record<string, string> = { hire: "Hire people", raise: "A raise", pause: "Pause someone's pay", drop_role: "Drop a planned role", bonus: "A bonus", exit: "Someone leaves" };
/** A saved step back into the form: paise as rupees, months as YYYY-MM (a pause keeps its days). */
const toDraft = (s: Step): Draft => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "boolean" ? v : v === null || v === undefined ? ""
  : typeof v === "number" && ["monthly", "amount"].includes(k) ? String(v / 100) : (k === "month" || (k === "from" && s.kind !== "pause")) ? String(v).slice(0, 7) : String(v)]));
const month7 = (m: string) => m.slice(0, 7);

export function WhatIf({ d }: { d: PeopleCost }) {
  const router = useRouter(), first = d.outlook.months[0]?.month ?? d.thisMonth, months = d.outlook.months.map((m) => m.month);
  const [id, setId] = useState<string | null>(null), [name, setName] = useState(""), [steps, setSteps] = useState<Draft[]>([]), [opening, setOpening] = useState(d.openingAssumed && d.opening !== null ? String(d.opening / 100) : "");
  const [result, setResult] = useState<Outlook | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [compare, setCompare] = useState<string[]>([]);
  const [compared, setCompared] = useState<{ name: string; o: Outlook }[]>([]);
  const fresh = (kind: string): Draft => kind === "hire" ? { kind, count: "1", role: "", pod: d.budget.pods.find(Boolean) ?? "", monthly: "", from: month7(first) }
    : kind === "raise" ? { kind, scope: "pod", pod: d.budget.pods.find(Boolean) ?? "", person: "", percent: "10", amount: "", from: month7(first) }
    : kind === "pause" ? { kind, person: d.people[0]?.id ?? "", from: first, to: first.slice(0, 8) + "28", paidPercent: "0" }
    : kind === "drop_role" ? { kind, role: d.roles.find((r) => r.status === "planned")?.id ?? "" }
    : kind === "bonus" ? { kind, scope: "all", pod: "", person: "", amount: "", month: month7(months.find((m) => m.slice(5, 7) === "03") ?? first), each: false }
    : { kind, person: d.people[0]?.id ?? "", on: first };
  const set = (i: number, k: string, v: string | boolean) => setSteps(steps.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const payload = () => steps.map((s) => ({ ...s }));
  async function preview() {
    setBusy(true); setError("");
    try { const r = await post<{ outlook: Outlook }>("comp/scenarios/preview", { steps: payload(), opening }); setResult(r.outlook); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not work it out"); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError("");
    try { const r = await post<{ id: string }>("comp/scenarios", { id, name, steps: payload(), opening }); setId(r.id); notify({ id: "whatif", tone: "success", title: `Saved “${name}”`, timeout: 3000 }); router.refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  async function archive(s: Scenario) {
    try { await post(`comp/scenarios/${s.id}/archive`); notify({ id: "whatif", tone: "success", title: `Archived “${s.name}”`, timeout: 3000 }); if (id === s.id) setId(null); router.refresh(); }
    catch (e) { notify({ id: "whatif", tone: "error", title: e instanceof Error ? e.message : "Could not archive", timeout: 4000 }); }
  }
  function load(s: Scenario) { setId(s.id); setName(s.name); setSteps(s.steps.map(toDraft)); setResult(null); }
  async function runCompare(ids: string[]) {
    setCompare(ids);
    const out: { name: string; o: Outlook }[] = [];
    for (const sid of ids) { const s = d.scenarios.find((x) => x.id === sid); if (!s) continue; const r = await post<{ outlook: Outlook }>("comp/scenarios/preview", { steps: s.steps, opening }).catch(() => null); if (r) out.push({ name: s.name, o: r.outlook }); }
    setCompared(out);
  }
  const person = (pid: unknown) => d.people.find((p) => p.id === pid)?.name ?? "someone";
  /** Where a step is made real: People & pay's own flows (HR proposes, a founder approves). */
  const apply = (s: Draft) => s.kind === "hire" ? <Link href="/people/jobs">Open the role in Jobs, then make the offer in People & pay</Link>
    : s.kind === "raise" && s.scope === "person" ? <Link href={`/people/pay/${s.person}?do=change`}>Change {person(s.person)}’s pay</Link>
    : s.kind === "raise" ? <Link href="/people/pay">Change pay for each person in People & pay</Link>
    : s.kind === "pause" ? <Link href={`/people/pay/${s.person}?do=pause`}>Pause {person(s.person)}’s pay</Link>
    : s.kind === "bonus" && s.scope === "person" ? <Link href={`/people/pay/${s.person}?do=items`}>Add the bonus for {person(s.person)}</Link>
    : s.kind === "bonus" ? <Link href="/people/pay">Add each bonus in People & pay</Link>
    : s.kind === "exit" ? <Link href={`/people/pay/${s.person}`}>Their exit and full and final</Link>
    : <span>Mark the role dropped in Budget</span>;
  const pods = d.budget.pods.filter(Boolean) as string[];
  return <div className={c.whatif}>
    <Panel title={id ? `Scenario: ${name}` : "A new scenario"} sub="nothing here changes a record">
      <div className={c.pane}>
        <label className={c.field}><span className={c.note}>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="For example: two editors in November" /></label>
        <ol className={c.steps}>{steps.map((s, i) => <li key={i} className={c.step}>
          <div className={c.stepHead}><span>{KIND[String(s.kind)]}</span><button type="button" className={styles.btn} aria-label={`Remove step ${i + 1}`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}><Trash2 size={14} aria-hidden="true" /></button></div>
          <div className={c.stepGrid}>
            {s.kind === "hire" ? <><label>People<input inputMode="numeric" value={String(s.count)} onChange={(e) => set(i, "count", e.target.value)} /></label><label>Role<input value={String(s.role)} onChange={(e) => set(i, "role", e.target.value)} placeholder="Editor" /></label>
              <label>Pod<select value={String(s.pod)} onChange={(e) => set(i, "pod", e.target.value)}><option value="">No pod</option>{pods.map((p) => <option key={p}>{p}</option>)}</select></label>
              <label>Pay a month, each (₹)<input inputMode="decimal" value={String(s.monthly)} onChange={(e) => set(i, "monthly", e.target.value)} /></label>
              <label>From<select value={String(s.from)} onChange={(e) => set(i, "from", e.target.value)}>{months.map((m) => <option key={m} value={month7(m)}>{monthFull(m)}</option>)}</select></label></> : null}
            {s.kind === "raise" || s.kind === "bonus" ? <label>For<select value={String(s.scope)} onChange={(e) => set(i, "scope", e.target.value)}><option value="all">Everyone</option><option value="pod">A pod</option><option value="person">One person</option></select></label> : null}
            {(s.kind === "raise" || s.kind === "bonus") && s.scope === "pod" ? <label>Pod<select value={String(s.pod)} onChange={(e) => set(i, "pod", e.target.value)}>{pods.map((p) => <option key={p}>{p}</option>)}</select></label> : null}
            {((s.kind === "raise" || s.kind === "bonus") && s.scope === "person") || s.kind === "pause" || s.kind === "exit" ? <label>Person<select value={String(s.person)} onChange={(e) => set(i, "person", e.target.value)}>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.pod ? ` · ${p.pod}` : ""}</option>)}</select></label> : null}
            {s.kind === "raise" ? <><label>Percent<input inputMode="decimal" value={String(s.percent)} onChange={(e) => set(i, "percent", e.target.value)} placeholder="10" /></label><label>or ₹ a month<input inputMode="decimal" value={String(s.amount)} onChange={(e) => set(i, "amount", e.target.value)} disabled={String(s.percent) !== ""} /></label>
              <label>From<select value={String(s.from)} onChange={(e) => set(i, "from", e.target.value)}>{months.map((m) => <option key={m} value={month7(m)}>{monthFull(m)}</option>)}</select></label></> : null}
            {s.kind === "pause" ? <><label>First day<input type="date" value={String(s.from)} onChange={(e) => set(i, "from", e.target.value)} /></label><label>Last day<input type="date" value={String(s.to)} onChange={(e) => set(i, "to", e.target.value)} /></label>
              <label>Paid share %<input inputMode="numeric" value={String(s.paidPercent)} onChange={(e) => set(i, "paidPercent", e.target.value)} /></label></> : null}
            {s.kind === "drop_role" ? <label>Planned role<select value={String(s.role)} onChange={(e) => set(i, "role", e.target.value)}>{d.roles.filter((r) => r.status === "planned").map((r) => <option key={r.id} value={r.id}>{r.title} · {podName(r.pod)}</option>)}</select></label> : null}
            {s.kind === "bonus" ? <><label>{s.scope === "person" || s.each ? "Amount each (₹)" : "Total (₹)"}<input inputMode="decimal" value={String(s.amount)} onChange={(e) => set(i, "amount", e.target.value)} /></label>
              <label>Paid in<select value={String(s.month)} onChange={(e) => set(i, "month", e.target.value)}>{months.map((m) => <option key={m} value={month7(m)}>{monthFull(m)}</option>)}</select></label>
              {s.scope !== "person" ? <label className={c.check}><input type="checkbox" checked={s.each === true} onChange={(e) => set(i, "each", e.target.checked)} />Each person</label> : null}</> : null}
            {s.kind === "exit" ? <label>Last day<input type="date" value={String(s.on)} onChange={(e) => set(i, "on", e.target.value)} /></label> : null}
          </div>
          <span className={c.apply}>To make it real: {apply(s)}</span>
        </li>)}</ol>
        <div className={c.tools}><Plus size={14} aria-hidden="true" /><select className={c.addStep} aria-label="Add a step" value="" onChange={(e) => { if (e.target.value) setSteps([...steps, fresh(e.target.value)]); }}><option value="">Add a step…</option>{Object.entries(KIND).filter(([k]) => k !== "drop_role" || d.roles.some((r) => r.status === "planned")).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <label className={c.field}><span className={c.note}>Opening balance (assumed; bank balances are unconfirmed)</span><input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder={d.cash.balance ? `${d.cash.balance.amount / 100} (last known, ${d.cash.balance.asOf})` : "₹"} /></label>
        <p role="alert" className={c.note}>{error}</p>
        <div className={c.tools}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={preview} disabled={busy || !steps.length}>{busy ? "Working it out…" : "See the effect"}</button>
          {d.can.plan ? <button type="button" className={styles.btn} onClick={save} disabled={busy || name.trim().length < 2 || !steps.length}>{id ? "Save changes" : "Save scenario"}</button> : <span className={c.note}>Leadership saves scenarios.</span>}
          {id ? <button type="button" className={styles.btn} onClick={() => { setId(null); setName(""); setSteps([]); setResult(null); }}>New scenario</button> : null}</div>
      </div>
    </Panel>
    <div className={c.body}>
      <Panel title="The effect" sub={result ? "next twelve months, against the base" : "add steps and see the effect"}>
        <div className={c.pane}>{result ? <Effect base={d.outlook} o={result} d={d} /> : <p className={c.note}>The base is today’s pay records: versions in force, scheduled changes, accepted offers, pauses and last days. Planned roles and waiting offers count as planned.</p>}</div>
      </Panel>
      <Panel title="Saved scenarios" sub="tick up to three to compare">
        <div className={c.pane}>{d.scenarios.length ? <ul className={c.saved}>{d.scenarios.map((s) => <li key={s.id}>
          <label className={c.check}><input type="checkbox" checked={compare.includes(s.id)} disabled={!compare.includes(s.id) && compare.length >= 3} onChange={(e) => runCompare(e.target.checked ? [...compare, s.id] : compare.filter((x) => x !== s.id))} /><span><b>{s.name}</b><small>{s.steps.length} {s.steps.length === 1 ? "step" : "steps"} · {s.by}</small></span></label>
          <span className={c.tools}><button type="button" className={styles.btn} onClick={() => load(s)}>Open</button>{d.can.plan ? <button type="button" className={styles.btn} onClick={() => archive(s)}>Archive</button> : null}</span></li>)}</ul>
          : <p className={c.note}>No saved scenarios yet.</p>}
          {compared.length ? <Compare d={d} items={compared} /> : null}</div>
      </Panel>
    </div>
  </div>;
}

function Effect({ base, o, d }: { base: Outlook; o: Outlook; d: PeopleCost }) {
  const diff = (o.yearCost.scenario ?? 0) - base.yearCost.base;
  const burn = (k: "base" | "scenario") => { const xs = o.months.map((m) => (k === "base" ? m.base.burn : m.scenario?.burn ?? null)).filter((x): x is number => x !== null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  return <>
    <table className={c.versus}><thead><tr><th scope="col"><span className={c.srOnly}>Measure</span></th><th scope="col">Base</th><th scope="col">Scenario</th></tr></thead><tbody>
      <tr><th scope="row">People cost, 12 months</th><td>{short(base.yearCost.base)}</td><td>{short(o.yearCost.scenario)}<small>{diff >= 0 ? "+" : "−"}{short(Math.abs(diff))}</small></td></tr>
      {d.cash.access ? <><tr><th scope="row">Burn a month</th><td>{short(burn("base"))}</td><td>{short(burn("scenario"))}</td></tr>
        <tr><th scope="row">Runway</th><td>{runwayText(o.runway.base)}</td><td>{runwayText(o.runway.scenario)}</td></tr></> : null}
      <tr><th scope="row">Months over budget</th><td>{d.budget.set ? o.overBudget.base.length : "—"}</td><td>{d.budget.set ? o.overBudget.scenario?.length ?? 0 : "—"}</td></tr>
    </tbody></table>
    <div className={c.matrixWrap} tabIndex={0} aria-label="Month by month; scroll across"><table className={c.matrix}><thead><tr><th scope="col">Month</th><th scope="col">Base cost</th><th scope="col">Scenario</th>{d.cash.access ? <><th scope="col">Base cash</th><th scope="col">Scenario cash</th></> : null}<th scope="col">Budget</th></tr></thead>
      <tbody>{o.months.map((m) => <tr key={m.month}><th scope="row">{monthFull(m.month)}</th><td>{short(m.base.cost)}</td><td data-over={m.budget !== null && m.scenario && m.scenario.cost + m.scenario.planned > m.budget ? "" : undefined}>{short(m.scenario?.cost)}</td>
        {d.cash.access ? <><td>{short(m.base.cash)}</td><td>{short(m.scenario?.cash)}</td></> : null}<td>{short(m.budget)}</td></tr>)}</tbody></table></div>
    <p className={c.note}>{d.cash.access ? (d.opening === null ? "Cash needs an opening balance: type one above." : `Cash starts from ${rupees(d.opening)}, ${d.openingAssumed ? "an assumed balance" : "the last known balance (unconfirmed)"}.`) : "Cash and runway need finance access."}</p>
  </>;
}

function Compare({ d, items }: { d: PeopleCost; items: { name: string; o: Outlook }[] }) {
  const b = items[0]?.o;
  if (!b) return null;
  return <table className={c.versus}><caption className={c.note}>Side by side, next twelve months</caption><thead><tr><th scope="col"><span className={c.srOnly}>Measure</span></th><th scope="col">Base</th>{items.map((x) => <th key={x.name} scope="col">{x.name}</th>)}</tr></thead><tbody>
    <tr><th scope="row">People cost</th><td>{short(b.yearCost.base)}</td>{items.map((x) => <td key={x.name}>{short(x.o.yearCost.scenario)}</td>)}</tr>
    {d.cash.access ? <tr><th scope="row">Runway</th><td>{runwayText(b.runway.base)}</td>{items.map((x) => <td key={x.name}>{runwayText(x.o.runway.scenario)}</td>)}</tr> : null}
    <tr><th scope="row">Months over budget</th><td>{d.budget.set ? b.overBudget.base.length : "—"}</td>{items.map((x) => <td key={x.name}>{d.budget.set ? x.o.overBudget.scenario?.length ?? 0 : "—"}</td>)}</tr>
  </tbody></table>;
}
