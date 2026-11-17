import Link from "next/link";
import { CalendarCheck2, CircleCheck, CircleDashed, Flag, Hourglass, MessageCircle, Repeat, Rocket } from "lucide-react";
import { ProgressRing } from "../kit/game";
import { api } from "../lib/api";
import { styles } from "../ui";
import { ClockButton } from "./plan-clocks-client";
import { TaskStagePick } from "./stages-client";
import css from "./plan-clocks.module.css";

/** PM-BUILD-1 (17 Nov 2026; KAZUK-PM-2 phase 1, migration 2262): a client project's plan when its template runs on clocks
 *  (format 3). In order, as Kazuk's "One project" screen: where the project stands (package, the day number, going live),
 *  "Before ads can go live" (the two clocks' inputs, each with its one button), then the steps in their phases (one
 *  band per phase with its ring; the phase in progress open): code, step, who, when, and status in words (Running for
 *  set-up work that runs on, "Waits on C20" while an earlier step is open). Every word comes from the template. */
export type ClockGate = { key: "day0" | "live"; label: string; step: string; stepTitle: string; on: string | null; by: string | null; open: number; planned: string | null;
  inputs: { id: string; title: string; state: "done" | "running" | "open"; taskId: string | null; who: string | null }[] };
export type ClockState = { dayN: number; fromDay0: boolean; day0On: string | null; liveOn: string | null; liveDay: number | null; startLabel: string | null;
  labels: Partial<Record<"start" | "day0" | "live" | "bought", string>>; gates: ClockGate[]; windows: { key: string; label: string; opens: string | null; closes: string | null }[] };
export type StepMeta = { type: string; place: string; owner: string; after: string[]; unlocks: string[]; hours: [number, number] | null; note: string | null };
type PT = { id: string; title: string; step: string | null; phase: string | null; status: string; due: string | null; start: string | null; doneOn: string | null; who: string | null;
  role: string | null; parentId?: string | null };
type Stage = { n: number; label: string; total: number; done: number; late: number; running?: number };

const DONE = new Set(["done", "accepted"]);
const CLOSED = new Set(["done", "accepted", "in_review", "cancelled", "not_applicable", "merged"]);
const short = (d: string | null) => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }) : "—";
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const minus = (s: string) => s.replace(/-(\d)/g, "−$1");
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

type Status = { label: string; tone: "good" | "bad" | "warn" | "run" | "wait" | "plain"; icon?: "run" | "wait" };
function statusOf(t: PT, meta: StepMeta | undefined, open: Set<string>, today: string): Status {
  if (DONE.has(t.status)) return { label: "Done", tone: "good" };
  if (t.status === "in_review") return { label: "In review", tone: "warn" };
  if (t.status === "in_progress" && meta && (meta.type === "ongoing" || meta.type === "repeating")) return { label: meta.type === "repeating" ? "Running · repeats" : "Running", tone: "run", icon: "run" };
  if (t.due && t.due < today) { const n = daysBetween(t.due, today); return { label: `${n} ${n === 1 ? "day" : "days"} late`, tone: "bad" }; }
  if (t.status === "blocked") return { label: "Blocked", tone: "bad" };
  if (t.status === "in_progress") return { label: "In progress", tone: "warn" };
  const waits = (meta?.after ?? []).filter((a) => open.has(a));
  if (waits.length) return { label: `Waits on ${waits.slice(0, 2).join(", ")}${waits.length > 2 ? " …" : ""}`, tone: "wait", icon: "wait" };
  return { label: "Not started", tone: "plain" };
}

export function ClockPlan({ projectId, today, canRun, packageLabel, categoryLabel, clocks, stages, current, tasks, steps, notMade, stageList, clientGroupId, teamChatId, labels }: {
  projectId: string; today: string; canRun: boolean; packageLabel: string | null; categoryLabel: string | null;
  clocks: ClockState; stages: Stage[]; current: number; tasks: PT[]; steps: Record<string, StepMeta>; notMade: { id: string; title: string; why: string }[];
  stageList: { n: number; label: string }[]; clientGroupId: string | null; teamChatId: string | null; labels: Record<string, string> }) {
  const L = clocks.labels;
  const day0Word = L.day0 ?? "Day 0", liveWord = L.live ?? "Live";
  const live = clocks.liveOn, day0 = clocks.fromDay0;
  const open = new Set(tasks.filter((t) => t.step && !CLOSED.has(t.status) && !(t.status === "in_progress" && ["ongoing", "repeating"].includes(steps[t.step]?.type ?? ""))).map((t) => t.step!));
  const stageOf = (t: PT) => t.phase && /^s\d+$/.test(t.phase) ? Number(t.phase.slice(1)) : null;
  // The first clock not yet recorded is the next thing to do; its button is the view's one primary action.
  const next = clocks.gates.find((g) => !g.on) ?? null;
  const gateTitle = labels.gate ?? `Before ${lower(liveWord)}`;
  const claim = live ? clocks.windows.find((w) => w.opens) ?? null : null;
  const loose = tasks.filter((t) => !t.phase && !t.parentId && !CLOSED.has(t.status));
  const auto = notMade.filter((x) => x.why === "auto").map((x) => x.id), cond = notMade.filter((x) => x.why === "condition").map((x) => x.id);
  return <div className={css.wrap}>
    {clocks.gates.length ? <section className={css.gate} aria-label={gateTitle} data-done={next ? undefined : ""}>
      <div className={css.gateHead}><h3><Flag size={15} aria-hidden="true" />{gateTitle}</h3>
        <div className={css.chips} aria-label="Where the project stands">
          {packageLabel ? <span className={css.chip} data-tone="brand">{packageLabel}{categoryLabel && categoryLabel !== packageLabel ? <span className={css.wide}> · {categoryLabel}</span> : null}</span> : null}
        <span className={css.chip} data-tone={day0 ? "good" : "plain"}><CalendarCheck2 size={13} aria-hidden="true" />
          Day {minus(String(clocks.dayN))}<span className={css.wide}>{day0 ? ` since ${lower(day0Word)}` : ` · ${lower(day0Word)} not declared yet`}</span></span>
        <span className={css.chip} data-tone={live ? "good" : "warn"}><Rocket size={13} aria-hidden="true" />
          {live ? `${liveWord} ${short(live)} · day ${clocks.liveDay}` : `${liveWord}: not yet`}</span>
          {claim ? <span className={css.chip} title={`${claim.label}: ${short(claim.opens)} to ${short(claim.closes)}`}>{claim.label} {short(claim.opens)} → {short(claim.closes)}</span> : null}
        </div>
      </div>
      <ol className={css.gateSteps}>{clocks.gates.map((g, i) => {
        const isNext = next?.key === g.key;
        const sub = g.on ? `${g.key === "day0" ? "Declared" : "Recorded"} for ${short(g.on)}${g.by ? ` by ${g.by}` : ""}`
          : g.key === "live" && !day0 ? `After ${lower(day0Word)}` : g.planned ? `Planned by ${short(g.planned)}${g.planned < today ? ` · ${daysBetween(g.planned, today)} days past` : ""}` : "Not dated yet";
        return <li key={g.key} className={css.gateStep} data-state={g.on ? "done" : isNext ? "now" : "later"}>
          <span className={css.gateNo} aria-hidden="true">{g.on ? <CircleCheck size={18} /> : i + 1}</span>
          <div className={css.gateMain}>
            <p className={css.gateName}><b>{g.label}</b><span>{sub}</span></p>
            {!g.on && canRun ? <div className={css.gateAct}><ClockButton projectId={projectId} clock={g.key} label={g.key === "day0" ? `Declare ${lower(g.label)}` : `Record ${lower(g.label)}`}
            what={g.label} open={g.inputs.filter((x) => x.state === "open").map((x) => ({ code: x.id, title: x.title, taskId: x.taskId, who: x.who }))} primary={isNext} today={today} />
</div> : null}
            {/* Recorded: one line. Waiting: what holds it up first and loudest, running work next, the done ones as one chip. */}
            {g.on ? <p className={css.gateDone}><CircleCheck size={13} aria-hidden="true" />All {g.inputs.length} inputs done</p>
              : g.inputs.length ? <ul className={css.inputs} aria-label={`What ${lower(g.label)} needs`}>
                {g.inputs.filter((x) => x.state !== "done").sort((a, b) => Number(a.state !== "open") - Number(b.state !== "open")).map((x) => <li key={x.id}>
                  <Link href={x.taskId ? `/tasks/${x.taskId}` : "#"} className={css.input} data-state={x.state} title={`${x.id} ${x.title}${x.who ? ` · ${x.who}` : ""}`}>
                    <b>{x.id}</b><span>{x.title}</span><em>{x.state === "running" ? "running" : x.who ? `open · ${x.who.split(" ")[0]}` : "open"}</em></Link></li>)}
                {g.inputs.some((x) => x.state === "done") ? <li><span className={css.input} data-state="done" title={g.inputs.filter((x) => x.state === "done").map((x) => `${x.id} ${x.title}`).join(" · ")}>
                  <span>{g.inputs.filter((x) => x.state === "done").length} of {g.inputs.length} done</span><em>✓</em></span></li> : null}
              </ul> : null}
          </div>
        </li>; })}</ol>
      {next ? <p className={css.gateFoot}>{next.key === "live" ? `${liveWord} can't be recorded until all ${next.inputs.length} are done. A campaign set up counts once it is running.`
        : `${day0Word} can't be declared until all ${next.inputs.length} inputs are in. Every date after it counts from that day.`}</p> : null}
    </section> : null}

    <section className={css.steps} aria-label="Steps" id="plan-tasks">
      <div className={css.stepsHead}><h3>Steps</h3><small>{tasks.filter((t) => DONE.has(t.status)).length} of {tasks.filter((t) => t.status !== "cancelled").length} done</small>
        <span className={css.stepsTools}>
          {clientGroupId ? <Link className={styles.btn} href={`/chats?channel=${clientGroupId}`}><MessageCircle size={13} aria-hidden="true" />Open {labels.clientGroup ?? "client group"}</Link> : null}
          {teamChatId ? <Link className={styles.btn} href={`/chats?channel=${teamChatId}`}><MessageCircle size={13} aria-hidden="true" />Open {labels.teamChat ?? "team chat"}</Link> : null}</span></div>
      {stageList.map((s) => {
        const st = stages.find((x) => x.n === s.n); const mine = tasks.filter((t) => stageOf(t) === s.n && t.status !== "cancelled");
        if (!mine.length) return null;
        const done = mine.filter((t) => DONE.has(t.status)).length, pct = done / mine.length;
        const late = st?.late ?? 0, running = st?.running ?? 0;
        const sorted = [...mine].sort((a, b) => Number(DONE.has(a.status)) - Number(DONE.has(b.status)) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.step ?? "").localeCompare(b.step ?? "", "en", { numeric: true }));
        return <details key={s.n} className={css.band} open={s.n === current || late > 0} data-state={done === mine.length ? "done" : s.n === current ? "now" : undefined}>
          <summary className={css.bandHead}>
            <ProgressRing value={pct} size={34} stroke={4} label={`${Math.round(pct * 100)}% of ${s.label} done`} tone={done === mine.length ? "good" : undefined}><span className={css.ringPct}>{Math.round(pct * 100)}</span></ProgressRing>
            <span className={css.bandName}><b>{s.label}</b><small>{done} of {mine.length} done</small>
              {late ? <span className={css.pill} data-tone="bad">{late} late</span> : null}
              {running ? <span className={css.pill} data-tone="run">{running} running</span> : null}
              {s.n === current && done < mine.length ? <span className={css.pill} data-tone="now">Now</span> : null}</span>
          </summary>
          <ul className={css.rows}>
            <li className={css.rowHead} aria-hidden="true"><span>Code</span><span>Step</span><span>Who</span><span>When</span><span>Status</span></li>
            {sorted.map((t) => { const m = t.step ? steps[t.step] : undefined; const stt = statusOf(t, m, open, today);
              const when = DONE.has(t.status) ? `Done ${short(t.doneOn)}` : t.due ? short(t.due) : m ? minus(m.place) : "No date";
              const title = t.step ? t.title.replace(new RegExp(`^${t.step}\\s`), "") : t.title;
              return <li key={t.id} className={css.row} data-tone={stt.tone}>
                <span className={css.code}>{t.step ?? "—"}</span>
                <span className={css.stepMain}><Link href={`/tasks/${t.id}`} className={css.stepTitle} title={title}>{title}</Link>
                  {!DONE.has(t.status) && t.due && m ? <small>{minus(m.place)}{m.hours ? ` · ${m.hours[0] === m.hours[1] ? m.hours[0] : `${m.hours[0]}–${m.hours[1]}`} work hours` : ""}</small> : null}</span>
                <span className={css.who} data-none={t.who ? undefined : ""} data-when={` · ${when}`}>{t.who ?? m?.owner ?? t.role ?? "Nobody yet"}</span>
                <span className={css.when}>{when}</span>
                <span className={css.status} data-tone={stt.tone}>{stt.icon === "run" ? <Repeat size={12} aria-hidden="true" /> : stt.icon === "wait" ? <Hourglass size={12} aria-hidden="true" /> : null}{stt.label}</span>
              </li>; })}
          </ul>
        </details>; })}
      {loose.length ? <details className={css.band} open>
        <summary className={css.bandHead}><span className={css.looseIcon}><CircleDashed size={18} aria-hidden="true" /></span><span className={css.bandName}><b>Not on a phase yet</b><small>{loose.length} open</small></span></summary>
        <ul className={css.rows}>{loose.map((t) => <li key={t.id} className={css.row} data-tone="plain">
          <span className={css.code}>—</span>
          <span className={css.stepMain}><Link href={`/tasks/${t.id}`} className={css.stepTitle}>{t.title}</Link>
            {canRun ? <TaskStagePick projectId={projectId} taskId={t.id} title={t.title} stages={stageList} stage={null} /> : null}</span>
          <span className={css.who} data-none={t.who ? undefined : ""}>{t.who ?? "Nobody yet"}</span>
          <span className={css.when}>{t.due ? short(t.due) : "No date"}</span><span className={css.status} data-tone="plain">Open</span></li>)}</ul>
      </details> : null}
      {notMade.length ? <p className={css.notMade}>{[auto.length ? `${auto.join(", ")} ${auto.length === 1 ? "happens" : "happen"} by itself, so ${auto.length === 1 ? "it is" : "they are"} not a card` : null,
        cond.length ? `${cond.join(", ")} ${cond.length === 1 ? "is" : "are"} added once ${cond.length === 1 ? "its" : "their"} condition is met (for example, real buyers)` : null].filter(Boolean).join(". ")}.</p> : null}
    </section>
  </div>;
}

type StepRef = { code: string; title: string; taskId: string | null; who: string | null; state: "done" | "running" | "open" };
type StepCard = { code: string; title: string; phase: string | null; owner: string; type: string; place: { label: string; start: string | null; due: string | null }; hours: [number, number] | null;
  note: string | null; clientInput: boolean; now: string | null; waits: StepRef[]; unlocks: StepRef[]; inputs: StepRef[]; records: { key: string; label: string } | null; running: boolean; today: string };
const TYPE_WORDS: Record<string, string> = { gate: "Gate: what follows waits for it", milestone: "Milestone", approval: "Approval", ongoing: "Runs on once set up", repeating: "Repeats" };

function Refs({ items, label, opens }: { items: StepRef[]; label: string; opens?: boolean }) {
  return <ul className={css.inputs} aria-label={label}>{items.map((x) => <li key={x.code}>
    <Link href={x.taskId ? `/tasks/${x.taskId}` : "#"} className={css.input} data-state={opens && x.state === "open" ? "next" : x.state} title={`${x.code} ${x.title}${x.who ? ` · ${x.who}` : ""}`}>
      <b>{x.code}</b><span>{x.title}</span><em>{x.state === "done" ? "✓" : x.state === "running" ? "running" : x.who ? x.who.split(" ")[0] : "open"}</em></Link></li>)}</ul>;
}

/** PM-BUILD-1: a plan step on its task's page, as Kazuk's "anatomy of one card": code and phase, the role that owns it,
 *  where it sits on its clock with its dates, the work-hours benchmark, what it waits on and what finishing it opens. */
export async function PlanStepCard({ taskId, waits = true }: { taskId: string; /** False when the page lists what it waits on itself. */ waits?: boolean }) {
  const s = (await api<{ step: StepCard | null }>(`tasks/${encodeURIComponent(taskId)}/plan-step`)).data?.step ?? null;
  if (!s) return null;
  const dates = s.place.start || s.place.due ? `${s.place.start && s.place.start !== s.place.due ? `${short(s.place.start)} → ` : ""}${s.place.due ? short(s.place.due) : "runs on"}` : null;
  const openInputs = s.inputs.filter((x) => x.state === "open");
  return <section className={css.card} aria-label={`Step ${s.code}`}>
    <p className={css.cardHead}><span className={css.code}>{s.code}</span><span>{s.phase}</span>
      {s.running ? <span className={css.status} data-tone="run"><Repeat size={12} aria-hidden="true" />Running</span> : TYPE_WORDS[s.type] ? <span className={css.pill} data-tone="now">{TYPE_WORDS[s.type]}</span> : null}</p>
    {/* One line of what only the plan knows (the side panel already has the person, the due day and the estimate). */}
    <p className={css.cardLine}><span>Role: <b>{s.owner}</b></span><span>Planned: <b>{minus(s.place.label)}</b>{dates ? ` (${dates})` : ""}</span>{s.now ? <span className={css.today}>Today is {minus(s.now)}</span> : null}{s.clientInput ? <span>Needs the client&apos;s input</span> : null}
      {!dates ? <span>Dated once its clock is recorded</span> : null}</p>
    {s.inputs.length ? <div className={css.cardRefs}><p>{openInputs.length ? `Can be done once these are done (${openInputs.length} open)` : "Every input is done"}</p><Refs items={s.inputs} label="Inputs" /></div> : null}
    {waits && s.waits.length && !s.inputs.length ? <div className={css.cardRefs}><p>Waits on</p><Refs items={s.waits} label="Waits on" /></div> : null}
    {s.unlocks.length ? <div className={css.cardRefs}><p>Next after this</p><Refs items={s.unlocks} label="Next after this" opens /></div> : null}
    {s.records ? <p className={css.cardNote}>Marking this done records <b>{lower(s.records.label)}</b>; the steps that count from it get their dates.</p> : null}
    {s.note ? <p className={css.cardNote}>{s.note}</p> : null}
  </section>;
}
