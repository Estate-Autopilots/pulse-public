"use client";
// PROFILE-2 (owner, 17 Nov 2026: "skills editable on hover/click, and a skills database like LinkedIn's"): one skill
// picker for the profile and the People page. Skills read as chips; on hover a pencil shows, and a click on the chips
// (or the pencil) opens the editor in place: type to search the skills library (Pulse's own list and O*NET), pick a
// suggestion for the person's role, or press Enter to keep your own words. Saved as the person's own labels; the
// database links each one to the library (skill_refs) so resumes and matching can use them.
import { Check, Plus, Sparkles, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import css from "./skill-picker.module.css";

type Found = { id: string; label: string; kind: string; category?: string | null; why?: string };
type About = { id: string; name: string; licence: string; attribution: string; skills: number };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function get<T>(path: string): Promise<T | null> {
  try { const r = await fetch(`/api/v0/${path}`, { cache: "no-store" }); return r.ok ? await r.json() as T : null; } catch { return null; }
}

export function SkillPicker({ skills, canEdit, role, onSave, empty, label = "Skills" }: {
  skills: string[]; canEdit: boolean; role?: string | null; onSave: (next: string[]) => Promise<boolean>;
  /** What an empty list says to someone who cannot edit it. */ empty?: string; label?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [list, setList] = useState(skills);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [suggest, setSuggest] = useState<Found[]>([]);
  const [about, setAbout] = useState<About[]>([]);
  const [at, setAt] = useState(-1);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  // The editor starts from the saved skills each time it opens.
  const open = () => { setList(skills); setQ(""); setFound([]); setAt(-1); setEditing(true); };
  // Suggestions for the role once the editor opens; the list's licence words once.
  useEffect(() => {
    if (!editing) return;
    let live = true;
    void get<{ skills: Found[] }>(`account/skill-library/suggest?role=${encodeURIComponent(role ?? "")}&have=${encodeURIComponent(list.join("|"))}`).then((d) => { if (live) setSuggest(d?.skills ?? []); });
    if (!about.length) void get<{ sources: About[] }>("account/skill-library/about").then((d) => { if (live) setAbout(d?.sources ?? []); });
    input.current?.focus();
    // The editor and its list come into view (the list opens under the box).
    input.current?.closest("[data-skill-editor]")?.scrollIntoView({ block: "center", behavior: "smooth" });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- asked once per opening; the list changes while it is open
  }, [editing, role]);
  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    let live = true;
    const t = window.setTimeout(() => { void get<{ skills: Found[] }>(`account/skill-library?q=${encodeURIComponent(term)}&limit=4`).then((d) => { if (live) { setFound(d?.skills ?? []); setAt(-1); } }); }, 140);
    return () => { live = false; window.clearTimeout(t); };
  }, [q]);

  const add = (s: string) => { const v = s.trim().replace(/\s+/g, " ").slice(0, 60); if (v && !list.some((x) => same(x, v))) setList([...list, v]); setQ(""); setFound([]); input.current?.focus(); };
  const remove = (s: string) => setList(list.filter((x) => x !== s));
  const changed = list.length !== skills.length || list.some((s, i) => s !== skills[i]);
  const close = () => { setEditing(false); setQ(""); setFound([]); setList(skills); };
  const save = async () => {
    if (!changed) { close(); return; }
    setBusy(true);
    const ok = await onSave(list).catch(() => false);
    setBusy(false);
    if (ok) { setEditing(false); setQ(""); setFound([]); }
  };
  const shown = q.trim() ? found.filter((f) => !list.some((x) => same(x, f.label))) : [];
  const custom = q.trim() && !shown.some((f) => same(f.label, q)) && !list.some((x) => same(x, q)) ? q.trim() : null;
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = shown.length + (custom ? 1 : 0);
    if (e.key === "ArrowDown" && n) { e.preventDefault(); setAt((at + 1) % n); }
    else if (e.key === "ArrowUp" && n) { e.preventDefault(); setAt((at - 1 + n) % n); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (at >= 0 && at < shown.length) add(shown[at].label);
      else if (q.trim()) add(q);
      else void save();
    } else if (e.key === "Escape") { e.preventDefault(); if (q) setQ(""); else close(); }
    else if (e.key === "Backspace" && !q && list.length) remove(list[list.length - 1]);
  };

  if (!editing) {
    return <div className={css.view} data-skill-view="" data-editable={canEdit ? "" : undefined}>
      {skills.length ? <ul className={css.chips} aria-label={label}>{skills.map((s) => <li key={s} className={css.chip}>{s}</li>)}
        {canEdit ? <li className={css.editItem}><button type="button" className={`${css.chip} ${css.add}`} onClick={open} aria-label={`Add or change ${label.toLowerCase()}`}><Plus size={12} aria-hidden="true" />Add skill</button></li> : null}</ul>
        : <p className={css.empty}>{canEdit ? "No skills yet. Add the ones you use at work." : (empty ?? "No skills listed yet.")}</p>}
      {canEdit && !skills.length ? <button type="button" className={`${css.chip} ${css.add}`} onClick={open} aria-label={`Add ${label.toLowerCase()}`}><Plus size={12} aria-hidden="true" />Add skill</button> : null}
      {canEdit && skills.length ? <button type="button" className={css.cover} tabIndex={-1} aria-hidden="true" onClick={open} /> : null}
    </div>;
  }
  // PROFILE-2 (judge: "no clear Done"): Cancel and Save sit above the box, so an open list never hides them.
  return <div className={css.editor} data-skill-editor="">
    <div className={css.foot}>
      <small className={css.hint}>Type a skill, pick one, or press Enter to add your own.</small>
      <span className={css.actions}>
        <button type="button" className={css.quiet} onClick={close} disabled={busy}>Cancel</button>
        <button type="button" className={css.primary} onClick={() => void save()} disabled={busy}><Check size={14} aria-hidden="true" />{busy ? "Saving…" : "Save"}</button>
      </span>
    </div>
    <div className={css.anchor}>
    <div className={css.box} onClick={() => input.current?.focus()}>
      {list.map((s) => <span key={s} className={`${css.chip} ${css.on}`}>{s}<button type="button" aria-label={`Remove ${s}`} onClick={(e) => { e.stopPropagation(); remove(s); }}><X size={12} aria-hidden="true" /></button></span>)}
      <input ref={input} className={css.input} value={q} onChange={(e) => { setQ(e.target.value); setAt(-1); }} onKeyDown={keys} maxLength={60}
        placeholder={list.length ? "Add another skill" : "Type a skill, e.g. Video editing"} aria-label="Find or add a skill"
        role="combobox" aria-expanded={shown.length > 0 || !!custom} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={at >= 0 ? `${listId}-${at}` : undefined} />
    </div>
    {shown.length || custom ? <ul className={css.menu} id={listId} role="listbox" aria-label="Matching skills">
      {shown.map((f, i) => <li key={f.id} id={`${listId}-${i}`} role="option" aria-selected={i === at} className={css.option} data-on={i === at ? "" : undefined}
        onMouseDown={(e) => { e.preventDefault(); add(f.label); }}><span>{f.label}</span></li>)}
      {custom ? <li id={`${listId}-${shown.length}`} role="option" aria-selected={at === shown.length} className={css.option} data-on={at === shown.length ? "" : undefined}
        onMouseDown={(e) => { e.preventDefault(); add(custom); }}><span><Plus size={13} aria-hidden="true" /> Add “{custom}” as a new skill</span></li> : null}
    </ul> : null}
    </div>
    {!q && suggest.filter((s) => !list.some((x) => same(x, s.label))).length ? <div className={css.suggest}>
      <p><Sparkles size={13} aria-hidden="true" />{role ? `Often used by a ${role.toLowerCase()}` : "Suggested for you"}</p>
      <div className={css.chips}>{suggest.filter((s) => !list.some((x) => same(x, s.label))).slice(0, 10).map((s) => <button key={s.id} type="button" className={`${css.chip} ${css.add}`} onClick={() => add(s.label)}><Plus size={12} aria-hidden="true" />{s.label}</button>)}</div>
    </div> : null}
    <small className={css.credit}>{about.some((a) => a.id.startsWith("onet")) ? "Skills list includes O*NET data (USDOL/ETA), CC BY 4.0." : "Pick from the list or type your own."}</small>
  </div>;
}
