"use client";
// CALENDAR-HUB (owner, 13 Nov 2026, P2.1): "Add to calendar" (concept 3's sheet): what, when, a note. It opens filled from
// the slot that was clicked or dragged across, so most of the time only "what" is typed. One button: "Add to calendar".
// The event is the person's own, in this company; it goes to their Google Calendar at the next sync when connected.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CalendarPlus } from "lucide-react";
import { Drawer, DrawerFooter, useIsPhone } from "../kit/drawer";
import { DateField } from "../kit/date-field";
import { Switch } from "../kit/switch";
import { celebrate, gameCss, toast } from "../kit/game";
import { dayWords } from "../lib/calendar.mjs";
import { styles } from "../ui";
import css from "./hub.module.css";

export type Draft = { title: string; day: string; last: string; allDay: boolean; from: string; to: string; note?: string };
const TIME = /^\d{2}:\d{2}$/;

export function AddSheet({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const what = useRef<HTMLInputElement>(null);
  const ids = useId();
  // A phone's sheet keeps its button in the footer; a computer's side panel puts it right under the form (no gap).
  const phone = useIsPhone();
  const submit = <button type="submit" form={`${ids}-form`} className={gameCss.primary} disabled={busy}>{busy ? "Adding…" : "Add to calendar"}</button>;
  useEffect(() => { what.current?.focus(); }, []);
  const set = (x: Partial<Draft>) => { setError(null); setD((o) => ({ ...o, ...x })); };
  const problem = !d.title.trim() ? "Say what it is." : !d.day ? "Pick a day." : d.allDay ? (d.last && d.last < d.day ? "The last day is before the first day." : null)
    : !TIME.test(d.from) || !TIME.test(d.to) ? "Pick a start and an end time." : d.to <= d.from ? "The end is before the start." : null;
  async function save(ev?: FormEvent) {
    ev?.preventDefault();
    if (problem) { setError(problem); return; }
    setBusy(true);
    const body = d.allDay ? { title: d.title, allDay: true, start: d.day, end: d.last || d.day, note: d.note ?? "" }
      : { title: d.title, allDay: false, start: `${d.day}T${d.from}`, end: `${d.day}T${d.to}`, note: d.note ?? "" };
    const r = await fetch("/api/v0/calendar/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (r?.ok) { celebrate(document.activeElement); toast(`Added: ${d.title.trim()} on ${dayWords(d.day)}`); onSaved(); return; }
    const why = r ? ((await r.json().catch(() => ({}))) as { error?: string }) : {};
    setError(why.error ?? "That was not saved. Try again.");
  }
  // The fields say the day and time (no second line repeating them under the title).
  return <Drawer title="Add to calendar" icon={<CalendarPlus size={18} aria-hidden="true" />} onClose={onClose} size="sm" noAutofocus
    footer={phone ? <DrawerFooter status={error ?? undefined} primary={submit} /> : undefined}>
    <form id={`${ids}-form`} className={css.form} onSubmit={(e) => void save(e)}>
      <label className={styles.field}>What
        <input ref={what} value={d.title} maxLength={200} placeholder="Meet Lotus Interiors" onChange={(e) => set({ title: e.target.value })} autoComplete="off" />
      </label>
      {/* A day on its own line, then From and To side by side (all day: first and last day side by side). */}
      {d.allDay ? <div className={css.row}>
        <label className={styles.field}>First day
          <DateField value={d.day} onChange={(e) => set({ day: e.target.value, last: d.last < e.target.value ? e.target.value : d.last })} aria-label="First day" />
        </label>
        <label className={styles.field}>Last day
          <DateField value={d.last} min={d.day} onChange={(e) => set({ last: e.target.value })} aria-label="Last day" />
        </label>
      </div> : <label className={styles.field}>Day
          <DateField value={d.day} onChange={(e) => set({ day: e.target.value, last: d.last < e.target.value ? e.target.value : d.last })} aria-label="Day" />
        </label>}
      {/* "All day" right under the day it is about; From and To follow when it is off. */}
      <Switch inline label="All day" checked={d.allDay} onChange={(on) => set({ allDay: on, last: d.day })} />
      {d.allDay ? null : <div className={css.row}>
          <label className={styles.field}>From<input type="time" value={d.from} step={900} onChange={(e) => set({ from: e.target.value })} /></label>
          <label className={styles.field}>To<input type="time" value={d.to} step={900} onChange={(e) => set({ to: e.target.value })} /></label>
        </div>}
      <label className={styles.field}>Note (if you like)
        <textarea value={d.note ?? ""} maxLength={1000} rows={3} placeholder="Where, who, what to bring" onChange={(e) => set({ note: e.target.value })} />
      </label>
      {phone ? null : <div className={css.formEnd}>{error ? <p className={css.formError} role="alert">{error}</p> : null}{submit}</div>}
    </form>
  </Drawer>;
}
