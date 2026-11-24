"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Check, Megaphone, Package, Rocket } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../../../records";
import { styles } from "../../../../ui";
import css from "./wizard.module.css";

export type WizardStep = { id: string; stage: number; title: string; type: string; from: string; start: number; end: number | null; byPackage: Record<string, { start: number; end: number | null }> | null;
  packages: Record<string, string>; role: string | null; when: string | null; lines: boolean };
export type WizardTemplate = { key: string; name: string; stages: { n: number; label: string }[]; packages: { key: string; label: string }[]; categories: { key: string; label: string; units: number }[];
  bandwidth: { role: string }; clocks?: { key: string; label: string; day?: number; step?: string }[] | null; roles?: { label: string; lead?: boolean; client?: boolean; system?: boolean; outside?: boolean }[];
  steps: number; list?: WizardStep[] };
type Person = { id: string; name: string };
const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const day = (d: string) => DAY.format(new Date(`${d}T00:00:00Z`));
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const phaseName = (l: string) => l.replace(/^(stage|phase)\s*\d+\s*·\s*/i, "").replace(/[™®]/g, "").replace(/\s*·\s*outsourced$/i, "").trim();
const STEPS = ["Template", "Dates", "People", "Preview & create"];
const ICONS = [Rocket, Megaphone, Package];

/** The plan a template makes for a package: its steps, and each one's dates from the clocks' planned days. */
function layout(t: WizardTemplate, pkg: string, kickoff: string) {
  const list = (t.list ?? []).filter((s) => (s.packages[pkg] ?? "no") === "yes" && s.type !== "auto" && !s.when);
  const span = (s: WizardStep) => { const bp = s.byPackage?.[pkg]; return { a: bp?.start ?? s.start, b: bp ? bp.end : s.end }; };
  const stepById = new Map((t.list ?? []).map((s) => [s.id, s]));
  const clock = (k: string) => t.clocks?.find((c) => c.key === k);
  const d0s = clock("day0")?.step ? stepById.get(clock("day0")!.step!) : undefined;
  const day0 = d0s && (d0s.from ?? "start") === "start" ? plus(kickoff, span(d0s).b ?? span(d0s).a) : null;
  const lvs = clock("live")?.step ? stepById.get(clock("live")!.step!) : undefined;
  const live = lvs && day0 && lvs.from === "day0" ? plus(day0, span(lvs).b ?? span(lvs).a) : null;
  const base = (from: string) => from === "start" ? kickoff : from === "day0" ? day0 : from === "live" ? live : null;
  const dated = list.map((s) => { const { a, b } = span(s); const b0 = base(s.from); return { ...s, startOn: b0 ? plus(b0, Math.max(0, a)) : null, dueOn: b0 && b !== null ? plus(b0, b) : null }; });
  const phases = t.stages.map((st) => { const mine = dated.filter((s) => s.stage === st.n); const starts = mine.map((s) => s.startOn).filter(Boolean).sort() as string[], ends = mine.map((s) => s.dueOn).filter(Boolean).sort() as string[];
    return { n: st.n, label: phaseName(st.label), steps: mine.length, from: starts[0] ?? null, to: ends.at(-1) ?? null }; }).filter((p) => p.steps);
  const liveDays = day0 && live ? Math.round((Date.parse(`${live}T00:00:00Z`) - Date.parse(`${day0}T00:00:00Z`)) / 86400000) : null;
  return { dated, phases, day0, live, liveDays };
}

export function SetupWizard({ projectId, templates, people, leadId }: { projectId: string; templates: WizardTemplate[]; people: Person[]; leadId: string | null }) {
  const router = useRouter();
  const [step, setStep] = useState(0); const [key, setKey] = useState(templates[0].key);
  const t = templates.find((x) => x.key === key) ?? templates[0];
  const [pkg, setPkg] = useState(t.packages[0]?.key ?? ""); const [category, setCategory] = useState("");
  const [kickoff, setKickoff] = useState(new Date().toISOString().slice(0, 10));
  const [lead, setLead] = useState(leadId ?? ""); const [roles, setRoles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const plan = useMemo(() => layout(t, pkg, kickoff), [t, pkg, kickoff]);
  const roleList = (t.roles ?? []).filter((r) => !r.client && !r.system && !r.lead && r.label !== t.bandwidth.role && plan.dated.some((s) => s.role === r.label));
  const startLabel = t.clocks?.find((c) => c.key === "start")?.label ?? "Kick-off";
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? null;
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await post<{ tasks: number }>(`projects/${projectId}/plan`, { template: key, package: pkg, category: category || null, kickoff, leadId: lead || null });
      const chosen = Object.fromEntries(Object.entries(roles).filter(([, v]) => v));
      if (Object.keys(chosen).length) await post(`projects/${projectId}/roles`, { roles: chosen });
      notify({ id: "setup", tone: "success", title: "Plan set up", message: `${r.tasks} steps laid out.` });
      router.push(`/tasks/projects/${projectId}`); router.refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return <section className={css.wizard} aria-label="Set up this project">
    <p className={css.stepNow}>Step {step + 1} of {STEPS.length}: {STEPS[step]}</p>
    <ol className={css.stepper}>{STEPS.map((s, i) => <li key={s} data-state={i < step ? "done" : i === step ? "now" : "later"}>
      <button type="button" onClick={() => i < step && setStep(i)} disabled={i > step} aria-current={i === step ? "step" : undefined}>
        <span className={css.num}>{i < step ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : i + 1}</span><span className={css.stepLabel}>{s}</span></button></li>)}</ol>

    {step === 0 ? <div className={css.body}>
      <h2>Pick a template</h2>
      <div className={css.cards} role="radiogroup" aria-label="Template">{templates.map((x, i) => { const Icon = ICONS[i % ICONS.length]; const l = layout(x, x.packages[0]?.key ?? "", kickoff);
        return <button key={x.key} type="button" role="radio" aria-checked={x.key === key} className={css.card} onClick={() => { setKey(x.key); setPkg(x.packages[0]?.key ?? ""); }}>
          <span className={css.tile} aria-hidden="true"><Icon size={20} /></span>
          <span><b>{x.name}</b><small>{l.phases.length} phases · {l.dated.length} steps{l.liveDays !== null ? ` · ads live on Day ${l.liveDays}` : ""}</small></span></button>; })}</div>
      {t.packages.length > 1 ? <fieldset className={css.pick}><legend>Package sold</legend>
        <div className={css.chips} role="radiogroup" aria-label="Package">{t.packages.map((p) => <button key={p.key} type="button" role="radio" aria-checked={p.key === pkg} onClick={() => setPkg(p.key)}>{p.label}</button>)}</div></fieldset> : null}
      {t.categories.length ? <label className={css.field}><span>Category (optional)</span><select value={category} onChange={(e) => setCategory(e.target.value)}>
        <option value="">Choose later</option>{t.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label> : null}
    </div> : null}

    {step === 1 ? <div className={css.body}>
      <h2>Set the dates</h2>
      <label className={css.field}><span>{startLabel} on</span><input type="date" value={kickoff} onChange={(e) => setKickoff(e.target.value)} /></label>
      <ul className={css.clocks}>
        <li><b>{startLabel}</b><span>{day(kickoff)}</span></li>
        {plan.day0 ? <li><b>{t.clocks?.find((c) => c.key === "day0")?.label ?? "Every input in"} (Day 0)</b><span>{day(plan.day0)} · planned</span></li> : null}
        {plan.live ? <li><b>{t.clocks?.find((c) => c.key === "live")?.label ?? "Live"}</b><span>{day(plan.live)} · planned</span></li> : null}
      </ul>
      {plan.liveDays !== null ? <p className={css.note}>Day 0 is the day every input from the client is in; ads go live {plan.liveDays} days later.</p> : null}
      <section className={css.preview} aria-label="The phases' dates"><h3>The phases</h3>
        <ol>{plan.phases.map((p) => <li key={p.n}><span>{p.label}{plan.live && p.from && p.from > plan.live ? <em className={css.after}> · after ads go live</em> : null}</span><small>{p.from && p.to ? (p.from === p.to ? day(p.from) : `${day(p.from)} – ${day(p.to)}`) : "Dated later"}</small></li>)}</ol>
        <p className={css.note}>Phases overlap: work runs side by side, and some keeps running after ads go live.</p></section>
    </div> : null}

    {step === 2 ? <div className={css.body}>
      <h2>Who does what</h2>
      <label className={css.field}><span>{t.bandwidth.role}<small> · leads the project</small></span><select value={lead} onChange={(e) => setLead(e.target.value)}>
        <option value="">Choose a person</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {roleList.map((r) => <label key={r.label} className={css.field}><span>{r.label}<small> · {plan.dated.filter((s) => s.role === r.label).length === 1 ? "1 step" : `${plan.dated.filter((s) => s.role === r.label).length} steps`}</small></span>
        <select value={roles[r.label] ?? ""} onChange={(e) => setRoles({ ...roles, [r.label]: e.target.value })}>
          <option value="">Decide later</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="none">Nobody on this project (leave its steps out)</option></select></label>)}
    </div> : null}

    {step === 3 ? <div className={css.body}>
      <h2>Check and create</h2>
      <dl className={css.summary}>
        <div><dt>Template</dt><dd>{t.name}{t.packages.length > 1 ? ` · ${t.packages.find((p) => p.key === pkg)?.label}` : ""}</dd></div>
        <div><dt>{startLabel}</dt><dd>{day(kickoff)}</dd></div>
        {plan.day0 ? <div><dt>Inputs in (Day 0)</dt><dd>{day(plan.day0)} (planned)</dd></div> : null}
        {plan.live ? <div><dt>Ads live</dt><dd>{day(plan.live)} (planned)</dd></div> : null}
        <div><dt>Plan</dt><dd>{plan.phases.length} phases · {plan.dated.length} steps</dd></div>
        <div><dt>Lead</dt><dd>{lead ? name(lead) : "Not chosen yet"}</dd></div>
      </dl>
      <section className={css.preview} aria-label="The first steps"><h3>The first steps</h3>
        <ol>{[...plan.dated].filter((s) => s.dueOn).sort((a, b) => a.dueOn!.localeCompare(b.dueOn!)).slice(0, 5).map((s) => <li key={s.id}><span>{s.title.replace(new RegExp(`^${s.id}\\s+`), "")}</span>
          <small>{s.role === t.bandwidth.role ? (lead ? name(lead) : s.role) : roles[s.role ?? ""] && roles[s.role ?? ""] !== "none" ? name(roles[s.role ?? ""]) : s.role ?? ""} · {day(s.dueOn!)}</small></li>)}</ol></section>
      {err ? <p className={css.err} role="alert">{err}</p> : null}
    </div> : null}

    <footer className={css.foot}>
      {step > 0 ? <button type="button" className={styles.btn} onClick={() => setStep(step - 1)}>Back</button> : <span />}
      {step < 3 ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setStep(step + 1)} disabled={step === 2 && !lead}>Next: {STEPS[step + 1]}</button>
        : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={create} disabled={busy || !lead}>{busy ? "Creating…" : "Create the plan"}</button>}
    </footer>
  </section>;
}
