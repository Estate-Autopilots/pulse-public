"use client";
// CALENDAR-HUB (owner, 13 Nov 2026, P2.1 T2.1.3: "for people like me who have different identities in different
// companies, a calendar view of which day is consumed by what"): My companies. Concept 1 on a computer (a totals card
// with one stacked bar and a toggle per company, then the week coloured by company with each day's split under its
// name); concept 3 on a phone (the totals card with its days, then the list). Each company is read inside itself as the
// person (GET /api/v0/calendar/companies), their own time only: meetings, tasks with a time, their events and their time
// at work. Overlaps inside one company count once (lib/calendar.mjs busyMinutes).
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Calendar, type CalEvent, type CalInput } from "../kit/calendar";
import { EmptyState, SkeletonRows } from "../kit/game";
import { useIsPhone } from "../kit/drawer";
import { companyHours, dayWords, hoursWords, weekOf } from "../lib/calendar.mjs";
import css from "./hub.module.css";

type Company = { org: string; name: string; handle: string | null; current: boolean; accent: string | null; now: string; tz: string; items: CalInput[] };
type Answer = { from: string | null; to: string | null; companies: Company[]; unavailable: string[] };
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function Companies({ today, onAdd }: { today: string | null; onAdd: (start?: string, end?: string, allDay?: boolean) => void }) {
  const phone = useIsPhone();
  const [range, setRange] = useState<{ from: string; to: string } | null>(() => { const w = weekOf(today ?? ""); return w.length ? { from: w[0], to: w[6] } : null; });
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState<string[]>([]);
  const [again, setAgain] = useState(0);
  const from = range?.from, to = range?.to;
  useEffect(() => {
    if (!from || !to) return;
    let live = true;
    fetch(`/api/v0/calendar/companies?from=${from}&to=${to}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((next: Answer | null) => {
      if (!live) return;
      if (next && Array.isArray(next.companies)) { setData(next); setError(null); } else setError("Your companies did not load. Try again in a moment.");
    });
    return () => { live = false; };
  }, [from, to, again]);

  const companies = data?.companies ?? [];
  const days: string[] = [];
  if (from && to) for (let d = from; d <= to && days.length < 42; ) { days.push(d); const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); d = x.toISOString().slice(0, 10); }
  const hours = companyHours(companies, days);
  const shown = hours.rows.filter((r) => !off.includes(r.org));
  const total = shown.reduce((a, r) => a + r.minutes, 0);
  const colorBy = new Map(hours.rows.map((r) => [r.org, r.color]));
  const busiest = Math.max(0, ...days.map((d) => shown.reduce((a, r) => a + (r.byDay[d] ?? 0), 0)));
  // Every company's items on one calendar: the company's name under each title, its colour on each block. An item from
  // another company opens there, so its link is left out here (the peek names the company).
  const byId = new Map<string, string>();
  const events: CalInput[] = [];
  for (const c of companies) {
    if (off.includes(c.org)) continue;
    for (const it of c.items) {
      const id = `${c.org.slice(0, 8)}-${String(it.id ?? "")}`;
      events.push({ ...it, id, meta: c.name, ...(c.current ? {} : { href: undefined }), editable: false });
      byId.set(`${it.source ?? "pulse"}:${it.kind ?? "event"}:${id}`, colorBy.get(c.org) ?? "#64748B");
    }
  }
  const colorOf = (e: CalEvent) => byId.get(e.id);
  const dayBar = (day: string) => {
    const parts = shown.map((r) => ({ r, m: r.byDay[day] ?? 0 })).filter((x) => x.m > 0);
    const sum = parts.reduce((a, x) => a + x.m, 0);
    return <span className={css.dayBar} aria-label={sum ? `${hoursWords(sum)} on ${dayWords(day)}` : `Free on ${dayWords(day)}`}>
      <b>{sum ? hoursWords(sum) : "Free"}</b>
      <span className={css.miniBar} aria-hidden="true">{parts.map((x) => <i key={x.r.org} style={{ flexGrow: x.m, background: x.r.color }} />)}</span>
    </span>;
  };

  if (error && !data) return <EmptyState art="nothing" title="Your companies did not load" text={error} action={{ label: "Try again", onClick: () => { setError(null); setAgain((n) => n + 1); } }} />;
  if (!data) return <SkeletonRows rows={5} height={64} label="Loading your companies" />;
  if (companies.length < 2) return <EmptyState art="nothing" title="You work in one company here" text="When you also work in another company on Pulse, this shows which one takes each day and hour." action={{ label: "Open my calendar", href: "/calendar" }} />;
  const week = days.length === 7, now = (companies.find((c) => c.current) ?? companies[0]).now;
  const label = week && today && days.includes(today) ? "This week" : days.length === 1 ? dayWords(days[0]) : `${dayWords(days[0])} – ${dayWords(days[days.length - 1])}`;

  return <div className={css.stack}>
    <section className={css.totals} aria-label={`${label}: hours by company`}>
      <div className={css.totalHead}>
        <span className={css.totalLabel}>{label}</span>
        <b className={css.totalValue}>{hoursWords(total)}</b>
        <span className={css.totalSub}>{shown.length === hours.rows.length ? `across ${hours.rows.length} companies` : `${shown.length} of ${hours.rows.length} companies shown`}</span>
      </div>
      <div className={css.totalBody}>
        <div className={css.bigBar} role="img" aria-label={shown.map((r) => `${r.name} ${hoursWords(r.minutes)}`).join(", ") || "No time yet"}>
          {total ? shown.filter((r) => r.minutes > 0).map((r) => <i key={r.org} style={{ flexGrow: r.minutes, background: r.color }} />) : <i className={css.emptyBar} />}
        </div>
        <ul className={css.legend}>
          {hours.rows.map((r) => { const on = !off.includes(r.org); return <li key={r.org}>
            <button type="button" className={css.legendItem} aria-pressed={on} style={{ ["--c" as string]: r.color }}
              onClick={() => setOff(on ? [...off, r.org] : off.filter((x) => x !== r.org))} title={on ? `Hide ${r.name}` : `Show ${r.name}`}>
              <span className={css.swatch} aria-hidden="true">{on ? <Check size={14} strokeWidth={3} /> : null}</span><span className={css.legendName}>{r.name}</span><b className={css.legendHours}>{hoursWords(r.minutes)}</b>
            </button></li>; })}
        </ul>
        {week ? <ol className={css.days} aria-label="Each day">
          {days.map((d, i) => { const parts = shown.map((r) => ({ r, m: r.byDay[d] ?? 0 })).filter((x) => x.m > 0); const sum = parts.reduce((a, x) => a + x.m, 0);
            // The bar is as tall as the day's hours against the busiest day; on a phone the words break after the hours.
            const words = sum ? hoursWords(sum).split(" ") : ["–"];
            return <li key={d} className={css.day} data-today={d === today ? "" : undefined} aria-label={`${DOW[i]}: ${sum ? hoursWords(sum) : "free"}`}>
              <span className={css.dayName} aria-hidden="true">{DOW[i]}</span>
              <span className={css.dayStack} aria-hidden="true"><span className={css.dayFill} style={{ height: `${busiest && sum ? Math.max(8, Math.round((sum / busiest) * 100)) : 0}%` }}>
                {parts.map((x) => <i key={x.r.org} style={{ flexGrow: x.m, background: x.r.color }} />)}</span></span>
              <span className={css.dayHours} aria-hidden="true">{words.map((w) => <span key={w}>{w}</span>)}</span>
            </li>; })}
        </ol> : null}
      </div>
      {data.unavailable.length ? <p className={css.note}>Could not read {data.unavailable.join(", ")} just now.</p> : null}
    </section>
    <Calendar label="My companies" events={events} now={now} date={range?.from} view={phone ? "list" : "week"} views={phone ? ["list", "day"] : ["week", "day"]} kinds={[]}
      colorOf={colorOf} dayExtra={dayBar} onSlot={onAdd}
      empty="None of your companies has time booked on these days."
      onRange={(from, to) => { if (!range || from !== range.from || to !== range.to) setRange({ from, to }); }}
      foot="Only your own time: meetings, tasks with a time, your events and time at work. Hours that overlap in one company count once." />
  </div>;
}
