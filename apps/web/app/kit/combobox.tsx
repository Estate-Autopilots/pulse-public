"use client";
// TASKS-4A kit: Combobox and Select. A button shows the choice; it opens a list *downward* (above only without room),
// with a search field when the list is long, icons, groups and a detail line per option. Keyboard: Enter, Space or ↓
// open it; typing on the closed button opens it already searching; ↑ ↓ Home End PageUp PageDown move; Enter chooses;
// Escape closes and gives focus back. Screen readers hear a combobox driving a listbox (aria-activedescendant).
// PersonSelect and PeopleInput are the same list with faces.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { AiBadge } from "./ai-badge";
import { Popover } from "./popover";
import { Avatar, PersonChip, type PersonLike } from "./person";
import type { Placement } from "./layer";
import css from "./kit.module.css";
import { SelectField } from "./select-field";

export type Option<V extends string = string> = { value: V; label: string; detail?: ReactNode; icon?: ReactNode; group?: string; keywords?: string; disabled?: boolean; tag?: ReactNode };
type Common<V extends string> = {
  label: string; options: Option<V>[]; placeholder?: string; searchPlaceholder?: string; emptyText?: string;
  /** Shown in the button while nothing is chosen, e.g. what Pulse read from a title. */ hint?: ReactNode;
  /** A first option meaning "none" (e.g. "No project"); choosing it gives null. */ noneLabel?: string;
  searchable?: boolean; size?: "sm" | "md"; variant?: "field" | "chip" | "ghost"; icon?: ReactNode; className?: string; disabled?: boolean;
  placement?: Placement; renderValue?: (o: Option<V>) => ReactNode; footer?: ReactNode; max?: number; autoOpen?: boolean; id?: string;
  /** Keep the list open after a choice (adding several). */ keepOpen?: boolean;
  /** UI-POLISH: the visible face of a real <SelectField> (SelectField): the select keeps focus, keyboard and the screen
   *  reader, so this button is out of the tab order and hidden from assistive tech; after a choice focus goes back. */
  shadow?: boolean; focusBack?: () => void;
};
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** The list itself, for a combobox or a mention box: options, the active one, choose. */
export function OptionList<V extends string>({ id, label, options, active, chosen, onActive, onChoose, emptyText, more, focusRef, onKeyDown }: { id: string; label: string; options: Option<V>[]; active: number;
  chosen?: V | null; onActive: (i: number) => void; onChoose: (o: Option<V>) => void; emptyText?: string; more?: number;
  /** Given when the list itself takes focus (no search field): it then carries aria-activedescendant and the keys. */ focusRef?: React.RefObject<HTMLUListElement | null>; onKeyDown?: (e: KeyboardEvent) => void }) {
  const own = useRef<HTMLUListElement>(null), list = focusRef ?? own;
  useEffect(() => { list.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${active}`)}`)?.scrollIntoView({ block: "nearest" }); }, [active, id, list]);
  const heads = options.map((o, i) => o.group && o.group !== options[i - 1]?.group ? o.group : null);
  return <ul ref={list} id={id} role="listbox" aria-label={label} className={css.lb} tabIndex={focusRef ? 0 : undefined} onKeyDown={onKeyDown}
    aria-activedescendant={focusRef && options[active] ? `${id}-${active}` : undefined}>
    {options.map((o, i) => {
      const head = heads[i];
      return [head ? <li key={`g-${head}`} role="presentation" className={css.lbGroup}>{head}</li> : null,
        <li key={`${i}:${o.value}`} id={`${id}-${i}`} role="option" aria-selected={i === active} aria-disabled={o.disabled || undefined} className={css.lbItem} data-chosen={chosen === o.value ? "" : undefined}
          onPointerMove={() => { if (i !== active) onActive(i); }} onMouseDown={(e) => e.preventDefault()} onClick={() => { if (!o.disabled) onChoose(o); }}>
          {o.icon ?? null}<span className={css.lbMain}><span>{o.label}</span>{o.detail ? <small>{o.detail}</small> : null}</span>
          {o.tag ?? null}{chosen === o.value ? <Check size={15} className={css.lbCheck} aria-hidden="true" /> : null}
        </li>];
    })}
    {!options.length ? <li role="presentation" className={css.lbEmpty}>{emptyText ?? "Nothing matches"}</li> : null}
    {more ? <li role="presentation" className={css.lbMore}>{more} more: keep typing to narrow</li> : null}
  </ul>;
}

/** Arrow keys over a list of options; returns true when the key was used. */
export function listKeys(e: KeyboardEvent, n: number, active: number, set: (i: number) => void) {
  const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[e.key];
  if (step !== undefined && n) { e.preventDefault(); set(Math.abs(step) > 1 ? Math.max(0, Math.min(n - 1, active + step)) : (active + step + n) % n); return true; }
  if ((e.key === "Home" || e.key === "End") && n) { e.preventDefault(); set(e.key === "Home" ? 0 : n - 1); return true; }
  return false;
}

export function Combobox<V extends string>({ value, onChange, ...p }: Common<V> & { value: V | null; onChange: (v: V | null, o: Option<V> | null) => void }) {
  const { label, options, placeholder = "Choose", searchPlaceholder, emptyText, hint, noneLabel, size, variant = "field", icon, className, disabled, placement = "bottom-start", renderValue, footer, max = 80, autoOpen, keepOpen, shadow, focusBack } = p;
  const searchable = p.searchable ?? options.length > 8;
  const [open, setOpen] = useState(!!autoOpen), [q, setQ] = useState(""), [active, setActive] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null), listFocus = useRef<HTMLUListElement>(null);
  const uid = useId(), listId = `${p.id ?? uid}-list`;
  const all = useMemo(() => noneLabel ? [{ value: "" as V, label: noneLabel } as Option<V>, ...options] : options, [options, noneLabel]);
  const found = useMemo(() => { const n = norm(q.trim()); return n ? all.filter((o) => o.value && norm(`${o.label} ${typeof o.detail === "string" ? o.detail : ""} ${o.keywords ?? ""}`).includes(n)) : all; }, [all, q]);
  const shown = found.slice(0, max);
  const chosen = options.find((o) => o.value === value) ?? null;
  const show = (query = "") => { setQ(query); const i = query ? 0 : Math.max(0, all.findIndex((o) => (o.value || null) === value)); setActive(i); setOpen(true); };
  const choose = (o: Option<V>) => { onChange((o.value || null) as V | null, o.value ? o : null); if (keepOpen) { setQ(""); search.current?.focus(); } else { setOpen(false); if (focusBack) focusBack(); else anchor.current?.focus({ preventScroll: true }); } };
  const keys = (e: KeyboardEvent) => {
    if (listKeys(e, shown.length, active, setActive)) return;
    if (e.key === "Enter" && shown[active]) { e.preventDefault(); if (!shown[active].disabled) choose(shown[active]); return; }
    if (!searchable && e.key.length === 1 && /\S/.test(e.key)) { const i = shown.findIndex((o, k) => k > active && norm(o.label).startsWith(norm(e.key))); const j = i >= 0 ? i : shown.findIndex((o) => norm(o.label).startsWith(norm(e.key))); if (j >= 0) setActive(j); }
  };
  const trigger = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); show(); }
    // Letters typed before focus reaches the search field (it moves on the next frame) add to it rather than restart it.
    else if (searchable && e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); if (open) { setQ((x) => x + e.key); setActive(0); } else show(e.key); }
  };
  const valueNode = chosen ? (renderValue ? renderValue(chosen) : <>{chosen.icon ?? icon ?? null}<span>{chosen.label}</span></>)
    : hint ? <span className={css.triggerHint}>{icon ?? null}{hint}</span> : <>{icon ?? null}<span className={css.triggerPlaceholder}>{placeholder}</span></>;
  return <>
    <button ref={anchor} type="button" className={`${css.trigger}${className ? ` ${className}` : ""}`} data-size={size} data-variant={variant} data-set={chosen ? "" : undefined} disabled={disabled}
      tabIndex={shadow ? -1 : undefined} aria-hidden={shadow || undefined} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={shadow ? undefined : `${label}: ${chosen?.label ?? (typeof hint === "string" ? hint : placeholder)}`}
      onClick={() => open ? setOpen(false) : show()} onKeyDown={trigger}>
      <span className={css.triggerValue}>{valueNode}</span><ChevronDown size={15} className={css.chev} aria-hidden="true" />
    </button>
    <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={label} role="none" placement={placement} matchWidth focus={searchable ? search : listFocus}>
      {searchable ? <label className={css.lbSearch}><Search size={15} aria-hidden="true" />
        <input ref={search} aria-label={label} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={keys} placeholder={searchPlaceholder ?? "Search…"} role="combobox" aria-expanded="true"
          aria-controls={listId} aria-autocomplete="list" aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined} autoComplete="off" spellCheck={false} enterKeyHint="go" /></label>
        : null}
      <OptionList id={listId} label={label} options={shown} active={active} chosen={(value ?? "") as V} onActive={setActive} onChoose={choose} emptyText={emptyText ?? (q ? `Nothing matches “${q}”` : "Nothing to choose yet")} more={found.length - shown.length}
        focusRef={searchable ? undefined : listFocus} onKeyDown={searchable ? undefined : keys} />
      {footer}
    </Popover>
  </>;
}

/** A short list without search (status, priority, sort order). */
export function Select<V extends string>(props: Omit<Common<V>, "searchable"> & { value: V | null; onChange: (v: V | null, o: Option<V> | null) => void }) {
  return <Combobox {...props} searchable={false} />;
}

// ------------------------------------------------------------------------------------------------------------ people
export type PickPerson = PersonLike & { pod?: string | null; role?: string | null; username?: string | null; canAssign?: boolean };
const first = (name: string) => name.replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
export function personOptions(people: PickPerson[], me?: string | null, askTag?: ReactNode): Option<string>[] {
  return people.map((p) => ({ value: p.id, label: p.id === me ? `Me (${first(p.name)})` : p.name, detail: [p.role, p.pod].filter(Boolean).join(" · ") || undefined,
    icon: <Avatar ai={p.agent} name={p.name} id={p.id} photoAt={p.photoAt ?? null} size={26} />, keywords: `${p.name} ${p.username ?? ""} ${p.pod ?? ""}`,
    tag: p.agent || (askTag && p.id !== me && p.canAssign === false) ? <>{p.agent ? <AiBadge employeeId={p.employeeId} /> : null}{askTag && p.id !== me && p.canAssign === false ? askTag : null}</> : undefined }));
}

/** One person, searchable, with photos. `askTag` marks people the viewer would ask rather than assign. */
export function PersonSelect({ people, value, onChange, me, label, placeholder = "Choose someone", askTag, size, variant, autoOpen, noneLabel }: { people: PickPerson[]; value: string | null;
  onChange: (p: PickPerson | null) => void; me?: string | null; label: string; placeholder?: string; askTag?: ReactNode; size?: "sm" | "md"; variant?: "field" | "chip" | "ghost"; autoOpen?: boolean; noneLabel?: string }) {
  const options = useMemo(() => personOptions(people, me, askTag), [people, me, askTag]);
  const chosen = people.find((p) => p.id === value);
  return <Combobox label={label} options={options} value={value} placeholder={placeholder} searchable size={size} variant={variant} autoOpen={autoOpen} noneLabel={noneLabel}
    searchPlaceholder="Search people" renderValue={() => chosen ? <><Avatar name={chosen.name} id={chosen.id} photoAt={chosen.photoAt ?? null} size={22} /><span>{chosen.id === me ? `Me (${first(chosen.name)})` : chosen.name}</span></> : null}
    onChange={(v) => onChange(people.find((p) => p.id === v) ?? null)} />;
}

/** Several people as chips, with "Add" opening the same searchable list (it stays open while adding). */
export function PeopleInput({ people, value, onChange, label, exclude, me, addLabel = "Add people", tagFor }: { people: PickPerson[]; value: string[]; onChange: (ids: string[]) => void; label: string;
  exclude?: string[]; me?: string | null; addLabel?: string; tagFor?: (p: PickPerson) => ReactNode }) {
  const left = useMemo(() => people.filter((p) => !value.includes(p.id) && !exclude?.includes(p.id)), [people, value, exclude]);
  const options = useMemo(() => personOptions(left, me).map((o) => { const p = left.find((x) => x.id === o.value)!; return { ...o, tag: tagFor?.(p) }; }), [left, me, tagFor]);
  return <div role="group" aria-label={label} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, minWidth: 0 }}>
    {value.map((id) => { const p = people.find((x) => x.id === id); return p ? <PersonChip key={id} person={p} me={me} onRemove={() => onChange(value.filter((x) => x !== id))} /> : null; })}
    <Combobox label={addLabel} options={options} value={null} placeholder={value.length ? "Add more" : addLabel} searchable variant="chip" size="sm" keepOpen icon={<Plus size={14} aria-hidden="true" />}
      searchPlaceholder="Search people" onChange={(v) => { if (v) onChange([...value, v]); }} />
  </div>;
}
