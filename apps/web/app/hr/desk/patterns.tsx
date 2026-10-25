// HR desk → Policies → Patterns & shifts: named shifts and who is on them, per-person standing working patterns, and the
// Sunday/holiday work people asked for. It replaces the separate "Work calendar" tab and the "Person & organisation
// shifts" button; the full assignment history stays on /shifts.
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { RecordForm } from "../../records";
import { styles } from "../../ui";
import { longDay } from "../../lib/format";
import { PatternSetup } from "../flow-actions";
import type { FlowSettings, WorkCalendar } from "../flow-types";
import flowCss from "../flows.module.css";
import css from "../desk.module.css";

type Row = Record<string, unknown>;
export type Shifts = { shifts: Row[]; assignments: Row[]; people: Row[] };
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STATUS: Record<string, string> = { pending: "Waiting for a decision", approved: "Approved", rejected: "Declined", cancelled: "Withdrawn" };

export function PatternsShifts({ setup, calendar, shifts, today }: { setup: FlowSettings | null; calendar: WorkCalendar | null; shifts: Shifts | null; today: string }) {
  const current = (shifts?.assignments ?? []).filter((a) => !a.valid_to || s(a.valid_to).slice(0, 10) >= today);
  const shiftFields = [{ key: "name", label: "Name", required: true }, { key: "start", label: "Starts (HH:MM)", required: true }, { key: "end", label: "Ends (HH:MM)", required: true }, { key: "grace", label: "Grace minutes", required: true }];
  return <div className={flowCss.stack} data-grow=""><div className={css.patterns}>
    <div className={css.patternCol}>
      <section className={flowCss.card} aria-labelledby="shifts-title">
        <div className={flowCss.title}><h3 id="shifts-title">Shifts</h3>
          {shifts ? <span className={styles.inline}>
            <RecordForm path="shifts" title="Create or edit named shift" label="New shift" fields={shiftFields} values={{ grace: "15" }} />
            <RecordForm path="shifts" title="Assign shift" label="Assign shift" fields={[{ key: "personId", label: "Person", required: true, type: "select", options: shifts.people.map((p) => ({ value: s(p.id), label: s(p.name) })) }, { key: "shiftId", label: "Shift", required: true, type: "select", options: shifts.shifts.map((p) => ({ value: s(p.id), label: s(p.name) })) }, { key: "mode", label: "Mode", required: true, type: "select", options: ["office", "wfh", "field"].map((value) => ({ value, label: value })) }, { key: "from", label: "Effective from", required: true, type: "date" }]} note="A person can have an office shift and a different WFH shift. New assignments end earlier assignments of the same mode." />
          </span> : null}
        </div>
        <p className={flowCss.meta}>The organisation&apos;s hours are in Working rules. A named shift assigned to someone replaces them for that person and mode; late marks use the shift&apos;s own grace.</p>
        {shifts ? (shifts.shifts.length ? <ul className={css.shiftList}>{shifts.shifts.map((p) => { const on = current.filter((a) => a.shift_id === p.id); return <li key={s(p.id)}>
          <span><b>{s(p.name)}</b><small>{s(p.start)}–{s(p.end)} · {s(p.grace)} min grace · {on.length ? `${on.length} ${on.length === 1 ? "person" : "people"}` : "nobody assigned"}</small></span>
          <RecordForm path="shifts" title="Edit shift" label="Edit" fields={shiftFields} values={{ name: s(p.name), start: s(p.start), end: s(p.end), grace: s(p.grace) }} extra={{ id: s(p.id) }} />
        </li>; })}</ul> : <p className={flowCss.meta}>No named shifts yet: everyone works the organisation&apos;s hours.</p>) : <p className={flowCss.meta}>Shifts are not available right now.</p>}
        <Link href="/shifts" className={css.more}>Every assignment and its dates<ChevronRight size={13} aria-hidden="true" /></Link>
      </section>
      {setup ? <PatternSetup data={setup} today={today} /> : null}
    </div>
    <div className={css.patternCol}>
      <section className={flowCss.card} aria-labelledby="patterns-title"><h3 id="patterns-title">Standing working patterns</h3>
        <p className={flowCss.meta}>People whose regular week differs from the organisation&apos;s working days. Their own calendar and attendance use it.</p>
        {(setup?.patterns ?? calendar?.patterns ?? []).length ? <ul className={css.shiftList}>{(setup?.patterns ?? calendar?.patterns ?? []).map((p, i) => <li key={i}><span><b>{p.name}</b><small>{p.workDays.map((d) => WEEK[d - 1]).join(", ")} · {longDay(p.fromDate)} to {p.toDate ? longDay(p.toDate) : "ongoing"}{p.reason ? ` · ${p.reason}` : ""}</small></span></li>)}</ul> : <p className={flowCss.meta}>Nobody has a standing pattern: everyone works the organisation&apos;s days.</p>}
      </section>
      <section className={flowCss.card} aria-labelledby="dayoff-title"><h3 id="dayoff-title">Sunday and holiday work</h3>
        <p className={flowCss.meta}>Days off people asked to work. Approved days with a check-in earn comp-off; decide them in Approvals.</p>
        {calendar?.work.length ? <ul className={css.shiftList}>{calendar.work.map((w) => <li key={w.id}><span><b>{w.name}</b><small>{longDay(w.day)} · {STATUS[w.status] ?? w.status}</small></span></li>)}</ul> : <p className={flowCss.meta}>No requests to work on a day off.</p>}
        <Link href="/hr?tab=approvals" className={css.more}>Approvals<ChevronRight size={13} aria-hidden="true" /></Link>
      </section>
    </div>
  </div></div>;
}
