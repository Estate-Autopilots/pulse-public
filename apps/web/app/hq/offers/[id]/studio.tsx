"use client";
// PULSE-HQ (owner, 23 Oct 2026): Offer Studio, a guided builder. Hormozi's grand slam offer, one step at a time: the
// customer and their dream outcome, the problems in the way, a solution for each mapped to Pulse features, how it is
// delivered, the packages, bonuses, guarantee, scarcity and urgency, a MAGIC name, price and anchors, the value
// equation and the positioning. Each step has a hint, an example and a check; every change saves a moment later and
// the offer sheet is redrawn live beside it. Duplicate makes a template; the sheet prints to PDF.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Copy, Eye, FileText, Lightbulb, Plus, Search, Star, Trash2, X } from "lucide-react";
import { hqPost, useAutosave } from "../../client";
import { BILLING, CATEGORIES, OFFER_STATUS, money, nameIdeas, per, stackValue, valueScore, valueWord, type Anchor, type Billing, type Bonus, type Feature, type Naming, type Offer, type OfferStatus, type Problem, type Tier } from "../../model";
import { OfferSheet } from "../../offer-sheet";
import { STEPS, stepDone } from "../../steps";
import css from "../../hq.module.css";
import { TrackRecent } from "../../recent";

const ACCENTS = ["#6b4cf0", "#0a7cff", "#1f9d55", "#e8a100", "#e0569b", "#d63d0b", "#1d1d1f"];
const GUARANTEES = [
  { label: "Unconditional", text: "Not happy within 30 days? Full refund, no questions." },
  { label: "Conditional", text: "Use Pulse for 30 days as we set it up; if you cannot see every delivery, owner and due date, month two is free." },
  { label: "Outcome", text: "If your team is not running on Pulse in 30 days, we keep working for free until it is." },
  { label: "Anti-guarantee", text: "No refunds once setup starts, because we put our team on your launch from day one." },
];
const SCARCITY = ["We launch five companies a month.", "Only ten founding customers.", "Two launches per region per month."];
const URGENCY = ["Founding price locked for life before 31 December 2026.", "Launch fee waived this quarter.", "Bonuses expire at the end of the month."];
const VEHICLES = ["Done-for-you setup", "A weekly launch call", "Pulse for the whole team on web, phone and desktop", "Process templates for your industry", "Group onboarding sessions", "Admin training", "Data migration from your current tools", "A monthly review with the owner"];

export function Studio({ initial, features, canEdit }: { initial: Offer; features: Feature[]; canEdit: boolean }) {
  const router = useRouter();
  const [o, setO] = useState<Offer>({ ...initial, problems: initial.problems ?? [], delivery: initial.delivery ?? [] });
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [step, setStep] = useState(() => Math.max(0, STEPS.findIndex((s) => !stepDone(s.key, initial))));
  const save = useAutosave(`offers/${initial.id}`);
  const edit = <K extends keyof Offer>(k: K, v: Offer[K]) => { setO((x) => ({ ...x, [k]: v })); if (canEdit) save.queue({ [k]: v }); };
  const value = valueScore(o);
  const live = { ...o, value };
  const done = STEPS.filter((s) => stepDone(s.key, o)).length;
  const s = STEPS[step];
  const featureName = new Map(features.map((f) => [f.key, f.name]));
  const solutionFeatures = [...new Set(o.problems.flatMap((p) => p.features))];
  // On a phone the step row scrolls sideways: keep the current step in view.
  const stepRow = useRef<HTMLOListElement>(null);
  useEffect(() => { stepRow.current?.querySelector<HTMLElement>('[aria-current="step"]')?.scrollIntoView({ block: "nearest", inline: "center" }); }, [step]);

  return <>
    <TrackRecent href={`/hq/offers/${o.id}`} title={o.name} kind="offer" />
    <div className={`${css.studioTop} ${css.noPrint}`}>
      <Link href="/hq/offers" className={css.iconBtn} aria-label="Back to Offer Studio"><ArrowLeft size={17} /></Link>
      <input className={css.studioName} value={o.name} maxLength={80} onChange={(e) => edit("name", e.target.value)} aria-label="Offer name" readOnly={!canEdit} />
      {canEdit ? <span className={`${css.saved} ${css.glass}`} data-state={save.state} role="status" title={save.error ?? undefined}><i aria-hidden="true" />{save.state === "saving" ? "Saving" : save.state === "error" ? "Not saved" : save.state === "saved" ? "Saved" : "Autosaves"}</span> : null}
      <select className={css.select} style={{ width: "auto" }} value={o.status} onChange={(e) => edit("status", e.target.value as OfferStatus)} aria-label="Status" disabled={!canEdit}>{OFFER_STATUS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
      <div className={`${css.chips} ${css.modeSwitch}`} role="group" aria-label="Show">
        <button type="button" className={css.chip} data-on={mode === "edit" ? "" : undefined} onClick={() => setMode("edit")}>Edit</button>
        <button type="button" className={css.chip} data-on={mode === "preview" ? "" : undefined} onClick={() => setMode("preview")}><Eye size={14} aria-hidden="true" />Preview</button>
      </div>
      <Link href={`/hq/offers/${o.id}/sheet`} className={css.secondary}><FileText size={15} aria-hidden="true" />Offer sheet · PDF</Link>
      {canEdit ? <button type="button" className={css.iconBtn} aria-label="Duplicate as a template" title="Duplicate as a template" onClick={async () => { await save.flush(); const r = await hqPost<{ id: string }>(`offers/${o.id}/duplicate`); router.push(`/hq/offers/${r.id}`); }}><Copy size={16} /></button> : null}
      {canEdit ? <button type="button" className={`${css.iconBtn} ${css.danger}`} aria-label="Delete offer" title="Delete offer" onClick={async () => { if (!window.confirm(`Delete ${o.name}?`)) return; await hqPost(`offers/${o.id}/remove`); router.push("/hq/offers"); router.refresh(); }}><Trash2 size={16} /></button> : null}
    </div>

    <nav className={css.steps} aria-label="Offer builder steps">
      <span className={css.stepsProgress} aria-label={`${done} of ${STEPS.length} steps done`}><i style={{ width: `${(done / STEPS.length) * 100}%` }} /></span>
      <ol ref={stepRow}>{STEPS.map((x, i) => { const ok = stepDone(x.key, o);
        return <li key={x.key}><button type="button" className={css.stepBtn} data-on={i === step ? "" : undefined} data-done={ok ? "" : undefined} aria-current={i === step ? "step" : undefined} title={x.title} onClick={() => setStep(i)}>
          <span className={css.stepDot}>{ok ? <Check size={12} aria-hidden="true" /> : i + 1}</span><span className={css.stepLabel}>{x.short}</span></button></li>; })}</ol>
    </nav>

    <div className={css.studio} data-mode={mode} style={{ "--offer": o.accent } as CSSProperties}>
      <fieldset className={css.editor} disabled={!canEdit} style={{ border: 0, margin: 0, padding: 0 }}>
        <section className={css.block} aria-labelledby="step-title">
          <div className={css.blockHead}><span className={css.stepNo}>{step + 1}</span><div><h3 id="step-title">{s.title}</h3><p>{s.hint}</p></div></div>
          {s.example ? <details className={css.example}><summary><Lightbulb size={14} aria-hidden="true" />Example</summary><p>{s.example}</p></details> : null}

          {s.key === "customer" ? <>
            <Field label="Ideal customer (who, how big, what they use today, what hurts)"><textarea className={css.textarea} value={o.icp} maxLength={600} onChange={(e) => edit("icp", e.target.value)} /></Field>
            <Field label="Dream outcome (their life once this works)"><textarea className={css.textarea} value={o.dreamOutcome} maxLength={600} onChange={(e) => edit("dreamOutcome", e.target.value)} /></Field>
          </> : null}

          {s.key === "problems" ? <ProblemList problems={o.problems} onChange={(v) => edit("problems", v)} /> : null}

          {s.key === "solutions" ? (o.problems.length ? o.problems.map((p, i) => <SolutionRow key={i} p={p} features={features} featureName={featureName}
            onChange={(next) => edit("problems", o.problems.map((x, j) => j === i ? next : x))} />) : <p className={css.empty}>List the problems first (step 2).</p>) : null}

          {s.key === "delivery" ? <>
            <ListEdit items={o.delivery} onChange={(v) => edit("delivery", v)} placeholder="How they receive it" add="Add a delivery vehicle" max={12} />
            <div className={css.hintChips}>{VEHICLES.filter((v) => !o.delivery.includes(v)).map((v) => <button key={v} type="button" className={css.hintChip} onClick={() => edit("delivery", [...o.delivery, v])}><Plus size={12} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -1 }} />{v}</button>)}</div>
          </> : null}

          {s.key === "tiers" ? <TiersBlock tiers={o.tiers} features={features} currency={o.currency} billing={o.billing} suggested={solutionFeatures} onChange={(t) => edit("tiers", t)} /> : null}

          {s.key === "bonuses" ? <BonusEdit items={o.bonuses} currency={o.currency} onChange={(v) => edit("bonuses", v)} /> : null}

          {s.key === "guarantee" ? <>
            <Field label="Guarantee"><textarea className={css.textarea} value={o.guarantee} maxLength={600} onChange={(e) => edit("guarantee", e.target.value)} /></Field>
            <Hints items={GUARANTEES} on={(t) => edit("guarantee", t)} />
          </> : null}

          {s.key === "scarcity" ? <>
            <Field label="Scarcity (a true limit)"><input className={css.input} value={o.scarcity} maxLength={400} onChange={(e) => edit("scarcity", e.target.value)} /></Field>
            <Hints items={SCARCITY.map((t) => ({ label: t, text: t }))} on={(t) => edit("scarcity", t)} />
            <Field label="Urgency (a true reason to decide now)"><input className={css.input} value={o.urgency} maxLength={400} onChange={(e) => edit("urgency", e.target.value)} /></Field>
            <Hints items={URGENCY.map((t) => ({ label: t, text: t }))} on={(t) => edit("urgency", t)} />
          </> : null}

          {s.key === "naming" ? <NamingBlock naming={o.naming} onChange={(v) => edit("naming", v)} onUse={(name) => edit("name", name)} /> : null}

          {s.key === "price" ? <>
            <div className={css.formGrid}>
              <Field label="Headline price"><input className={css.input} type="number" min={0} step={1} value={o.price ?? ""} onChange={(e) => edit("price", e.target.value === "" ? null : Number(e.target.value))} /></Field>
              <Field label="Billing"><select className={css.select} value={o.billing} onChange={(e) => edit("billing", e.target.value as Billing)}>{BILLING.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}</select></Field>
              <Field label="Currency"><select className={css.select} value={o.currency} onChange={(e) => edit("currency", e.target.value)}>{["INR", "USD", "EUR", "GBP", "AED"].map((c) => <option key={c}>{c}</option>)}</select></Field>
            </div>
            <AnchorEdit items={o.anchors} onChange={(v) => edit("anchors", v)} />
            <p className={css.legend}>Bonuses worth {money(stackValue(o), o.currency)}{o.price ? ` against ${money(o.price, o.currency)}${per(o.billing)}` : ""}.</p>
          </> : null}

          {s.key === "value" ? <>
            <Slider label="Dream outcome" hint="How big the result is" v={o.dream} on={(v) => edit("dream", v)} />
            <Slider label="Perceived likelihood" hint="How sure they are it works" v={o.likelihood} on={(v) => edit("likelihood", v)} />
            <Slider label="Time delay" hint="How long until they feel it (1 = now)" v={o.time} on={(v) => edit("time", v)} />
            <Slider label="Effort & sacrifice" hint="What it asks of them (1 = nothing)" v={o.effort} on={(v) => edit("effort", v)} />
            <div className={css.equation}>
              <span className={css.fraction}><span>{o.dream} × {o.likelihood}</span><hr /><span>{o.time} × {o.effort}</span></span>
              <span className={css.equationScore}><b>{value >= 10 ? Math.round(value) : value.toFixed(1)}</b><span>{valueWord(value)} value</span></span>
            </div>
          </> : null}

          {s.key === "positioning" ? <>
            <Field label="Positioning statement"><textarea className={css.textarea} value={o.positioning} maxLength={800} onChange={(e) => edit("positioning", e.target.value)} /></Field>
            <Field label="Brand notes (tone, what to show first, words to use and avoid)"><textarea className={css.textarea} value={o.brandNotes} maxLength={800} onChange={(e) => edit("brandNotes", e.target.value)} /></Field>
            <div className={css.fieldLabel}><span>Core deliverables (outcomes they can picture)</span><ListEdit items={o.deliverables} onChange={(v) => edit("deliverables", v)} placeholder="A deliverable" add="Add deliverable" max={20} /></div>
            <div className={css.fieldLabel}><span>Accent</span><span className={css.swatches} role="radiogroup" aria-label="Accent colour">{ACCENTS.map((c) => <button key={c} type="button" role="radio" aria-checked={o.accent === c} aria-label={c} className={css.swatch} data-on={o.accent === c ? "" : undefined} style={{ "--c": c } as CSSProperties} onClick={() => edit("accent", c)} />)}</span></div>
          </> : null}

          {!stepDone(s.key, o) ? <p className={css.stepCheck} role="status"><CircleAlert size={15} aria-hidden="true" />{s.check}</p> : <p className={css.stepOk} role="status"><Check size={15} aria-hidden="true" />This step is done.</p>}
          <div className={css.stepNav}>
            <button type="button" className={css.ghost} disabled={step === 0} onClick={() => setStep(step - 1)}><ArrowLeft size={15} aria-hidden="true" />Back</button>
            <span className={css.legend}>Step {step + 1} of {STEPS.length} · {done} done</span>
            {step < STEPS.length - 1 ? <button type="button" className={css.primary} onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1].short}<ArrowRight size={15} aria-hidden="true" /></button>
              : <Link href={`/hq/offers/${o.id}/sheet`} className={css.primary}>See the offer sheet<ArrowRight size={15} aria-hidden="true" /></Link>}
          </div>
        </section>
      </fieldset>

      <div className={css.previewCol} aria-label="Live preview"><OfferSheet offer={live} features={features} /></div>
    </div>
  </>;
}

function ProblemList({ problems, onChange }: { problems: Problem[]; onChange: (v: Problem[]) => void }) {
  return <div className={css.listEdit}>
    {problems.map((p, i) => <div key={i} className={css.listRow}>
      <input className={css.input} value={p.problem} maxLength={200} placeholder="What stands in the way" onChange={(e) => onChange(problems.map((x, j) => j === i ? { ...x, problem: e.target.value } : x))} aria-label={`Problem ${i + 1}`} />
      <button type="button" className={css.iconBtn} aria-label={`Remove problem ${i + 1}`} onClick={() => onChange(problems.filter((_, j) => j !== i))}><X size={15} /></button>
    </div>)}
    {problems.length < 12 ? <button type="button" className={css.ghost} style={{ alignSelf: "flex-start" }} onClick={() => onChange([...problems, { problem: "", solution: "", features: [] }])}><Plus size={15} aria-hidden="true" />Add a problem</button> : null}
  </div>;
}

function SolutionRow({ p, features, featureName, onChange }: { p: Problem; features: Feature[]; featureName: Map<string, string>; onChange: (p: Problem) => void }) {
  const [find, setFind] = useState("");
  const q = find.trim().toLowerCase();
  const found = q.length > 1 ? features.filter((f) => !p.features.includes(f.key) && `${f.name} ${f.promise}`.toLowerCase().includes(q)).slice(0, 6) : [];
  return <div className={css.solution}>
    <p className={css.solutionProblem}><b>Problem</b>{p.problem || "Untitled problem"}</p>
    <textarea className={css.textarea} style={{ minHeight: 60 }} value={p.solution} maxLength={300} placeholder="How it goes away with Pulse" onChange={(e) => onChange({ ...p, solution: e.target.value })} aria-label={`Solution to: ${p.problem}`} />
    <div className={css.chips}>{p.features.map((k) => <button key={k} type="button" className={css.tag} onClick={() => onChange({ ...p, features: p.features.filter((x) => x !== k) })} aria-label={`Unlink ${featureName.get(k) ?? k}`}>{featureName.get(k) ?? k}<X size={13} aria-hidden="true" /></button>)}</div>
    <label className={css.search} style={{ maxWidth: "none" }}><Search size={15} aria-hidden="true" /><input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find the Pulse feature that solves it" aria-label={`Find a feature for: ${p.problem}`} /></label>
    {found.length ? <div className={css.pickList}>{found.map((f) => <button key={f.key} type="button" className={css.pickRow} onClick={() => { onChange({ ...p, features: [...p.features, f.key] }); setFind(""); }}><Plus size={14} aria-hidden="true" />{f.name}<small>{CATEGORIES.find((c) => c.key === f.category)?.label}</small></button>)}</div> : null}
  </div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className={css.fieldLabel}><span>{label}</span>{children}</label>;
}

function Slider({ label, hint, v, on }: { label: string; hint: string; v: number; on: (v: number) => void }) {
  return <div className={css.slider}><label>{label}<small>{hint}</small></label>
    <input type="range" min={1} max={10} step={1} value={v} onChange={(e) => on(Number(e.target.value))} aria-label={label} /><output>{v}</output></div>;
}
function Hints({ items, on }: { items: { label: string; text: string }[]; on: (t: string) => void }) {
  return <div className={css.hintChips}>{items.map((h) => <button key={h.label} type="button" className={css.hintChip} title={h.text} onClick={() => on(h.text)}>{h.label}</button>)}</div>;
}

function ListEdit({ items, onChange, placeholder, add, max }: { items: string[]; onChange: (v: string[]) => void; placeholder: string; add: string; max: number }) {
  return <div className={css.listEdit}>
    {items.map((item, i) => <div key={i} className={css.listRow}>
      <input className={css.input} value={item} maxLength={200} placeholder={placeholder} onChange={(e) => onChange(items.map((x, j) => j === i ? e.target.value : x))} aria-label={`${placeholder} ${i + 1}`} />
      <button type="button" className={css.iconBtn} aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}><X size={15} /></button>
    </div>)}
    {items.length < max ? <button type="button" className={css.ghost} style={{ alignSelf: "flex-start" }} onClick={() => onChange([...items, ""])}><Plus size={15} aria-hidden="true" />{add}</button> : null}
  </div>;
}

function BonusEdit({ items, currency, onChange }: { items: Bonus[]; currency: string; onChange: (v: Bonus[]) => void }) {
  const set = (i: number, patch: Partial<Bonus>) => onChange(items.map((b, j) => j === i ? { ...b, ...patch } : b));
  return <div className={css.listEdit}>
    {items.map((b, i) => <div key={i} className={css.bonusRow}>
      <input className={css.input} value={b.name} maxLength={120} placeholder="Bonus" onChange={(e) => set(i, { name: e.target.value })} aria-label={`Bonus ${i + 1}`} />
      <input className={css.input} type="number" min={0} value={b.value || ""} placeholder={`Value (${currency})`} onChange={(e) => set(i, { value: Number(e.target.value) || 0 })} aria-label={`Bonus ${i + 1} value`} />
      <button type="button" className={css.iconBtn} aria-label="Remove bonus" onClick={() => onChange(items.filter((_, j) => j !== i))}><X size={15} /></button>
      <input className={`${css.input} ${css.wide}`} value={b.why} maxLength={300} placeholder="The objection it answers" onChange={(e) => set(i, { why: e.target.value })} aria-label={`Bonus ${i + 1} reason`} />
    </div>)}
    {items.length < 12 ? <button type="button" className={css.ghost} style={{ alignSelf: "flex-start" }} onClick={() => onChange([...items, { name: "", value: 0, why: "" }])}><Plus size={15} aria-hidden="true" />Add bonus</button> : null}
  </div>;
}

function AnchorEdit({ items, onChange }: { items: Anchor[]; onChange: (v: Anchor[]) => void }) {
  const set = (i: number, patch: Partial<Anchor>) => onChange(items.map((a, j) => j === i ? { ...a, ...patch } : a));
  return <div className={css.listEdit}>
    <span className={css.subhead}>Price anchors: what it costs without Pulse</span>
    {items.map((a, i) => <div key={i} className={css.bonusRow}>
      <input className={css.input} value={a.label} maxLength={120} placeholder="The alternative" onChange={(e) => set(i, { label: e.target.value })} aria-label={`Anchor ${i + 1}`} />
      <input className={css.input} type="number" min={0} value={a.amount || ""} placeholder="Amount" onChange={(e) => set(i, { amount: Number(e.target.value) || 0 })} aria-label={`Anchor ${i + 1} amount`} />
      <button type="button" className={css.iconBtn} aria-label="Remove anchor" onClick={() => onChange(items.filter((_, j) => j !== i))}><X size={15} /></button>
    </div>)}
    {items.length < 8 ? <button type="button" className={css.ghost} style={{ alignSelf: "flex-start" }} onClick={() => onChange([...items, { label: "", amount: 0 }])}><Plus size={15} aria-hidden="true" />Add anchor</button> : null}
  </div>;
}

function NamingBlock({ naming, onChange, onUse }: { naming: Naming; onChange: (v: Naming) => void; onUse: (name: string) => void }) {
  const n: Naming = Object.assign({ magnet: "", avatar: "", goal: "", interval: "", container: "", tagline: "" }, naming);
  const set = (k: keyof Naming, v: string) => onChange({ ...n, [k]: v });
  const ideas = nameIdeas(n);
  const parts: { k: keyof Naming; label: string; hint: string }[] = [
    { k: "magnet", label: "Magnet", hint: "A reason now: Autopilot, Launch, Founder-free" },
    { k: "avatar", label: "Avatar", hint: "Who: Agency, Solar Installer" },
    { k: "goal", label: "Goal", hint: "The dream in a phrase" },
    { k: "interval", label: "Interval", hint: "How fast: in 30 days" },
    { k: "container", label: "Container", hint: "What it is: Launch, Pack, Licence" },
  ];
  return <>
    <div className={css.formGrid}>
      {parts.map((p) => <label key={p.k} className={`${css.fieldLabel} ${p.k === "goal" ? css.wide : ""}`}><span>{p.label}<small>{p.hint}</small></span><input className={css.input} value={n[p.k]} maxLength={80} onChange={(e) => set(p.k, e.target.value)} /></label>)}
      <label className={`${css.fieldLabel} ${css.wide}`}><span>Tagline</span><input className={css.input} value={n.tagline} maxLength={160} onChange={(e) => set("tagline", e.target.value)} /></label>
    </div>
    {ideas.length ? <div className={css.hintChips} aria-label="Name ideas">{ideas.map((name) => <button key={name} type="button" className={css.hintChip} onClick={() => onUse(name)} title="Use as the offer name"><Star size={12} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -1 }} />{name}</button>)}</div> : null}
  </>;
}

function TiersBlock({ tiers, features, currency, billing, suggested, onChange }: { tiers: Tier[]; features: Feature[]; currency: string; billing: Billing; suggested: string[]; onChange: (t: Tier[]) => void }) {
  const [at, setAt] = useState(0);
  const [find, setFind] = useState("");
  const tier = tiers[Math.min(at, tiers.length - 1)];
  const set = (patch: Partial<Tier>) => onChange(tiers.map((t, i) => i === Math.min(at, tiers.length - 1) ? { ...t, ...patch } : t));
  const q = find.trim().toLowerCase();
  const groups = useMemo(() => CATEGORIES.map((c) => ({ ...c, items: features.filter((f) => f.category === c.key && (!q || `${f.name} ${f.promise}`.toLowerCase().includes(q))) })).filter((g) => g.items.length), [features, q]);
  const add = () => { const next = [...tiers, { key: `tier-${Date.now().toString(36)}`, name: `Tier ${tiers.length + 1}`, price: null, blurb: "", seats: null, highlight: false, features: tier ? [...tier.features] : [] }]; onChange(next); setAt(next.length - 1); };
  return <>
    <div className={css.tierTabs} role="tablist" aria-label="Tiers">
      {tiers.map((t, i) => <button key={t.key} type="button" role="tab" aria-selected={i === at} className={css.chip} data-on={i === at ? "" : undefined} onClick={() => setAt(i)}>{t.highlight ? <Star size={13} aria-hidden="true" /> : null}{t.name}<small>{t.features.length}</small></button>)}
      {tiers.length < 5 ? <button type="button" className={css.chip} onClick={add}><Plus size={14} aria-hidden="true" />Tier</button> : null}
    </div>
    {tier ? <>
      <div className={css.formGrid}>
        <Field label="Tier name"><input className={css.input} value={tier.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label={`Price (${currency}${per(billing)})`}><input className={css.input} type="number" min={0} value={tier.price ?? ""} placeholder="Custom" onChange={(e) => set({ price: e.target.value === "" ? null : Number(e.target.value) })} /></Field>
        <Field label="Seats"><input className={css.input} type="number" min={1} value={tier.seats ?? ""} placeholder="Unlimited" onChange={(e) => set({ seats: e.target.value === "" ? null : Number(e.target.value) })} /></Field>
        <label className={css.fieldLabel}><span>Most chosen</span><span className={css.toolbar}><input type="checkbox" checked={tier.highlight} onChange={(e) => onChange(tiers.map((t, i) => ({ ...t, highlight: i === at ? e.target.checked : e.target.checked ? false : t.highlight })))} style={{ width: 18, height: 18 }} /> Highlight this tier</span></label>
        <label className={`${css.fieldLabel} ${css.wide}`}><span>One line</span><input className={css.input} value={tier.blurb} maxLength={240} onChange={(e) => set({ blurb: e.target.value })} /></label>
      </div>
      {suggested.some((k) => !tier.features.includes(k)) ? <button type="button" className={css.secondary} style={{ alignSelf: "flex-start" }} onClick={() => set({ features: [...new Set([...tier.features, ...suggested])] })}>
        <Plus size={15} aria-hidden="true" />Add the {suggested.filter((k) => !tier.features.includes(k)).length} features your solutions use</button> : null}
      <label className={css.search} style={{ maxWidth: "none" }}><Search size={15} aria-hidden="true" /><input value={find} onChange={(e) => setFind(e.target.value)} placeholder={`Find features (${tier.features.length} in ${tier.name})`} aria-label="Find features" /></label>
      <div className={css.featurePick}>
        {groups.map((g) => { const all = g.items.every((f) => tier.features.includes(f.key));
          return <div key={g.key}>
            <div className={css.pickCat}>{g.label}<button type="button" onClick={() => set({ features: all ? tier.features.filter((k) => !g.items.some((f) => f.key === k)) : [...new Set([...tier.features, ...g.items.map((f) => f.key)])] })}>{all ? "None" : "All"}</button></div>
            {g.items.map((f) => <label key={f.key} className={css.check}><input type="checkbox" checked={tier.features.includes(f.key)} onChange={(e) => set({ features: e.target.checked ? [...tier.features, f.key] : tier.features.filter((k) => k !== f.key) })} /><span>{f.name}</span><small style={{ color: "var(--faint)", fontSize: 11.5 }}>{f.status === "live" ? "" : f.status}</small></label>)}
          </div>; })}
      </div>
      {tiers.length > 1 ? <button type="button" className={`${css.ghost} ${css.danger}`} style={{ alignSelf: "flex-start" }} onClick={() => { onChange(tiers.filter((_, i) => i !== at)); setAt(0); }}><Trash2 size={15} aria-hidden="true" />Remove {tier.name}</button> : null}
    </> : <button type="button" className={css.secondary} onClick={add}><Plus size={15} aria-hidden="true" />Add the first tier</button>}
    <span className={css.legend}>{tiers.some((t) => t.price !== null) ? `Starts at ${money(Math.min(...tiers.map((t) => t.price ?? Infinity)), currency)}${per(billing)}` : "Give each tier a price"}</span>
  </>;
}
