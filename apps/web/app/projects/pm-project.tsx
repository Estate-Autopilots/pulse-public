import Link from "next/link";
import { cache } from "react";
import { Check, CircleAlert, Circle, Clock, Columns3, GanttChartSquare, Megaphone, Rows3, Users } from "lucide-react";
import { api } from "../lib/api";
import { Avatar } from "../avatar";
import { type PmCard } from "./pm-cards";
import { ICONS, day } from "./pm-shared";
import home from "./pm-home.module.css";
import { ClockMoveButton, NextStepAction, UpdateButton } from "./pm-project-client";
import { ClientAsks } from "./client-asks";
import css from "./pm-project.module.css";

/** PM-BUILD-3 (the Mac's screens 02 and 03, SPEC v1.1 §5.2–5.3): a project with a delivery plan opens on its next step.
 *  The next step card (the step, who has it, when it is due, one button that fits the viewer), the phases as a numbered
 *  strip with the clock line (tap a phase to see its steps), the phase's steps as a list or a board (To do, Doing, In
 *  review, Waiting on client, Done), and beside them the clocks (with "Move a date") and who does what. The plan's other
 *  cards (what we promised, before ads can go live, set-up) fold under it. Data: GET /api/v0/projects/:id/pm. */
export type PmStep = { id: string; code: string | null; title: string; stage: number | null; status: string; word: string; tone: string; late: number; clientLate: number;
  who: string | null; whoId: string | null; role: string | null; due: string | null; start?: string | null; planned: boolean; mine: boolean; gate: boolean };
export type PmProjectData = { today: string; me: string; plan: boolean; card: PmCard; steps: PmStep[];
  project: { id: string; title: string; status: string; client: string | null; clientId: string | null; leadId: string | null; lead: string | null; canRun: boolean };
  team: { role: string; id: string | null; name: string | null; lead: boolean; open: number; nobody: number }[];
  clocks: { key: string; label: string; on: string | null; happened: boolean }[]; reasons: { key: string; label: string; side?: string }[] | null; canMove: boolean };

export type PmUpdate = { today: string; canPost: boolean; system: { health: string; word: string; reason: string | null }; draft: { done: string[]; next: string[]; help: string[] };
  history: { id: string; body: string; on: string; by: string | null; meta: { health?: string; system?: string; reason?: string } | null }[] };
const WORD: Record<string, string> = { late: "Late", at_risk: "At risk", waiting_client: "Waiting on client", on_track: "On track", not_started: "Not started", needs_setup: "Needs setup", paused: "Paused", done: "Done" };
export const pmData = cache((projectId: string) => api<PmProjectData>(`projects/${encodeURIComponent(projectId)}/pm`));
/** The project's colour and icon as a tile (the page header). */
export function ProjectTile({ color, icon }: { color: string; icon: string }) {
  const Icon = ICONS[icon] ?? ICONS.folder;
  return <span className={`${home.tile} ${home.pc}`} data-color={color} aria-hidden="true"><Icon size={22} /></span>;
}
const COLUMNS = [["todo", "To do"], ["doing", "Doing"], ["review", "In review"], ["client", "Waiting on client"], ["done", "Done"]] as const;
const columnOf = (s: PmStep) => s.tone === "done" || s.tone === "skip" ? "done" : s.tone === "doing" ? "doing" : s.tone === "turn" || s.tone === "review" ? "review" : s.tone === "client" ? "client" : "todo";
const dd = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

function LateFlag({ s }: { s: PmStep }) {
  if (s.late) return <span className={css.flag} data-tone="late">Late · {s.late} {s.late === 1 ? "day" : "days"}</span>;
  if (s.clientLate) return <span className={css.flag} data-tone="client">Client late · {s.clientLate} {s.clientLate === 1 ? "day" : "days"}</span>;
  return null;
}
function When({ s, today }: { s: PmStep; today: string }) {
  if (!s.due) return <span className={css.when}>No date yet</span>;
  if (s.tone !== "done" && s.due === today) return <span className={css.when} data-tone="today">Due today</span>;
  return <span className={css.when}>{s.planned ? "Planned " : ""}{day(s.due)}</span>;
}
function Mark({ s }: { s: PmStep }) {
  if (s.tone === "done") return <span className={css.mark} data-tone="done" aria-label="Done"><Check size={13} strokeWidth={3} /></span>;
  if (s.late) return <span className={css.mark} data-tone="late" aria-label="Late"><CircleAlert size={18} /></span>;
  return <span className={css.mark} data-tone={s.tone === "doing" ? "doing" : undefined} aria-hidden="true"><Circle size={18} /></span>;
}

const PHASE_WORD: Record<string, string> = { done: "Done", active: "Doing", late: "Late", waiting: "Waiting on client", todo: "To do" };
/** The Mac's screen 18 (deferred past v1, so last): the phases as dated bars, the clocks as markers and today as a line;
 *  on a phone, the phases as a dated list. Dates are the steps' (stored, else planned). */
function Timeline({ d }: { d: PmProjectData }) {
  const today = d.today;
  const phases = d.card.phases.filter((p) => p.state !== "none").map((p) => {
    const mine = d.steps.filter((s) => s.stage === p.n);
    const starts = mine.map((s) => s.start ?? s.due).filter((x): x is string => !!x).sort(), ends = mine.map((s) => s.due ?? s.start).filter((x): x is string => !!x).sort();
    return { ...p, from: starts[0] ?? null, to: ends.at(-1) ?? null };
  });
  const marks = d.clocks.filter((k) => k.on).map((k) => ({ key: k.key, label: k.label, on: k.on!, happened: k.happened }));
  const all = [...phases.flatMap((p) => [p.from, p.to]), ...marks.map((m) => m.on), today].filter((x): x is string => !!x).sort();
  if (!all.length) return <p className={css.colEmpty}>No dates yet: they come from the clocks.</p>;
  const lo = Date.parse(`${all[0]}T00:00:00Z`) - 2 * 86400000, hi = Date.parse(`${all.at(-1)}T00:00:00Z`) + 3 * 86400000;
  const at = (x: string) => ((Date.parse(`${x}T00:00:00Z`) - lo) / (hi - lo)) * 100;
  const span = (a: string, b: string) => a === b ? day(a) : `${day(a)} – ${day(b)}`;
  return <>
    <ol className={css.tlList} aria-label="Phases by date">{phases.map((p) => <li key={p.n} data-state={p.state}>
      <span><b>{p.label}</b><small>{p.from && p.to ? span(p.from, p.to) : "No dates yet"}</small></span><span className={css.chip} data-tone={p.state === "done" ? "done" : p.state === "active" ? "doing" : undefined}>{PHASE_WORD[p.state]}</span></li>)}
      {marks.filter((m) => m.key === "live").map((m) => <li key={m.key} data-state="gate"><span><b>{m.label}</b><small>{m.happened ? "" : "Planned "}{day(m.on)}</small></span><span className={css.chip}>Gate</span></li>)}</ol>
    <p className={css.tlNote}>The timeline works best on a bigger screen.</p>
    <div className={css.tl} role="img" aria-label={`Timeline: ${phases.map((p) => `${p.label} ${p.from && p.to ? span(p.from, p.to) : "no dates"}`).join("; ")}`}>
      <div className={css.tlMarks}>{marks.map((m) => <span key={m.key} className={css.tlMark} data-key={m.key} data-happened={m.happened ? "" : undefined} style={{ left: `${at(m.on)}%` }}>
        <i aria-hidden="true" /><small>{m.label} · {day(m.on)}</small></span>)}
        <span className={css.tlToday} style={{ left: `${at(today)}%` }}><small>Today</small></span></div>
      {phases.map((p) => <div key={p.n} className={css.tlRow}>
        <span className={css.tlLabel}><b>{p.label}</b><small>{PHASE_WORD[p.state]}</small></span>
        <span className={css.tlTrack}>{p.from && p.to ? <span className={css.tlBar} data-state={p.state} style={{ left: `${at(p.from)}%`, width: `${Math.max(1.5, at(p.to) - at(p.from) + 100 / ((hi - lo) / 86400000))}%` }}>
          <small>{span(p.from, p.to)}</small></span> : null}
          <i className={css.tlTodayLine} style={{ left: `${at(today)}%` }} aria-hidden="true" /></span>
      </div>)}
    </div>
  </>;
}

export async function PmProjectHome({ projectId, phase, view }: { projectId: string; phase?: string; view?: string }) {
  const [r, u] = await Promise.all([pmData(projectId), api<PmUpdate>(`projects/${encodeURIComponent(projectId)}/update`)]);
  const d = r.data; if (!d?.plan) return null;
  const up = u.data ?? null;
  const c = d.card, today = d.today, base = `/tasks/projects/${projectId}`;
  const shown = c.phases.filter((p) => p.state !== "none");
  const asked = phase !== undefined && /^\d+$/.test(phase) ? Number(phase) : null;
  const pick = shown.find((p) => p.n === asked) ?? shown.find((p) => p.n === c.current) ?? shown.find((p) => p.state !== "done") ?? shown[0];
  const steps = d.steps.filter((s) => s.stage === pick?.n);
  const board = view === "board", timeline = view === "timeline";
  const n = c.next ? d.steps.find((s) => s.id === c.next!.id) ?? null : null;
  const href = (over: { phase?: number; view?: string }) => { const q = new URLSearchParams(); const ph = over.phase ?? (asked ?? undefined); const v = over.view ?? view;
    if (ph !== undefined && ph !== c.current) q.set("phase", String(ph)); if (v && v !== "list") q.set("pv", v); const s = q.toString(); return `${base}${s ? `?${s}` : ""}#steps`; };
  const live = d.clocks.find((x) => x.key === "live");
  // Who does what, one line per person (their roles together); a role nobody holds on its own line.
  const people = [...d.team.reduce((m, t) => { const k = t.id ?? `none:${t.role}`; const x = m.get(k) ?? { key: k, id: t.id, name: t.name, roles: [] as string[], lead: false };
    x.roles.push(t.lead ? `${t.role} (lead)` : t.role); x.lead ||= t.lead; return m.set(k, x); }, new Map<string, { key: string; id: string | null; name: string | null; roles: string[]; lead: boolean }>()).values()]
    .sort((a, b) => Number(b.lead) - Number(a.lead) || Number(!!b.name) - Number(!!a.name));
  return <section className={css.home} aria-label="Project home" data-view={board ? "board" : timeline ? "timeline" : "list"}>
    <div className={css.main}>
      {n ? <section className={css.next} aria-label="Next step">
        <p className={css.kicker}>Next step</p>
        <h2 className={css.nextTitle}><Link href={`/tasks/${n.id}`}>{n.title}</Link></h2>
        <p className={css.nextMeta}>{n.who ? <span className={css.person}><Avatar name={n.who} id={n.whoId} size={26} /><b>{n.mine ? "You" : n.who}</b></span> : <span className={css.nobody}>Nobody has it yet</span>}
          <span className={css.chip} data-tone={n.tone}>{n.word}</span><When s={n} today={today} /><LateFlag s={n} /></p>
        <NextStepAction step={{ id: n.id, title: n.title, status: n.status, mine: n.mine, tone: n.tone, gate: n.gate }} />
      </section> : <section className={css.next} aria-label="Next step"><p className={css.kicker}>Next step</p><h2 className={css.nextTitle}>Nothing open in the plan</h2>
        <p className={css.nextMeta}>Every step of this plan is done or running.</p></section>}

      <section className={css.phaseCard} aria-label="Phases">
        <ol className={css.stepper}>{shown.map((p, i) => <li key={p.n} data-state={p.state} data-current={p.n === c.current ? "" : undefined} data-picked={p.n === pick?.n ? "" : undefined}>
          <Link href={href({ phase: p.n })} aria-current={p.n === pick?.n ? "true" : undefined} title={`${p.label}: ${p.done} of ${p.total} steps done`}>
            <span className={css.dot}>{p.state === "done" ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : i + 1}</span>
            <span className={css.phaseLabel}>{p.label}</span></Link></li>)}</ol>
        {c.line ? <p className={css.clockLine}><Clock size={14} aria-hidden="true" />{c.line}</p> : null}
      </section>

      <section id="steps" className={css.steps} aria-label={`${pick?.label ?? "Phase"}: its steps`}>
        <header className={css.stepsHead}>
          <h3>{timeline ? "All phases" : pick?.label ?? "Steps"}<small>{timeline ? c.line : pick ? `${pick.done} of ${pick.total} done` : null}</small></h3>
          <nav className={css.views} aria-label="Show the steps as">
            <Link href={href({ view: "list" })} aria-current={!board && !timeline ? "true" : undefined}><Rows3 size={14} aria-hidden="true" />List</Link>
            <Link href={href({ view: "board" })} aria-current={board ? "true" : undefined}><Columns3 size={14} aria-hidden="true" />Board</Link>
            <Link href={href({ view: "timeline" })} aria-current={timeline ? "true" : undefined}><GanttChartSquare size={14} aria-hidden="true" />Timeline</Link>
          </nav>
        </header>
        {timeline ? <Timeline d={d} /> : !board ? <ul className={css.rows}>{steps.map((s) => <li key={s.id} data-next={s.id === n?.id ? "" : undefined} data-tone={s.tone}>
          <Mark s={s} />
          <span className={css.rowMain}><Link href={`/tasks/${s.id}`} className={css.rowTitle}>{s.title}</Link>
            <small>{s.who ? (s.mine ? "You" : s.who) : <span className={css.nobody}>Nobody yet</span>}</small></span>
          <span className={css.rowEnd}><When s={s} today={today} />{s.late || s.clientLate ? <LateFlag s={s} /> : s.tone === "done" ? null : <span className={css.chip} data-tone={s.tone}>{s.word}</span>}</span>
        </li>)}</ul>
          : <><nav className={css.colTabs} aria-label="Columns">{COLUMNS.map(([k, label]) => <a key={k} href={`#col-${k}`}>{label}<b>{steps.filter((s) => columnOf(s) === k).length}</b></a>)}</nav>
            <div className={css.board}>{COLUMNS.map(([k, label], ci) => { const list = steps.filter((s) => columnOf(s) === k);
            return <section key={k} id={`col-${k}`} className={css.col} aria-label={`${label}, ${list.length}`} data-col={ci}><h4>{label}<small>{list.length}</small></h4>
              {list.map((s) => <Link key={s.id} href={`/tasks/${s.id}`} className={css.cardStep} data-next={s.id === n?.id ? "" : undefined}>
                <b>{s.title}</b><span className={css.cardMeta}>{s.who ? <><Avatar name={s.who} id={s.whoId} size={20} />{s.mine ? "You" : s.who}</> : "Nobody yet"}<When s={s} today={today} /></span><LateFlag s={s} /></Link>)}
              {list.length ? null : <p className={css.colEmpty}>None yet</p>}</section>; })}</div></>}
      </section>
    </div>

    <aside className={css.side} aria-label="Clocks, team and updates">
      <ClientAsks projectId={projectId} />
      <section className={css.sideCard} aria-label="Clocks">
        <h3><Clock size={16} aria-hidden="true" />Clocks</h3>
        <ul className={css.clocks}>{d.clocks.map((k) => { const d0 = d.clocks.find((x) => x.key === "day0")?.on;
          const rel = k.on && d0 ? dd(d0, k.on) : null;
          return <li key={k.key} data-happened={k.happened ? "" : undefined}>
            <span className={css.clockMark}>{k.happened ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : null}</span>
            <span><b>{k.label}</b><small>{k.on ? `${k.happened ? "" : "Planned "}${day(k.on)}` : "No day yet"}{rel !== null && k.key === "live" ? ` · Day ${rel}` : k.key === "day0" ? " · Day 0" : ""}
              {k.key === "live" && !k.happened && k.on && k.on >= today ? ` (in ${dd(today, k.on)} ${dd(today, k.on) === 1 ? "day" : "days"})` : ""}</small></span></li>; })}</ul>
        {d.canMove ? <ClockMoveButton projectId={projectId} clocks={d.clocks.filter((k) => k.key === "day0" || k.key === "live").map((k) => ({ key: k.key, label: k.label, on: k.on, happened: k.happened }))}
          reasons={d.reasons ?? [{ key: "client_delay", label: "Client delay" }, { key: "our_delay", label: "Our delay" }, { key: "other", label: "Other" }]} today={today} /> : null}
        {live && !live.on ? <p className={css.sideNote}>Going live gets its day once Day 0 is set.</p> : null}
      </section>
      <section className={css.sideCard} aria-label="Team">
        <h3><Users size={16} aria-hidden="true" />Team</h3>
        <ul className={css.team}>{people.slice(0, 7).map((t) => <li key={t.key}>
          {t.name ? <Avatar name={t.name} id={t.id} size={30} /> : <span className={css.empty} aria-hidden="true" />}
          <span><b>{t.name ?? "Nobody yet"}</b><small>{t.roles.join(", ")}</small></span></li>)}</ul>
        {people.length > 7 ? <p className={css.sideNote}>and {people.length - 7} more</p> : null}
        {d.project.canRun ? <Link className={css.sideLink} href={`${base}?more=1#setup`}>Change who does what</Link> : null}
      </section>
      {up ? <section className={css.sideCard} aria-label="Updates">
        <h3><Megaphone size={16} aria-hidden="true" />Updates</h3>
        {up.history[0] ? <div className={css.lastUpdate}><small>{up.history[0].on === today ? "Today" : day(up.history[0].on)}{up.history[0].by ? ` · ${up.history[0].by}` : ""}{up.history[0].meta?.health ? ` · ${WORD[up.history[0].meta.health] ?? ""}` : ""}</small>
          <p>{up.history[0].body.split("\n").filter((l) => l.trim() && !/^(Done this week|Next week|Needs help)$/i.test(l.trim()))[0]?.replace(/^[•-]\s*/, "") ?? ""}</p></div>
          : <p className={css.sideNote}>No update yet. A short one each week keeps the client and the team in step.</p>}
        {up.canPost ? <UpdateButton projectId={projectId} draft={up.draft} system={up.system} late={!up.history[0] || dd(up.history[0].on, today) >= 8} /> : null}
      </section> : null}
    </aside>
  </section>;
}
