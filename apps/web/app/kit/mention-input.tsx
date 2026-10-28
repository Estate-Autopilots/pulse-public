"use client";
// TASKS-4A kit: a text field where @someone becomes a person. Typing @ lists colleagues at once, with their photo, role
// and pod, narrowing as you type; ↑ ↓ and Enter (or Tab, or a click) put the chosen one in the text as a chip (photo
// and name, one unit: Backspace removes it whole). The value is plain text with "@Full Name" for each chip, plus the
// chosen ids, as comments and notifications already expect; `segments()` gives text and people in order. The
// placeholder can rotate through examples (`placeholder` as a list); it stops moving under reduced motion.
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { initials, hueStyle } from "../ui";
import { Popover } from "./popover";
import { listKeys, OptionList, personOptions, type PickPerson } from "./combobox";
import css from "./kit.module.css";

export type Segment = { kind: "text"; text: string } | { kind: "person"; id: string; name: string };
export type MentionHandle = { focus: () => void; clear: () => void; text: () => string; mentions: () => string[]; segments: () => Segment[]; setText: (text: string) => void; insert: (p: PickPerson) => void };
type Props = {
  people: PickPerson[] | null; me?: string | null; label: string; placeholder?: string | string[];
  /** Enter submits and pasted lines join; with `wrap` the text still wraps onto more lines as it grows. */ singleLine?: boolean; wrap?: boolean; autoFocus?: boolean; initial?: string;
  onChange?: (text: string, mentions: string[]) => void; onMention?: (p: PickPerson) => void; onUnmention?: (id: string) => void; onSubmit?: () => void;
  /** Called the first time @ is typed (load people lazily). */ onWant?: () => void;
  className?: string; boxClassName?: string; id?: string; maxLength?: number; enterKeyHint?: "send" | "done" | "go" | "enter";
};
const QUERY = /(?:^|[\s(])@([\p{L}\p{N}._'-]{0,30})$/u;
const norm = (s: string) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

function walk(root: Node, out: Segment[]) {
  const push = (text: string) => { const last = out.at(-1); if (last?.kind === "text") last.text += text; else out.push({ kind: "text", text }); };
  root.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) { push((n.nodeValue ?? "").replace(/\u00a0/g, " ")); return; }
    if (!(n instanceof HTMLElement)) return;
    if (n.dataset.mentionId) { out.push({ kind: "person", id: n.dataset.mentionId, name: n.dataset.mentionName ?? "" }); return; }
    if (n.tagName === "BR") { push("\n"); return; }
    if ((n.tagName === "DIV" || n.tagName === "P") && out.length) push("\n");
    walk(n, out);
  });
}
const segmentsOf = (root: HTMLElement | null) => { const out: Segment[] = []; if (root) walk(root, out); return out; };
const textOf = (segs: Segment[]) => segs.map((s) => s.kind === "text" ? s.text : `@${s.name}`).join("");

/** The chip as DOM: the box is edited by the browser, not by React. */
function chipNode(p: PickPerson) {
  const el = document.createElement("span");
  el.className = css.chip; el.contentEditable = "false"; el.dataset.mentionId = p.id; el.dataset.mentionName = p.name; el.setAttribute("aria-label", p.name);
  const face = document.createElement("span"); face.className = css.chipFace; face.setAttribute("aria-hidden", "true");
  Object.entries(hueStyle(p.name)).forEach(([k, v]) => face.style.setProperty(k, String(v)));
  if (p.photoAt) { const img = document.createElement("img"); img.src = `/photo/${p.id}?v=${Date.parse(p.photoAt)}`; img.alt = ""; face.append(img); } else face.textContent = initials(p.name);
  const name = document.createElement("span"); name.textContent = p.name.replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "");
  el.append(face, name);
  return el;
}

/** Rotates through examples every few seconds while the field is empty (not under reduced motion). */
function useRotating(list: string[], running: boolean) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!running || list.length < 2 || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") setI((x) => x + 1); }, 3400);
    return () => clearInterval(t);
  }, [running, list.length]);
  return list.length ? list[i % list.length] : "";
}

export const MentionInput = forwardRef<MentionHandle, Props>(function MentionInput({ people, me, label, placeholder, singleLine, wrap, autoFocus, initial, onChange, onMention, onUnmention, onSubmit, onWant,
  className, boxClassName, id, maxLength, enterKeyHint }, ref) {
  const box = useRef<HTMLDivElement>(null), shell = useRef<HTMLDivElement>(null);
  const spot = useRef<{ node: Text; offset: number; length: number } | null>(null);
  const known = useRef<string[]>([]), wanted = useRef(false);
  const [query, setQuery] = useState<string | null>(null), [active, setActive] = useState(0), [empty, setEmpty] = useState(!initial);
  const listId = `${useId()}-people`;
  const examples = useMemo(() => Array.isArray(placeholder) ? placeholder.filter(Boolean) : placeholder ? [placeholder] : [], [placeholder]);
  const ghost = useRotating(examples, empty);
  const matches = useMemo(() => {
    if (query === null || !people) return [];
    const q = norm(query);
    const list = people.filter((p) => !q || norm(`${p.name} ${p.username ?? ""}`).split(/\s+/).some((w) => w.startsWith(q)) || norm(p.name).includes(q));
    return personOptions(list.slice(0, 8), me);
  }, [query, people, me]);
  const open = query !== null && (!!matches.length || people === null);

  const emit = useCallback(() => {
    const segs = segmentsOf(box.current), ids = segs.flatMap((s) => s.kind === "person" ? [s.id] : []);
    for (const gone of known.current.filter((x) => !ids.includes(x))) onUnmention?.(gone);
    known.current = ids;
    const text = textOf(segs); setEmpty(!text.trim() && !ids.length); onChange?.(text, [...new Set(ids)]);
  }, [onChange, onUnmention]);
  const read = useCallback(() => {
    const sel = window.getSelection(), node = sel?.anchorNode;
    if (node && node.nodeType === Node.TEXT_NODE && box.current?.contains(node) && sel?.isCollapsed) {
      const before = (node.nodeValue ?? "").slice(0, sel.anchorOffset).replace(/\u00a0/g, " ");
      const m = before.match(QUERY);
      if (m) { spot.current = { node: node as Text, offset: sel.anchorOffset, length: m[1].length + 1 }; if (!wanted.current) { wanted.current = true; onWant?.(); } setQuery(m[1]); setActive(0); return; }
    }
    spot.current = null; setQuery(null);
  }, [onWant]);
  const place = (node: Node, offset: number) => { const r = document.createRange(); r.setStart(node, offset); r.collapse(true); const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); };
  const insert = useCallback((p: PickPerson) => {
    const el = box.current; if (!el) return;
    const chip = chipNode(p), space = document.createTextNode("\u00a0");
    const at = spot.current;
    if (at && el.contains(at.node)) {
      const after = at.node.splitText(at.offset); at.node.deleteData(at.offset - at.length, at.length);
      after.parentNode?.insertBefore(chip, after); after.parentNode?.insertBefore(space, after);
      if (after.nodeValue?.startsWith(" ") || after.nodeValue?.startsWith("\u00a0")) after.deleteData(0, 1);
    } else { if (el.textContent && !/\s$/.test(el.textContent)) el.append(document.createTextNode(" ")); el.append(chip, space); }
    el.focus(); place(space, 1); spot.current = null; setQuery(null); onMention?.(p); emit();
  }, [emit, onMention]);
  const setText = useCallback((text: string) => { if (box.current) { box.current.textContent = text; emit(); } }, [emit]);
  useImperativeHandle(ref, () => ({
    focus: () => { const el = box.current; if (!el) return; el.focus(); const last = el.lastChild; if (last) place(last.nodeType === Node.TEXT_NODE ? last : el, last.nodeType === Node.TEXT_NODE ? (last.nodeValue ?? "").length : el.childNodes.length); },
    clear: () => { if (box.current) box.current.innerHTML = ""; setQuery(null); emit(); },
    text: () => textOf(segmentsOf(box.current)), mentions: () => [...new Set(segmentsOf(box.current).flatMap((s) => s.kind === "person" ? [s.id] : []))],
    segments: () => segmentsOf(box.current), setText, insert,
  }), [emit, insert, setText]);
  // The first text is there before the first paint (a form opened from a chat message shows its words at once).
  useLayoutEffect(() => { if (initial && box.current && !box.current.textContent) { box.current.textContent = initial; emit(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => { const el = box.current; if (!el) return; el.focus(); if (el.lastChild) place(el.lastChild, (el.lastChild.nodeValue ?? "").length); });
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (open && matches.length) {
      if (listKeys(e, matches.length, active, setActive)) return;
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const p = people?.find((x) => x.id === matches[active]?.value); if (p) insert(p); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setQuery(null); return; }
    }
    if (e.key === "Enter" && (singleLine || e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); onSubmit?.(); return; }
    if (maxLength && e.key.length === 1 && !e.metaKey && !e.ctrlKey && (box.current?.textContent ?? "").length >= maxLength && window.getSelection()?.isCollapsed) e.preventDefault();
  };
  return <div ref={shell} className={`${css.mention}${className ? ` ${className}` : ""}`} data-single={singleLine && !wrap ? "" : undefined}>
    {empty && ghost ? <span key={ghost} className={css.mentionGhost} data-in="" aria-hidden="true">{ghost}</span> : null}
    <div ref={box} id={id} className={`${css.mentionBox}${boxClassName ? ` ${boxClassName}` : ""}`} contentEditable suppressContentEditableWarning role="textbox" aria-multiline={!singleLine}
      aria-label={label} aria-placeholder={examples[0]} aria-autocomplete="list" aria-controls={open ? listId : undefined}
      aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined} enterKeyHint={enterKeyHint} spellCheck
      onInput={() => { read(); emit(); }} onKeyUp={(e) => { if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) read(); }} onClick={read} onKeyDown={keys}
      onBlur={() => setTimeout(() => { if (!shell.current?.contains(document.activeElement)) setQuery(null); }, 150)}
      onPaste={(e) => { e.preventDefault(); const t = e.clipboardData.getData("text/plain"); document.execCommand("insertText", false, singleLine ? t.replace(/\s*\n+\s*/g, " ") : t); }}
      onDrop={(e) => e.preventDefault()} />
    <Popover open={open} onClose={() => setQuery(null)} anchor={shell} label="People" role="none" focus="none" placement="bottom-start" minRoom={180}>
      {people === null ? <p className={css.lbEmpty}>Loading people…</p>
        : <OptionList id={listId} label="People" options={matches} active={active} onActive={setActive} onChoose={(o) => { const p = people.find((x) => x.id === o.value); if (p) insert(p); }} />}
    </Popover>
  </div>;
});
