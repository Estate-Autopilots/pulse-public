"use client";
// Owner workbench (21 Oct 2026): choosing people happens where you clicked. The list opens anchored to the control
// (search on top, arrows and Enter work), a click acts at once, and in "add" mode it stays open so several people can be
// added without a dialog, a second dropdown or a Save button.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Check, Search } from "lucide-react";
import { Avatar } from "../ui";
import { Popover } from "./popover";
import css from "./people-popover.module.css";

export type PopPerson = { id: string; name: string; role?: string | null; pod?: string | null; photoAt?: string | null; canAssign?: boolean };

export function PeoplePopover({ open, onClose, anchor, people, onPick, label, chosen = [], keepOpen = false, me }: {
  open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; people: PopPerson[]; onPick: (p: PopPerson) => void; label: string;
  /** Already chosen: shown with a tick, not chosen again. */ chosen?: string[]; /** "Add" lists stay open after a pick. */ keepOpen?: boolean; me?: string | null;
}) {
  const [q, setQ] = useState(""), [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null);
  // Each opening starts with an empty search and the first row active (set during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) { setWasOpen(open); if (open) { setQ(""); setActive(0); } }
  const shown = useMemo(() => {
    const w = q.trim().toLowerCase();
    const all = w ? people.filter((p) => `${p.name} ${p.role ?? ""} ${p.pod ?? ""}`.toLowerCase().includes(w)) : people;
    return [...all].sort((a, b) => Number(b.id === me) - Number(a.id === me));
  }, [people, q, me]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  const pick = (p: PopPerson | undefined) => { if (!p || chosen.includes(p.id)) return; onPick(p); if (!keepOpen) onClose(); };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(shown[active]); }
  };
  return <Popover open={open} onClose={onClose} anchor={anchor} label={label} focus={input} placement="bottom-start" sheet className={css.pop}>
    <label className={css.search}><Search size={15} aria-hidden="true" />
      <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={keys} placeholder="Search people" aria-label={label}
        role="combobox" aria-expanded="true" aria-controls="people-pop-list" aria-activedescendant={shown[active] ? `pp-${shown[active].id}` : undefined} /></label>
    <ul ref={list} id="people-pop-list" className={css.list} role="listbox" aria-label={label}>
      {shown.map((p, i) => { const done = chosen.includes(p.id);
        return <li key={p.id} id={`pp-${p.id}`} role="option" aria-selected={i === active} aria-disabled={done || undefined} data-i={i} data-active={i === active ? "" : undefined}
          className={css.row} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}>
          <Avatar name={p.name} id={p.id} photoAt={p.photoAt ?? null} size={28} />
          <span className={css.text}><b>{p.id === me ? `${p.name} (you)` : p.name}</b>{p.role || p.pod ? <small>{[p.role, p.pod].filter(Boolean).join(" · ")}</small> : null}</span>
          {done ? <Check size={16} className={css.tick} aria-label="Added" /> : p.canAssign === false ? <span className={css.ask} title="Outside your reach: they get a request to accept">Ask</span> : null}
        </li>; })}
      {!shown.length ? <li className={css.none}>Nobody matches “{q}”.</li> : null}
    </ul>
  </Popover>;
}
