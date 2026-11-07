"use client";
// FOUNDATIONS: a goal's page. The progress and what it counts, the value now (for a goal with a number to reach), the
// projects and tasks under it (add and take off), its smaller goals, and done / drop / reopen for whoever may change it.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { FolderKanban, ListChecks, X } from "lucide-react";
import { post } from "../../orgs/client";
import { useWords } from "../../org-code";
import { dueWords, levelWords, percent, plainNumber, progressWords } from "../../lib/goals.mjs";
import { PageHeader } from "../../ui";
import { GoalCard, ProgressBar, type GoalDetail, type GoalLink } from "../parts";
import { NewGoal } from "../new-goal";
import css from "../goals.module.css";

const STATUS: Record<string, string> = { open: "Open", in_progress: "In progress", blocked: "Blocked", in_review: "In review", done: "Done", accepted: "Done",
  cancelled: "Cancelled", unknown: "Open", onboarding: "Starting", active: "Active", paused: "Paused" };
type Picks = { projects: { id: string; title: string; status: string }[]; tasks: { id: string; title: string; status: string }[] };
const say = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

export function GoalView({ initial }: { initial: GoalDetail }) {
  const words = useWords();
  const router = useRouter();
  const d = initial, g = d.goal;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picks, setPicks] = useState<Picks | null>(null);
  const due = dueWords(g.targetOn, d.today, g.status);

  async function act(key: string, path: string, body: unknown = {}) {
    setBusy(key); setError(null);
    try { await post(path, body); router.refresh(); } catch (e) { setError(say(e)); } finally { setBusy(null); }
  }
  async function find(e: FormEvent) {
    e.preventDefault();
    try { const r = await fetch(`/api/v0/goals-pick?q=${encodeURIComponent(q)}`, { cache: "no-store" }); setPicks(r.ok ? await r.json() : null); }
    catch { setPicks(null); }
  }
  function saveValue(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = Number(new FormData(e.currentTarget).get("currentValue"));
    if (Number.isFinite(v)) void act("value", `goals/${g.id}`, { currentValue: v });
  }
  const href = (l: GoalLink) => l.projectId ? `/projects/${l.projectId}` : `/tasks/${l.taskId}`;

  return <div className={css.wrap}>
    <PageHeader title={g.title} back={{ href: "/goals", label: "Goals" }} context={[levelWords(g, words), g.parent ? `Part of “${g.parent}”` : null].filter(Boolean) as string[]} />
    <section className={`${css.hero} ${css.big}`} aria-label="Progress">
      <div className={css.heroTop}>
        <span className={css.heroPct}>{percent(g.progress.progress)}%</span>
        <span className={css.meta}><span>{progressWords(g)}</span>{due ? <span data-tone={g.progress.late ? "late" : undefined}>{due}</span> : null}</span>
      </div>
      <ProgressBar goal={g} />
      <p className={css.hint}>{g.progress.basis === "measure" ? `Progress is how far the number has moved from ${plainNumber(g.measure?.start ?? 0)} towards ${plainNumber(g.measure?.target ?? 0)}.`
        : g.progress.basis === "work" ? "Progress is the share of the tasks under this goal that are done (the tasks of its projects included), with its smaller goals counted too."
        : g.progress.basis === "done" ? "Marked done." : "Put projects or tasks under this goal, or give it a number to reach, and its progress follows."}</p>
      {g.why ? <p className={css.why}>{g.why}</p> : null}
      {g.canEdit && g.measure && g.status === "active" ? <form className={css.actions} onSubmit={saveValue}>
        <label className={css.field}>{`Now (${g.measure.label})`}<input name="currentValue" type="number" step="any" defaultValue={g.measure.current} /></label>
        <button type="submit" className={css.btn} disabled={busy === "value"}>{busy === "value" ? "Saving…" : "Update"}</button>
      </form> : null}
      {g.canEdit ? <div className={css.actions}>
        {g.status === "active" ? <>
          <button type="button" className={`${css.btn} ${css.primary}`} disabled={!!busy} onClick={() => act("done", `goals/${g.id}`, { status: "done" })}>Mark done</button>
          <button type="button" className={`${css.btn} ${css.quiet}`} disabled={!!busy} onClick={() => act("drop", `goals/${g.id}`, { status: "dropped" })}>Drop this goal</button>
        </> : <button type="button" className={css.btn} disabled={!!busy} onClick={() => act("open", `goals/${g.id}`, { status: "active" })}>Reopen</button>}
      </div> : null}
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </section>

    <section className={css.section} aria-label="Work under this goal">
      <div className={css.sectionHead}><h2>Work under this goal</h2><span>{d.links.length ? `${d.links.length} linked` : ""}</span></div>
      {d.links.length ? <ul className={css.list}>{d.links.map((l) => <li key={l.id}>
        {l.kind === "project" ? <FolderKanban size={16} aria-label={words.project} /> : <ListChecks size={16} aria-label="Task" />}
        <span className={css.itemText}>
          <Link href={href(l)}>{l.title}</Link>
          <span>{[STATUS[l.status] ?? l.status, l.kind === "project" ? `${l.tasksDone} of ${l.tasks} tasks done` : null, l.who, l.dueOn ? `Due ${l.dueOn}` : null].filter(Boolean).join(" · ")}</span>
        </span>
        {g.canEdit ? <button type="button" className={`${css.btn} ${css.quiet}`} aria-label={`Take “${l.title}” off this goal`} disabled={!!busy}
          onClick={() => act(`rm-${l.id}`, `goals/${g.id}/links/${l.id}/remove`)}><X size={16} aria-hidden="true" /></button> : null}
      </li>)}</ul> : <p className={css.empty}>Nothing under this goal yet.{g.canEdit ? ` Find a ${words.project.toLowerCase()} or a task below and add it.` : ""}</p>}
      {g.canEdit ? <form className={css.form} onSubmit={find} role="search" aria-label="Add work to this goal">
        <div className={css.actions}>
          <label className={css.field} style={{ flex: 1 }}>{`Add a ${words.project.toLowerCase()} or a task`}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a few letters of its name" />
          </label>
          <button type="submit" className={css.btn}>Find</button>
        </div>
        {picks ? <div className={css.picks}>
          {[...picks.projects.map((p) => ({ ...p, kind: "project" as const })), ...picks.tasks.map((t) => ({ ...t, kind: "task" as const }))].map((p) =>
            <button key={`${p.kind}-${p.id}`} type="button" className={`${css.btn} ${css.pick}`} disabled={!!busy}
              onClick={() => act(`add-${p.id}`, `goals/${g.id}/links`, p.kind === "project" ? { projectId: p.id } : { taskId: p.id }).then(() => setPicks(null))}>
              {p.kind === "project" ? <FolderKanban size={16} aria-hidden="true" /> : <ListChecks size={16} aria-hidden="true" />}{p.title}
            </button>)}
          {!picks.projects.length && !picks.tasks.length ? <p className={css.hint}>Nothing you can see matches. Try other words.</p> : null}
        </div> : null}
      </form> : null}
    </section>

    <section className={css.section} aria-label="Smaller goals">
      <div className={css.sectionHead}><h2>Smaller goals</h2><span>{d.subGoals.length ? `${d.subGoals.length}` : ""}</span></div>
      {d.subGoals.length ? <div className={css.grid}>{d.subGoals.map((s) => <GoalCard key={s.id} goal={s} today={d.today} words={words} />)}</div>
        : <p className={css.empty}>Break a big goal into smaller ones; their progress adds up here.</p>}
      <div className={css.actions}><NewGoal canCompany={d.canCompany} teams={d.teams} parentId={g.id} label="Add a smaller goal" onMade={() => router.refresh()} /></div>
    </section>
  </div>;
}
