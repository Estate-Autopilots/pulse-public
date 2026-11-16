"use client";
// DOCS-DRIVE: the small parts the Drive page shares: each doc type's icon and colour, and the dialogs it opens (move to a
// folder, add a tag, share, and "are you sure" for a move that lets more people see something). The dialogs are native
// <dialog> (top layer, Esc closes, focus stays inside); when UI-DIALOGS' shared useConfirm lands, the confirm moves there.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, ChevronRight, FileSignature, FileText, Folder, Home, Lightbulb, ListChecks, Lock, Map as MapIcon, ShieldCheck, Tag as TagIcon, Tags } from "lucide-react";
import { DOC_TYPES, descendants, docType } from "../../lib/docs-drive.mjs";
import css from "./drive.module.css";

export type DocType = keyof typeof DOC_TYPES;
const TYPE_ICON: Record<DocType, typeof FileText> = { doc: FileText, meeting: CalendarDays, sop: ListChecks, offer: Tags, contract: FileSignature, policy: ShieldCheck, plan: MapIcon, brief: Lightbulb };

/** A doc type's icon in its colour, on a soft tile of the same colour. */
export function TypeIcon({ type, size = 16 }: { type: DocType; size?: number }) {
  const I = TYPE_ICON[type] ?? FileText;
  return <span className={css.typeIcon} style={{ ["--t" as string]: DOC_TYPES[type].colour }} aria-hidden="true"><I size={size} /></span>;
}
export const typeOf = (category: string | null | undefined) => docType(category) as DocType;
export function TypeChip({ type }: { type: DocType }) {
  return <span className={css.typeChip} style={{ ["--t" as string]: DOC_TYPES[type].colour }}>{DOC_TYPES[type].label}</span>;
}
export const FolderGlyph = ({ size = 18 }: { size?: number }) => <Folder size={size} className={css.folderIcon} fill="currentColor" fillOpacity={0.35} aria-hidden="true" />;

/** A native dialog: opens as it mounts, Esc or the backdrop closes it. */
export function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => { if (d?.open) d.close(); };
  }, []);
  return <dialog ref={ref} className={css.dialog} aria-label={label} onCancel={(e) => { e.preventDefault(); onClose(); }}
    onClick={(e) => { if (e.target === ref.current) onClose(); }}>
    <div className={css.dialogBody}>{children}</div>
  </dialog>;
}

/** "Are you sure?" with one clear verb. */
export function Confirm({ title, body, yes, onYes, onNo }: { title: string; body: string; yes: string; onYes: () => void; onNo: () => void }) {
  return <Dialog label={title} onClose={onNo}>
    <h2>{title}</h2>
    <p>{body}</p>
    <div className={css.dialogFoot}>
      <button type="button" className={`${css.btn} ${css.quiet}`} onClick={onNo}>Cancel</button>
      <button type="button" className={`${css.btn} ${css.primary}`} onClick={onYes} autoFocus>{yes}</button>
    </div>
  </Dialog>;
}

type F = { id: string; name: string; parentId: string | null; access?: "company" | "people" };
/** Move to…: pick a folder (or the top of My Docs). Folders being moved, and their own folders, cannot be picked. */
export function MoveDialog({ folders, moving, count, here, onPick, onClose }: { folders: F[]; moving: string[]; count: number; here: string | null; onPick: (to: string | null) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const blocked = new Set<string>(moving);
  for (const id of moving) for (const d of descendants(folders, id)) blocked.add(d);
  const rows: { f: F; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    if (depth > 12) return;
    for (const f of folders.filter((x) => x.parentId === parent).sort((a, b) => a.name.localeCompare(b.name))) { rows.push({ f, depth }); walk(f.id, depth + 1); }
  };
  walk(null, 0);
  const shown = q.trim() ? rows.filter((r) => r.f.name.toLowerCase().includes(q.trim().toLowerCase())).map((r) => ({ ...r, depth: 0 })) : rows;
  return <Dialog label="Move to a folder" onClose={onClose}>
    <h2>Move {count === 1 ? "it" : `${count} things`} to…</h2>
    <label className={css.field}>Find a folder<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a folder name" autoFocus /></label>
    <ul className={css.pick}>
      {!q.trim() ? <li><button type="button" onClick={() => onPick(null)} disabled={here === null && !moving.length}><Home size={16} aria-hidden="true" />My Docs (no folder)</button></li> : null}
      {shown.map(({ f, depth }) => <li key={f.id}><button type="button" style={{ paddingLeft: 10 + depth * 16 }} disabled={blocked.has(f.id)} onClick={() => onPick(f.id)}
        aria-pressed={here === f.id}>{depth ? <ChevronRight size={12} aria-hidden="true" /> : null}<FolderGlyph size={16} />{f.name}
        {f.access === "people" ? <Lock size={13} className={css.lock} aria-label="Private folder" /> : null}</button></li>)}
      {!shown.length ? <li className={css.menuNote}>No folder has that name.</li> : null}
    </ul>
    <div className={css.dialogFoot}><button type="button" className={`${css.btn} ${css.quiet}`} onClick={onClose}>Cancel</button></div>
  </Dialog>;
}

/** Add a tag to the docs chosen (suggestions are the company's tags, most used first). */
export function TagDialog({ count, suggestions, onPick, onClose }: { count: number; suggestions: string[]; onPick: (tag: string) => void; onClose: () => void }) {
  const [t, setT] = useState("");
  const clean = t.trim().toLowerCase().replace(/^#+/, "");
  const shown = suggestions.filter((s) => !clean || s.includes(clean)).slice(0, 12);
  return <Dialog label="Add a tag" onClose={onClose}>
    <h2>Add a tag to {count === 1 ? "this doc" : `${count} docs`}</h2>
    <form onSubmit={(e) => { e.preventDefault(); if (clean) onPick(clean); }} style={{ display: "contents" }}>
      <label className={css.field}>Tag<input value={t} maxLength={40} onChange={(e) => setT(e.target.value)} placeholder="offer, sop, stage 2…" autoFocus /></label>
      {shown.length ? <div className={css.chips}>{shown.map((s) => <button key={s} type="button" className={css.chip} onClick={() => onPick(s)}><TagIcon size={12} aria-hidden="true" />{s}</button>)}</div> : null}
      <div className={css.dialogFoot}>
        <button type="button" className={`${css.btn} ${css.quiet}`} onClick={onClose}>Cancel</button>
        <button type="submit" className={`${css.btn} ${css.primary}`} disabled={!clean}>Add tag</button>
      </div>
    </form>
  </Dialog>;
}

export type Role = "view" | "comment" | "edit";
export const ROLE_WORDS: Record<Role, string> = { view: "Can view", comment: "Can comment", edit: "Can edit" };
type Person = { personId: string; name: string; role: Role };
/** Share the docs chosen: only me, everyone who can open their folder, or chosen people who view, comment or edit. */
export function ShareDialog({ count, folderName, onShare, onClose }: { count: number; folderName: string | null;
  onShare: (s: { access: "private" | "company" | "people"; people: { personId: string; role: Role }[] }) => void; onClose: () => void }) {
  const [access, setAccess] = useState<"private" | "company" | "people">("company");
  const [people, setPeople] = useState<Person[]>([]);
  const [q, setQ] = useState(""), [found, setFound] = useState<{ personId: string; name: string }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = (v: string) => {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    if (!v.trim()) { setFound([]); return; }
    timer.current = setTimeout(() => {
      void fetch(`/api/v0/docs/mentions?kinds=person,agent&q=${encodeURIComponent(v.trim())}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : { items: [] })
        .then((d: { items: { id: string; label: string }[] }) => setFound(d.items.map((x) => ({ personId: x.id, name: x.label }))))
        .catch(() => setFound([]));
    }, 220);
  };
  const add = (p: { personId: string; name: string }) => { setPeople((x) => x.some((y) => y.personId === p.personId) ? x : [...x, { ...p, role: "comment" }]); setQ(""); setFound([]); };
  return <Dialog label="Share" onClose={onClose}>
    <h2>Share {count === 1 ? "this doc" : `${count} docs`}</h2>
    <label className={css.radio}><input type="radio" name="dd-share" checked={access === "company"} onChange={() => setAccess("company")} />
      <span><b>{folderName ? `Everyone who can open “${folderName}”` : "Everyone in the company"}</b><br /><span className={css.tileSub}>They can read and edit it. A private folder keeps it to its people.</span></span></label>
    <label className={css.radio}><input type="radio" name="dd-share" checked={access === "people"} onChange={() => setAccess("people")} />
      <span><b>Only the people I choose</b><br /><span className={css.tileSub}>Each one can view, comment or edit.</span></span></label>
    <label className={css.radio}><input type="radio" name="dd-share" checked={access === "private"} onChange={() => setAccess("private")} />
      <span><b>Only me</b><br /><span className={css.tileSub}>Nobody else sees it.</span></span></label>
    {access === "people" ? <>
      <ul className={css.people}>{people.map((p) => <li key={p.personId}><span>{p.name}</span>
        <select aria-label={`What ${p.name} can do`} value={p.role} onChange={(e) => setPeople((x) => x.map((y) => y.personId === p.personId ? { ...y, role: e.target.value as Role } : y))}>
          {(Object.keys(ROLE_WORDS) as Role[]).map((r) => <option key={r} value={r}>{ROLE_WORDS[r]}</option>)}</select>
        <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => setPeople((x) => x.filter((y) => y.personId !== p.personId))} aria-label={`Remove ${p.name}`}>×</button></li>)}</ul>
      <label className={css.field}>Add a person<input value={q} onChange={(e) => search(e.target.value)} placeholder="Type a name" autoFocus /></label>
      {found.length ? <ul className={css.pick}>{found.slice(0, 6).map((p) => <li key={p.personId}><button type="button" onClick={() => add(p)}>{p.name}</button></li>)}</ul> : null}
    </> : null}
    <div className={css.dialogFoot}>
      <button type="button" className={`${css.btn} ${css.quiet}`} onClick={onClose}>Cancel</button>
      <button type="button" className={`${css.btn} ${css.primary}`} disabled={access === "people" && !people.length}
        onClick={() => onShare({ access, people: access === "people" ? people.map((p) => ({ personId: p.personId, role: p.role })) : [] })}>Share</button>
    </div>
  </Dialog>;
}
