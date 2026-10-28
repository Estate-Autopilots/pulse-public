import Link from "next/link";
import { CalendarRange } from "lucide-react";
import { api } from "../../../../lib/api";
import { Badge, Empty, Message, Page, PageHeader, Panel, styles } from "../../../../ui";
import { ChangeDates, ProjectStatusButton, REASON_LABEL, STATUS_LABEL, type RunStatus } from "../../../../projects/run-client";
import css from "../../../../projects/overview.module.css";
import { ShareTimeline } from "../../../../projects/share-client";

/** KAZUK (Kazuk's screen 5): a project's timeline. Its tasks as bars over the weeks (Day 0 = kick-off), done / in
 *  progress / planned, the old dates of anything moved, today's line, and every date change with its reason. */
type T = { id: string; title: string; status: string; parentId: string | null; step?: string | null; phase?: string | null; waitsFor?: { id: string; step: string | null; title: string; due: string | null }[]; who: string | null; start: string | null; due: string | null; doneOn: string | null; was: { start: string | null; due: string | null } | null; waiting: number };
type Data = { project: { id: string; title: string; status: string; startsOn: string | null; dueOn: string | null; lead: string | null; canRun: boolean; today: string };
  tasks: T[]; changes: { id: string; title: string; fromStart: string | null; fromDue: string | null; toStart: string | null; toDue: string | null; reason: string; note: string | null; moved: number; who: string | null; at: string }[];
  history: { status: RunStatus; from: string | null; reason: string; startsOn: string | null; restartOn: string | null; shiftedDays: number | null; who: string | null; at: string }[];
  stages?: { n: number; key: string; label: string }[] | null };

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const DAY = 86400000;
const fmt = (d: string | null) => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }) : "—";

export default async function Timeline({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<Data>(`projects/${encodeURIComponent(id)}/timeline`);
  if (r.error) return <Message text={r.error} />; if (!r.data) return null;
  const { project: p, tasks, changes, history } = r.data;
  const share = p.canRun ? (await api<{ active: boolean }>(`projects/${encodeURIComponent(id)}/share`)).data : null; const stages = r.data.stages ?? null;
  const status: RunStatus = p.status === "cancelled" ? "discontinued" : p.status === "paused" ? (history[0]?.status === "on_hold" ? "on_hold" : "paused") : "active";
  // A task started after its due day (planned late) is drawn on its due day.
  const dated = tasks.filter((t) => t.start || t.due).map((t) => t.start && t.due && t.start > t.due ? { ...t, start: t.due } : t);
  const kick = p.startsOn ?? dated.map((t) => (t.start ?? t.due) as string).sort()[0] ?? p.today;
  const lastDay = [p.today, p.dueOn, ...dated.map((t) => t.due ?? t.start)].filter((x): x is string => !!x).sort().at(-1) ?? p.today;
  // Whole weeks from the kick-off's Monday, at most 16 on screen.
  const monday = ms(kick) - ((new Date(ms(kick)).getUTCDay() + 6) % 7) * DAY;
  const weeks = Math.min(16, Math.max(4, Math.ceil((ms(lastDay) - monday) / DAY / 7) + 1));
  const span = weeks * 7 * DAY;
  const pos = (d: string) => Math.max(0, Math.min(100, ((ms(d) - monday) / span) * 100));
  const bar = (a: string | null, b: string | null) => {
    const s = (a ?? b) as string, e = (b ?? a) as string; const lo = s < e ? s : e, hi = s < e ? e : s;
    return { left: `${pos(lo)}%`, width: `${Math.max(1.2, pos(hi) - pos(lo) + 100 / (weeks * 7))}%` };
  };
  const dayNo = Math.round((ms(p.today) - ms(kick)) / DAY);
  const state = (t: T) => ["done", "accepted", "in_review"].includes(t.status) ? "done" : t.status === "in_progress" ? "doing" : "planned";
  const late = (t: T) => state(t) !== "done" && !!t.due && t.due < p.today;
  const in7 = new Date(ms(p.today) + 7 * DAY).toISOString().slice(0, 10);
  const soon = dated.filter((t) => t.status === "open" && t.start && t.start >= p.today && t.start <= in7).sort((a, b) => a.start!.localeCompare(b.start!)).slice(0, 8);
  const missed = dated.filter((t) => t.status === "open" && t.start && t.start < p.today && (!t.due || t.due >= p.today)).slice(0, 4);
  return <Page fit>
    <PageHeader title="Timeline" back={{ href: `/tasks/projects/${p.id}`, label: p.title }}
      context={[`Day 0 = kick-off, ${fmt(kick)}`, dayNo >= 0 ? `today is Day ${dayNo}` : `starts in ${-dayNo} days`, p.lead ? `Lead: ${p.lead}` : null, status !== "active" ? STATUS_LABEL[status] : null]}
      actions={p.canRun ? <><ShareTimeline projectId={p.id} active={!!share?.active} /><ProjectStatusButton projectId={p.id} status={status} /></> : <Badge>{STATUS_LABEL[status]}</Badge>} />
    <div className={css.grid}>
      <div className={css.main}>
        <Panel title="Tasks over the weeks" sub={<span className={css.legend}><i data-s="done" />Done<i data-s="doing" />In progress<i data-s="planned" />Planned<i data-s="was" />Old dates<i data-s="today" />Today</span>} primary>
          {dated.length ? <div className={css.gantt} style={{ ["--weeks" as string]: weeks }}>
            <div className={css.ganttHead}><span>Task · owner</span><div className={css.weeks}>{Array.from({ length: weeks }, (_, i) => <span key={i}>W{i + 1}<small>{fmt(new Date(monday + i * 7 * DAY).toISOString().slice(0, 10))}</small></span>)}</div></div>
            {(stages ? stages.map((st) => ({ head: `${st.n} · ${st.label}`, rows: dated.filter((t) => t.phase === st.key) })).concat([{ head: "Other work", rows: dated.filter((t) => !t.phase || !stages.some((st) => st.key === t.phase)) }]).filter((g) => g.rows.length)
              : [{ head: null as string | null, rows: dated }]).flatMap((g) => [g.head ? <div key={`h-${g.head}`} className={css.ganttGroup}>{g.head}</div> : null, ...g.rows.map((t) => <div key={t.id} className={css.ganttRow} data-child={t.parentId ? "" : undefined}>
              <div className={css.ganttName}>
                <Link href={`/tasks/${t.id}`}>{t.title}</Link>
                <small>{t.who ?? "Nobody on it"} · {t.start && t.due && t.start !== t.due ? `${fmt(t.start)} – ` : ""}{fmt(t.due ?? t.start)}{late(t) ? <b> · late</b> : null}</small>
                {t.waitsFor?.length ? <small className={css.after}>after {t.waitsFor.map((w) => w.step ?? w.title.slice(0, 24)).join(", ")}</small> : null}
                {p.canRun && state(t) !== "done" ? <ChangeDates projectId={p.id} task={t} /> : null}
              </div>
              <div className={css.track}>
                {(t.waitsFor ?? []).filter((w) => w.due && (t.start ?? t.due)).map((w) => { const from = pos(w.due!), to = pos((t.start ?? t.due)!);
                  return to > from ? <i key={w.id} className={css.dep} style={{ left: `${from}%`, width: `${to - from}%` }} title={`Waits for ${w.step ?? ""} ${w.title}`} /> : <i key={w.id} className={css.depLate} style={{ left: `${to}%` }} title={`Starts before ${w.step ?? w.title} ends`} />; })}
                {t.was?.due ? <i className={css.was} style={bar(t.was.start, t.was.due)} /> : null}
                <i className={css.barFill} data-s={state(t)} data-late={late(t) ? "" : undefined} style={bar(t.start, t.due)} title={`${t.title}: ${fmt(t.start)} – ${fmt(t.due)}`} />
                <i className={css.today} style={{ left: `${pos(p.today)}%` }} />
              </div>
            </div>)])}
          </div> : <Empty icon={CalendarRange} first title="No dated tasks yet" text="Give the project's tasks a start or due day and they line up here week by week." action={{ href: `/tasks/projects/${p.id}`, label: "Open the tasks" }} />}
        </Panel>
      </div>
      <aside className={css.side}>
        {/* Kazuk's screen 6: what starts in the next 7 days (each owner is reminded the day before) and what should have started. */}
        {soon.length || missed.length ? <Panel title="Starting in the next 7 days" sub="Each owner is reminded the day before">
          <ul className={css.needs}>
            {soon.map((t) => <li key={t.id}><Link href={`/tasks/${t.id}`} className={css.needTitle}>{t.title}</Link><span className={css.needMeta}>{t.who ?? "Nobody on it"} · {fmt(t.start)}</span></li>)}
            {missed.map((t) => <li key={t.id} className={css.missed}><Link href={`/tasks/${t.id}`} className={css.needTitle}>Should have started: {t.title}</Link><span className={css.needMeta}>Planned {fmt(t.start)} · {t.who ?? "nobody on it"} has not started it</span></li>)}
          </ul>
        </Panel> : null}
        <Panel title="Date changes on this project" sub={changes.length ? String(changes.length) : undefined}>
          {changes.length ? <ul className={css.needs}>{changes.map((c) => <li key={c.id}>
            <span className={css.needTitle}>{c.title} moved to {c.toStart && c.toStart !== c.toDue ? `${fmt(c.toStart)}–` : ""}{fmt(c.toDue)}{c.moved ? `; ${c.moved} waiting ${c.moved === 1 ? "task" : "tasks"} moved too` : ""}</span>
            <span className={css.needMeta}>{REASON_LABEL[c.reason] ?? c.reason}{c.note ? ` · ${c.note}` : ""} · was {fmt(c.fromDue)} · {c.who ?? "someone"}, {fmt(c.at.slice(0, 10))}</span>
          </li>)}</ul> : <p className={css.empty}>No dates changed yet. Every change asks for a reason and shows here.</p>}
        </Panel>
        {history.length ? <Panel title="Status history">
          <ul className={css.needs}>{history.map((h, i) => <li key={i}>
            <span className={css.needTitle}>{STATUS_LABEL[h.status]}{h.restartOn ? ` · restart ${fmt(h.restartOn)}` : ""}{h.shiftedDays ? ` · tasks moved ${h.shiftedDays} days` : ""}</span>
            <span className={css.needMeta}>{h.reason} · {h.who ?? "someone"}, {fmt(h.at.slice(0, 10))}</span>
          </li>)}</ul>
        </Panel> : null}
        <p className={styles.muted}>Paused and held projects drop out of late counts on Projects but stay visible.</p>
      </aside>
    </div>
  </Page>;
}
