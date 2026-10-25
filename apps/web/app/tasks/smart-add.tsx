"use client";
// TASKS-3: the quick-add line, one calm input. Typing @, # or ! opens suggestions (people with their photo, projects and
// tags, priorities); what the line already says shows as chips at once (no round trip), each with × to take it back.
// A day at the end of the line ("fri", "12 oct", "tomorrow") becomes the due date. Enter adds; someone outside your reach
// is asked instead of refused. ⋯ opens the full + Create form with what was typed.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CalendarDays, Flag, FolderKanban, Hash, Maximize2, Plus, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { openCreate, useWorkOptions, type Person, type Project } from "../create";
import { post } from "../records";
import { Avatar } from "../ui";
import { KindChip, kindOf } from "../work-kind";
import { activeToken, cut, findPeople, parseLine, PRIORITY as WORDS } from "../lib/quick-parse.mjs";
import { PRIORITY, shortDay } from "./parts";
import css from "./smart-add.module.css";
import captureCss from "./views/capture.module.css";
import { zoneDay } from "../lib/zone.mjs";
import { useOrgZone } from "../org-code";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const first = (name: string | null | undefined) => String(name ?? "").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
type Pick = { person: Person | null; project: Project | null; priority: string | null; tags: string[] };
type Suggestion = { key: string; kind: "person" | "project" | "tag" | "priority"; label: string; person?: Person; project?: Project; tag?: string; priority?: string };
const NONE: Pick = { person: null, project: null, priority: null, tags: [] };

export function SmartAdd({ parentId, projectId, assigneeId, placeholder, label = "Add a task", autoFocusKey = true, compact, onCreated }: { parentId?: string; projectId?: string; assigneeId?: string; placeholder?: string; label?: string;
  /** N (or Q) focuses this line. */ autoFocusKey?: boolean; /** A smaller line (subtasks). */ compact?: boolean; onCreated?: (id: string) => void }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const revision = useRef(0), inFlight = useRef(false), refocus = useRef(false);
  const [text, setText] = useState(""), [caret, setCaret] = useState(0), [picked, setPicked] = useState<Pick>(NONE), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [dismissedAssigneeId, setDismissedAssigneeId] = useState<string>();
  const scopeAssigneeId = assigneeId === dismissedAssigneeId ? undefined : assigneeId;
  const [focused, setFocused] = useState(false), [at, setAt] = useState(0), [closed, setClosed] = useState(false), [known, setKnown] = useState<string[]>([]);
  const { data } = useWorkOptions(focused || !!text);
  const zone = useOrgZone(), today = data?.today ?? zoneDay(zone);
  const me = data?.people.find((p) => p.id === data.me) ?? null;
  // Focus only after the cleared draft and the enabled controls have committed.
  useEffect(() => { if (!busy && refocus.current) { refocus.current = false; input.current?.focus(); } }, [busy]);
  useEffect(() => {
    if (!autoFocusKey) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if ((e.key === "n" || e.key === "q") && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target) && !document.querySelector('[aria-modal="true"]')) { e.preventDefault(); input.current?.focus(); } };
    document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey);
  }, [autoFocusKey]);
  useEffect(() => { if (focused && !known.length) fetch("/api/v0/work/tags").then((r) => r.ok ? r.json() : { rows: [] }).then((d) => setKnown(d.rows.map((x: { tag: string }) => x.tag))).catch(() => undefined); }, [focused, known.length]);

  const parsed = useMemo(() => parseLine(text, { today, people: data?.people ?? [], projects: data?.projects ?? [], me }), [text, today, data, me]);
  const token = focused && !closed ? activeToken(text, caret) : null;
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token) return [];
    const q = token.query.toLowerCase();
    if (token.kind === "person") return findPeople(q, data?.people ?? [], me).slice(0, 7).map((p) => ({ key: p.id, kind: "person" as const, label: p.name, person: p }));
    if (token.kind === "priority") return (["urgent", "high", "normal", "low"] as const).filter((p) => !q || p.startsWith(q)).map((p) => ({ key: p, kind: "priority" as const, label: PRIORITY[p], priority: p }));
    const projects = (data?.projects ?? []).filter((p) => !q || `${p.name} ${p.clientName ?? ""}`.toLowerCase().includes(q.replace(/[-_]/g, " "))).slice(0, 6)
      .map((p) => ({ key: p.id, kind: "project" as const, label: p.name, project: p }));
    const tag = q.replace(/[^\p{L}\p{N}_&-]/gu, "").slice(0, 40);
    const tags = known.filter((t) => t.includes(tag) && t !== tag).slice(0, 3).map((t) => ({ key: `tag:${t}`, kind: "tag" as const, label: `#${t}`, tag: t }));
    return [...projects, ...(tag ? [{ key: `tag:${tag}`, kind: "tag" as const, label: `#${tag}`, tag }] : []), ...tags];
  }, [token, data, me, known]);
  const open = suggestions.length > 0;
  const index = Math.min(at, Math.max(0, suggestions.length - 1));

  // What the line says, with explicit picks winning over what is typed.
  const person = picked.person ?? parsed.assignee ?? data?.people.find((p) => p.id === scopeAssigneeId), project = picked.project ?? parsed.project;
  const priority = picked.priority ?? parsed.priority, tags = [...new Set([...picked.tags, ...parsed.tags])];
  const dueToken = parsed.tokens.find((t) => t.kind === "due");
  const problems = parsed.problems.filter((p) => !(p.kind === "person" && picked.person) && !(p.kind === "project" && picked.project));

  function set(next: string, pos?: number) { revision.current++; setText(next); setError(""); setClosed(false); const c = pos ?? next.length; setCaret(c); requestAnimationFrame(() => { input.current?.setSelectionRange(c, c); }); }
  function choose(s: Suggestion) {
    if (!token) return;
    const next = cut(text, token.start, token.end); const pos = Math.min(token.start, next.length);
    if (s.kind === "person") setPicked((p) => ({ ...p, person: s.person! }));
    else if (s.kind === "project") setPicked((p) => ({ ...p, project: s.project! }));
    else if (s.kind === "priority") setPicked((p) => ({ ...p, priority: s.priority! }));
    else setPicked((p) => ({ ...p, tags: [...new Set([...p.tags, s.tag!])] }));
    set(next, pos); setAt(0);
  }
  function drop(kind: "person" | "project" | "priority" | "due" | "tag", tag?: string) {
    if (kind === "person") setDismissedAssigneeId(assigneeId);
    let next = text;
    for (const t of [...parsed.tokens].reverse()) if (t.kind === kind && (kind !== "tag" || t.label === tag)) next = cut(next, t.start, t.end);
    setPicked((p) => ({ ...p, ...(kind === "person" ? { person: null } : kind === "project" ? { project: null } : kind === "priority" ? { priority: null } : kind === "tag" ? { tags: p.tags.filter((x) => x !== tag) } : {}) }));
    set(next); input.current?.focus();
  }
  async function submit(e?: FormEvent) {
    e?.preventDefault(); if (busy || inFlight.current) return;
    // TASKS-4A: no red scolding for a line that is only chips; Add stays off until there are words.
    if (!parsed.title.trim()) { input.current?.focus(); return; }
    if (problems.length) { setError(problems[0].text); return; }
    const submittedRevision = revision.current;
    inFlight.current = true; setBusy(true); setError("");
    // The words the server reads are the line minus what became a tag here; explicit picks travel beside them.
    let line = text; for (const t of [...parsed.tokens].reverse()) if (t.kind === "tag") line = cut(line, t.start, t.end);
    try {
      const r = await post<{ id: string; asked: { to: string | null } | null; assigned: boolean; assigneeName: string | null; parsed: { title: string } }>("tasks/quick", {
        text: line, ...(picked.person ? { assigneeId: picked.person.id } : scopeAssigneeId && !parsed.assignee ? { assigneeId: scopeAssigneeId } : {}), ...(picked.project ? { projectId: picked.project.id } : projectId && !project ? { projectId } : {}),
        ...(picked.priority ? { priority: picked.priority } : {}), ...(tags.length ? { tags } : {}), ...(parentId ? { parentId } : {}) });
      const who = r.asked ? `Asked ${first(r.asked.to ?? person?.name)} to take it` : r.assigned ? `Added for ${first(r.assigneeName ?? person?.name)}` : "Added";
      notify({ id: "task-added", tone: "success", title: who, message: r.parsed?.title ?? parsed.title, href: `/tasks/${r.id}`, timeout: 3500 });
      // A response owns only its submitted revision, never a newer draft. Explicit
      // selections remain useful context for the next entry; typed chips clear with the text.
      if (revision.current === submittedRevision) { setText(""); setCaret(0); setClosed(true); }
      onCreated?.(r.id); router.refresh();
    } catch (err) { setError(msg(err)); } finally { inFlight.current = false; refocus.current = true; setBusy(false); }
  }
  function key(e: KeyboardEvent<HTMLInputElement>) {
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setAt((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length); return; }
    // Enter adds the task when what is being typed already reads as something ("!high", "@Meera", "#Launch"); Tab, or
    // Enter on an unfinished or ambiguous word, takes the highlighted suggestion.
    const settled = !!token && parsed.tokens.some((t) => t.start <= token.start && t.end >= token.end);
    if (open && (e.key === "Tab" || (e.key === "Enter" && !settled))) { e.preventDefault(); choose(suggestions[index]); return; }
    if (e.key === "Escape") { if (open) { e.preventDefault(); e.stopPropagation(); setClosed(true); } else if (text) { e.preventDefault(); set(""); setPicked(NONE); } return; }
    if (e.key === "Backspace" && !text && (picked.person || picked.project || picked.tags.length || picked.priority)) {
      revision.current++;
      e.preventDefault(); setPicked((p) => p.tags.length ? { ...p, tags: p.tags.slice(0, -1) } : p.priority ? { ...p, priority: null } : p.project ? { ...p, project: null } : { ...p, person: null });
    }
  }
  const listId = `smart-${label.replace(/\W+/g, "-").toLowerCase()}`;
  const chips = person || project || dueToken || priority !== "normal" || tags.length;
  return <form className={`${css.smart} ${compact ? "" : captureCss.capture}`} data-compact={compact ? "" : undefined} data-focused={focused ? "" : undefined} onSubmit={submit} aria-label={label}>
    <div className={css.bar}>
      <Plus size={16} aria-hidden="true" className={css.plus} />
      <input ref={input} className={css.input} value={text} aria-label={label} aria-autocomplete="list" aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${listId}-${index}` : undefined}
        placeholder={placeholder ?? "Add a task · @ who · # project or tag · ! priority · fri"} enterKeyHint="done" autoComplete="off" maxLength={500}
        onChange={(e) => { revision.current++; setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setError(""); setClosed(false); setAt(0); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)} onKeyDown={key} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 120)} />
      {chips ? <span className={css.chips} aria-label="What this task will have">
        {person ? <span className={css.chip} data-kind="person" title={person.canAssign === false ? `Outside your reach: ${first(person.name)} is asked to take it` : `${person.name} does it`}>
          <Avatar name={person.name} id={person.id} photoAt={person.photoAt ?? null} size={18} />{person.id === data?.me ? "Me" : first(person.name)}{person.canAssign === false ? <em>ask</em> : null}
          <button type="button" aria-label={`Not ${person.name}`} onClick={() => drop("person")}><X size={11} aria-hidden="true" /></button></span> : null}
        {project ? <span className={css.chip} data-kind="project" title={project.name}><KindChip kind={kindOf(project.kind ?? "internal")} short /><span>{project.name}</span>
          <button type="button" aria-label={`Not in ${project.name}`} onClick={() => drop("project")}><X size={11} aria-hidden="true" /></button></span> : null}
        {dueToken ? <span className={css.chip} data-kind="due"><CalendarDays size={12} aria-hidden="true" />{dueToken.label === today ? "Today" : shortDay(dueToken.label)}
          <button type="button" aria-label="Keep the day in the title" onClick={() => drop("due")}><X size={11} aria-hidden="true" /></button></span> : null}
        {priority !== "normal" ? <span className={css.chip} data-kind="priority" data-p={priority}><Flag size={12} aria-hidden="true" />{PRIORITY[priority]}
          <button type="button" aria-label="Normal priority" onClick={() => drop("priority")}><X size={11} aria-hidden="true" /></button></span> : null}
        {tags.map((t) => <span key={t} className={css.chip} data-kind="tag"><Hash size={11} aria-hidden="true" />{t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => drop("tag", t)}><X size={11} aria-hidden="true" /></button></span>)}
      </span> : null}
      <button type="button" className={css.more} title="More options: the full form" aria-label="More options" onClick={() => openCreate({ kind: "task", title: parsed.title || text, assigneeId: person?.id, projectId: project?.id ?? projectId, parentId })}><Maximize2 size={14} aria-hidden="true" /></button>
      <button className={css.add} disabled={busy || !parsed.title.trim()}>{busy ? "Adding…" : error ? "Retry" : "Add"}</button>
    </div>
    {open ? <ul className={css.list} id={listId} role="listbox" aria-label={token?.kind === "person" ? "People" : token?.kind === "priority" ? "Priority" : "Projects and tags"}>
      {suggestions.map((s, i) => <li key={s.key} id={`${listId}-${i}`} role="option" aria-selected={i === index} onMouseEnter={() => setAt(i)} onMouseDown={(e) => { e.preventDefault(); choose(s); }}>
        {s.kind === "person" ? <><Avatar name={s.person!.name} id={s.person!.id} photoAt={s.person!.photoAt ?? null} size={24} /><span className={css.optMain}>{s.person!.id === data?.me ? `Me (${s.person!.name})` : s.person!.name}<small>{[s.person!.role, s.person!.pod].filter(Boolean).join(" · ")}</small></span>{s.person!.canAssign === false && s.person!.id !== data?.me ? <em title="You ask; they accept or decline">Ask</em> : null}</>
          : s.kind === "project" ? <><KindChip kind={kindOf(s.project!.kind)} short /><span className={css.optMain}>{s.project!.name}<small>{s.project!.clientName ?? (s.project!.recent ? "Recent" : "")}</small></span><FolderKanban size={13} aria-hidden="true" /></>
          : s.kind === "tag" ? <><Hash size={15} aria-hidden="true" /><span className={css.optMain}>{s.tag}<small>{known.includes(s.tag!) ? "Tag" : "New tag"}</small></span></>
          : <><Flag size={15} aria-hidden="true" data-p={s.priority} /><span className={css.optMain}>{s.label}<small>{Object.entries(WORDS).filter(([, v]) => v === s.priority).map(([k]) => k).slice(0, 2).join(" ")}</small></span></>}
      </li>)}
    </ul> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
  </form>;
}
