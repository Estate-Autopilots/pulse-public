"use client";
// TASKS-P0: @mentions as people, not plain text. Typing @ lists colleagues with their photo, name and role; a chosen
// one becomes a chip with their avatar in the box, and posted comments show the same chips. The comment body stays
// plain text ("… @Kabir Shah …") with the mentioned ids beside it, as the API and notifications already expect.
import { forwardRef, Fragment, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Avatar, hueStyle, initials } from "../ui";
import type { Person } from "../create";
import css from "./mentions.module.css";

export type ComposerHandle = { text: () => string; mentions: () => string[]; clear: () => void; focus: () => void };
const QUERY = /(?:^|\s)@([\p{L}\p{N}._-]{0,30})$/u;

/** The box's text, with each chip as "@Name" and line breaks kept. */
function serialise(root: Node): string {
  let out = "";
  const walk = (n: Node, top: boolean) => {
    if (n.nodeType === Node.TEXT_NODE) { out += (n.nodeValue ?? "").replace(/ /g, " "); return; }
    if (!(n instanceof HTMLElement)) return;
    if (n.dataset.mentionName) { out += `@${n.dataset.mentionName}`; return; }
    if (n.tagName === "BR") { out += "\n"; return; }
    const block = !top && (n.tagName === "DIV" || n.tagName === "P");
    if (block && out && !out.endsWith("\n")) out += "\n";
    n.childNodes.forEach((c) => walk(c, false));
  };
  root.childNodes.forEach((c) => walk(c, false));
  return out;
}
/** The mention chip as DOM (the box is not React-managed): avatar, then the name. */
function chip(p: Person) {
  const el = document.createElement("span");
  el.className = css.chip; el.contentEditable = "false"; el.dataset.mentionId = p.id; el.dataset.mentionName = p.name;
  el.setAttribute("aria-label", `@${p.name}`);
  const face = document.createElement("span"); face.className = css.face;
  Object.entries(hueStyle(p.name)).forEach(([k, v]) => face.style.setProperty(k, String(v)));
  if (p.photoAt) { const img = document.createElement("img"); img.src = `/photo/${p.id}?v=${Date.parse(p.photoAt)}`; img.alt = ""; face.append(img); } else face.textContent = initials(p.name);
  const name = document.createElement("span"); name.textContent = p.name;
  el.append(face, name);
  return el;
}

/** A comment box that turns @someone into a chip. */
export const MentionComposer = forwardRef<ComposerHandle, { people: Person[] | null; me: string | null; label: string; placeholder: string; onWant: () => void; onChange: (text: string) => void; onSubmit: () => void }>(
  function MentionComposer({ people, me, label, placeholder, onWant, onChange, onSubmit }, ref) {
    const box = useRef<HTMLDivElement>(null);
    const [query, setQuery] = useState<string | null>(null), [at, setAt] = useState(0);
    const spot = useRef<{ node: Text; offset: number } | null>(null);
    const matches = useMemo(() => query === null || !people ? [] : people.filter((p) => p.id !== me && `${p.name} ${p.username ?? ""}`.toLowerCase().includes(query.toLowerCase())).slice(0, 6), [query, people, me]);
    useImperativeHandle(ref, () => ({
      text: () => box.current ? serialise(box.current).trim() : "",
      mentions: () => [...new Set([...(box.current?.querySelectorAll<HTMLElement>("[data-mention-id]") ?? [])].map((e) => e.dataset.mentionId!))],
      clear: () => { if (box.current) box.current.innerHTML = ""; setQuery(null); onChange(""); },
      focus: () => box.current?.focus(),
    }), [onChange]);
    function read() {
      const sel = window.getSelection(); const node = sel?.anchorNode;
      if (node && node.nodeType === Node.TEXT_NODE && box.current?.contains(node)) {
        const m = (node.nodeValue ?? "").slice(0, sel!.anchorOffset).replace(/ /g, " ").match(QUERY);
        if (m) { spot.current = { node: node as Text, offset: sel!.anchorOffset }; if (query === null) onWant(); setQuery(m[1]); setAt(0); }
        else { spot.current = null; setQuery(null); }
      } else { spot.current = null; setQuery(null); }
      onChange(box.current ? serialise(box.current) : "");
    }
    function choose(p: Person) {
      const s = spot.current; if (!s || !box.current) return;
      const text = s.node.nodeValue ?? "";
      const start = text.slice(0, s.offset).lastIndexOf("@");
      const after = s.node.splitText(s.offset);
      s.node.nodeValue = text.slice(0, start);
      const space = document.createTextNode(" ");
      after.parentNode!.insertBefore(chip(p), after); after.parentNode!.insertBefore(space, after);
      if (!after.nodeValue) after.remove();
      const range = document.createRange(); range.setStart(space, 1); range.collapse(true);
      const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
      box.current.focus(); spot.current = null; setQuery(null); onChange(serialise(box.current));
    }
    function key(e: KeyboardEvent<HTMLDivElement>) {
      if (query !== null && matches.length) {
        if (e.key === "ArrowDown") { e.preventDefault(); setAt((a) => Math.min(a + 1, matches.length - 1)); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(matches[at]); return; }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setQuery(null); return; }
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
    }
    return <div className={css.wrap}>
      <div ref={box} className={css.box} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={label} data-placeholder={placeholder} tabIndex={0}
        aria-autocomplete="list" aria-controls="mention-list"
        onInput={read} onKeyUp={(e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) read(); }} onClick={read} onKeyDown={key}
        onPaste={(e) => { e.preventDefault(); document.execCommand("insertText", false, e.clipboardData.getData("text/plain")); }} />
      {query !== null && matches.length ? <ul id="mention-list" className={css.list} role="listbox" aria-label="Mention someone">{matches.map((p, i) => <li key={p.id} role="option" aria-selected={i === at}
        onMouseDown={(e) => { e.preventDefault(); choose(p); }} onMouseEnter={() => setAt(i)}>
        <Avatar name={p.name} id={p.id} photoAt={p.photoAt ?? null} size={28} /><span className={css.who}><b>{p.name}</b><small>{[p.role, p.pod].filter(Boolean).join(" · ") || "Team"}</small></span></li>)}</ul> : null}
    </div>;
  });

/** A posted comment: mentions of the people it names become chips. */
export function MentionText({ body, people }: { body: string; people: { id: string; name: string; photoAt?: string | null }[] }): ReactNode {
  if (!people.length) return body;
  const names = people.map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  const parts = body.split(new RegExp(`(@(?:${names.join("|")}))`, "g"));
  return parts.map((part, i) => {
    const p = part.startsWith("@") ? people.find((x) => `@${x.name}` === part) : null;
    return p ? <span key={i} className={css.chip} aria-label={`@${p.name}`}><Avatar name={p.name} id={p.id} photoAt={p.photoAt ?? null} size={18} /><span>{p.name}</span></span> : <Fragment key={i}>{part}</Fragment>;
  });
}
