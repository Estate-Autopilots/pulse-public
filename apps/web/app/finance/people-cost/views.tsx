"use client";

// COMP-B: Finance → People cost. Overview (the story in ten seconds: payroll this month, people cost against the budget,
// runway, what if), Budget (pod × month, set or seeded by leadership; planned roles), Ledger (locked payroll's entries).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { FinTable } from "../table";
import { Modal, post } from "../../records";
import { Badge, Kpi, Panel, styles, Tiles } from "../../ui";
import fin from "../fin.module.css";  // RELEASE-6: a word in a tile uses the Finance tiles' word style (it spilled at 390)
import { day, rupees } from "../../people/pay/model";
import { monthLong, RUN_STATUS } from "../../people/pay/payroll/model";
import { BudgetChart } from "./chart";
import { ACCOUNT, fyLabel, mon, monthFull, podName, short, type LedgerEntry, type PeopleCost, type Role, type Runway } from "./model";
import c from "./cost.module.css";
import { SelectField } from "../../kit/select-field";

export const runwayText = (r: Runway | null | undefined) => !r ? "—" : r.months === null ? "Balance needed" : r.beyond ? `${r.months}+ months` : r.months === 0 ? "Under a month" : `${r.months} ${r.months === 1 ? "month" : "months"}`;

/** What the bank balance is and why runway is uncertain, with an assumed balance for the sandbox. */
export function BalanceNote({ d }: { d: PeopleCost }) {
  const router = useRouter(), [v, setV] = useState(d.openingAssumed && d.opening !== null ? String(d.opening / 100) : "");
  const b = d.cash.balance;
  function apply(e: FormEvent) { e.preventDefault(); const q = new URLSearchParams(window.location.search); if (v) q.set("opening", v.replace(/[,₹\s]/g, "")); else q.delete("opening"); router.push(`?${q}`); }
  if (!d.cash.access) return <p className={c.need} role="note"><ShieldCheck size={14} aria-hidden="true" />Runway and the cash forecast need finance access, which is granted to each person separately. Payroll and the budget are below.</p>;
  return <div className={c.need} role="note"><AlertTriangle size={14} aria-hidden="true" />
    <span>Bank balances are <b>unconfirmed</b> until Kazuk’s Axis statements arrive. {d.openingAssumed ? `Runway uses the balance you typed (${rupees(d.opening)}).` : b ? `Runway starts from the last known balance, ${rupees(b.amount)} on ${day(b.asOf)} (${b.ageDays} days old).` : "No balance is known, so runway is not worked out."}</span>
    <form onSubmit={apply}><label className={c.note} htmlFor="opening">Assume a balance</label><input id="opening" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="₹" /><button className={styles.btn}>Apply</button></form>
  </div>;
}

export function Overview({ d }: { d: PeopleCost }) {
  const run = d.payroll.runs.find((r) => r.month.slice(0, 7) === d.thisMonth.slice(0, 7) && r.status !== "withdrawn") ?? d.payroll.runs.find((r) => ["draft", "checked"].includes(r.status)) ?? d.payroll.runs[0] ?? null;
  const t = d.budget.thisMonth, used = t ? (t.actual ?? t.committed + t.planned) : null;
  const year = d.budget.rows.reduce((a, r) => a + (r.actual ?? r.committed), 0), yearBudget = d.budget.rows.some((r) => r.budget !== null) ? d.budget.rows.reduce((a, r) => a + (r.budget ?? 0), 0) : null;
  const rw = d.outlook.runway.base, next = run ? run.status === "draft" ? "HR checks it next" : run.status === "checked" ? "A founder approves it next" : run.status === "locked" ? (run.payout ? "Bank file ready to upload" : "Payslips issued") : "" : "HR starts it";
  return <div className={c.body}>
    <Tiles count={4} dense>
      <Kpi label={run ? `Payroll · ${monthLong(run.month).replace(/ \d{4}$/, "")}` : `Payroll · ${monthLong(d.thisMonth).replace(/ \d{4}$/, "")}`} value={run ? RUN_STATUS[run.status].label : "Not started"} note={next}
        href={run ? `/people/pay/payroll/${run.id}` : "/people/pay/payroll"} tone={run?.status === "checked" ? "warning" : undefined} />
      <Kpi label="People cost this month" value={rupees(used)} note={t?.budget !== null && t?.budget !== undefined ? `${used !== null && used > t.budget ? "over" : "of"} the ${rupees(t.budget)} budget` : "No budget set yet"} tone={t?.budget !== null && t?.budget !== undefined && used !== null && used > t.budget ? "warning" : undefined} />
      <Kpi label={`This year · ${fyLabel(d.budget.months)}`} value={short(year)} note={yearBudget !== null ? `against a ${short(yearBudget)} budget` : "paid and committed"} tone={yearBudget !== null && year > yearBudget ? "warning" : undefined} />
      <Kpi label="Runway" value={(v => /^\d/.test(v) ? v : <span className={fin.wordValue}>{v}</span>)(d.cash.access ? runwayText(rw) : "Finance access")} note={d.cash.access ? (d.opening === null ? "No bank balance" : `${d.openingAssumed ? "assumed" : "unconfirmed"} balance · burn ${short(rw?.burn ?? 0)} a month`) : "needed for runway"} tone={!d.cash.access || d.opening === null || !d.openingAssumed ? "warning" : undefined} />
    </Tiles>
    <BalanceNote d={d} />
    <div className={c.pair}>
      <Panel title={`People budget, ${fyLabel(d.budget.months)}`} sub={d.budget.set ? "by month, all pods" : "no budget set: leadership sets or seeds it in Budget"}>
        <div className={c.pane}><BudgetChart rows={d.budget.rows} label="People cost against the budget, month by month" />
          {d.budget.alerts.length ? <ul className={c.alerts}>{d.budget.alerts.map((a) => <li key={`${a.pod}`}><Badge tone="warning">Over budget</Badge>{a.text}, by up to {rupees(a.by)} a month ({a.months} {a.months === 1 ? "month" : "months"})</li>)}</ul>
            : d.budget.set ? <p className={c.note}>Every pod stays within its budget for the rest of the year, counting what is planned.</p> : null}
        </div>
      </Panel>
      <Panel title="What if…" sub="saved scenarios against the base">
        <div className={c.pane}>{d.compared.length ? <Versus d={d} /> : d.scenarios.length ? <ul className={c.saved}>{d.scenarios.slice(0, 5).map((s) => <li key={s.id}><span><b>{s.name}</b><small>{s.steps.length} {s.steps.length === 1 ? "step" : "steps"} · {s.by}</small></span>
            <Link href={`?costView=${encodeURIComponent("What if…")}&compare=${s.id}`}>Compare</Link></li>)}</ul>
          : <p className={c.note}>Try “hire two editors from November”, “10% for Pod 1 from January” or “a bonus in March” and see burn, runway and the budget move. Nothing changes until someone makes it real through People & pay.</p>}
          <Link className={styles.btn} href={`?costView=${encodeURIComponent("What if…")}`}>Open What if…</Link></div>
      </Panel>
    </div>
    <div className={c.pair}>
      <FinTable label="The next twelve months" title="The next twelve months" sub="people cost from pay records; cash from the Finance forecast (base)" csv="people-outlook"
        columns={[{ key: "month", label: "Month", phone: "title" }, { key: "cost", label: "People cost", align: "right", phone: "value" }, { key: "planned", label: "Planned", align: "right" },
          { key: "budget", label: "Budget", align: "right" }, ...(d.cash.access ? [{ key: "burn", label: "Burn", align: "right" as const }, { key: "cash", label: "Cash", align: "right" as const }] : [])]}
        rows={d.outlook.months.map((m) => ({ id: m.month, cells: { month: { v: m.month, t: monthFull(m.month), sub: m.base.held ? "forecast held flat" : undefined }, cost: { v: m.base.cost, t: short(m.base.cost) }, planned: m.base.planned ? { v: m.base.planned, t: short(m.base.planned) } : null,
          budget: m.budget !== null ? { v: m.budget, t: short(m.budget) } : null, burn: m.base.burn !== null ? { v: m.base.burn, t: short(m.base.burn) } : null, cash: m.base.cash !== null ? { v: m.base.cash, t: short(m.base.cash) } : null } }))} />
      <Panel title="Coming up" sub="known changes, probations, offers and last days">
        <div className={c.pane}>{d.events.length ? <ul className={c.events}>{d.events.slice(0, 12).map((e, i) => <li key={i}><time dateTime={e.on}>{day(e.on).replace(/ \d{4}$/, "")}</time><span><b>{e.person}</b> · <small>{e.label}{e.until ? ` until ${day(e.until)}` : ""}</small></span>
          <span className={c.num}>{e.change ? `${e.change > 0 ? "+" : "−"}${short(Math.abs(e.change))} a month` : ""}</span></li>)}</ul> : <p className={c.note}>No scheduled change, probation end, offer or last day in the next twelve months.</p>}</div>
      </Panel>
    </div>
    <p className={c.note}><ShieldCheck size={13} aria-hidden="true" /> {d.coverage.withRecords} of {d.coverage.staff} current staff have pay records in Pulse; people cost counts only them. {d.cash.access && d.cash.basis ? `Cash: ${d.cash.basis} Confidence ${d.cash.confidence}. Pulse adds only the change in people cost the pay records know about, because the forecast’s costs already include the payroll of the monthly cost sheet.` : ""} Individuals’ pay is for founders and HR; every look is logged.</p>
    {d.cash.access && d.cash.assumptions?.length ? <details className={c.note}><summary>How the cash forecast is worked out</summary><ul>{d.cash.assumptions.map((a) => <li key={a}>{a}</li>)}<li>Months beyond the forecast’s six repeat its last month.</li><li>Downside also counts offers not yet accepted and planned roles.</li></ul></details> : null}
  </div>;
}

/** Base and saved scenarios side by side (up to three). */
export function Versus({ d }: { d: PeopleCost }) {
  const cols = [{ name: "Base", o: d.outlook, base: true }, ...d.compared.map((x) => ({ name: x.name, o: x.outlook, base: false }))];
  const cost = (o: PeopleCost["outlook"], base: boolean) => base ? o.yearCost.base : o.yearCost.scenario ?? o.yearCost.base;
  const rw = (o: PeopleCost["outlook"], base: boolean) => base ? o.runway.base : o.runway.scenario;
  const burn = (o: PeopleCost["outlook"], base: boolean) => { const xs = o.months.map((m) => base ? m.base.burn : m.scenario?.burn ?? null).filter((x): x is number => x !== null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const over = (o: PeopleCost["outlook"], base: boolean) => (base ? o.overBudget.base : o.overBudget.scenario ?? []).length;
  const b0 = cost(d.outlook, true);
  return <div className={c.matrixWrap}><table className={c.versus}><caption className={c.note}>The next twelve months</caption>
    <thead><tr><th scope="col"><span className={c.srOnly}>Measure</span></th>{cols.map((x) => <th key={x.name} scope="col">{x.name}</th>)}</tr></thead>
    <tbody>
      <tr><th scope="row">People cost</th>{cols.map((x) => { const v = cost(x.o, x.base); return <td key={x.name}>{short(v)}{x.base ? null : <small>{v - b0 >= 0 ? "+" : "−"}{short(Math.abs(v - b0))}</small>}</td>; })}</tr>
      {d.cash.access ? <tr><th scope="row">Burn a month</th>{cols.map((x) => <td key={x.name}>{short(burn(x.o, x.base))}</td>)}</tr> : null}
      {d.cash.access ? <tr><th scope="row">Runway</th>{cols.map((x) => <td key={x.name}>{runwayText(rw(x.o, x.base))}</td>)}</tr> : null}
      <tr><th scope="row">Months over budget</th>{cols.map((x) => <td key={x.name}>{d.budget.set ? over(x.o, x.base) : "—"}</td>)}</tr>
    </tbody></table></div>;
}

// ----------------------------------------------------------------------------------------------- budget
export function Budget({ d }: { d: PeopleCost }) {
  const router = useRouter(), [setting, setSetting] = useState(false), [role, setRole] = useState<Role | "new" | null>(null), [busy, setBusy] = useState(false);
  const pods = d.budget.pods;
  async function seed() {
    setBusy(true);
    try { const r = await post<{ saved: number; basis: string }>("comp/budget/seed"); notify({ id: "budget", tone: "success", title: r.saved ? `Seeded ${r.saved} months: ${r.basis}` : "Nothing to seed: every month already has a budget", timeout: 5000 }); router.refresh(); }
    catch (e) { notify({ id: "budget", tone: "error", title: e instanceof Error ? e.message : "Could not seed", timeout: 5000 }); } finally { setBusy(false); }
  }
  const cell = (r: PeopleCost["budget"]["rows"][number], pod: string | null) => { const x = r.byPod.find((y) => (y.pod ?? "") === (pod ?? "")); if (!x) return null; const used = x.actual ?? x.committed + x.planned; return { used, x }; };
  return <div className={c.body}>
    <div className={c.tools}>{d.can.plan ? <><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setSetting(true)}>Set a budget</button>
      <button type="button" className={styles.btn} onClick={seed} disabled={busy}>{busy ? "Seeding…" : "Seed from the last three months"}</button></> : <span className={c.note}>Leadership sets the people budget.</span>}
      <span className={c.note}>Each cell: what is paid or committed and planned · the budget below it. Shaded: over budget.</span></div>
    <Panel title={`Budget by pod, ${fyLabel(d.budget.months)}`}>
      <div className={c.matrixWrap} tabIndex={0} aria-label="Budget by pod and month; scroll across for more months">
        <table className={c.matrix}><thead><tr><th scope="col">Pod</th>{d.budget.months.map((m) => <th key={m} scope="col">{mon(m)}</th>)}</tr></thead>
          <tbody>{pods.map((p) => <tr key={p ?? ""}><th scope="row">{podName(p)}</th>{d.budget.rows.map((r) => { const v = cell(r, p); return <td key={r.month} data-over={v?.x.over ? "" : undefined} data-locked={r.locked ? "" : undefined}>
            {v ? short(v.used) : "—"}<small>{v?.x.budget !== null && v?.x.budget !== undefined ? short(v.x.budget) : "no budget"}</small></td>; })}</tr>)}</tbody>
          <tfoot><tr><th scope="row">All pods</th>{d.budget.rows.map((r) => <td key={r.month}>{short(r.actual ?? r.committed + r.planned)}<small>{r.budget !== null ? short(r.budget) : "no budget"}</small></td>)}</tr></tfoot>
        </table>
      </div>
    </Panel>
    <FinTable label="Planned roles" title="Planned roles" sub="open jobs and roles to hire; they count as planned cost from their month" csv="planned-roles"
      toolbar={d.can.plan ? <button type="button" className={styles.btn} onClick={() => setRole("new")}>Plan a role</button> : null}
      columns={[{ key: "title", label: "Role", phone: "title" }, { key: "pod", label: "Pod" }, { key: "count", label: "People", align: "right" }, { key: "from", label: "From" },
        { key: "monthly", label: "Cost a month", align: "right", phone: "value" }, { key: "status", label: "Status" }]}
      rows={d.roles.map((r) => ({ id: r.id, cells: { title: { v: r.title, t: r.title, sub: r.job ? `Job: ${r.job}` : undefined }, pod: podName(r.pod), count: r.count, from: { v: r.from, t: monthFull(r.from) },
        monthly: { v: r.monthly * r.count, t: rupees(r.monthly * r.count), sub: r.count > 1 ? `${rupees(r.monthly)} each` : undefined }, status: { v: r.status, t: r.status === "planned" ? "Planned" : r.status === "filled" ? "Filled" : "Dropped", chip: true, tone: r.status === "planned" ? "accent" : "neutral" } },
        action: d.can.plan ? <button type="button" className={styles.btn} onClick={() => setRole(r)}>Edit</button> : undefined }))}
      empty="No roles planned. Plan one to see what hiring does to the budget." />
    {setting ? <SetBudget d={d} onClose={() => setSetting(false)} /> : null}
    {role ? <RoleForm d={d} role={role === "new" ? null : role} onClose={() => setRole(null)} /> : null}
  </div>;
}

function SetBudget({ d, onClose }: { d: PeopleCost; onClose: () => void }) {
  const router = useRouter(), months = d.budget.months, firstOpen = months.find((m) => m >= d.thisMonth) ?? months[0];
  const [pod, setPod] = useState(d.budget.pods[0] ?? ""), [amount, setAmount] = useState(""), [from, setFrom] = useState(firstOpen.slice(0, 7)), [to, setTo] = useState(months[11].slice(0, 7)), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { const r = await post<{ saved: number }>("comp/budget", { pod: pod ?? "", amount, from, to }); notify({ id: "budget", tone: "success", title: `Budget set for ${r.saved} ${r.saved === 1 ? "month" : "months"}`, timeout: 3500 }); onClose(); router.refresh(); }
    catch (x) { setError(x instanceof Error ? x.message : "Could not save"); } finally { setBusy(false); }
  }
  return <Modal title="Set a people budget" sub="The same amount a month for a pod over a range of months. Leave the amount empty to clear it." onClose={onClose}>
    <form className={styles.modalBody} onSubmit={submit}>
      <label className={styles.field}>Pod<SelectField value={pod ?? ""} onChange={(e) => setPod(e.target.value)}>{d.budget.pods.map((p) => <option key={p ?? ""} value={p ?? ""}>{podName(p)}</option>)}</SelectField></label>
      <label className={styles.field}>Budget a month<span className={c.tools}><span aria-hidden="true">₹</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></span></label>
      <label className={styles.field}>From<SelectField value={from} onChange={(e) => setFrom(e.target.value)}>{months.map((m) => <option key={m} value={m.slice(0, 7)}>{monthFull(m)}</option>)}</SelectField></label>
      <label className={styles.field}>To<SelectField value={to} onChange={(e) => setTo(e.target.value)}>{months.map((m) => <option key={m} value={m.slice(0, 7)}>{monthFull(m)}</option>)}</SelectField></label>
      <div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Cancel</button><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>Save budget</button></div>
    </form>
  </Modal>;
}

function RoleForm({ d, role, onClose }: { d: PeopleCost; role: Role | null; onClose: () => void }) {
  const router = useRouter();
  const [f, setF] = useState({ title: role?.title ?? "", jobId: role?.jobId ?? "", pod: role?.pod ?? "", count: String(role?.count ?? 1), from: (role?.from ?? d.outlook.months[0]?.month ?? d.thisMonth).slice(0, 7),
    monthly: role ? String(role.monthly / 100) : "", status: role?.status ?? "planned", note: role?.note ?? "" });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { await post("comp/budget/roles", { ...(role ? { id: role.id } : {}), ...f, jobId: f.jobId || null }); notify({ id: "budget", tone: "success", title: role ? "Role saved" : "Role planned", timeout: 3000 }); onClose(); router.refresh(); }
    catch (x) { setError(x instanceof Error ? x.message : "Could not save"); } finally { setBusy(false); }
  }
  const months = [...d.budget.months, ...d.outlook.months.map((m) => m.month)].filter((m, i, a) => a.indexOf(m) === i && m >= d.thisMonth).sort();
  return <Modal title={role ? "Edit planned role" : "Plan a role"} sub="Its cost counts as planned from its month. Pay never goes on the job itself; hiring still goes through an offer in People & pay." onClose={onClose}>
    <form className={styles.modalBody} onSubmit={submit}>
      <label className={styles.field}>Role<input value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={120} required placeholder="For example: Video editor" /></label>
      {d.jobs?.length ? <label className={styles.field}>Job (optional)<SelectField value={f.jobId} onChange={(e) => set("jobId", e.target.value)}><option value="">No job yet</option>{d.jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}</SelectField></label> : null}
      <label className={styles.field}>Pod<input value={f.pod} onChange={(e) => set("pod", e.target.value)} list="pods" maxLength={80} /><datalist id="pods">{d.budget.pods.filter(Boolean).map((p) => <option key={p!} value={p!} />)}</datalist></label>
      <label className={styles.field}>People<input inputMode="numeric" value={f.count} onChange={(e) => set("count", e.target.value)} required /></label>
      <label className={styles.field}>From<SelectField value={f.from} onChange={(e) => set("from", e.target.value)}>{months.map((m) => <option key={m} value={m.slice(0, 7)}>{monthFull(m)}</option>)}</SelectField></label>
      <label className={styles.field}>Cost a month, each (CTC ÷ 12)<span className={c.tools}><span aria-hidden="true">₹</span><input inputMode="decimal" value={f.monthly} onChange={(e) => set("monthly", e.target.value)} required={!role} /></span></label>
      {role ? <label className={styles.field}>Status<SelectField value={f.status} onChange={(e) => set("status", e.target.value)}><option value="planned">Planned</option><option value="filled">Filled</option><option value="dropped">Dropped</option></SelectField></label> : null}
      <label className={`${styles.field} ${styles.wide}`}>Note<textarea value={f.note} onChange={(e) => set("note", e.target.value)} maxLength={500} /></label>
      <div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Cancel</button><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>Save</button></div>
    </form>
  </Modal>;
}

// ------------------------------------------------------------------------------------------------ ledger
export function Ledger({ entries }: { entries: LedgerEntry[] | null }) {
  if (entries === null) return <p className={c.note}>The people-cost ledger is for founders and HR.</p>;
  const months = [...new Set(entries.map((e) => e.month))].sort().reverse();
  return <div className={c.body}>
    <p className={c.note}>Each locked payroll posts here: debits (salaries, employer contributions, reimbursements, advances) equal credits (net pay, statutory dues, recoveries). By pod and department for founders and HR; the CA sees one total a month per account on the CA desk.</p>
    <FinTable fill search label="People-cost ledger" title="Entries" sub={months.length ? `${months.length} ${months.length === 1 ? "month" : "months"}` : undefined} csv="people-cost-ledger" sort={{ key: "month", dir: "desc" }}
      filters={[{ key: "all", label: "All" }, { key: "debit", label: "Debits" }, { key: "credit", label: "Credits" }, ...months.slice(0, 3).map((m) => ({ key: m, label: mon(`${m}-01`) }))]}
      columns={[{ key: "month", label: "Month" }, { key: "account", label: "Account", phone: "title" }, { key: "pod", label: "Pod" }, { key: "department", label: "Department", phone: "hide" },
        { key: "debit", label: "Debit", align: "right", phone: "value" }, { key: "credit", label: "Credit", align: "right" }, { key: "people", label: "People", align: "right", phone: "hide" }]}
      rows={entries.map((e, i) => ({ id: `${e.runId}-${i}`, tags: [e.side, e.month], cells: { month: { v: e.month, t: monthFull(`${e.month}-01`), sub: e.kind === "correction" ? "correction" : undefined }, account: ACCOUNT[e.account] ?? e.account,
        pod: podName(e.pod), department: e.department, debit: e.side === "debit" ? { v: e.amount, t: rupees(e.amount) } : null, credit: e.side === "credit" ? { v: e.amount, t: rupees(e.amount) } : null, people: e.people } }))}
      empty="Nothing posted yet: the first locked payroll posts its entries here." />
  </div>;
}

