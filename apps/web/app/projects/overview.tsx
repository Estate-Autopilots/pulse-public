import Link from "next/link";
import { Bot, CircleCheck, FolderSearch, Search } from "lucide-react";
import { api, vocabulary } from "../lib/api";
import { lower } from "../lib/words.mjs";
import { count, dayYear, plural } from "../lib/format";
import { Badge, Empty, Kpi, Message, Panel, Tiles, styles } from "../ui";
import css from "./overview.module.css";
import { AskAgent } from "./ask-agent";

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
        {ceo && d.pods.length > 1 ? <div className={styles.segmented} role="group" aria-label={words.teams}>
          <Link href={href({ pod: null })} className={styles.segment} aria-current={!d.pod ? "true" : undefined}>All {lower(words.teams)}</Link>
          {d.pods.map((p) => <Link key={p} href={href({ pod: p })} className={styles.segment} aria-current={d.pod === p ? "true" : undefined}>{p}</Link>)}
        </div> : null}
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
    {d.scope === "archived" ? null : ceo && d.ceo && d.ceo.stages.length ? <Tiles count={6}>
      <Kpi label={`Active ${lower(words.projects)}`} value={count(d.totals.active)} />
      <Kpi label={d.labels.adsLive ?? "Live"} value={count(d.ceo.tiles.adsLive)} />
      <Kpi label={`${d.labels.foundation ?? "Foundation"} at risk`} value={count(d.ceo.tiles.foundationRisk)} tone={d.ceo.tiles.foundationRisk ? "danger" : undefined} />
      <Kpi label="Stuck at a gate over 3 days" value={count(d.ceo.tiles.stuckGate)} tone={d.ceo.tiles.stuckGate ? "warning" : undefined} />
      <Kpi label="Tasks late" value={count(d.totals.late)} tone={d.totals.late ? "danger" : undefined} note={lateText} />
      <Kpi label="Waiting on the client" value={count(d.totals.waiting)} tone={d.totals.waiting ? "warning" : undefined} />
    </Tiles> : <Tiles count={4}>
      <Kpi label={`Active ${lower(words.projects)}`} value={count(d.totals.active)} />
      <Kpi label="Need you today" value={count(d.totals.needYou)} tone={d.totals.needYou ? "accent" : undefined} />
      <Kpi label="Tasks late" value={count(d.totals.late)} tone={d.totals.late ? "danger" : undefined} note={lateText} />
      <Kpi label="Waiting on the client" value={count(d.totals.waiting)} tone={d.totals.waiting ? "warning" : undefined} />
    </Tiles>}
    <div className={css.grid}>
      <div className={css.main}>
        {ceo && d.ceo?.stages.length ? <Panel title={`Where the ${lower(words.projects)} are`} sub={`${words.projects} per stage`}>
          <div className={css.stageChart} role="img" aria-label={d.ceo.stages.map((s) => `${s.n} ${s.label}: ${s.projects}`).join(", ")}>
            {d.ceo.stages.map((s) => <div key={s.n} className={css.stageCol}>
              <b>{s.projects}</b><i style={{ height: `${Math.max(4, Math.round((s.projects / maxStage) * 120))}px` }} data-empty={s.projects ? undefined : ""} /><span>{s.n} {s.label}</span>
            </div>)}
          </div>
        </Panel> : null}
        {ceo && d.ceo?.decisions.length ? <Panel title={`${words.projects} that need a decision`} sub="Worst first · open a project">
          <table className={`${styles.table} ${css.table}`}>
            <thead><tr><th>{words.project}</th><th className={styles.hideSmall}>{words.team} · lead</th><th className={styles.hideSmall}>Stage</th><th className={`${styles.right} ${styles.hideSmall}`}>Days in stage</th><th>Why it is here</th><th className={styles.right}>Late tasks</th></tr></thead>
            <tbody>{d.ceo.decisions.map((x) => <tr key={x.id}>
              <td className={css.lead}><Link href={`/tasks/projects/${x.id}`} className={styles.cellLink}>{x.title}</Link></td>
              <td className={styles.hideSmall}>{[x.pod, x.lead].filter(Boolean).join(" · ") || <span className={styles.muted}>No lead</span>}</td>
              <td className={styles.hideSmall}>{x.stage ?? <span className={styles.muted}>—</span>}</td>
              <td className={`${styles.right} ${styles.num} ${styles.hideSmall}`}>{x.daysInStage ?? "—"}</td>
              <td className={css.why} data-tone="danger">{x.why.split(" · ").slice(0, 2).join("; ")}</td>
              <td className={`${styles.right} ${styles.num}`}>{x.late}</td>
            </tr>)}</tbody>
          </table>
        </Panel> : null}
        <Panel title={d.scope === "archived" ? `Archived ${lower(words.projects)}` : ceo ? `All ${lower(words.projects)}` : d.scope === "pod" ? `My ${lower(words.team)}'s ${lower(words.projects)}` : `My ${lower(words.projects)}`}
          sub={d.scope === "archived" ? "Paused, on hold, done or discontinued" : "Sorted by what needs you first"} primary>
          {rows.length ? <table className={`${styles.table} ${css.table}`}>
            <thead><tr><th>{words.project}</th>{hasStage ? <th className={styles.hideSmall}>Stage</th> : null}<th>Next step · owner</th><th className={styles.hideSmall}>Clocks</th><th className={styles.right}>Open tasks</th><th>Health</th></tr></thead>
            <tbody>{rows.map((x) => <tr key={x.id}>
              <td className={css.lead}>
                <Link href={`/tasks/projects/${x.id}`} className={styles.cellLink}>{x.title}</Link>
                <span className={styles.cellSub}>{[x.location, x.client && x.client !== x.title ? x.client : null, ceo || d.scope === "pod" ? x.lead : null].filter(Boolean).join(" · ") || (x.kind === "internal" ? "Internal" : words.client)}</span>
              </td>
              {hasStage ? <td className={styles.hideSmall}>{x.plan ? <><span className={css.stageName}>Stage {x.plan.stage} · {x.plan.stageLabel}</span><span className={css.meter} aria-label={`${x.plan.progress}% of the plan done`}><i style={{ width: `${x.plan.progress}%` }} /></span></>
                : x.stage ? <><span className={css.stageName}>{x.stage}</span>{x.stageOf ? <span className={css.meter}><i style={{ width: `${Math.round(((x.stageDone ?? 0) / x.stageOf) * 100)}%` }} /></span> : null}</>
                : STATUS[x.status] ? <Badge tone="warning">{STATUS[x.status]}</Badge> : <span className={styles.muted}>No plan yet</span>}</td> : null}
              <td>{x.next ? <><Link href={`/tasks/${x.next.id}`} className={css.next}>{x.next.title}</Link>
                <span className={styles.cellSub}>{x.next.who ?? "Nobody on it"}{x.next.due ? <> · <span data-late={x.next.late ? "" : undefined} className={css.due}>{x.next.late ? "was due " : "due "}{short(x.next.due)}</span></> : ""}</span></>
                : <span className={styles.muted}>No open task</span>}</td>
              <td className={`${styles.hideSmall} ${css.clocks}`}>{clocks(x, d.today, d.labels.adsLive ?? "Live").map((c) => <span key={c}>{c}</span>)}</td>
              <td className={`${styles.right} ${styles.num}`}>{x.open}{x.late ? <span className={css.late}>{x.late} late</span> : null}</td>
              <td title={x.why} className={css.health}><Badge tone={HEALTH[x.health].tone}>{HEALTH[x.health].label}</Badge></td>
            </tr>)}</tbody>
          </table> : <Empty icon={FolderSearch} first title={needle ? `No ${lower(words.project)} matches` : d.scope === "mine" ? `No ${lower(words.projects)} need you` : `No active ${lower(words.projects)} here`}
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
          {d.needsYou.length ? <ul className={css.needs}>{d.needsYou.map((n) => <li key={n.id}>
            <Link href={`/tasks/${n.id}`} className={css.needTitle}>{n.title}</Link>
            <span className={css.needMeta}><Link href={`/tasks/projects/${n.projectId}`}>{n.project}</Link> · {n.status === "blocked" ? "blocked" : n.late ? `was due ${short(n.due)}` : "due today"}</span>
          </li>)}</ul> : <Empty icon={CircleCheck} compact title="Nothing late or due today" text="Your project work is on time." />}
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
