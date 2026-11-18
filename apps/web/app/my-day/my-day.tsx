"use client";
// TASKUX (owner, 2 Nov 2026): My day. One list across every organisation of the account: what to do first, what is
// overdue, what is at a set time, the running clock, time planned against time spent per company and workstream, and
// the day's and the week's targets. Each item carries its company (its logo, else its initials tile, and its name). Done / Start / Pause act inside
// the item's own organisation; opening an item of another organisation moves there first (the account switch).
import { DayRing, WeeklyRecap, celebrate } from "../kit/game";
import { streakOf } from "../lib/game.mjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { AlertTriangle, CalendarClock, Check, ChevronRight, Clock, Flag, Flame, Hourglass, ListChecks, Loader2, Pause, Play, Repeat, Sparkles, Target, Timer } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { undoHere } from "../kit/undo-here";
import { buildDay, minutesText, type Company, type DayData, type DayItem, type Stream } from "../lib/my-day.mjs";
import { arrive, openInTab, post } from "../orgs/client";
import { shortDay } from "../tasks/parts";
import { CompanyMark } from "../company-mark";
import { companiesText, isPractice, isRealCompany } from "../lib/companies.mjs";
import css from "./my-day.module.css";

const STAGE: Record<string, string> = { waiting: "Waiting for response", revision: "Revision required", on_hold: "On hold" };
const FILTER_KEY = "pulse.myday.only";
// COMPANY-MARKS: the stripes and meters wear the company's set brand colour; without one, the page's neutral (CSS).
const orgStyle = (x: { color?: string | null }) => (x.color && /^#[0-9a-f]{6}$/i.test(x.color) ? { "--org-color": x.color } : {}) as CSSProperties;
const message = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const daysLate = (due: string, today: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000);

type Streaks = { today: string; checkins: string[]; done: { day: string; n: number }[] };
/** Monday of the week of an ISO day. */
const monday = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
/** This week so far: tasks finished, days checked in, and the best day. */
function week(s: Streaks) {
  const from = monday(s.today);
  const done = s.done.filter((d) => d.day >= from), best = done.reduce((m, d) => Math.max(m, d.n), 0);
  return [{ label: "Tasks done", value: done.reduce((n, d) => n + d.n, 0) }, { label: "Days checked in", value: s.checkins.filter((d) => d >= from).length },
    { label: "Best day", value: best ? `${best} done` : "–" }];
}

/** The two streaks in one plain line: a flame when there is one, quiet words when there is none. */
function StreakLine({ work, checkin }: { work: number; checkin: number }) {
  const say = (n: number, what: string) => n ? `${n} ${n === 1 ? "day" : "days"} in a row ${what}` : null;
  const parts = [say(work, "finishing work"), say(checkin, "checking in")].filter(Boolean);
  return parts.length ? <span className={css.streakLine}><Flame size={15} aria-hidden="true" />{parts.join(" · ")}</span>
    : <span className={css.streakLine} data-cold="">Finish one task today to start a streak</span>;
}

/** Tasks done each day this week, Monday to Sunday, as small bars (today's in the accent). */
function WeekBars({ s }: { s: Streaks }) {
  const from = monday(s.today);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
  const n = days.map((d) => s.done.find((x) => x.day === d)?.n ?? 0), top = Math.max(1, ...n);
  return <figure className={css.weekBars} aria-labelledby="week-bars-title"><figcaption id="week-bars-title" className={css.weekTitle}>Tasks done each day</figcaption><div className={css.weekRow} aria-label={`Tasks done this week: ${days.map((d, i) => `${WEEKDAY[i]} ${n[i]}`).join(", ")}`}>
    {days.map((d, i) => <span key={d} data-today={d === s.today ? "" : undefined} data-future={d > s.today ? "" : undefined}>
      <b>{n[i] || ""}</b><i style={{ height: `${Math.max(4, Math.round((n[i] / top) * 48))}px` }} /><small>{WEEKDAY[i]}</small></span>)}
  </div></figure>;
}
const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** When an item is due, in a few words. */
function when(i: DayItem, today: string) {
  if (i.section === "done") return "Done";
  if (i.section === "scheduled") return i.dueTime ?? "Today";
  if (i.dueOn && i.dueOn < today) { const d = daysLate(i.dueOn, today); return d === 1 ? "Due yesterday" : `${d} days late`; }
  if (i.dueOn === today) return "Due today";
  if (i.dueOn) return `Due ${shortDay(i.dueOn)}`;
  if (i.startsOn && i.startsOn <= today) return "Started";
  if (i.startsOn) return `Starts ${shortDay(i.startsOn)}`;
  return null;
}

/** Into the item's organisation (when it is another one), then its page. */
async function openIn(item: { id: string; org: string; orgName: string; current: boolean }, go: (href: string) => void) {
  if (item.current) { go(`/tasks/${item.id}`); return; }
  window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: { name: item.orgName } }));
  try { const moved = await openInTab(item.org); arrive(moved, `/tasks/${item.id}`); }
  catch (e) { window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: null })); notify({ id: "myday-open", tone: "error", title: "Could not open it", message: message(e) }); }
}

function OrgTag({ name, mark, color }: { name: string; mark?: string | null; color?: string | null }) {
  return <span className={css.org} style={orgStyle({ color })}><CompanyMark name={name} mark={mark} color={color} size={16} /><span className={css.orgName}>{name}</span></span>;
}

function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return <span className={css.meter} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)}><i style={{ width: `${pct}%` }} data-full={value >= max ? "" : undefined} /></span>;
}

export function MyDay({ initial, name }: { initial: DayData; name: string | null }) {
  const [data, setData] = useState(initial);
  const [now, setNow] = useState(() => Date.parse(initial.generatedAt) || 0);
  const [only, setOnly] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const router = useRouter();
  const go = useCallback((href: string) => router.push(href), [router]);

  // The clock on screen moves; the remembered filter comes back (this browser only).
  useEffect(() => {
    const first = window.setTimeout(() => {
      setNow(Date.now());
      try { const saved = JSON.parse(window.localStorage.getItem(FILTER_KEY) ?? "[]"); if (Array.isArray(saved)) setOnly(saved.filter((x) => typeof x === "string" && initial.seats.some((s) => s.org === x))); } catch { /* private window */ }
    }, 0);
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { window.clearTimeout(first); window.clearInterval(t); };
  }, [initial.seats]);
  const choose = (next: string[]) => { setOnly(next); try { window.localStorage.setItem(FILTER_KEY, JSON.stringify(next)); } catch { /* private window */ } };

  const reload = useCallback(async () => {
    const r = await fetch("/api/v0/tasks/my-day", { cache: "no-store" });
    if (r.ok) { setData(await r.json()); setNow(Date.now()); setGone(new Set()); }
  }, []);
  // Coming back to the tab reads the day again (another device may have moved things on).
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void reload(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  const day = useMemo(() => buildDay(data, now || Date.parse(data.generatedAt), only), [data, now, only]);
  // UX-GAMIFY (owner, 9 Nov 2026): the day's ring, the check-in and tasks-done streaks, and the week in a few numbers.
  const [streaks, setStreaks] = useState<Streaks | null>(null);
  useEffect(() => { let live = true; fetch("/api/v0/tasks/my-day/streaks", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((x) => { if (live && x) setStreaks(x); }).catch(() => undefined); return () => { live = false; }; }, [data]);
  const today = data.seats.find((s) => s.ok && s.today)?.today ?? new Date(now || Date.parse(data.generatedAt)).toISOString().slice(0, 10);
  const many = data.seats.length > 1;
  // CONNECTIONS (2199): the companies you are in, not your own space and not test or demo companies.
  const realCount = data.seats.filter((x) => x.kind === "staff" && isRealCompany(x)).length;
  const practice = new Set(data.seats.filter((x) => isPractice(x)).map((x) => x.org));

  async function act(item: { id: string; org: string; title: string; status?: string }, action: "done" | "start" | "pause", origin?: Element | null) {
    setBusy(`${item.id}:${action}`);
    try {
      await post("tasks/my-day/act", { org: item.org, task: item.id, action });
      if (action === "done") {
        setGone((g) => new Set(g).add(item.id));
        // DOREVE-2 (AC card 7): one click; the row shows done where it is (nothing slides under the pointer) and Undo sits
        // on it for a few seconds (it puts the task back as it was); the lists catch up after that.
        const was = item.status === "in_progress" || item.status === "blocked" ? item.status : "open";
        let undone = false;
        undoHere(origin, { title: `Done: ${item.title.length > 44 ? `${item.title.slice(0, 43)}…` : item.title}`, undo: () => { undone = true; return post("tasks/my-day/act", { org: item.org, task: item.id, action: "reopen", to: was })
          .then(() => { setGone((g) => { const n = new Set(g); n.delete(item.id); return n; }); return reload(); })
          .catch((e) => notify({ id: "myday-act", tone: "error", title: "Not undone", message: message(e) })); } });
        setTimeout(() => { if (!undone) void reload(); }, 7000);
        const left = day.totals.overdue + day.totals.today + day.totals.doing;
        celebrate(origin ?? null, { big: left <= 1, id: left <= 1 ? `myday-all-done:${today}` : undefined });
      } else await reload();
    } catch (e) { notify({ id: "myday-act", tone: "error", title: action === "done" ? "Not marked done" : "The clock did not change", message: message(e) }); }
    finally { setBusy(null); }
  }

  // Built from parts: Node and browsers punctuate the same Intl format differently, which breaks hydration.
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: data.seats.find((s) => s.timeZone)?.timeZone ?? "Asia/Kolkata" }).formatToParts(new Date(now || Date.parse(data.generatedAt)));
  const part = (k: string) => parts.find((x) => x.type === k)?.value ?? "";
  const dateText = `${part("weekday")} ${part("day")} ${part("month")}`;
  const first = (name ?? "").split(" ")[0];
  // DOREVE-2: a task ticked a moment ago counts as done at once (the data catches up after the Undo window).
  const ticked = new Map<string, DayItem>();
  for (const i of [...day.focus, ...day.sections.flatMap((x) => x.items)]) if (gone.has(i.id) && i.section !== "done") ticked.set(i.id, i);
  const t = { ...day.totals, done: day.totals.done + ticked.size };
  for (const i of ticked.values()) if (i.section === "overdue" || i.section === "today" || i.section === "doing") t[i.section] = Math.max(0, t[i.section] - 1);
  const shown = (i: DayItem): DayItem => gone.has(i.id) ? { ...i, section: "done", running: false } : i;
  // VISUAL-QA (owner, 10 Nov 2026: "Start with repeats the same tasks as the Overdue list just below it"): each task
  // shows once. Start with holds the first few as full rows (tick, clock), and the lists below leave them out.
  const keyOf = (i: { org: string; id: string }) => `${i.org}:${i.id}`;
  const focus = day.focus;
  const inFocus = new Set(focus.map(keyOf));

  return <div className={css.wrap}>
    <header className={css.head}>
      <div className={css.headText}>
        <p className={css.eyebrow}>{dateText}{many && realCount ? ` · ${companiesText(realCount)}` : ""}</p>
        <h1 className={css.title}>{first ? `${first}’s day` : "My day"}</h1>
      </div>
      {/* VISUAL-QA: an empty day has no 0 / 0 / 0 / 0 strip (the empty-day message says it in words). */}
      {t.overdue + t.today + t.doing + t.planned + t.actual ? <dl className={css.stats} aria-label="Today at a glance">
        <div data-tone={t.overdue ? "bad" : undefined}><dt>Overdue</dt><dd>{t.overdue}</dd></div>
        <div><dt>Today</dt><dd>{t.today + t.doing}</dd></div>
        <div><dt>Planned</dt><dd>{minutesText(t.planned)}</dd></div>
        <div data-tone={t.planned && t.actual >= t.planned ? "good" : undefined}><dt>Spent</dt><dd>{minutesText(t.actual)}</dd></div>
      </dl> : null}
    </header>

    <div className={css.progress} aria-label="Your progress">
      {t.done + t.today + t.doing + t.overdue ? <DayRing done={t.done} total={t.done + t.today + t.doing + t.overdue} what="done" size={48} sub={<span />} />
        : <span className={css.planNext}><b>Nothing planned for today</b><Link href="/tasks?view=board" className={css.planBtn}>Plan my day</Link></span>}
      {streaks ? <StreakLine work={streakOf(streaks.done.map((d) => d.day), streaks.today).days} checkin={streakOf(streaks.checkins, streaks.today, { weekends: false }).days} /> : null}
    </div>

    {many ? <nav className={css.filters} aria-label="Show companies">
      <button type="button" className={css.chip} aria-pressed={!only.length} onClick={() => choose([])}>All</button>
      {day.companies.filter((c) => !practice.has(c.org) || (c.overdue ?? 0) + (c.today ?? 0) + (c.doing ?? 0) > 0).map((c) => <button key={c.org} type="button" className={css.chip} aria-pressed={only.includes(c.org)} style={orgStyle(c)} title={c.name}
        aria-label={`${c.name}${c.ok && (c.overdue || c.today) ? `, ${(c.overdue ?? 0) + (c.today ?? 0)} for today` : ""}`}
        onClick={() => choose(only.includes(c.org) ? only.filter((x) => x !== c.org) : [...only, c.org])}>
        <CompanyMark name={c.name} mark={c.mark} color={c.color} size={18} /><span className={css.chipName}>{c.name}</span>{c.ok && (c.overdue || c.today) ? <span className={css.chipCount} aria-label={`${(c.overdue ?? 0) + (c.today ?? 0)} for today`}>{(c.overdue ?? 0) + (c.today ?? 0)}</span> : null}
      </button>)}
    </nav> : null}

    <div className={css.grid}>
      {day.timer ? <section className={css.timer} style={orgStyle(day.timer)} aria-label="Running clock">
        <Timer size={18} aria-hidden="true" className={css.timerIcon} />
        <div className={css.timerText}>
          <button type="button" className={css.linkish} onClick={() => void openIn({ id: day.timer!.taskId, org: day.timer!.org, orgName: day.timer!.orgName, current: day.timer!.current }, go)}>{day.timer.title}</button>
          <span className={css.meta}><OrgTag name={day.timer.orgName} mark={day.timer.mark} color={day.timer.color} /><span className={css.clock}>{minutesText(day.timer.minutes)} on the clock</span></span>
        </div>
        <button type="button" className={css.roundBtn} aria-label={`Pause “${day.timer.title}”`} disabled={!!busy}
          onClick={() => void act({ id: day.timer!.taskId, org: day.timer!.org, title: day.timer!.title }, "pause")}>{busy === `${day.timer.taskId}:pause` ? <Loader2 size={18} className={css.spin} /> : <Pause size={18} />}</button>
      </section> : null}

      {/* A region, not a second <main>: the shell already gives the page its one <main id="main-content">. */}
      <section className={css.main} aria-label="Your work today">
        {focus.length ? <section className={`${css.section} ${css.focusBox}`} aria-label="Start with" data-section="focus">
          <h2 className={css.sectionHead}><Sparkles size={15} aria-hidden="true" />Start with<small>{focus.length}</small></h2>
          <ol className={css.list}>{focus.map((i) => <Row key={keyOf(i)} item={shown(i)} today={today} many={many} busy={busy} onAct={act} go={go} />)}</ol>
        </section> : null}
        {day.sections.length ? day.sections.map((s) => {
          const items = s.items.filter((i) => !inFocus.has(keyOf(i)));
          if (!items.length) return null;
          const body = <ul className={css.list}>{items.map((i) => <Row key={`${i.org}:${i.id}`} item={shown(i)} today={today} many={many} busy={busy} onAct={act} go={go} />)}</ul>;
          return s.key === "done"
            ? <details key={s.key} className={css.section}><summary className={css.sectionHead}><Check size={15} aria-hidden="true" />{s.label}<small>{items.length + [...ticked.values()].filter((i) => !items.some((x) => x.id === i.id)).length}</small><ChevronRight size={14} className={css.chev} aria-hidden="true" /></summary>{body}</details>
            : <section key={s.key} className={css.section} aria-label={s.label} data-section={s.key}>
              <h2 className={css.sectionHead}>{s.key === "overdue" ? <AlertTriangle size={15} aria-hidden="true" /> : s.key === "scheduled" ? <CalendarClock size={15} aria-hidden="true" /> : s.key === "waiting" ? <Hourglass size={15} aria-hidden="true" /> : s.key === "priority" ? <Flag size={15} aria-hidden="true" /> : <ListChecks size={15} aria-hidden="true" />}{s.label}<small>{items.length}</small></h2>
              {body}
            </section>;
        }) : <div className={css.empty}><Check size={22} aria-hidden="true" /><b>Nothing due today</b><span>No overdue work and nothing planned for today{only.length ? " in the companies chosen" : ""}.</span><Link href="/tasks" className={css.btn}>Plan the week in Work</Link></div>}
      </section>

      <aside className={css.side} aria-label="Companies, time and targets">
        {streaks && week(streaks).some((x) => typeof x.value === "number" && x.value > 0) ? <section data-area="week" aria-label="Your week" className={css.week}><WeeklyRecap title="Your week" items={week(streaks)} /><WeekBars s={streaks} /></section> : null}
        {many ? <section className={css.card} data-area="companies" aria-label="Companies">
          <h2 className={css.sectionHead}><AlertTriangle size={15} aria-hidden="true" />Which company needs you</h2>
          <ul className={css.companies}>{day.companies.map((c) => <CompanyRow key={c.org} c={c} onOnly={() => choose([c.org])} />)}</ul>
        </section> : null}
        <section className={css.card} data-area="time" aria-label="Time today">
          <h2 className={css.sectionHead}><Clock size={15} aria-hidden="true" />Time today{day.streams.length ? <small>planned · spent</small> : null}</h2>
          {day.streams.length ? <ul className={css.streams}>{day.streams.map((s) => <StreamRow key={s.key} s={s} many={many} />)}</ul>
            : <p className={css.quiet}>No estimates or time yet today. Give tasks an estimate to plan the day; the clock records time as you work.</p>}
        </section>
        {/* TASK-CLEAN (owner, 17 Nov 2026): no hours to set; the week in every company, counted the same way. */}
        {many ? null : <section className={css.card} data-area="targets" aria-label="This week">
          <h2 className={css.sectionHead}><Target size={15} aria-hidden="true" />This week</h2>
          <ul className={css.targets}>{day.companies.filter((c) => c.ok).map((c) => <WeekRow key={c.org} c={c} />)}</ul>
        </section>}
      </aside>
    </div>
    {data.more ? <p className={css.quiet}>{data.more} more {data.more === 1 ? "company is" : "companies are"} not shown here: open them from the organisation switcher.</p> : null}
  </div>;
}

function Row({ item: i, today, many, busy, onAct, go }: { item: DayItem; today: string; many: boolean; busy: string | null; onAct: (i: DayItem, a: "done" | "start" | "pause", origin?: Element | null) => void; go: (href: string) => void }) {
  const finished = i.section === "done";
  const w = when(i, today);
  return <li className={css.item} style={orgStyle(i)} data-section={i.section} data-running={i.running ? "" : undefined}>
    <button type="button" className={css.check} aria-label={finished ? `“${i.title}” is done` : `Mark “${i.title}” done`} disabled={finished || !!busy}
      aria-pressed={finished} onClick={(e) => onAct(i, "done", e.currentTarget)}>{busy === `${i.id}:done` ? <Loader2 size={18} className={css.spin} /> : <span className={css.ring}>{finished ? <Check size={14} /> : null}</span>}</button>
    <div className={css.body}>
      <button type="button" className={css.itemTitle} onClick={() => void openIn(i, go)} title={i.current ? "Open" : `Open in ${i.orgName}`}>{i.title}</button>
      <div className={css.meta}>
        {many ? <OrgTag name={i.orgName} mark={i.mark} color={i.color} /> : null}
        {i.priority === "urgent" || i.priority === "high" ? <span className={css.prio} data-p={i.priority}><Flag size={12} aria-hidden="true" />{i.priority === "urgent" ? "Urgent" : "High"}</span> : null}
        {w ? <span data-late={i.section === "overdue" ? "" : undefined}>{w}</span> : null}
        {i.stage ? <span className={css.stage} data-stage={i.stage}>{STAGE[i.stage]}</span> : null}
        {i.estimateMinutes ? <span><Clock size={12} aria-hidden="true" />{i.minutesToday ? `${minutesText(i.minutesToday)} of ` : ""}{minutesText(i.estimateMinutes)}</span> : i.minutesToday ? <span><Clock size={12} aria-hidden="true" />{minutesText(i.minutesToday)}</span> : null}
        {i.workstream || i.projectName ? <span className={css.project}>{i.workstream ?? i.projectName}</span> : null}
        {i.repeats ? <span aria-label={`Repeats every ${i.repeats}`} title={`Repeats every ${i.repeats}`}><Repeat size={12} aria-hidden="true" /></span> : null}
      </div>
    </div>
    {!finished ? <button type="button" className={css.roundBtn} data-on={i.running ? "" : undefined} disabled={!!busy}
      aria-label={i.running ? `Pause “${i.title}”` : `Start the clock on “${i.title}”`} onClick={() => onAct(i, i.running ? "pause" : "start")}>
      {busy === `${i.id}:start` || busy === `${i.id}:pause` ? <Loader2 size={18} className={css.spin} /> : i.running ? <Pause size={18} /> : <Play size={18} />}
    </button> : <span />}
  </li>;
}

function CompanyRow({ c, onOnly }: { c: Company; onOnly: () => void }) {
  if (!c.ok) return <li className={css.company} style={orgStyle(c)}><i className={css.bar} aria-hidden="true" /><div><b><CompanyMark name={c.name} mark={c.mark} color={c.color} size={20} />{c.name}</b><small>Could not be read just now</small></div></li>;
  const bits: ReactNode[] = [];
  if (c.overdue) bits.push(<span key="o" data-late="">{c.overdue} overdue</span>);
  if (c.today) bits.push(<span key="t">{c.today} today</span>);
  if (c.doing) bits.push(<span key="d">{c.doing} doing</span>);
  if (c.waiting) bits.push(<span key="w">{c.waiting} waiting</span>);
  if (!bits.length) bits.push(<span key="n">Nothing due today</span>);
  // TASK-CLEAN (owner, 17 Nov 2026: "targets in hours: what does that mean?"): the week in work done, on the same line,
  // the same way for every company; a tick once it is all done.
  const wk = weekOf(c), met = wk.total > 0 && wk.done >= wk.total;
  bits.push(<span key="wk" className={css.companyWeek} data-met={met ? "" : undefined}>{met ? <Check size={12} aria-hidden="true" /> : null}{weekWords(c)}</span>);

  return <li className={css.company} style={orgStyle(c)}>
    <i className={css.bar} aria-hidden="true" />
    <button type="button" className={css.companyBtn} onClick={onOnly} aria-label={`Show only ${c.name}`}>
      <b><CompanyMark name={c.name} mark={c.mark} color={c.color} size={20} />{c.name}{c.current ? <small className={css.here}>open now</small> : null}</b>
      <span className={css.companyMeta}>{bits}</span>
      {/* The week's bar once something is done (an empty bar read as a divider); no hours bar (time stays in "Time today"). */}
      {wk.done > 0 ? <span className={css.companyTime}><Meter value={wk.done} max={Math.max(wk.total, 1)} label={`${c.name}: ${wk.done} of ${wk.total} done this week`} /></span> : null}
    </button>
  </li>;
}

function StreamRow({ s, many }: { s: Stream; many: boolean }) {
  const max = Math.max(s.planned, s.actual, 1);
  return <li className={css.stream} style={orgStyle(s)}>
    {/* TASK-CLEAN (judge): work with no project is named by its company, not "No project" twice. */}
    <div className={css.streamHead}><span className={css.streamName}><CompanyMark name={s.orgName} mark={s.mark} color={s.color} size={16} />{s.stream === "No project" ? (many ? s.orgName : "Other work") : s.stream}{many && s.stream !== "No project" ? <small>{s.orgName}</small> : null}</span>
      <span className={css.streamNums}>{minutesText(s.planned)} · <b data-over={s.planned && s.actual > s.planned ? "" : undefined}>{minutesText(s.actual)}</b></span></div>
    <span className={css.twin} aria-hidden="true"><i data-kind="planned" style={{ width: `${(s.planned / max) * 100}%` }} /><i data-kind="actual" style={{ width: `${(s.actual / max) * 100}%` }} /></span>
  </li>;
}

/** TASK-CLEAN: the week in one company, in the owner's words: "This week: 2 of 5 done" (a role's own weekly goal, where
 *  the company set one, is the "of": "This week: 3 of 5 calls done"), "This week: all 5 done", or "Nothing due this
 *  week". The "This week:" label keeps it a share of the week, not more tasks beside "1 today" (judge round 10). Without
 *  the label under the one-company card's own "This week" heading. */
function weekOf(c: Company) {
  const w = c.weekPlan ?? { done: 0, left: 0, late: 0, goal: null };
  return { done: w.done, total: w.goal ? Math.max(w.goal.target, w.done) : w.done + w.left };
}
function weekWords(c: Company, label = true) {
  const w = c.weekPlan ?? { done: 0, left: 0, late: 0, goal: null };
  const pre = label ? "This week: " : "";
  if (w.goal) return `${pre}${w.done} of ${w.goal.target} ${w.goal.unit ? `${w.goal.unit} ` : ""}done`;
  const total = w.done + w.left;
  if (!total) return label ? "Nothing due this week" : "Nothing due";
  if (w.done >= total) return `${label ? "This week: all" : "All"} ${total} done`;
  return `${pre}${w.done} of ${total} done`;
}

/** TASK-CLEAN: the week card when the person works in one company (with several, each company's row says it). */
function WeekRow({ c }: { c: Company }) {
  const w = c.weekPlan ?? { done: 0, left: 0, late: 0, goal: null };
  const total = w.goal ? Math.max(w.goal.target, w.done) : w.done + w.left;
  const all = total > 0 && w.done >= total;
  return <li className={css.targetCard} style={orgStyle(c)}>
    <div className={css.targetLine} data-met={all ? "" : undefined}>
      <span className={css.targetLabel}>{all ? <Check size={13} aria-label="All done" /> : null}{weekWords(c, false)}</span>
      {w.done > 0 ? <Meter value={w.done} max={total} label={`${c.name}: ${w.done} of ${total} done this week`} /> : null}
    </div>
  </li>;
}
