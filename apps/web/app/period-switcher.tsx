"use client";

import { CalendarRange, ChevronDown } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Period } from "./lib/api";
import { range, shiftDay } from "./lib/format";
import styles from "./ui.module.css";

/** This week / Last week / a custom range. The choice lives in the URL so every link and refresh keeps it. */
export function PeriodSwitcher({ period }: { period: Period }) {
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const custom = period.kind !== "this" && period.kind !== "last";

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (event.target instanceof Node && !wrap.current?.contains(event.target)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointer); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const go = (next: { period?: string; from?: string; to?: string }) => {
    const q = new URLSearchParams(params.toString());
    for (const key of ["period", "week", "from", "to"]) q.delete(key);
    for (const [key, value] of Object.entries(next)) if (value) q.set(key, value);
    const text = q.toString();
    setOpen(false);
    router.push(text ? `${pathname}?${text}` : pathname);
  };
  const today = period.today; const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = shiftDay(monthStart, -1); const lastMonthStart = `${lastMonthEnd.slice(0, 8)}01`;
  const presets = [
    { label: "Last 7 days", from: shiftDay(today, -6), to: today },
    { label: "Last 30 days", from: shiftDay(today, -29), to: today },
    { label: "This month", from: monthStart, to: today },
    { label: "Last month", from: lastMonthStart, to: lastMonthEnd },
  ];
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget); const from = String(data.get("from")); const to = String(data.get("to"));
    if (from && to) go(from <= to ? { from, to } : { from: to, to: from });
  };

  return (
    <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Period">
      <button type="button" className={styles.segment} aria-pressed={period.kind === "this"} onClick={() => go({})}>This week</button>
      <button type="button" className={styles.segment} aria-pressed={period.kind === "last"} onClick={() => go({ period: "last" })}>Last week</button>
      <div className={styles.popoverWrap} ref={wrap}>
        <button type="button" className={styles.segment} aria-pressed={custom} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <CalendarRange size={13} aria-hidden="true" />{custom ? range(period.from, period.to) : "Custom"}<ChevronDown size={13} aria-hidden="true" />
        </button>
        {open ? (
          <div className={styles.popover} role="dialog" aria-label="Choose a date range">
            {presets.map((preset) => <button key={preset.label} type="button" className={styles.menuItem} onClick={() => go({ from: preset.from, to: preset.to })}><span>{preset.label}</span><small>{range(preset.from, preset.to)}</small></button>)}
            <div className={styles.menuRule} />
            <form className={styles.rangeForm} onSubmit={submit}>
              <label className={styles.field}>From<input type="date" name="from" defaultValue={period.from} max={today} required /></label>
              <label className={styles.field}>To<input type="date" name="to" defaultValue={period.to > today ? today : period.to} max={today} required /></label>
              <button className={`${styles.btn} ${styles.btnPrimary}`}>Apply range</button>
            </form>
          </div>
        ) : null}
      </div>
    </div>
  );
}
