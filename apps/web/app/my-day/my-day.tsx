"use client";
// TASKUX (owner, 2 Nov 2026): My day. One list across every organisation of the account: what to do first, what is
// overdue, what is at a set time, the running clock, time planned against time spent per company and workstream, and
// the day's and the week's targets. Each item carries its company (its logo, else its initials tile, and its name). Done / Start / Pause act inside
// the item's own organisation; opening an item of another organisation moves there first (the account switch).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, CalendarClock, Check, ChevronRight, Clock, Flag, Hourglass, ListChecks, Loader2, Pause, Play, Repeat, Sparkles, Target, Timer } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { buildDay, minutesText, type Company, type DayData, type DayItem, type Stream } from "../lib/my-day.mjs";
import { arrive, post, type Moved } from "../orgs/client";
import { shortDay } from "../tasks/parts";
import { CompanyMark } from "../company-mark";
import css from "./my-day.module.css";

const STAGE: Record<string, string> = { waiting: "Waiting for response", revision: "Revision required", on_hold: "On hold" };
const FILTER_KEY = "pulse.myday.only";
// COMPANY-MARKS: the stripes and meters wear the company's set brand colour; without one, the page's neutral (CSS).
const orgStyle = (x: { color?: string | null }) => (x.color && /^#[0-9a-f]{6}$/i.test(x.color) ? { "--org-color": x.color } : {}) as CSSProperties;
const message = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const daysLate = (due: string, today: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000);

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
  try { const moved = await post<Moved>("account/switch", { org: item.org }); arrive(moved, `/tasks/${item.id}`); }
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
  const today = data.seats.find((s) => s.ok && s.today)?.today ?? new Date(now || Date.parse(data.generatedAt)).toISOString().slice(0, 10);
  const many = data.seats.length > 1;

  async function act(item: { id: string; org: string; title: string }, action: "done" | "start" | "pause") {
    setBusy(`${item.id}:${action}`);
    try {
      await post("tasks/my-day/act", { org: item.org, task: item.id, action });
      if (action === "done") { setGone((g) => new Set(g).add(item.id)); notify({ id: "myday-done", tone: "success", title: "Done", message: item.title, timeout: 2500 }); }
      await reload();
    } catch (e) { notify({ id: "myday-act", tone: "error", title: action === "done" ? "Not marked done" : "The clock did not change", message: message(e) }); }
    finally { setBusy(null); }
  }

  // Built from parts: Node and browsers punctuate the same Intl format differently, which breaks hydration.
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: data.seats.find((s) => s.timeZone)?.timeZone ?? "Asia/Kolkata" }).formatToParts(new Date(now || Date.parse(data.generatedAt)));
  const part = (k: string) => parts.find((x) => x.type === k)?.value ?? "";
  const dateText = `${part("weekday")} ${part("day")} ${part("month")}`;
  const first = (name ?? "").split(" ")[0];
  const t = day.totals;

  return <div className={css.wrap}>
    <header className={css.head}>
      <div className={css.headText}>
        <p className={css.eyebrow}>{dateText}{many ? ` · ${data.seats.length} companies` : ""}</p>
        <h1 className={css.title}>{first ? `${first}’s day` : "My day"}</h1>
      </div>
      <dl className={css.stats} aria-label="Today at a glance">
        <div data-tone={t.overdue ? "bad" : undefined}><dt>Overdue</dt><dd>{t.overdue}</dd></div>
        <div><dt>Today</dt><dd>{t.today + t.doing}</dd></div>
        <div><dt>Planned</dt><dd>{minutesText(t.planned)}</dd></div>
        <div data-tone={t.planned && t.actual >= t.planned ? "good" : undefined}><dt>Spent</dt><dd>{minutesText(t.actual)}</dd></div>
      </dl>
    </header>

    {many ? <nav className={css.filters} aria-label="Show companies">
      <button type="button" className={css.chip} aria-pressed={!only.length} onClick={() => choose([])}>All</button>
      {day.companies.map((c) => <button key={c.org} type="button" className={css.chip} aria-pressed={only.includes(c.org)} style={orgStyle(c)}
        onClick={() => choose(only.includes(c.org) ? only.filter((x) => x !== c.org) : [...only, c.org])}>
        <CompanyMark name={c.name} mark={c.mark} color={c.color} size={18} />{c.name}{c.ok && (c.overdue || c.today) ? <span className={css.chipCount} aria-label={`${(c.overdue ?? 0) + (c.today ?? 0)} for today`}>{(c.overdue ?? 0) + (c.today ?? 0)}</span> : null}
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
        {day.focus.length ? <section className={css.focus} aria-label="Start with">
          <h2 className={css.sectionHead}><Sparkles size={15} aria-hidden="true" />Start with</h2>
          <ol className={css.focusList}>{day.focus.map((i, n) => <li key={`${i.org}:${i.id}`} style={orgStyle(i)}>
            <span className={css.focusNo} aria-hidden="true">{n + 1}</span>
            <button type="button" className={css.focusOpen} onClick={() => void openIn(i, go)}><b>{i.title}</b><small><CompanyMark name={i.orgName} mark={i.mark} color={i.color} size={16} />{i.orgName}{when(i, today) ? ` · ${when(i, today)}` : ""}{i.estimateMinutes ? ` · ${minutesText(i.estimateMinutes)}` : ""}</small></button>
          </li>)}</ol>
        </section> : null}
        {day.sections.length ? day.sections.map((s) => {
          const items = s.items.filter((i) => !gone.has(i.id) || s.key === "done");
          if (!items.length) return null;
          const body = <ul className={css.list}>{items.map((i) => <Row key={`${i.org}:${i.id}`} item={i} today={today} many={many} busy={busy} onAct={act} go={go} />)}</ul>;
          return s.key === "done"
            ? <details key={s.key} className={css.section}><summary className={css.sectionHead}><Check size={15} aria-hidden="true" />{s.label}<small>{items.length}</small><ChevronRight size={14} className={css.chev} aria-hidden="true" /></summary>{body}</details>
            : <section key={s.key} className={css.section} aria-label={s.label} data-section={s.key}>
              <h2 className={css.sectionHead}>{s.key === "overdue" ? <AlertTriangle size={15} aria-hidden="true" /> : s.key === "scheduled" ? <CalendarClock size={15} aria-hidden="true" /> : s.key === "waiting" ? <Hourglass size={15} aria-hidden="true" /> : s.key === "priority" ? <Flag size={15} aria-hidden="true" /> : <ListChecks size={15} aria-hidden="true" />}{s.label}<small>{items.length}</small></h2>
              {body}
            </section>;
        }) : <div className={css.empty}><Check size={22} aria-hidden="true" /><b>Nothing due today</b><span>No overdue work and nothing planned for today{only.length ? " in the companies chosen" : ""}. <Link href="/tasks">Open Work</Link> to plan the week.</span></div>}
      </section>

      <aside className={css.side} aria-label="Companies, time and targets">
        {many ? <section className={css.card} data-area="companies" aria-label="Companies">
          <h2 className={css.sectionHead}><AlertTriangle size={15} aria-hidden="true" />Which company needs you</h2>
          <ul className={css.companies}>{day.companies.map((c) => <CompanyRow key={c.org} c={c} onOnly={() => choose([c.org])} />)}</ul>
        </section> : null}
        <section className={css.card} data-area="time" aria-label="Time today">
          <h2 className={css.sectionHead}><Clock size={15} aria-hidden="true" />Time today<small>planned · spent</small></h2>
          {day.streams.length ? <ul className={css.streams}>{day.streams.map((s) => <StreamRow key={s.key} s={s} many={many} />)}</ul>
            : <p className={css.quiet}>No estimates or time yet today. Give tasks an estimate to plan the day; the clock records time as you work.</p>}
        </section>
        <section className={css.card} data-area="targets" aria-label="Targets">
          <h2 className={css.sectionHead}><Target size={15} aria-hidden="true" />Targets</h2>
          <ul className={css.targets}>{day.companies.filter((c) => c.ok).map((c) => <TargetRow key={c.org} c={c} many={many} onSaved={reload} />)}</ul>
        </section>
      </aside>
    </div>
    {data.more ? <p className={css.quiet}>{data.more} more {data.more === 1 ? "company is" : "companies are"} not shown here: open them from the organisation switcher.</p> : null}
  </div>;
}

function Row({ item: i, today, many, busy, onAct, go }: { item: DayItem; today: string; many: boolean; busy: string | null; onAct: (i: DayItem, a: "done" | "start" | "pause") => void; go: (href: string) => void }) {
  const finished = i.section === "done";
  const w = when(i, today);
  return <li className={css.item} style={orgStyle(i)} data-section={i.section} data-running={i.running ? "" : undefined}>
    <button type="button" className={css.check} aria-label={finished ? `“${i.title}” is done` : `Mark “${i.title}” done`} disabled={finished || !!busy}
      aria-pressed={finished} onClick={() => onAct(i, "done")}>{busy === `${i.id}:done` ? <Loader2 size={18} className={css.spin} /> : <span className={css.ring}>{finished ? <Check size={14} /> : null}</span>}</button>
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
  return <li className={css.company} style={orgStyle(c)}>
    <i className={css.bar} aria-hidden="true" />
    <button type="button" className={css.companyBtn} onClick={onOnly} aria-label={`Show only ${c.name}`}>
      <b><CompanyMark name={c.name} mark={c.mark} color={c.color} size={20} />{c.name}{c.current ? <small className={css.here}>open now</small> : null}</b>
      <span className={css.companyMeta}>{bits}</span>
      {c.planned || c.actual ? <span className={css.companyTime}><Meter value={c.actual ?? 0} max={Math.max(c.planned ?? 0, 1)} label={`${c.name}: time spent against planned`} />{minutesText(c.actual ?? 0)} of {minutesText(c.planned ?? 0)}</span> : null}
    </button>
  </li>;
}

function StreamRow({ s, many }: { s: Stream; many: boolean }) {
  const max = Math.max(s.planned, s.actual, 1);
  return <li className={css.stream} style={orgStyle(s)}>
    <div className={css.streamHead}><span className={css.streamName}><CompanyMark name={s.orgName} mark={s.mark} color={s.color} size={16} />{s.stream}{many ? <small>{s.orgName}</small> : null}</span>
      <span className={css.streamNums}>{minutesText(s.planned)} · <b data-over={s.planned && s.actual > s.planned ? "" : undefined}>{minutesText(s.actual)}</b></span></div>
    <span className={css.twin} aria-hidden="true"><i data-kind="planned" style={{ width: `${(s.planned / max) * 100}%` }} /><i data-kind="actual" style={{ width: `${(s.actual / max) * 100}%` }} /></span>
  </li>;
}

function TargetLine({ label, t, unit }: { label: string; t: { target: number; actual: number; met: boolean } | null; unit?: "time" | string | null }) {
  if (!t) return null;
  const fmt = (n: number) => unit === "time" ? minutesText(n) : String(n);
  return <div className={css.targetLine} data-met={t.met ? "" : undefined}>
    <span className={css.targetLabel}>{t.met ? <Check size={13} aria-label="Met" /> : null}{label}</span>
    <Meter value={t.actual} max={t.target} label={`${label}: ${fmt(t.actual)} of ${fmt(t.target)}`} />
    <span className={css.targetNums}>{fmt(t.actual)} / {fmt(t.target)}{unit && unit !== "time" ? ` ${unit}` : ""}</span>
  </div>;
}

function TargetRow({ c, many, onSaved }: { c: Company; many: boolean; onSaved: () => Promise<void> }) {
  const [edit, setEdit] = useState(false); const [saving, setSaving] = useState(false);
  const tg = c.targets;
  const none = !tg?.day && !tg?.week && !tg?.tasks;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget); const h = (k: string) => { const v = Number(f.get(k)); return v > 0 ? Math.round(v * 60) : null; };
    setSaving(true);
    try { await post("tasks/targets", { dailyMinutes: h("day"), weeklyMinutes: h("week") }); setEdit(false); await onSaved(); notify({ id: "myday-targets", tone: "success", title: "Targets saved", timeout: 2000 }); }
    catch (err) { notify({ id: "myday-targets", tone: "error", title: "Targets not saved", message: message(err) }); }
    finally { setSaving(false); }
  }
  return <li className={css.targetCard} style={orgStyle(c)}>
    {many ? <OrgTag name={c.name} mark={c.mark} color={c.color} /> : null}
    {none && !edit ? <p className={css.quiet}>No targets yet.</p> : null}
    {!edit ? <>
      <TargetLine label="Today" t={tg?.day ?? null} unit="time" />
      <TargetLine label="This week" t={tg?.week ?? null} unit="time" />
      <TargetLine label="Finished this week" t={tg?.tasks ?? null} unit={tg?.tasks?.unit ?? "tasks"} />
    </> : null}
    {c.current ? edit ? <form className={css.targetForm} onSubmit={save}>
      <label>Hours a day<input name="day" type="number" min={0.25} max={24} step={0.25} inputMode="decimal" defaultValue={tg?.day ? tg.day.target / 60 : ""} /></label>
      <label>Hours a week<input name="week" type="number" min={0.5} max={168} step={0.5} inputMode="decimal" defaultValue={tg?.week ? tg.week.target / 60 : ""} /></label>
      <div className={css.formActions}><button type="submit" className={css.btnPrimary} disabled={saving}>{saving ? "Saving…" : "Save"}</button><button type="button" className={css.btn} onClick={() => setEdit(false)}>Cancel</button></div>
    </form> : <button type="button" className={css.btn} onClick={() => setEdit(true)}>{tg?.own ? "Change targets" : "Set my targets"}</button>
      : !tg?.own ? <p className={css.quiet}>Set them while {c.name} is open.</p> : null}
  </li>;
}
