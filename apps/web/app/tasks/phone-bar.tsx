"use client";
// QA-1024 (R084): on a phone, Work opens with one compact row (search, and one Filters chip) instead of three rows of
// controls (whose tasks, the view, and the Open/Today/This week filters) before the first task. The chip shows those
// rows (they stay the same controls, so nothing is lost) and hides them again; wider screens never see this bar.
import { useRef, useState } from "react";
import { ChevronDown, Search, SlidersHorizontal } from "lucide-react";
import css from "./tasks.module.css";

export function PhoneWorkBar({ label }: { label: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const toggle = () => { const next = !open; root.current?.closest("[data-work-controls]")?.toggleAttribute("data-filters-open", next); setOpen(next); };
  return <div ref={root} className={css.phoneBar}>
    <form className={css.phoneSearch} action="/tasks" role="search"><input type="hidden" name="view" value="all" /><Search size={15} aria-hidden="true" /><input type="search" name="q" placeholder="Search tasks" aria-label="Search tasks" enterKeyHint="search" /></form>
    <button type="button" className={css.phoneFilter} aria-expanded={open} onClick={toggle}><SlidersHorizontal size={15} aria-hidden="true" /><span>{open ? "Hide filters" : `Filters · ${label}`}</span><ChevronDown size={14} aria-hidden="true" /></button>
  </div>;
}
