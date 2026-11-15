"use client";
// FOUNDATIONS: a goal's page. The progress and what it counts, the value now (for a goal with a number to reach), the
// projects and tasks under it (add and take off), its smaller goals, and done / drop / reopen for whoever may change it.
// GOALS-2 (owner, 8 Nov 2026: "if money is involved, show the numbers … everything visualised"): after Codex's detail
// concept 1 (reports/goals-2/concepts/detail): a hero with the big number counting up, health by rule with its (i),
// the streak, and the goal's own picture: money draws the pace chart (so far, the straight line to the target, today's
// speed) and the months; clients stack their logos; a count fills a ring; a milestone is a checklist you tick here.
// Beside it: the next thing to do, the linked work and who owns it. Confetti once when the goal is hit.
// WORK-SPINE (owner, 10 Nov 2026: "the goal doesn't show its projects and tasks clearly", "the Next link can't be
// followed", "completing tasks should be one click from anywhere"): under the hero, the projects under the goal, each
// with its type, progress (tasks → project % → goal %) and its next open tasks, ticked done right here; late says why;
// the next thing to do can be finished in one click too. Projects open on their own page (never a client package).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ArrowRight, CalendarRange, Check, CircleDollarSign, FolderKanban, ListChecks, Plus, X, Zap } from "lucide-react";
import { DoneButton, DueChip, TickRow } from "../../tasks/spine";
import ss from "../../tasks/spine.module.css";
import { countedWords, projectHref, typeWord } from "../../lib/work-spine.mjs";
import { post } from "../../orgs/client";
import { useWords } from "../../org-code";
import { amountWords, levelWords, nextAction, pace, percent, readAmount, rupees, shortDate, SOURCE_WORDS, timeGone, valueNow, type GoalSource } from "../../lib/goals.mjs";
import { Milestone, celebrate } from "../../kit/game";
import { PageHeader } from "../../ui";
import { GoalCard, type GoalDetail, type GoalLink } from "../parts";
import { AddGoal } from "../add-goal";
import { BigNumber, ClientSlots, HealthChip, MonthTiles, Owner, PaceBar, PaceChart, Ring, StreakChip } from "../visuals";
import css from "../goals.module.css";

const STATUS: Record<string, string> = { open: "Open", in_progress: "In progress", blocked: "Blocked", in_review: "In review", done: "Done", accepted: "Done",
  cancelled: "Cancelled", unknown: "Open", onboarding: "Starting", active: "Active", paused: "Paused" };
type Picks = { projects: { id: string; title: string; status: string }[]; tasks: { id: string; title: string; status: string }[] };
const say = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const KIND_WORDS: Record<string, string> = { money: "Money", clients: "Clients", count: "Count", milestone: "Done by a date", custom: "Goal" };

export function GoalView({ initial }: { initial: GoalDetail }) {
  const words = useWords();
  const router = useRouter();
  const d = initial, g = d.goal, today = d.today;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picks, setPicks] = useState<Picks | null>(null);
  const [steps, setSteps] = useState(g.steps);
  const [value, setValue] = useState("");
  const p = pace(g, today), next = nextAction({ ...g, steps }, today), gone = timeGone(g, today);
  const pct = g.steps.length && !g.measure ? Math.round((steps.filter((s) => s.done).length / steps.length) * 100) : percent(g.progress.progress);
  const hit = g.status === "done" || pct >= 100;

  async function act(key: string, path: string, body: unknown = {}) {
    setBusy(key); setError(null);
    try { await post(path, body); router.refresh(); return true; } catch (e) { setError(say(e)); return false; } finally { setBusy(null); }
  }
  async function find(e: FormEvent) {
    e.preventDefault();
    try { const r = await fetch(`/api/v0/goals-pick?q=${encodeURIComponent(q)}`, { cache: "no-store" }); setPicks(r.ok ? await r.json() : null); }
    catch { setPicks(null); }
  }
  function saveValue(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = readAmount(value);
    if (v === null) { setError(g.kind === "money" ? "Type an amount, like 16.4 L or 16,40,000." : "Type a number."); return; }
    void act("value", `goals/${g.id}`, { currentValue: v }).then((ok) => { if (ok) setValue(""); });
  }
  async function tick(id: string, el?: HTMLElement) {
    const before = steps, after = steps.map((s) => s.id === id ? { ...s, done: !s.done } : s);
    if (after.find((s) => s.id === id)?.done) celebrate(el);  // UX-GAMIFY: a small burst for each step done
    setSteps(after);
    if (!(await act(`step-${id}`, `goals/${g.id}`, { steps: after }))) setSteps(before);
  }
  // GOALS-2: an existing goal can start filling itself in (the database checks who may pick which source).
  const can = d.sources ?? { billing: false, checkins: false };
  const sources = ([g.source, "manual",
    ...(g.kind === "money" && can.billing ? ["billing_received", "billing_invoiced"] : []),
    ...(g.kind === "clients" && can.billing ? ["clients_paying"] : []),
    ...(g.kind !== "money" && g.kind !== "clients" && can.checkins ? ["checkins"] : []),
    ...(g.kind !== "money" && d.links.length ? ["tasks_done"] : [])] as GoalSource[]).filter((x, i, all) => all.indexOf(x) === i);
  const href = (l: GoalLink) => l.projectId ? projectHref(l.projectId) : `/tasks/${l.taskId}`;
  const projects = d.links.filter((l) => l.kind === "project"), loose = d.links.filter((l) => l.kind === "task");
  const context = [KIND_WORDS[g.kind], levelWords(g, words), g.parent ? `Part of “${g.parent}”` : null].filter(Boolean) as string[];

  return <div className={css.wrap}>
    {/* UX-GAMIFY (owner, 9 Nov 2026: "level up moments when a goal milestone is hit"): a pop card with the burst, once per goal. */}
    <Milestone show={hit} id={`goal-hit-${g.id}`} title="Goal hit! Level up" text={`You reached “${g.title}”.`} />
    {/* WORK-SPINE's back link to the bigger goal; the dependency map is its "See how the work connects" link below (LAND-CAPTAIN-10). */}
    <PageHeader title={g.title} back={g.parentId ? { href: `/goals/${g.parentId}`, label: g.parent ?? "Bigger goal" } : { href: "/goals", label: "Goals" }} context={context} />
    <p className={css.facts}>
      {g.targetOn ? <span><CalendarRange size={15} aria-hidden="true" />{shortDate(g.startsOn, today)} to {shortDate(g.targetOn, today)}</span> : null}
      {g.measure ? <span><CircleDollarSign size={15} aria-hidden="true" />{g.source === "manual" ? "Updated by hand" : `Auto: ${SOURCE_WORDS[g.source]}`}</span> : null}
      {d.links.length ? <Link href={`/tasks/map?goal=${g.id}`} className={css.mapLink}>See how the work connects<ArrowRight size={14} aria-hidden="true" /></Link> : null}
    </p>
    <div className={css.detail}>
      <div className={css.mainCol}>
      <section className={css.hero} aria-label="Progress">
        <div className={css.heroChips}><HealthChip goal={g} today={today} /><StreakChip goal={g} today={today} />
          {g.status !== "active" ? <span className={css.chip} data-tone={g.status === "done" ? "good" : "muted"}>{g.status === "done" ? "Done" : "Dropped"}</span> : null}</div>

        {g.kind === "milestone" && steps.length ? <div className={css.heroSplit} key={`m-${pct}`} data-pop="">
          <Ring value={pct / 100} size={128} stroke={12} label={`${pct}% of the steps done`}><span className={css.ringBig}>{steps.filter((s) => s.done).length}<small>of {steps.length}</small></span></Ring>
          <ul className={css.checklist} aria-label="Steps">{steps.map((s) => <li key={s.id} data-done={s.done ? "" : undefined}>
            <button type="button" role="checkbox" aria-checked={s.done} disabled={!g.canEdit || !!busy || g.status !== "active"} onClick={(e) => tick(s.id, e.currentTarget)}>
              <span className={css.tickBox}>{s.done ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : null}</span><span>{s.title}</span></button></li>)}</ul>
        </div> : <>
          <div className={css.heroNumber} key={`n-${pct}`} data-pop="">
            {g.kind === "count" || g.kind === "custom" || !g.measure ? <Ring value={pct / 100} size={112} stroke={11} label={g.measure ? `${pct}% done` : `${pct}% done: ${g.progress.tasksDone ?? 0} of ${g.progress.tasks ?? 0} tasks`}><span className={css.ringBig}>{pct}%</span></Ring> : null}
            {/* WORK-SPINE (judge r12b): a goal counted from its work says its number once (the ring) and how it is
                counted beside it, not "1 of 9" again. */}
            <div>
              {g.measure ? <BigNumber goal={g} /> : null}
              {g.kind === "money" && g.measure ? <p className={css.heroSub}>{rupees(valueNow(g), true)} of {rupees(g.measure.target, true)} · {pct}%</p>
                : !g.measure && !g.progress.tasks ? <p className={css.heroSub}>Link work, or give it a number, and its progress follows.</p>
                : !g.measure ? <p className={css.heroLead}>{countedWords(g.progress)}</p> : null}
            </div>
          </div>
          {g.measure ? <PaceBar big value={g.progress.progress} expected={g.status === "active" ? gone : null} label={`${pct}% done`} /> : null}
          {g.kind === "clients" && g.measure ? <ClientSlots goal={g} max={20} /> : null}
          {g.measure && g.targetOn && (g.kind === "money" || g.history.length > 1 || g.source !== "manual") ? <PaceChart goal={g} today={today} /> : null}
          {p ? <p className={css.paceLine} data-hits={p.hits ? "" : undefined}><Zap size={16} aria-hidden="true" />{p.sentence}</p> : null}
          {g.kind === "money" ? <MonthTiles goal={g} today={today} /> : null}
          {g.kind === "clients" && g.auto?.items.length ? <ul className={css.clientList}>{g.auto.items.slice(-6).reverse().map((c) => <li key={c.id}><b>{c.name}</b><span>first paid {shortDate(c.on, today)}</span></li>)}</ul> : null}
        </>}

        {g.measure ? <p className={css.counted}>{countedWords(g.progress)}</p> : null}
        {g.why ? <p className={css.why}>{g.why}</p> : null}
        {g.canEdit && g.measure && g.source === "manual" && g.status === "active" ? <form className={css.update} onSubmit={saveValue}>
          <label className={css.field}><span>The number now</span>
            <span className={css.bigInput} data-money={g.kind === "money" ? "" : undefined} data-size="sm">{g.kind === "money" ? <span aria-hidden="true">₹</span> : null}
              <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder={amountWords(g, valueNow(g))} autoComplete="off" aria-label={`The number now (${g.measure.label})`} /></span></label>
          <button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy === "value" || !value.trim()}>{busy === "value" ? "Saving…" : "Update"}</button>
        </form> : null}
        {g.canEdit ? <div className={css.actions}>
          {/* WORK-SPINE: one "Mark done" per view: the goal's own only once it is reached; until then it waits under More. */}
          {g.status === "active" && hit ? <button type="button" className={`${css.btn} ${css.primary}`} disabled={!!busy} onClick={() => act("done", `goals/${g.id}`, { status: "done" })}><Check size={15} aria-hidden="true" />Mark this goal done</button>
          : g.status === "active" ? <details className={css.more}><summary aria-label="Finish or stop this goal">⋯ Finish or stop this goal</summary><div className={css.moreBody}>
            <button type="button" className={`${css.btn} ${css.quiet}`} disabled={!!busy} onClick={() => act("done", `goals/${g.id}`, { status: "done" })}><Check size={15} aria-hidden="true" />Mark this goal done</button>
            <button type="button" className={`${css.btn} ${css.quiet}`} disabled={!!busy} onClick={() => act("drop", `goals/${g.id}`, { status: "dropped" })}>Drop this goal</button></div></details> : <button type="button" className={css.btn} disabled={!!busy} onClick={() => act("open", `goals/${g.id}`, { status: "active" })}>Reopen</button>}
        </div> : null}
        {error ? <p className={css.error} role="alert">{error}</p> : null}
      </section>
    <section className={css.section} aria-label={`${words.project}s under this goal`}>
        <div className={css.sectionHead}><h2><FolderKanban size={17} aria-hidden="true" />{words.project}s under this goal</h2>
          <span>{projects.length ? `${projects.length} ${projects.length === 1 ? words.project.toLowerCase() : `${words.project.toLowerCase()}s`}` : ""}</span></div>
        {projects.length || loose.length ? <div className={css.workGrid}>
          {projects.map((l) => { const pct = l.tasks ? Math.round((100 * l.tasksDone) / l.tasks) : 0; return <article key={l.id} className={css.workCard} aria-label={l.title}>
            <header className={css.workHead}>
              <span className={css.workType} data-type={l.projectType ?? "internal"}>{typeWord(l.projectType)}</span>
              <Link href={href(l)} className={css.workTitle} title={l.title}>{l.title}</Link>
              {g.canEdit ? <details className={css.cardMenu}><summary aria-label={`More for “${l.title}”`} title="More">⋯</summary>
                <button type="button" className={css.removeLink} aria-label={`Take “${l.title}” off this goal`} disabled={!!busy}
                  onClick={() => act(`rm-${l.id}`, `goals/${g.id}/links/${l.id}/remove`)}><X size={13} aria-hidden="true" />Take it off this goal</button></details> : null}
            </header>
            <div className={css.workProgress}>
              <PaceBar value={l.tasks ? l.tasksDone / l.tasks : 0} label={`${l.tasksDone} of ${l.tasks} tasks done`} />
              <span><b>{pct}%</b> · {l.tasksDone} of {l.tasks} {l.tasks === 1 ? "task" : "tasks"}{l.late ? <> · <span className={css.workLate}>{l.late} late</span></> : null}</span>
            </div>
            {l.next?.length ? <ul className={ss.ticks} aria-label={`Next in ${l.title}`}>{l.next.map((t) => <TickRow key={t.id} task={t} today={today} canTick={g.canEdit || (!!d.me && t.whoId === d.me)} />)}</ul>
              : <p className={css.hint}>{l.tasks ? "Every task here is done." : "No tasks yet."}</p>}
            <Link href={href(l)} className={css.workMore}>{l.open && l.open > (l.next?.length ?? 0) ? `See all ${l.open} open tasks` : `Open the ${words.project.toLowerCase()}`}<ArrowRight size={14} aria-hidden="true" /></Link>
          </article>; })}
          {loose.length ? <article className={css.workCard} aria-label="Tasks linked on their own">
            <header className={css.workHead}><span className={css.workType} data-type="task">Tasks</span><span className={css.workTitle}>Linked on their own</span></header>
            <ul className={ss.ticks}>{loose.map((l) => <TickRow key={l.id} task={{ id: l.taskId!, title: l.title, status: l.status, dueOn: l.dueOn, who: l.who }} today={today} />)}</ul>
          </article> : null}
        </div> : <p className={css.hint}>No {words.project.toLowerCase()} or task under this goal yet.{g.canEdit ? " Add one with “Add work to this goal”." : ""}</p>}
        </section>
      </div>

      <aside className={css.side}>
        <section className={css.sideCard} aria-label="Next thing to do" data-o="next">
          <h2><Zap size={16} aria-hidden="true" />Next thing to do</h2>
          {next && g.nextTask && next.href === `/tasks/${g.nextTask.id}` ? <>
            <p className={css.nextTitle}>{g.nextTask.title}</p>
            <DueChip dueOn={g.nextTask.dueOn} today={today} status="open" />
            <div className={css.nextActions}>{d.me ? <DoneButton id={g.nextTask.id} title={g.nextTask.title} /> : null}
              <Link href={next.href} className={css.nextOpen}>Open the task<ArrowRight size={15} aria-hidden="true" /></Link></div></>
            : next ? <Link href={next.href} className={css.nextBig}>{next.label}<ArrowRight size={16} aria-hidden="true" /></Link>
            : <p className={css.hint}>{g.status === "active" ? "Nothing waiting. Keep going." : "This goal is closed."}</p>}
        </section>

        {g.canEdit ? <section className={css.sideCard} aria-label="Work under this goal" data-o="add">
          <h2><FolderKanban size={16} aria-hidden="true" />{g.canEdit ? "Add work to this goal" : "Linked work"}</h2>
          {d.links.length && !g.canEdit ? <ul className={css.list}>{d.links.map((l) => <li key={l.id}>
            {l.kind === "project" ? <FolderKanban size={16} aria-label={words.project} /> : <ListChecks size={16} aria-label="Task" />}
            <span className={css.itemText}>
              <Link href={href(l)}>{l.title}</Link>
              <span>{[STATUS[l.status] ?? l.status, l.kind === "project" ? `${l.tasksDone} of ${l.tasks} tasks done` : null, l.who, l.dueOn ? `Due ${shortDate(l.dueOn, today)}` : null].filter(Boolean).join(" · ")}</span>
              {l.kind === "project" && l.tasks ? <PaceBar value={l.tasksDone / l.tasks} label={`${l.tasksDone} of ${l.tasks} tasks done`} /> : null}
            </span>
            {g.canEdit ? <button type="button" className={`${css.btn} ${css.quiet} ${css.iconBtn}`} aria-label={`Take “${l.title}” off this goal`} disabled={!!busy}
              onClick={() => act(`rm-${l.id}`, `goals/${g.id}/links/${l.id}/remove`)}><X size={16} aria-hidden="true" /></button> : null}
          </li>)}</ul> : !d.links.length ? <p className={css.hint}>Nothing linked yet.{g.canEdit ? ` Find a ${words.project.toLowerCase()} or a task below.` : ""}</p>
            : <p className={css.hint}>The {words.project.toLowerCase()}s and tasks under this goal are listed under its progress. Find more to add:</p>}
          {g.canEdit ? <form className={css.findRow} onSubmit={find} role="search" aria-label="Add work to this goal">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find a ${words.project.toLowerCase()} or task`} aria-label={`Add a ${words.project.toLowerCase()} or a task`} />
            <button type="submit" className={css.btn}>Find</button>
          </form> : null}
          {picks ? <div className={css.picks}>
            {[...picks.projects.map((x) => ({ ...x, kind: "project" as const })), ...picks.tasks.map((x) => ({ ...x, kind: "task" as const }))].map((x) =>
              <button key={`${x.kind}-${x.id}`} type="button" className={`${css.btn} ${css.pick}`} disabled={!!busy}
                onClick={() => act(`add-${x.id}`, `goals/${g.id}/links`, x.kind === "project" ? { projectId: x.id } : { taskId: x.id }).then(() => setPicks(null))}>
                {x.kind === "project" ? <FolderKanban size={16} aria-hidden="true" /> : <ListChecks size={16} aria-hidden="true" />}{x.title}<Plus size={15} aria-hidden="true" />
              </button>)}
            {!picks.projects.length && !picks.tasks.length ? <p className={css.hint}>Nothing you can see matches. Try other words.</p> : null}
          </div> : null}
        </section> : null}

        {g.canEdit && g.measure && g.status === "active" && sources.length > 1 ? <section className={css.sideCard} aria-label="Where the number comes from">
          <h2><CircleDollarSign size={16} aria-hidden="true" />Where the number comes from</h2>
          <select className={css.select} value={g.source} disabled={!!busy} aria-label="Where the number comes from"
            onChange={(e) => void act("source", `goals/${g.id}`, { source: e.target.value })}>
            {sources.map((s) => <option key={s} value={s}>{SOURCE_WORDS[s]}</option>)}
          </select>
          {g.source !== "manual" && g.source !== "tasks_done" ? <p className={css.hint}>It fills itself in. Everyone who can see this goal sees this total.</p> : null}
        </section> : null}

        {g.owner ? <section className={css.sideCard} aria-label="Who" data-o="who">
          <h2>Who</h2><Owner goal={g} size={36} />
        </section> : null}
      </aside>
    </div>

    {d.subGoals.length || g.canEdit ? <section className={css.section} aria-label="Smaller goals">
      <div className={css.sectionHead}><h2>Smaller goals</h2><span>{d.subGoals.length ? `${d.subGoals.length}` : ""}</span></div>
      {d.subGoals.length ? <div className={css.grid}>{d.subGoals.map((s) => <GoalCard key={s.id} goal={s} today={today} words={words} />)}</div>
        : <p className={css.hint}>Break a big goal into smaller ones; their progress adds up here.</p>}
      {g.canEdit ? <div className={css.actions}><AddGoal canCompany={d.canCompany} teams={d.teams} people={d.people ?? []} sources={d.sources ?? { billing: false, checkins: false }} me={d.me}
        today={today} parentId={g.id} label="Add a smaller goal" defaultLevel={g.level === "company" ? "company" : "person"} onMade={() => router.refresh()} /></div> : null}
    </section> : null}
  </div>;
}
