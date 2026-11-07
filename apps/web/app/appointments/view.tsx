"use client";
// SELF-SERVE (owner, 4 Nov 2026): the team's appointments with its clients. What is next (stat tiles), the upcoming ones
// as striped cards with Cancel, booking one in the quiet right rail; each shows in the client's own space.
import { CalendarClock, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { BookForm, type Appointment } from "./book";
import css from "./appointments.module.css";

export type ApptData = { upcoming: Appointment[]; past: Appointment[]; clients: { id: string; name: string }[] };
const slot = (s: string) => new Date(s).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function AppointmentsView({ initial, clientWord }: { initial: ApptData; clientWord: { one: string; many: string } }) {
  const [data, setData] = useState(initial);
  const [note, setNote] = useState<string | null>(null);
  const reload = async () => { const r = await fetch("/api/v0/appointments", { cache: "no-store" }); if (r.ok) setData(await r.json()); };
  const cancel = async (a: Appointment) => {
    if (!window.confirm(`Cancel ${a.client}'s appointment on ${slot(a.startsAt)}?`)) return;
    const r = await fetch(`/api/v0/appointments/${a.id}/cancel`, { method: "POST" });
    if (r.ok) { setNote(`Cancelled. It is gone from ${a.client}'s space.`); await reload(); } else setNote("That did not cancel. Try again.");
  };
  const now = new Date();
  const today = data.upcoming.filter((a) => sameDay(new Date(a.startsAt), now)).length;
  const week = data.upcoming.filter((a) => new Date(a.startsAt).getTime() - now.getTime() < 7 * 86400000).length;
  return <div className={css.wrap}>
    <dl className={css.stats} aria-label="Appointments at a glance">
      <div><dt>Today</dt><dd>{today}</dd></div><div><dt>Next 7 days</dt><dd>{week}</dd></div><div><dt>{clientWord.many}</dt><dd>{data.clients.length}</dd></div>
    </dl>
    {note ? <p className={css.ok} role="status">{note}</p> : null}
    <div className={css.grid}>
      <section className={css.section} aria-labelledby="upcoming-h">
        <h2 id="upcoming-h" className={css.sectionHead}><CalendarClock size={16} aria-hidden="true" />Coming up<small>{data.upcoming.length}</small></h2>
        {data.upcoming.length ? <ul className={css.list}>{data.upcoming.map((a) => <li key={a.id} className={css.item} data-status={a.status}>
          <span className={css.itemMain}><b>{a.client}</b><small suppressHydrationWarning>{slot(a.startsAt)} · {a.minutes} min{a.place ? ` · ${a.place}` : ""}</small>{a.note ? <small>{a.note}</small> : null}</span>
          <button type="button" className={css.quiet} onClick={() => void cancel(a)} aria-label={`Cancel ${a.client}'s appointment`}><X size={14} aria-hidden="true" />Cancel</button>
        </li>)}</ul> : <p className={css.empty}>Nothing booked yet. Book the first one{data.clients.length ? "" : ` after you add a ${clientWord.one.toLowerCase()}`}: it shows in their space with the time and the place.</p>}
        {data.past.length ? <details><summary className={css.sectionHead} style={{ cursor: "pointer" }}>Earlier and cancelled<small>{data.past.length}</small></summary>
          <ul className={css.list} style={{ marginTop: 8 }}>{data.past.map((a) => <li key={a.id} className={css.item} data-status={a.status}>
            <span className={css.itemMain}><b>{a.client}</b><small suppressHydrationWarning>{slot(a.startsAt)}{a.status === "cancelled" ? " · cancelled" : ""}</small></span><span />
          </li>)}</ul></details> : null}
      </section>
      <aside className={css.side}>
        <section className={css.section} aria-labelledby="book-h">
          <h2 id="book-h" className={css.sectionHead}>Book an appointment</h2>
          {data.clients.length ? <BookForm clients={data.clients} onBooked={async (a) => { setNote(`Booked: ${a.client}, ${slot(a.startsAt)}. It is in their space now.`); await reload(); }} />
            : <><p className={css.empty}>Add a {clientWord.one.toLowerCase()} first; they get a link to their own space.</p>
              <Link className={css.primary} href="/clients/add"><UserPlus size={16} aria-hidden="true" />Add a {clientWord.one.toLowerCase()}</Link></>}
        </section>
        {data.clients.length ? <Link className={css.quiet} href="/clients/add"><UserPlus size={16} aria-hidden="true" />Add a {clientWord.one.toLowerCase()}</Link> : null}
      </aside>
    </div>
  </div>;
}
