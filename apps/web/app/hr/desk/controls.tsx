"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { shiftDay } from "../../lib/format";
import { styles } from "../../ui";
import { DatePicker } from "../../kit";
import css from "../desk.module.css";

/** Look at the roster of an earlier day. The day lives in the URL as ?date=. */
export function DayPicker({ date, today }: { date: string; today: string }) {
  const router = useRouter();
  const go = (d: string) => { if (/^\d{4}-\d{2}-\d{2}$/.test(d)) router.push(d >= today ? "/hr" : `/hr?date=${d}`, { scroll: false }); };
  return (
    <span className={css.pick}>
      <button type="button" className={css.pickStep} aria-label="The day before" onClick={() => go(shiftDay(date, -1))}><ChevronLeft size={15} aria-hidden="true" /></button>
      {/* UX-5A: the kit's day picker, not the browser's date box. */}
      <DatePicker label="Day shown" value={{ date, time: null }} max={today} today={today} quick={false} size="sm" variant="chip" onChange={(v) => { if (v.date) go(v.date); }} />
      <button type="button" className={css.pickStep} aria-label="The day after" disabled={date >= today} onClick={() => go(shiftDay(date, 1))}><ChevronRight size={15} aria-hidden="true" /></button>
      {date !== today ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => go(today)}>Today</button> : null}
    </span>
  );
}
