"use client";
// SELF-SERVE (owner, 4 Nov 2026): booking a client's appointment (db/migrations/1520: pulse.appointment_save). The day,
// the time, how long, where (an address or a video link) and a note; it shows in the client's space at once.
import { useState, type FormEvent } from "react";
import { SelectField } from "../kit/select-field";
import s from "../signup/setup.module.css";
import css from "./appointments.module.css";
import { DateField } from "../kit/date-field";

export type Appointment = { id: string; clientId: string; client: string; startsAt: string; minutes: number; place: string | null; note: string | null; status: string; by: string | null };

const pad = (n: number) => String(n).padStart(2, "0");
const tomorrow = () => { const d = new Date(Date.now() + 86400000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export function BookForm({ clientId, clients, onBooked, compact }: { clientId?: string; clients?: { id: string; name: string }[]; onBooked: (a: Appointment) => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false); const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget, f = new FormData(form);
    const day = String(f.get("day") ?? ""), time = String(f.get("time") ?? "");
    const at = new Date(`${day}T${time || "10:00"}`);
    if (!day || Number.isNaN(at.getTime())) { setProblem("Choose the day and the time."); return; }
    setBusy(true); setProblem(null);
    try {
      const r = await fetch("/api/v0/appointments", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: clientId ?? f.get("clientId"), startsAt: at.toISOString(), minutes: Number(f.get("minutes") ?? 50), place: f.get("place"), note: f.get("note") }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof d?.error === "string" ? d.error : "That did not save. Try again.");
      onBooked(d as Appointment); form.reset();
    } catch (err) { setProblem((err as Error).message); } finally { setBusy(false); }
  };
  return <form className={css.book} onSubmit={submit} aria-label="Book an appointment" data-compact={compact ? "" : undefined}>
    {clientId ? null : <label className={s.field}>Client<SelectField name="clientId" required defaultValue="">
      <option value="" disabled>Choose a client</option>{(clients ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField></label>}
    <div className={css.when}>
      <label className={s.field}>Day<DateField name="day" required defaultValue={tomorrow()}/></label>
      <label className={s.field}>Time<input name="time" type="time" required defaultValue="10:00" step={300} /></label>
      <label className={s.field}>Minutes<input name="minutes" type="number" min={5} max={600} step={5} defaultValue={50} inputMode="numeric" /></label>
    </div>
    <label className={s.field}>Where <small>an address, or a video link</small><input name="place" maxLength={300} placeholder="https://meet.google.com/… or the clinic’s address" /></label>
    <label className={s.field}>Note for them <small>optional</small><input name="note" maxLength={1000} placeholder="Bring last month’s reports" /></label>
    {problem ? <p className={css.problem} role="alert">{problem}</p> : null}
    <button type="submit" className={css.primary} disabled={busy}>{busy ? "Booking…" : "Book the appointment"}</button>
  </form>;
}
