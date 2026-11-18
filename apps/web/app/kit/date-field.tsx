"use client";
// UI-POLISH (R017): the date field for forms. It replaces the browser's <input type="date">, which followed the
// browser's language (an en-US phone showed 10/24/2026) and looked different in every browser. It shows the day as
// India writes it ("24 Oct 2026"), opens the kit's calendar under it (a sheet on a phone), and still takes typing on a
// computer ("24 oct", "24/10/2026"). A form gets the day as YYYY-MM-DD under `name`, exactly as the native field sent it,
// and `onChange` hands back `{ target: { value } }`, so a page swaps the tag and nothing else.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { CalendarDays } from "lucide-react";
import { Popover } from "./popover";
import { Calendar, type QuickDate } from "./date-picker";
import { formatDay, parseDay } from "../lib/day-text.mjs";
import { zoneDay } from "../lib/zone.mjs";
import { useOrgZone } from "../org-code";
import css from "./kit.module.css";

export type DateFieldChange = { target: { value: string; name: string }; currentTarget: { value: string; name: string } };
const coarse = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
const never = () => () => {};

export function DateField({ id, name, value, defaultValue, onChange, required, min, max, disabled, className, placeholder = "dd mmm yyyy", quick = false, today, autoFocus, ...aria }: {
  id?: string; name?: string; value?: string | null; defaultValue?: string | null; onChange?: (e: DateFieldChange) => void; required?: boolean; min?: string; max?: string; disabled?: boolean;
  className?: string; placeholder?: string; /** Quick choices beside the calendar (Today, Tomorrow…); none by default. */ quick?: QuickDate[] | false; today?: string; autoFocus?: boolean;
  "aria-label"?: string; "aria-describedby"?: string; title?: string }) {
  const zone = useOrgZone();
  const controlled = value !== undefined;
  const [own, setOwn] = useState(defaultValue ?? "");
  const iso = (controlled ? value : own) ?? "";
  const [text, setText] = useState(() => formatDay(iso));
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null), input = useRef<HTMLInputElement>(null);
  const layer = useId();
  const touch = useSyncExternalStore(never, coarse, () => false);
  const day = today ?? zoneDay(zone);
  // A new day from outside (a reset, another field) shows at once, unless someone is typing in this one.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors the day into the typed text
  useEffect(() => { if (!editing) setText(formatDay(iso)); }, [iso, editing]);
  const inRange = (d: string) => (!min || d >= min) && (!max || d <= max);
  const tell = (next: string) => { const t = { value: next, name: name ?? "" }; onChange?.({ target: t, currentTarget: t }); };
  const commit = (next: string) => {
    if (!controlled) setOwn(next);
    setText(formatDay(next));
    if (next !== iso) tell(next);
  };
  const settle = () => {
    setEditing(false);
    const parsed = parseDay(text, day);
    if (parsed === "") commit("");
    else if (parsed && inRange(parsed)) commit(parsed);
    else setText(formatDay(iso));
  };
  const show = () => { if (!disabled) setOpen(true); };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); requestAnimationFrame(() => document.getElementById(layer)?.querySelector<HTMLElement>('[role="grid"] button[tabindex="0"]')?.focus()); }
    else if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === "Enter") { settle(); setOpen(false); }
  };
  const typed = (v: string) => {
    // Typing is its own way in: the calendar steps aside (on a phone its sheet would cover the rest of the form).
    setEditing(true); setText(v); setOpen(false);
    const parsed = parseDay(v, day);
    // Only a whole day (with its year or a month's name) counts while typing; "2/1" waits for the field to be left.
    if (parsed && inRange(parsed) && /\d{4}|[a-z]{3}/i.test(v)) { if (!controlled) setOwn(parsed); if (parsed !== iso) tell(parsed); }
    else if (parsed === "" && iso) { if (!controlled) setOwn(""); tell(""); }
  };
  return <span ref={wrap} className={css.dateField} data-disabled={disabled ? "" : undefined}>
    <input ref={input} id={id} type="text" className={`${css.dateInput}${className ? ` ${className}` : ""}`} data-date-field="" value={text} placeholder={placeholder}
      required={required} disabled={disabled} autoFocus={autoFocus} autoComplete="off" spellCheck={false} inputMode={touch ? "none" : undefined}
      aria-haspopup="dialog" data-open={open ? "" : undefined} {...aria}
      onChange={(e) => typed(e.target.value)} onFocus={() => { if (touch) show(); }} onClick={show} onKeyDown={keys}
      onBlur={(e) => { const to = e.relatedTarget as Node | null; if (!to || !document.getElementById(layer)?.contains(to)) { settle(); if (!wrap.current?.contains(to)) setOpen(false); } }} />
    <button type="button" className={css.dateIcon} tabIndex={-1} aria-label="Open calendar" disabled={disabled} onClick={() => { setOpen((o) => !o); input.current?.focus({ preventScroll: true }); }}>
      <CalendarDays size={15} aria-hidden="true" />
    </button>
    {name ? <input type="hidden" name={name} value={iso} /> : null}
    <Popover id={layer} open={open} onClose={() => setOpen(false)} anchor={wrap} label={aria["aria-label"] ?? "Choose a date"} placement="bottom-start" focus="none" sheet>
      <Calendar key={iso || "none"} value={{ date: iso || null, time: null }} today={day} min={min} max={max} quick={quick} label={aria["aria-label"] ?? "Choose a date"}
        onChange={(v) => { setEditing(false); commit(v.date ?? ""); setOpen(false); if (!touch) input.current?.focus({ preventScroll: true }); }}
        onClear={!required && iso ? () => { setEditing(false); commit(""); setOpen(false); } : undefined} onDone={!required && iso ? () => setOpen(false) : undefined} />
    </Popover>
  </span>;
}
