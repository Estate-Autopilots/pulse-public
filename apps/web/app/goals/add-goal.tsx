"use client";
// GOALS-2 (owner, 8 Nov 2026: "adding goals is a very huge deal. It has to feel great"): setting a goal is a guided
// flow of five short steps with a live preview of the goal beside it (above it on a phone), and a small celebration
// when it is made. Replaces FOUNDATIONS' one long form (new-goal.tsx).
//   1 What do you want?  Money, Clients, Count, Done by a date (a checklist) or Custom.
//   2 The target and the date. The preview's ring, ₹ bar, logo slots or checklist and "about ₹1.9 L a week" follow
//     every key press; amounts understand "25 L", "1.2 cr" and "50k".
//   3 Whose goal and who owns it.
//   4 Link a project or tasks (optional).
//   5 Fill it in by itself: Billing for money and paying clients, check-ins, done tasks, or "I'll update it".
// Layout after Codex's "Add a goal" concepts (reports/goals-2/concepts/add): concept 1's tiles, concept 2's stepper and
// live preview, concept 3's "Goal set!". The kit Drawer holds it (a wide panel on a computer, a sheet on a phone), so
// focus, Escape and the phone's swipe work as everywhere else.
import { useRouter } from "next/navigation";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, CalendarCheck2, Check, CircleDollarSign, FolderKanban, IndianRupee, ListChecks, Plus, Sparkles, Target, Users, X } from "lucide-react";
import { post } from "../orgs/client";
import { useWords } from "../org-code";
import { say } from "../lib/words.mjs";
import { daysBetween, rupees, readAmount, shortDate, plainNumber, SOURCE_WORDS, type GoalKind, type GoalSource } from "../lib/goals.mjs";
import { Celebrate } from "../kit/celebrate";
import { DateField, Drawer, DrawerFooter, PersonSelect, Segmented } from "../kit";
import { styles } from "../ui";
import { Ring } from "./visuals";
import type { PickPerson, ScreenGoal, Sources, Team } from "./parts";
import css from "./goals.module.css";

type Level = "person" | "team" | "company";
type Pick = { id: string; title: string; kind: "project" | "task" };
const KIND_TILES: { kind: GoalKind; title: string; hint: string; icon: ReactNode }[] = [
  { kind: "money", title: "Money", hint: "Revenue, collections", icon: <IndianRupee size={22} aria-hidden="true" /> },
  { kind: "clients", title: "Clients", hint: "New or paying clients", icon: <Users size={22} aria-hidden="true" /> },
  { kind: "count", title: "Count", hint: "Calls, contracts, posts", icon: <Target size={22} aria-hidden="true" /> },
  { kind: "milestone", title: "Done by a date", hint: "A milestone with steps", icon: <ListChecks size={22} aria-hidden="true" /> },
  { kind: "custom", title: "Custom", hint: "Anything else", icon: <Sparkles size={22} aria-hidden="true" /> },
];
const STEPS = ["Type", "Target", "Owner", "Link", "Auto-fill"];
const COUNT_WORDS = ["calls", "contracts", "posts", "meetings", "reels"];

/** Last day of this month, of this quarter (Indian quarters end Jun, Sep, Dec, Mar) and in 90 days. */
function quickDates(today: string) {
  const [y, m] = today.split("-").map(Number);
  const end = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  const q = Math.ceil(m / 3) * 3;
  const in90 = new Date(Date.parse(`${today}T00:00:00Z`) + 90 * 86400000).toISOString().slice(0, 10);
  return [{ label: "End of month", on: end(y, m) }, { label: "End of quarter", on: end(y, q) }, { label: "In 90 days", on: in90 }];
}

function suggestTitle(kind: GoalKind | null, target: number | null, label: string, targetOn: string, today: string, clientsWhat: string) {
  const by = targetOn ? ` by ${shortDate(targetOn, today)}` : "";
  if (kind === "money" && target) return `${label === "invoiced" ? "Invoice" : "Collect"} ${rupees(target)}${by}`;
  if (kind === "clients" && target) return `Sign ${plainNumber(target)} ${clientsWhat}${by}`;
  if (kind === "count" && target && label) return `${plainNumber(target)} ${label}${by}`;
  return "";
}

export type AddGoalProps = { canCompany: boolean; teams: Team[]; people: PickPerson[]; sources: Sources; me: string | null; today: string; label?: string; quiet?: boolean;
  startKind?: string; defaultLevel?: Level; parentId?: string; onMade?: (g: ScreenGoal) => void; variant?: "button" | "tiles" };

/** "Add a goal" as a button (the page's primary action), or, on an empty page, the five kinds as big tiles. */
export function AddGoal(props: AddGoalProps) {
  const [open, setOpen] = useState<{ kind: GoalKind | null } | null>(null);
  const primary = !props.parentId && !props.quiet;
  return <>
    {props.variant === "tiles" ? <div className={css.kindTiles}>{KIND_TILES.map((t) => <button key={t.kind} type="button" className={css.kindTile} onClick={() => setOpen({ kind: t.kind })} aria-haspopup="dialog">
      <span className={css.kindIcon}>{t.icon}</span><b>{t.title}</b><span>{t.hint}</span></button>)}</div>
      : <button type="button" className={`${styles.btn}${primary ? ` ${styles.btnPrimary}` : ""}`} onClick={() => setOpen({ kind: (props.startKind as GoalKind) ?? null })} aria-haspopup="dialog">
        <Plus size={16} aria-hidden="true" />{props.label ?? "Add a goal"}</button>}
    {open ? <Wizard {...props} startKind={open.kind ?? undefined} onClose={() => setOpen(null)} /> : null}
  </>;
}

function Wizard({ canCompany, teams, people, sources, me, today, startKind, defaultLevel = "person", parentId, onMade, onClose }: AddGoalProps & { onClose: () => void }) {
  const words = useWords();
  const router = useRouter();
  const titleId = useId();
  const [step, setStep] = useState(startKind ? 1 : 0);
  const [kind, setKind] = useState<GoalKind | null>((startKind as GoalKind) ?? null);
  const [title, setTitle] = useState(""), [titleTouched, setTitleTouched] = useState(false);
  const [amount, setAmount] = useState(""), [startText, setStartText] = useState("");
  const [label, setLabel] = useState(""), [clientsWhat, setClientsWhat] = useState("paying clients");
  const [targetOn, setTargetOn] = useState("");
  const [steps, setSteps] = useState<string[]>([]), [stepText, setStepText] = useState("");
  const mineTeams = teams.filter((t) => t.canEdit);
  const [level, setLevel] = useState<Level>(defaultLevel === "company" && canCompany ? "company" : "person");
  const [teamId, setTeamId] = useState(mineTeams[0]?.id ?? "");
  const [ownerId, setOwnerId] = useState<string | null>(me);
  const [why, setWhy] = useState("");
  const [links, setLinks] = useState<Pick[]>([]), [q, setQ] = useState(""), [found, setFound] = useState<Pick[] | null>(null);
  const [source, setSource] = useState<GoalSource>("manual");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<ScreenGoal | null>(null);

  const target = kind === "milestone" ? null : readAmount(amount);
  const start = readAmount(startText) ?? 0;
  const money = kind === "money";
  const measureLabel = money ? (label === "invoiced" ? "rupees invoiced" : "rupees collected") : kind === "clients" ? clientsWhat : label.trim();
  const suggested = suggestTitle(kind, target, money ? label : label.trim(), targetOn, today, clientsWhat);
  const shownTitle = titleTouched ? title : title || suggested;

  // What each kind may fill itself from (the database checks again on save).
  const options = useMemo(() => {
    const o: { value: GoalSource; title: string; hint: string }[] = [];
    if (money && sources.billing) o.push({ value: label === "invoiced" ? "billing_invoiced" : "billing_received", title: label === "invoiced" ? "Invoices raised, from Billing" : "Money received, from Billing",
      hint: "Adds up every payment (or invoice) from the start day. Nobody has to type it." });
    if (kind === "clients" && sources.billing) o.push({ value: "clients_paying", title: "Clients who paid, from Billing", hint: "Counts each client the first time they pay, with their logo." });
    if ((kind === "count" || kind === "custom") && sources.checkins) o.push({ value: "checkins", title: "Staff checking in, from Attendance", hint: "The share of staff who checked in on the last work day, as a %." });
    if ((kind === "count" || kind === "custom") && links.length) o.push({ value: "tasks_done", title: "Tasks done under it", hint: "Counts the done tasks in the work you linked." });
    o.push({ value: "manual", title: "I'll update it", hint: "Type the new number on the goal's page when it moves." });
    return o;
  }, [money, kind, sources, label, links.length]);
  // The source in force: the one picked if this goal may still use it, else the first on offer.
  const chosen: GoalSource = options.some((o) => o.value === source) ? source : options[0].value;
  // A new money or clients goal fills itself in when it can (that is the point): the best source is picked the first
  // time the last step opens, in the click that opens it.
  const autoPicked = useRef(false);
  const toLast = () => { if (!autoPicked.current) { autoPicked.current = true; setSource(options[0].value); } setStep(4); };

  const days = targetOn ? daysBetween(today, targetOn) : null;
  const perWeek = target !== null && days && days > 0 ? Math.max(0, target - start) / Math.max(1, days / 7) : null;
  const unit = (n: number) => money ? rupees(n) : chosen === "checkins" ? `${plainNumber(Math.round(n))}%` : plainNumber(Math.round(n * 10) / 10);

  const problem = (s: number): string | null => {
    if (s === 0 && !kind) return "Pick what kind of goal it is.";
    if (s === 1) {
      if (kind === "milestone") { if (!steps.length) return "Add at least one step."; if (!targetOn) return "Pick the date it must be done by."; }
      else if (kind !== "custom" && (target === null || target <= 0)) return money ? "Type how much, like 25 L or 2,50,000." : "Type the number to reach.";
      else if (kind === "custom" && amount.trim() && target === null) return "Type a number, or leave it empty.";
      if (target !== null && target === start) return "The target must differ from where it starts.";
      if (kind === "count" && !label.trim()) return "Say what it counts, like calls or posts.";
      if (kind === "custom" && target !== null && !label.trim()) return "Say what the number counts.";
      if (!shownTitle.trim()) return "Give the goal a name.";
    }
    if (s === 2 && level === "team" && !teamId) return say("Pick the {team}.", words);
    if (s === 2 && level === "person" && !ownerId) return "Pick whose goal it is.";
    return null;
  };
  function next() { const p = problem(step); if (p) { setError(p); return; } setError(null); if (step >= 3) toLast(); else setStep(step + 1); }
  function back() { setError(null); setStep((s) => Math.max(0, s - 1)); }

  async function find(text: string) {
    setQ(text);
    if (text.trim().length < 2) { setFound(null); return; }
    try {
      const r = await fetch(`/api/v0/goals-pick?q=${encodeURIComponent(text.trim())}`, { cache: "no-store" });
      const d = r.ok ? await r.json() as { projects: { id: string; title: string }[]; tasks: { id: string; title: string }[] } : null;
      setFound(d ? [...d.projects.map((p) => ({ ...p, kind: "project" as const })), ...d.tasks.map((t) => ({ ...t, kind: "task" as const }))] : null);
    } catch { setFound(null); }
  }

  async function create() {
    for (const s of [0, 1, 2]) { const p = problem(s); if (p) { setStep(s); setError(p); return; } }
    setBusy(true); setError(null);
    const body: Record<string, unknown> = { level, title: shownTitle.trim(), why: why.trim() || null, targetOn: targetOn || null, startsOn: today, kind, source: target === null ? "manual" : chosen,
      ...(parentId ? { parentId } : {}), ...(level === "team" ? { teamId } : {}), ...(ownerId && level !== "team" ? { ownerId } : {}) };
    if (target !== null) Object.assign(body, { measureLabel, startValue: start, targetValue: target, currentValue: start });
    if (kind === "milestone") body.steps = steps.map((title, i) => ({ id: `s${i + 1}`, title, done: false }));
    try {
      const r = await post<{ goal: ScreenGoal }>("goals", body);
      for (const l of links) await post(`goals/${r.goal.id}/links`, l.kind === "project" ? { projectId: l.id } : { taskId: l.id }).catch(() => null);
      setMade(r.goal);
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "That did not work. Try again."); }
    finally { setBusy(false); }
  }

  const tiles = KIND_TILES.find((t) => t.kind === kind);
  const ownerName = people.find((p) => p.id === ownerId)?.name;
  const preview = <div className={css.preview} aria-label="Live preview" role="group">
    <span className={css.previewTag}>Live preview</span>
    <div className={css.previewCard}>
      {kind === "milestone" ? <span className={css.previewSteps}>{(steps.length ? steps : ["First step", "Second step", "Done"]).slice(0, 5).map((s, i) =>
        <span key={`${s}${i}`} data-empty={steps.length ? undefined : ""}><i aria-hidden="true" />{s}</span>)}</span>
        : kind === "clients" ? <span className={css.previewSlots} aria-hidden="true">{Array.from({ length: Math.min(10, Math.max(3, Math.round(target ?? 5))) }, (_, i) => <i key={i} />)}</span>
        : <Ring value={0} size={84} stroke={9} label="0% done"><span className={css.ringPct}>0%</span></Ring>}
      <div className={css.previewWords}>
        <b>{shownTitle || (tiles ? `A ${tiles.title.toLowerCase()} goal` : "Your goal")}</b>
        {target !== null ? <span className={css.previewNumber}><b>{unit(start)}</b> of {unit(target)}{money || chosen === "checkins" ? "" : ` ${measureLabel}`}</span>
          : kind === "milestone" ? <span className={css.previewNumber}><b>0</b> of {steps.length || "?"} steps</span> : null}
        {targetOn ? <span className={css.previewMeta}><CalendarCheck2 size={14} aria-hidden="true" />{shortDate(targetOn, today)}{days !== null && days >= 0 ? ` · ${days} days` : ""}</span> : null}
        {ownerName && step >= 2 ? <span className={css.previewMeta}><Users size={14} aria-hidden="true" />{ownerName}</span> : null}
        {step >= 4 && target !== null ? <span className={css.previewMeta}><CircleDollarSign size={14} aria-hidden="true" />{SOURCE_WORDS[chosen]}</span> : null}
      </div>
    </div>
    {perWeek !== null && perWeek > 0 ? <p className={css.previewPace}><Target size={15} aria-hidden="true" />That is about <b>{unit(perWeek)}</b> a week.</p> : null}
    {links.length ? <p className={css.previewMeta}><FolderKanban size={14} aria-hidden="true" />{links.length} linked</p> : null}
  </div>;

  if (made) return <Drawer title="Goal set" onClose={onClose} size="lg" label="Goal set">
    <Celebrate when id={`goal-new-${made.id}`} />
    <div className={css.done}>
      <span className={css.doneMark} aria-hidden="true"><Check size={40} strokeWidth={3} /></span>
      <h2>Goal set!</h2>
      <p>{made.measure && made.source !== "manual" ? "It fills itself in. We will tell you if it slips." : made.steps.length ? "Tick the steps as you go." : "Update the number as it moves. We will tell you if it slips."}</p>
      {preview}
      <div className={css.doneActions}>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => { onClose(); if (onMade) onMade(made); else router.push(`/goals/${made.id}`); }}>See my goal<ArrowRight size={16} aria-hidden="true" /></button>
        <button type="button" className={styles.btn} onClick={() => { setMade(null); setStep(0); setKind(null); setAmount(""); setTitle(""); setTitleTouched(false); setSteps([]); setLinks([]); setTargetOn(""); setLabel(""); autoPicked.current = false; }}>Add another</button>
      </div>
    </div>
  </Drawer>;

  return <Drawer title={parentId ? "Add a smaller goal" : "Add a goal"} icon={<Target size={16} aria-hidden="true" />} onClose={onClose} size="xl" label="Add a goal"
    footer={<DrawerFooter status={error} primary={step < 4
      ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={next}>Next<ArrowRight size={16} aria-hidden="true" /></button>
      : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={create} disabled={busy}>{busy ? "Setting it…" : "Set the goal"}</button>}>
      {step > 0 ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={back}><ArrowLeft size={16} aria-hidden="true" />Back</button> : null}
      {step >= 2 && step < 4 ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => { const p = problem(step); if (p) setError(p); else { setError(null); toLast(); } }}>Skip to the end</button> : null}
    </DrawerFooter>}>
    <ol className={css.stepper} aria-label="Steps">{STEPS.map((s, i) => <li key={s} data-state={i < step ? "done" : i === step ? "now" : undefined} aria-current={i === step ? "step" : undefined}>
      <button type="button" disabled={i > step} onClick={() => { setError(null); setStep(i); }}><span>{i < step ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : i + 1}</span>{s}</button></li>)}</ol>
    <div className={css.wizard} data-step={step}>
      <div className={css.wizardForm} key={step}>
        {step === 0 ? <>
          <h2 id={titleId} className={css.ask}>What do you want to achieve?</h2>
          <div className={css.kindTiles} role="radiogroup" aria-labelledby={titleId}>{KIND_TILES.map((t) =>
            <button key={t.kind} type="button" role="radio" aria-checked={kind === t.kind} className={css.kindTile} data-on={kind === t.kind ? "" : undefined}
              onClick={() => { setKind(t.kind); setError(null); setSource("manual"); autoPicked.current = false; if (t.kind === "money" && !label) setLabel("collected"); setTimeout(() => setStep(1), 160); }}>
              <span className={css.kindIcon}>{t.icon}</span><b>{t.title}</b><span>{t.hint}</span></button>)}</div>
        </> : null}

        {step === 1 ? <>
          <h2 className={css.ask}>{kind === "money" ? "How much, and by when?" : kind === "clients" ? "How many clients, and by when?" : kind === "milestone" ? "What has to be done, and by when?" : kind === "count" ? "How many, and by when?" : "Name your goal"}</h2>
          {kind === "money" ? <Segmented label="Which money" value={label === "invoiced" ? "invoiced" : "collected"} onChange={(v) => setLabel(v)}
            options={[{ value: "collected", label: "Money received" }, { value: "invoiced", label: "Invoices raised" }]} /> : null}
          {kind === "clients" ? <Segmented label="Which clients" value={clientsWhat} onChange={setClientsWhat}
            options={[{ value: "paying clients", label: "Paying clients" }, { value: "new clients", label: "New clients" }]} /> : null}
          {kind !== "milestone" ? <label className={css.bigField}>{kind === "money" ? "Target" : kind === "custom" ? "A number to reach (optional)" : "Target"}
            <span className={css.bigInput} data-money={money ? "" : undefined}>
              {money ? <span aria-hidden="true">₹</span> : null}
              <input value={amount} onChange={(e) => { setAmount(e.target.value); setError(null); }} inputMode="decimal" data-autofocus autoComplete="off"
                placeholder={money ? "25 L" : kind === "clients" ? "10" : "200"} aria-describedby={`${titleId}-amt`} />
              {money && target !== null ? <b className={css.amountChip}>{rupees(target)}</b> : null}
            </span>
            <span id={`${titleId}-amt`} className={css.hint}>{money ? (target !== null ? rupees(target, true) : "Type 25 L, 1.2 cr or 2,50,000") : " "}</span>
          </label> : null}
          {kind === "count" || (kind === "custom" && target !== null) ? <div className={css.field}><span>What it counts</span>
            <div className={css.wordChips}>{COUNT_WORDS.map((w) => <button key={w} type="button" className={css.wordChip} data-on={label === w ? "" : undefined} onClick={() => setLabel(w)}>{w}</button>)}</div>
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="Or type your own, like site visits" aria-label="What it counts" />
          </div> : null}
          {kind === "milestone" ? <div className={css.field}><span>Steps, in order</span>
            <ol className={css.stepList}>{steps.map((s, i) => <li key={`${s}${i}`}><span>{i + 1}</span>{s}
              <button type="button" aria-label={`Remove “${s}”`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}><X size={14} aria-hidden="true" /></button></li>)}</ol>
            <form className={css.stepAdd} onSubmit={(e) => { e.preventDefault(); const v = stepText.trim(); if (v && steps.length < 30) { setSteps([...steps, v.slice(0, 120)]); setStepText(""); setError(null); } }}>
              <input value={stepText} onChange={(e) => setStepText(e.target.value)} placeholder={steps.length ? "Next step" : "First step, like Book the company name"} aria-label="A step" data-autofocus maxLength={120} />
              <button type="submit" className={styles.btn}><Plus size={15} aria-hidden="true" />Add</button>
            </form>
          </div> : null}
          <div className={css.field}><span>By when?</span>
            <div className={css.wordChips}>{quickDates(today).map((d) => <button key={d.label} type="button" className={css.wordChip} data-on={targetOn === d.on ? "" : undefined} onClick={() => setTargetOn(d.on)}>
              {d.label}</button>)}</div>
            <DateField value={targetOn} onChange={(e) => setTargetOn(e.target.value)} min={today} aria-label="Target date" />
          </div>
          {kind !== "milestone" && kind !== "custom" ? <label className={css.field}><span>Starting from</span>
            <input value={startText} onChange={(e) => setStartText(e.target.value)} inputMode="decimal" placeholder="0" autoComplete="off" /></label> : null}
          <label className={css.field}><span>Goal name</span>
            <input value={shownTitle} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); setError(null); }} maxLength={160}
              placeholder={kind === "milestone" ? "For example: Launch the client portal" : "For example: Sign 12 new clients this year"} /></label>
        </> : null}

        {step === 2 ? <>
          <h2 className={css.ask}>Whose goal is it?</h2>
          <Segmented label="Whose goal" value={level} onChange={(v) => { setLevel(v); if (v === "person" && !people.find((p) => p.id === ownerId)?.canSetFor) setOwnerId(me); }}
            options={[{ value: "person", label: "A person's" }, ...(mineTeams.length ? [{ value: "team" as const, label: say("A {team}'s", words) }] : []),
              ...(canCompany ? [{ value: "company" as const, label: "The company's" }] : [])]} />
          {level === "team" ? <label className={css.field}><span>{say("{Team}", words)}</span>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>{mineTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label> : null}
          {level !== "team" ? <div className={css.field}><span>{level === "company" ? "Who drives it" : "Whose goal"}</span>
            <PersonSelect label={level === "company" ? "Who drives it" : "Whose goal"} people={level === "person" ? people.filter((p) => p.canSetFor) : people} value={ownerId} me={me}
              onChange={(p) => setOwnerId(p?.id ?? (level === "person" ? me : null))} noneLabel={level === "company" ? "Nobody in particular" : undefined} />
          </div> : null}
          <label className={css.field}><span>Why it matters <small className={css.hint}>Optional. People see it on the goal.</small></span>
            <textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={3} maxLength={2000} placeholder="Cash in the bank pays salaries on time." /></label>
        </> : null}

        {step === 3 ? <>
          <h2 className={css.ask}>Link a {words.project.toLowerCase()} or tasks</h2>
          <p className={css.hint}>Optional. The work under a goal shows on it, and its next task becomes the goal&apos;s next step.</p>
          <label className={css.field}><span>Find</span>
            <input value={q} onChange={(e) => void find(e.target.value)} placeholder="Type a few letters of its name" data-autofocus autoComplete="off" /></label>
          {links.length ? <div className={css.wordChips}>{links.map((l) => <span key={l.id} className={css.linkChip}>
            {l.kind === "project" ? <FolderKanban size={14} aria-hidden="true" /> : <ListChecks size={14} aria-hidden="true" />}{l.title}
            <button type="button" aria-label={`Unlink “${l.title}”`} onClick={() => setLinks(links.filter((x) => x.id !== l.id))}><X size={13} aria-hidden="true" /></button></span>)}</div> : null}
          {found ? <ul className={css.found}>{found.filter((f) => !links.some((l) => l.id === f.id)).slice(0, 10).map((f) => <li key={`${f.kind}${f.id}`}>
            <button type="button" onClick={() => setLinks([...links, f])}>{f.kind === "project" ? <FolderKanban size={15} aria-hidden="true" /> : <ListChecks size={15} aria-hidden="true" />}
              <span>{f.title}</span><Plus size={15} aria-hidden="true" /></button></li>)}
            {!found.length ? <li className={css.hint}>Nothing you can see matches. Try other words.</li> : null}</ul> : null}
        </> : null}

        {step === 4 ? <>
          <h2 className={css.ask}>{target === null ? "All set" : "Should it fill itself in?"}</h2>
          {target === null ? <p className={css.hint}>{kind === "milestone" ? "Tick the steps on the goal's page as you go." : "Its progress follows the work you linked."}</p>
            : <div className={css.sources} role="radiogroup" aria-label="Where its number comes from">{options.map((o) => <button key={o.value} type="button" role="radio" aria-checked={chosen === o.value}
              className={css.sourceTile} data-on={chosen === o.value ? "" : undefined} onClick={() => setSource(o.value)}><b>{o.title}</b><span>{o.hint}</span></button>)}</div>}
          {chosen !== "manual" && chosen !== "tasks_done" && target !== null ? <p className={css.notice}>Everyone who can see this goal will see this total.</p> : null}
          {target !== null && chosen === "checkins" ? <p className={css.hint}>The target is a share of staff, like 100 for everyone.</p> : null}
        </> : null}
      </div>
      {step > 0 ? preview : null}
    </div>
  </Drawer>;
}
