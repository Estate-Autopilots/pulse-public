import Link from "next/link";
import { Bot, CircleCheck, FolderSearch, Search } from "lucide-react";
import { api, vocabulary } from "../lib/api";
import { lower } from "../lib/words.mjs";
import { count, dayYear, plural } from "../lib/format";
import { Badge, Empty, Message, Panel, styles } from "../ui";
import css from "./overview.module.css";
import { AskAgent } from "./ask-agent";
import { UrlSelect } from "../tasks/views/scope-bar";

/** KAZUK (27-28 Oct 2026): Work → Projects, the project-management home, as in the Projects tab screens: the lead's
 *  "My projects" and leadership's "All projects". Which project needs you first, from the work itself and the project's
 *  delivery plan (stage, next step, clocks, gates), never from Drive delivery counts. Words come from the company's
 *  vocabulary and its delivery template. Data: GET /api/v0/projects/health. */
type Health = "blocked" | "waiting" | "at_risk" | "watch" | "on_track";
type PlanInfo = { stage: number; stageLabel: string | null; stageOf: number; progress: number; daysInStage: number; dayN: number; kickoff: string; adsLiveOn: string | null;
  adsPlanned: string | null; foundationDue: string | null; foundationLeft: number | null; foundationRisk: boolean; stuckGate: boolean; units: number; category: string | null; package: string | null };
type Row = {
  id: string; title: string; location: string | null; client: string | null; pod: string | null; leadId: string | null; lead: string | null;
  status: string; kind: string; startsOn: string | null; dueOn: string | null; open: number; late: number; blocked: number;
  noOwner: number; noDue: number; waitingClient: number; mine: boolean; stage: string | null; stageDone: number | null; stageOf: number | null;
  next: { id: string; title: string; who: string | null; due: string | null; late: boolean } | null; health: Health; why: string; plan: PlanInfo | null;
};
type Need = { id: string; title: string; status: string; due: string | null; late: boolean; projectId: string; project: string };
type Band = { units: number; state: "room" | "healthy" | "max" | "over"; projects: number };
type Data = { agent: { id: string; name: string; username: string | null } | null; labels: Record<string, string>; today: string; role: string; everyone: boolean; scope: string; pod: string | null; pods: string[]; rows: Row[];
  viewer: { name: string; role: string | null; pod: string | null } | null;
  bandwidth: { role: string; short: string; healthy: [number, number]; max: number; note: string | null; categories: { key: string; label: string; units: number }[];
    me: Band | null; people: (Band & { id: string; name: string; pod: string | null })[] } | null;
  ceo: { stages: { n: number; label: string; projects: number }[]; money: { title: string; detail: string; projects: { id: string; title: string }[] }[];
    alerts: { title: string; detail: string; projectId: string; project: string }[]; tiles: { adsLive: number; foundationRisk: number; stuckGate: number };
    decisions: { id: string; title: string; pod: string | null; lead: string | null; stage: string | null; daysInStage: number | null; why: string; late: number }[] } | null;
  totals: { active: number; late: number; lateProjects: number; blocked: number; waiting: number; atRisk: number; noOwner: number; noDue: number; needYou: number }; needsYou: Need[] };
type Score = { rows: { id: string; name: string; role: string | null; pod: string | null; open: number; late: number; doneWeek: number; usual: number | null; newcomer: boolean;
  target: { perWeek: number; unit: string | null } | null }[] };

const HEALTH: Record<Health, { label: string; tone: "danger" | "warning" | "success" | "neutral" | "accent" }> = {
  blocked: { label: "Blocked", tone: "danger" }, waiting: { label: "Waiting on client", tone: "warning" }, at_risk: { label: "At risk", tone: "danger" },
  watch: { label: "Watch", tone: "warning" }, on_track: { label: "On track", tone: "success" },
};
const STATUS: Record<string, string> = { paused: "Paused", on_hold: "On hold", done: "Done", cancelled: "Discontinued" };
const BAND: Record<Band["state"], { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  room: { label: "Has room", tone: "neutral" }, healthy: { label: "Healthy", tone: "success" }, max: { label: "At the maximum", tone: "warning" }, over: { label: "Over: needs a hire", tone: "danger" } };

const short = (d: string | null) => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }) : null;
function dayN(start: string | null, today: string) {
  if (!start) return null;
  const n = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
  return n >= 0 ? `Day ${n}` : `Starts ${short(start)}`;
}
function clocks(x: Row, today: string, live: string) {
  if (!x.plan) return [dayN(x.startsOn, today), x.dueOn ? `Ends ${short(x.dueOn)}` : null].filter(Boolean) as string[];
  const p = x.plan;
  return [p.dayN >= 0 ? `Kick-off + ${p.dayN}` : `Kick-off ${short(p.kickoff)}`,
    p.adsLiveOn ? `${live} ${short(p.adsLiveOn)}` : p.adsPlanned && p.adsPlanned < today ? `${live}: not yet` : p.adsPlanned ? `${live} by ${short(p.adsPlanned)}` : null].filter(Boolean) as string[];
}

/** WORK-UX (29 Oct 2026): the key numbers as one slim strip (number, then what it counts), not a row of tall empty tiles. */
type Stat = { label: string; value: number; tone?: "danger" | "warning" | "accent"; note?: string };
function Stats({ items }: { items: Stat[] }) {
  return <section className={css.stats} aria-label="Key numbers" data-count={items.length}>{items.map((x) => <div key={x.label} className={css.stat} data-tone={x.value ? x.tone : undefined}>
    <b>{count(x.value)}</b><span>{x.label}{x.note ? <small>{x.note}</small> : null}</span></div>)}</section>;
}

export async function ProjectsOverview({ scope, pod, q }: { scope?: string; pod?: string; q?: string }) {
  const qs = new URLSearchParams(); if (scope) qs.set("scope", scope); if (pod) qs.set("pod", pod);
  const [r, words] = await Promise.all([api<Data>(`projects/health?${qs}`), vocabulary()]);
  if (r.error) return <Message text={r.error} />; if (!r.data) return null;
  const d = r.data;
  const needle = (q ?? "").trim().toLowerCase();
  const rows = needle ? d.rows.filter((x) => `${x.title} ${x.client ?? ""} ${x.location ?? ""} ${x.lead ?? ""} ${x.next?.title ?? ""}`.toLowerCase().includes(needle)) : d.rows;
  const ceo = d.everyone && d.scope === "all";
  const people = ceo ? (await api<Score>(`work/scorecard${d.pod ? `?pod=${encodeURIComponent(d.pod)}` : ""}`)).data : null;
  const href = (over: { scope?: string; pod?: string | null }) => {
    const n = new URLSearchParams({ view: "projects" }); const s = over.scope ?? d.scope; n.set("scope", s);
    const p = over.pod === undefined ? d.pod : over.pod; if (p && s !== "mine") n.set("pod", p); if (q) n.set("q", q);
    return `/tasks?${n}`;
  };
  const scopes = [{ key: "mine", label: `My ${lower(words.projects)}` }, { key: "pod", label: `My ${lower(words.team)}` },
    ...(d.everyone ? [{ key: "all", label: `All ${lower(words.projects)}` }] : []), { key: "archived", label: "Archived" }];
  const hasStage = rows.some((x) => x.stage || STATUS[x.status]);
  const who = d.viewer ? [d.viewer.name, d.viewer.role, d.viewer.pod].filter(Boolean).join(" · ") : null;
  const lateText = d.totals.late ? `Across ${plural(d.totals.lateProjects, lower(words.project))}` : "Nothing late";
  const maxStage = Math.max(1, ...(d.ceo?.stages ?? []).map((s) => s.projects));
  return <div className={css.wrap}>
    <div className={css.bar}>
      {who ? <p className={css.who}>{who}{ceo ? ` · every ${lower(words.team)}, every role` : ""}</p> : null}
      <div className={css.barEnd}>
        {ceo && d.pods.length > 1 ? <UrlSelect param="pod" label={words.teams} value={d.pod ?? ""} options={[{ value: "", label: `All ${lower(words.teams)}` }, ...d.pods.map((p) => ({ value: p, label: p }))]} /> : null}
        <div className={styles.segmented} role="group" aria-label={`Whose ${lower(words.projects)}`}>
          {scopes.map((s) => <Link key={s.key} href={href({ scope: s.key })} className={styles.segment} aria-current={d.scope === s.key ? "true" : undefined}>{s.label}</Link>)}
        </div>
        <form className={styles.search} action="/tasks" role="search">
          <input type="hidden" name="view" value="projects" /><input type="hidden" name="scope" value={d.scope} />
          <Search size={14} aria-hidden="true" />
          <input className={styles.input} type="search" name="q" defaultValue={q ?? ""} placeholder={`Search a ${lower(words.project)} or a task`} aria-label={`Search ${lower(words.projects)}`} />
        </form>
      </div>
    </div>
    {d.scope === "archived" ? null : ceo && d.ceo && d.ceo.stages.length ? <Stats items={[
      { label: `Active ${lower(words.projects)}`, value: d.totals.active },
      { label: d.labels.adsLive ?? "Live", value: d.ceo.tiles.adsLive },
      { label: `${d.labels.foundation ?? "Foundation"} at risk`, value: d.ceo.tiles.foundationRisk, tone: "danger" },
      { label: "Stuck at a gate over 3 days", value: d.ceo.tiles.stuckGate, tone: "warning" },
      { label: "Tasks late", value: d.totals.late, tone: "danger", note: lateText },
      { label: "Waiting on the client", value: d.totals.waiting, tone: "warning" }]} />
    : <Stats items={[
      { label: `Active ${lower(words.projects)}`, value: d.totals.active },
      { label: "Need you today", value: d.totals.needYou, tone: "accent" },
      { label: "Tasks late", value: d.totals.late, tone: "danger", note: lateText },
      { label: "Waiting on the client", value: d.totals.waiting, tone: "warning" }]} />}
    <div className={css.grid}>
      <div className={css.main}>
        {ceo && d.ceo?.stages.length ? <Panel title={`Where the ${lower(words.projects)} are`} sub={`${words.projects} per stage`}>
          <div className={css.stageChart} role="img" aria-label={d.ceo.stages.map((s) => `${s.n} ${s.label}: ${s.projects}`).join(", ")}>
            {d.ceo.stages.map((s) => <div key={s.n} className={css.stageCol}>
              <b>{s.projects}</b><i style={{ height: `${Math.max(4, Math.round((s.projects / maxStage) * 72))}px` }} data-empty={s.projects ? undefined : ""} /><span>{s.n} {s.label}</span>
            </div>)}
          </div>
        </Panel> : null}
        {ceo && d.ceo?.decisions.length ? <Panel title={`${words.projects} that need a decision`} sub="Worst first · open a project">
          {/* WORK-UX: the same rows as the project list (the six-column table wrapped every cell to two or three lines). */}
          <ul className={css.plist} aria-label={`${words.projects} that need a decision`} data-kind="decide">
            <li className={css.phead} aria-hidden="true"><span>{words.project}</span><span>Stage · days in it</span><span>Why it is here</span><span>Late</span></li>
            {d.ceo.decisions.map((x) => <li key={x.id} className={css.prow} data-health="at_risk">
              <div className={css.pName}><Link href={`/tasks/projects/${x.id}`} className={css.pTitle}>{x.title}</Link>
                <span className={css.pSub}>{[x.pod, x.lead].filter(Boolean).join(" · ") || "No lead"}</span></div>
              <div className={css.pStage}><span className={css.stageName}>{x.stage ?? "No plan yet"}</span>{x.daysInStage !== null ? <span className={css.pSub}>{plural(x.daysInStage, "day")} in this stage</span> : null}</div>
              <div className={css.pWhy}>{x.why.split(" · ").slice(0, 2).join("; ")}</div>
              <div className={css.pLate}><b data-late={x.late ? "" : undefined}>{x.late}</b></div>
            </li>)}
          </ul>
        </Panel> : null}
        <Panel title={d.scope === "archived" ? `Archived ${lower(words.projects)}` : ceo ? `All ${lower(words.projects)}` : d.scope === "pod" ? `My ${lower(words.team)}'s ${lower(words.projects)}` : `My ${lower(words.projects)}`}
          sub={d.scope === "archived" ? "Paused, on hold, done or discontinued" : "Sorted by what needs you first"} primary>
          {/* WORK-UX (29 Oct 2026): one row per project that always fits beside the sidebar (the table cut off Open tasks and
              Health): the project with its clocks, the stage and its bar, the next step with its owner, open and late, health.
              Narrow panels and phones stack each row into a card. */}
          {rows.length ? <ul className={css.plist} aria-label={words.projects} data-stage={hasStage ? "" : undefined}>
            <li className={css.phead} aria-hidden="true"><span>{words.project}</span>{hasStage ? <span>Stage · open work</span> : null}<span>Next step · owner</span></li>
            {rows.map((x) => { const work = <span className={css.pCount}><b>{x.open}</b> open{x.late ? <span className={css.late}> · {x.late} late</span> : null}</span>;
              return <li key={x.id} className={css.prow} data-health={x.health}>
              <div className={css.pName}>
                <span className={css.pTitleRow}><Link href={`/tasks/projects/${x.id}`} className={css.pTitle}>{x.title}</Link><span className={css.pHealth} title={x.why}><Badge tone={HEALTH[x.health].tone}>{HEALTH[x.health].label}</Badge></span></span>
                <span className={css.pSub}>{[x.location, x.client && x.client !== x.title ? x.client : null, ceo || d.scope === "pod" ? x.lead : null].filter(Boolean).join(" · ") || (x.kind === "internal" ? "Internal" : words.client)}</span>
                <span className={css.pClocks}>{clocks(x, d.today, d.labels.adsLive ?? "Live").join(" · ")}</span>
                {hasStage ? null : work}
              </div>
              {hasStage ? <div className={css.pStage}>{x.plan ? <><span className={css.stageName}>Stage {x.plan.stage} · {x.plan.stageLabel}</span><span className={css.meter} aria-label={`${x.plan.progress}% of the plan done`}><i style={{ width: `${x.plan.progress}%` }} /></span></>
                : x.stage ? <><span className={css.stageName}>{x.stage}</span>{x.stageOf ? <span className={css.meter}><i style={{ width: `${Math.round(((x.stageDone ?? 0) / x.stageOf) * 100)}%` }} /></span> : null}</>
                : STATUS[x.status] ? <Badge tone="warning">{STATUS[x.status]}</Badge> : <span className={styles.muted}>No plan yet</span>}{work}</div> : null}
              <div className={css.pNext}>{x.next ? <><Link href={`/tasks/${x.next.id}`} className={css.next}>{x.next.title}</Link>
                <span className={css.pSub}>{x.next.who ?? "Nobody on it"}{x.next.due ? <> · <span data-late={x.next.late ? "" : undefined} className={css.due}>{x.next.late ? "was due " : "due "}{short(x.next.due)}</span></> : ""}</span></>
                : <span className={styles.muted}>No open task</span>}</div>
            </li>; })}
          </ul> : <Empty icon={FolderSearch} first title={needle ? `No ${lower(words.project)} matches` : d.scope === "mine" ? `No ${lower(words.projects)} need you` : `No active ${lower(words.projects)} here`}
            text={d.scope === "mine" ? `${words.projects} you lead or hold open work in show here.` : `${words.projects} show here once they have open work or a plan.`}
            action={d.scope === "mine" ? { href: href({ scope: "pod" }), label: `My ${lower(words.team)}` } : undefined} />}
        </Panel>
        {people?.rows.length ? <Panel title="People this week" sub="Output vs the role's target · coaching only for the first 30 days" action={{ href: "/tasks?view=people", label: "People" }}>
          <table className={`${styles.table} ${css.table}`}>
            <thead><tr><th>Person</th><th className={styles.hideSmall}>Role</th><th className={styles.right}>Open</th><th className={styles.right}>Late</th><th>Output vs target</th></tr></thead>
            <tbody>{people.rows.filter((p) => p.open || p.doneWeek || p.late).slice(0, 10).map((p) => {
              const goal = p.target?.perWeek ?? p.usual ?? null;
              return <tr key={p.id}>
                <td className={css.lead}><Link href={`/people/${p.id}`} className={styles.cellLink}>{p.name}</Link>{p.newcomer ? <span className={styles.cellSub}>First 30 days: coaching only</span> : null}</td>
                <td className={styles.hideSmall}>{[p.role, p.pod].filter(Boolean).join(" · ") || <span className={styles.muted}>Not set</span>}</td>
                <td className={`${styles.right} ${styles.num}`}>{p.open}</td>
                <td className={`${styles.right} ${styles.num}`} data-late={p.late ? "" : undefined}>{p.late}</td>
                <td>{goal ? <>{p.doneWeek} of {goal} {p.target?.unit ?? "tasks"} this week<span className={css.meter}><i style={{ width: `${Math.min(100, Math.round((p.doneWeek / goal) * 100))}%` }} /></span></> : <>{p.doneWeek} finished this week</>}</td>
              </tr>;
            })}</tbody>
          </table>
        </Panel> : null}
      </div>
      {d.scope === "archived" ? null : <aside className={css.side} aria-label="Needs you">
        {ceo && d.ceo ? <>
          <Panel title="Money at risk">
            {d.ceo.money.length ? <ul className={css.needs}>{d.ceo.money.map((m) => <li key={m.title}>
              <span className={css.needTitle}>{m.title}</span>
              <span className={css.needMeta}>{m.projects.slice(0, 3).map((p, i) => <span key={p.id}>{i ? ", " : ""}<Link href={`/tasks/projects/${p.id}`}>{p.title}</Link></span>)}{m.projects.length > 3 ? ` and ${m.projects.length - 3} more` : ""} · {m.detail}</span>
            </li>)}</ul> : <Empty icon={CircleCheck} compact title="Nothing at risk" text="No renewals, guarantee checks or outside-the-quote work need you." />}
          </Panel>
          <Panel title="Same-day alerts">
            {d.ceo.alerts.length ? <ul className={css.needs}>{d.ceo.alerts.map((a, i) => <li key={i}>
              <span className={css.needTitle}>{a.title}</span><span className={css.needMeta}>{a.detail} · <Link href={`/tasks/projects/${a.projectId}`}>{a.project}</Link></span>
            </li>)}</ul> : <Empty icon={CircleCheck} compact title="No alerts today" text="No gate, block or unowned work is waiting." />}
          </Panel>
        </> : <Panel title="Needs you today" sub={d.needsYou.length ? count(d.needsYou.length) : undefined}>
          {/* WORK-UX: the first six, the rest one tap away (twelve rows made the rail longer than the page). */}
          {d.needsYou.length ? <>{[d.needsYou.slice(0, 6), d.needsYou.slice(6)].map((part, i) => {
            const list = <ul className={css.needs}>{part.map((n) => <li key={n.id}>
              <Link href={`/tasks/${n.id}`} className={css.needTitle}>{n.title}</Link>
              <span className={css.needMeta}><Link href={`/tasks/projects/${n.projectId}`}>{n.project}</Link> · {n.status === "blocked" ? "blocked" : n.late ? `was due ${short(n.due)}` : "due today"}</span>
            </li>)}</ul>;
            return !part.length ? null : i ? <details key="more" className={css.moreNeeds}><summary>Show {part.length} more</summary>{list}</details> : <div key="first">{list}</div>;
          })}</> : <Empty icon={CircleCheck} compact title="Nothing late or due today" text="Your project work is on time." />}
        </Panel>}
        {d.bandwidth && (d.bandwidth.me || d.bandwidth.people.length) ? <Panel title={`${d.bandwidth.role} bandwidth`} sub={`Healthy ${d.bandwidth.healthy[0]}–${d.bandwidth.healthy[1]} units · max ${d.bandwidth.max}`}>
          <ul className={css.needs}>
            {(d.bandwidth.people.length ? d.bandwidth.people : d.bandwidth.me ? [{ ...d.bandwidth.me, id: "me", name: "You", pod: null }] : []).map((b) => <li key={b.id} className={css.band}>
              <span className={css.needTitle}>{b.name}<Badge tone={BAND[b.state].tone}>{BAND[b.state].label}</Badge></span>
              <span className={css.meter} data-tone={BAND[b.state].tone}><i style={{ width: `${Math.min(100, Math.round((b.units / d.bandwidth!.max) * 100))}%` }} /></span>
              <span className={css.needMeta}>{b.units} units · {plural(b.projects, lower(words.project))}</span>
            </li>)}
          </ul>
          <p className={css.empty}>{d.bandwidth.categories.map((c) => `${c.label} ${c.units}`).join(" · ")}{d.bandwidth.note ? `. ${d.bandwidth.note}.` : ""}</p>
        </Panel> : null}
        {d.totals.noOwner || d.totals.noDue ? <Panel title="Fix first">
          <ul className={css.needs}>
            {d.totals.noOwner ? <li><Link href="/tasks?scope=company&people=none&layout=table" className={css.needTitle}>{plural(d.totals.noOwner, "task")} with nobody on it</Link><span className={css.needMeta}>A task without an owner is never done or credited</span></li> : null}
            {d.totals.noDue ? <li><Link href="/tasks?scope=company&due=none&layout=table" className={css.needTitle}>{plural(d.totals.noDue, "task")} with no due day</Link><span className={css.needMeta}>Give each a day so it can be late, or on time</span></li> : null}
          </ul>
        </Panel> : null}
        <Panel title={ceo ? "Ask Pulse CEO" : "Ask your agent"} sub={d.agent ? d.agent.name : undefined}>
          <AskAgent agent={d.agent} context={`asked from Work → ${words.projects}`} placeholder={ceo ? `Which ${lower(words.projects)} will miss the foundation check?` : `What is late in my ${lower(words.projects)} this week?`} />
        </Panel>
        <p className={css.foot}>Read {dayYear(d.today)}. <Link href="/tasks?view=projects&list=1">Every {lower(words.project)}, as a list</Link> · <Link href="/projects?view=board">Delivery board</Link></p>
      </aside>}
    </div>
  </div>;
}
