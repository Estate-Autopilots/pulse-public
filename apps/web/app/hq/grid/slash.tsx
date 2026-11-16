"use client";
// PULSE-HQ (owner, 23 Oct 2026): a long-text field with slash commands. Type "/" at the start of a line (or after a
// space) and pick a block: a heading, a bullet, a checklist item, a numbered item, a quote, a divider, today's date, a
// problem / for whom / done-when outline or a link to a feature. ↑ ↓ choose, Enter or Tab inserts, Esc closes. The text
// stays plain text, so it reads the same everywhere.
import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import css from "./grid.module.css";

type Command = { key: string; label: string; hint: string; insert: () => string };
const today = () => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date());
const BASE: Command[] = [
  { key: "heading", label: "Heading", hint: "## ", insert: () => "## " },
  { key: "bullet", label: "Bullet", hint: "• ", insert: () => "• " },
  { key: "todo", label: "Checklist item", hint: "☐ ", insert: () => "☐ " },
  { key: "numbered", label: "Numbered item", hint: "1. ", insert: () => "1. " },
  { key: "quote", label: "Quote", hint: "> ", insert: () => "> " },
  { key: "divider", label: "Divider", hint: "———", insert: () => "———\n" },
  { key: "date", label: "Today's date", hint: "", insert: () => today() },
  { key: "outline", label: "Problem, for whom, done when", hint: "outline", insert: () => "Problem: \nFor whom: \nDone when: " },
  { key: "pros", label: "Pros and cons", hint: "outline", insert: () => "Pros:\n• \nCons:\n• " },
];

export type SlashHandle = { focus: () => void };
type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string; onValue: (v: string) => void; links?: { key: string; label: string }[]; onSubmit?: () => void; onCancel?: () => void;
  /** Enter saves (Shift+Enter starts a new line), as in a sheet's cell; otherwise Ctrl/⌘+Enter saves. */
  enterSubmits?: boolean;
};

const NO_LINKS: { key: string; label: string }[] = [];
export const SlashText = forwardRef<SlashHandle, Props>(function SlashText({ value, onValue, links = NO_LINKS, onSubmit, onCancel, enterSubmits, className, onKeyDown, ...rest }, ref) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ from: number; query: string } | null>(null);
  const [at, setAt] = useState(0);
  useImperativeHandle(ref, () => ({ focus: () => box.current?.focus() }), []);
  const commands = useMemo(() => [...BASE, ...links.slice(0, 200).map((l) => ({ key: `link:${l.key}`, label: `Link: ${l.label}`, hint: "feature", insert: () => `[[${l.label}]]` }))], [links]);
  const shown = useMemo(() => !menu ? [] : commands.filter((c) => !menu.query || c.label.toLowerCase().includes(menu.query.toLowerCase()) || c.key.startsWith(menu.query.toLowerCase())).slice(0, 8), [menu, commands]);

  const sync = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = before.match(/(^|[\s])\/([\w-]{0,24})$/);
    if (m) { setMenu({ from: caret - m[2].length - 1, query: m[2] }); setAt(0); } else setMenu(null);
  };
  const apply = (c: Command) => {
    if (!menu || !box.current) return;
    const caret = box.current.selectionStart ?? value.length;
    const ins = c.insert();
    const next = value.slice(0, menu.from) + ins + value.slice(caret);
    onValue(next); setMenu(null);
    const pos = menu.from + ins.length;
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(pos, pos); });
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && shown.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setAt((x) => (x + 1) % shown.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setAt((x) => (x - 1 + shown.length) % shown.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); apply(shown[Math.min(at, shown.length - 1)]); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMenu(null); return; }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (enterSubmits && !e.shiftKey)) && onSubmit) { e.preventDefault(); onSubmit(); return; }
    if (e.key === "Escape" && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    onKeyDown?.(e);
  };
  return <span className={css.slashWrap}>
    <textarea ref={box} {...rest} className={className} value={value} onKeyDown={keys}
      onChange={(e) => { onValue(e.target.value); sync(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
      onBlur={(e) => { setTimeout(() => setMenu(null), 120); rest.onBlur?.(e); }} aria-autocomplete="list" />
    {menu && shown.length ? <span className={css.slashMenu} role="listbox" aria-label="Insert a block">
      {shown.map((c, i) => <button key={c.key} type="button" role="option" aria-selected={i === at} className={css.slashItem} data-on={i === at ? "" : undefined}
        onMouseDown={(e) => { e.preventDefault(); apply(c); }}><span>{c.label}</span>{c.hint ? <small>{c.hint}</small> : null}</button>)}
    </span> : null}
  </span>;
});
