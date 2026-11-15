"use client";
// DOCS-DRIVE: the left side. Places (My Docs, Shared with me, Recent, Starred, Archived), then the folder tree: open and
// close with the arrow (or ← →), drag a folder or doc onto a folder to move it, right-click or ⋯ for the folder's menu,
// and rename or make a folder right there (its name field is focused, no browser prompt). On a phone it is a drawer.
import Link from "next/link";
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { Archive, ChevronRight, Clock, Home, Lock, MoreHorizontal, Star, Users, X } from "lucide-react";
import { FolderGlyph } from "./parts";
import css from "./drive.module.css";

export type TreeFolder = { id: string; name: string; parentId: string | null; access: "company" | "people"; docs: number; files: number; canEdit: boolean };
export type Place = "home" | "shared" | "recent" | "starred" | "archived" | null;
export type DropProps = { target: string | null | undefined; over: (id: string | null | undefined) => void; drop: (id: string | null, e: DragEvent) => void; allowed: (id: string | null) => boolean;
  start: (key: string, e: DragEvent) => void };

/** A name typed in place: Enter keeps it, Esc leaves it, the whole name is selected to type over. */
export function NameField({ value, label, fresh, onDone, onCancel }: { value: string; label: string; fresh?: boolean; onDone: (name: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    if (keep && v.trim() && (fresh || v.trim() !== value)) onDone(v.trim()); else onCancel();
  };
  return <input ref={ref} className={css.nameEdit} value={v} maxLength={120} aria-label={label} onChange={(e) => setV(e.target.value)}
    onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); finish(true); } if (e.key === "Escape") { e.preventDefault(); finish(false); } }}
    onBlur={() => finish(true)} />;
}

function Node({ f, all, depth, current, open, toggle, drop, renaming, onRename, creatingIn, onCreate, onMenu, onNavigate }: {
  f: TreeFolder; all: TreeFolder[]; depth: number; current: string | null; open: Set<string>; toggle: (id: string, on?: boolean) => void; drop: DropProps;
  renaming: string | null; onRename: (id: string, name: string | null) => void; creatingIn: string | null | undefined; onCreate: (name: string | null) => void;
  onMenu: (id: string, x: number, y: number) => void; onNavigate: () => void }) {
  const kids = all.filter((x) => x.parentId === f.id).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const isOpen = open.has(f.id) || creatingIn === f.id;
  const hasKids = kids.length > 0 || creatingIn === f.id;
  const keys = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" && hasKids && !isOpen) { e.preventDefault(); toggle(f.id, true); }
    if (e.key === "ArrowLeft" && isOpen) { e.preventDefault(); toggle(f.id, false); }
    if (e.key === "F2" && f.canEdit) { e.preventDefault(); onRename(f.id, ""); }
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onMenu(f.id, r.left + 24, r.bottom); }
  };
  return <li role="treeitem" aria-expanded={hasKids ? isOpen : undefined} aria-selected={current === f.id} aria-level={depth + 1}>
    <div className={css.row} data-drop={drop.target === f.id ? "1" : undefined} style={{ paddingLeft: depth * 16 }}
      onDragOver={(e) => { if (drop.allowed(f.id)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; drop.over(f.id); } }}
      onDragLeave={() => drop.over(undefined)} onDrop={(e) => { e.preventDefault(); drop.drop(f.id, e); }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(f.id, e.clientX, e.clientY); }}>
      {hasKids ? <button type="button" className={css.twist} aria-expanded={isOpen} aria-label={isOpen ? `Close ${f.name}` : `Open ${f.name}`} tabIndex={-1} onClick={() => toggle(f.id)}>
        <ChevronRight size={15} aria-hidden="true" /></button> : <span className={css.twistGap} />}
      {renaming === f.id ? <NameField value={f.name} label="Folder name" onDone={(n) => onRename(f.id, n)} onCancel={() => onRename(f.id, null)} />
        : <Link href={`/docs?folder=${f.id}`} className={css.node} aria-current={current === f.id ? "page" : undefined} draggable={f.canEdit}
          onDragStart={(e) => drop.start(`folder:${f.id}`, e)} onKeyDown={keys} onClick={onNavigate}>
          <FolderGlyph size={17} /><span className={css.name} title={f.name}>{f.name}</span>
          {f.access === "people" ? <Lock size={13} className={css.lock} aria-label="Private folder" /> : null}</Link>}
      <button type="button" className={css.more} aria-label={`More for ${f.name}`} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onMenu(f.id, r.left, r.bottom + 4); }}>
        <MoreHorizontal size={16} aria-hidden="true" /></button>
    </div>
    {hasKids ? <div className={css.kids} data-open={isOpen ? "1" : "0"}><ul role="group">
      {isOpen ? <>
        {creatingIn === f.id ? <li><div className={css.row} style={{ paddingLeft: (depth + 1) * 16 + 24 }}><FolderGlyph size={17} /><NameField fresh value="Untitled folder" label="New folder name" onDone={onCreate} onCancel={() => onCreate(null)} /></div></li> : null}
        {kids.map((k) => <Node key={k.id} f={k} all={all} depth={depth + 1} current={current} open={open} toggle={toggle} drop={drop} renaming={renaming} onRename={onRename}
          creatingIn={creatingIn} onCreate={onCreate} onMenu={onMenu} onNavigate={onNavigate} />)}
      </> : null}
    </ul></div> : null}
  </li>;
}

export function Side({ folders, current, place, open, toggle, drop, renaming, onRename, creatingIn, onCreate, onMenu, drawer, onDrawer, extra }: {
  folders: TreeFolder[]; current: string | null; place: Place; open: Set<string>; toggle: (id: string, on?: boolean) => void; drop: DropProps;
  renaming: string | null; onRename: (id: string, name: string | null) => void; creatingIn: string | null | undefined; onCreate: (name: string | null) => void;
  onMenu: (id: string, x: number, y: number) => void; drawer: boolean; onDrawer: (open: boolean) => void; extra?: ReactNode }) {
  const tops = folders.filter((f) => !f.parentId || !folders.some((x) => x.id === f.parentId)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const close = () => onDrawer(false);
  const place_ = (p: Place, href: string, icon: ReactNode, label: string, dropId?: null) => <Link href={href} className={css.place} aria-current={place === p ? "page" : undefined} onClick={close}
    data-drop={dropId === null && drop.target === null ? "1" : undefined}
    onDragOver={dropId === null ? (e) => { if (drop.allowed(null)) { e.preventDefault(); drop.over(null); } } : undefined}
    onDragLeave={dropId === null ? () => drop.over(undefined) : undefined} onDrop={dropId === null ? (e) => { e.preventDefault(); drop.drop(null, e); } : undefined}>{icon}{label}</Link>;
  return <>
    <button type="button" className={css.backdrop} data-open={drawer ? "1" : "0"} aria-label="Close folders" onClick={close} tabIndex={drawer ? 0 : -1} />
    <nav className={css.side} data-open={drawer ? "1" : "0"} aria-label="Folders">
      <div className={css.drawerHead}>Folders<button type="button" className={`${css.btn} ${css.icon} ${css.quiet}`} onClick={close} aria-label="Close folders"><X size={18} aria-hidden="true" /></button></div>
      {place_("home", "/docs", <Home size={17} aria-hidden="true" />, "My Docs", null)}
      {place_("shared", "/docs?view=shared", <Users size={17} aria-hidden="true" />, "Shared with me")}
      {place_("recent", "/docs?view=recent", <Clock size={17} aria-hidden="true" />, "Recent")}
      {place_("starred", "/docs?view=starred", <Star size={17} aria-hidden="true" />, "Starred")}
      {place_("archived", "/docs?archived=1", <Archive size={17} aria-hidden="true" />, "Archived")}
      <hr className={css.rule} />
      <ul className={css.tree} role="tree" aria-label="Folder tree">
        {creatingIn === null ? <li><div className={css.row} style={{ paddingLeft: 24 }}><FolderGlyph size={17} /><NameField fresh value="Untitled folder" label="New folder name" onDone={onCreate} onCancel={() => onCreate(null)} /></div></li> : null}
        {tops.map((f) => <Node key={f.id} f={f} all={folders} depth={0} current={current} open={open} toggle={toggle} drop={drop} renaming={renaming} onRename={onRename}
          creatingIn={creatingIn} onCreate={onCreate} onMenu={onMenu} onNavigate={close} />)}
      </ul>
      {extra}
    </nav>
  </>;
}
