"use client";
// DOCS-DRIVE: the details panel (right, toggled with "Details" or the i key; a sheet on a phone). For a doc: its first
// words, who can see it, who read it, its versions, tags, the tasks, projects and contracts it is linked to, and "Ask AI
// about this doc" (an AI employee's chat opens with the doc's link written; the AI employee reads linked docs). For a
// folder: what it holds and who it is for. For a file: its size, who added it, and Open.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BookOpenCheck, Clock, ExternalLink, Eye, History, Link2, Lock, MessageSquare, Sparkles, Star, Tag, Users, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../orgs/client";
import { draftStore } from "../../chats/drafts";
import { FileOpen } from "../../components/file-viewer";
import { countWords } from "../../lib/docs-drive.mjs";
import { FolderGlyph, TypeChip, TypeIcon, typeOf } from "./parts";
import css from "./drive.module.css";

type Share = { personId: string; name: string; canEdit: boolean; canComment: boolean };
type Details = {
  doc: { id: string; title: string; access: "private" | "company" | "people"; owner: string | null; updatedAt: string; updatedBy: string | null; version: number; tags: string[]; category: string | null;
    canEdit: boolean; canShare: boolean; companyEdits: boolean; createdAt: string; folderId: string | null };
  preview: string; shares: Share[]; versions: { id: string; version: number; savedAt: string; savedBy: string | null; reason: string }[];
  links: { id: string; kind: string; label: string; href: string; role: string; hidden: boolean }[]; mentions: { kind: string; id: string; label: string }[];
  reads: { name: string; summary: string; readPct: number }[]; comments: { open: number; total: number }; path: { id: string; name: string; private: boolean }[]; starred: boolean;
};
export type Picked = { kind: "doc"; id: string; title: string } | { kind: "folder"; id: string; name: string; access: "company" | "people"; docs: number; files: number; folders: number; people: { name: string }[]; canShare: boolean }
  | { kind: "file"; id: string; name: string; mime: string; size: number; url: string; addedBy: string | null; addedAt: string };

const ago = (iso: string) => {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  if (m < 60 * 24 * 14) return `${Math.round(m / 1440)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
};
export { ago };
const REASON: Record<string, string> = { edit: "edited", create: "made it", import: "imported it", restore: "restored an older version" };
const HREF: Record<string, string> = { contract: "/contracts/", client: "/clients/", task: "/tasks/", project: "/projects/", goal: "/goals/" };
const ROLE = (s: Share) => s.canEdit ? "can edit" : s.canComment ? "can comment" : "can view";

function AskAI({ docId, title }: { docId: string; title: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [ais, setAis] = useState<{ id: string; label: string }[] | null>(null), [busy, setBusy] = useState(false);
  const load = () => {
    setOpen((o) => !o);
    if (ais) return;
    void fetch("/api/v0/docs/mentions?kinds=agent&q=", { cache: "no-store" }).then((r) => r.ok ? r.json() : { items: [] })
      .then((d: { items: { id: string; label: string }[] }) => setAis(d.items)).catch(() => setAis([]));
  };
  const ask = async (ai: { id: string; label: string }) => {
    setBusy(true);
    try {
      const chat = await post<{ id: string }>("chats/direct", { personId: ai.id });
      draftStore.set(chat.id, `About the doc “${title}” (${window.location.origin}/docs/${docId}): `);
      router.push(`/chats?channel=${chat.id}`);
    } catch (e) { notify({ id: "docs-ask", tone: "error", title: "Could not open the chat", message: e instanceof Error ? e.message : undefined }); setBusy(false); }
  };
  return <div className={css.menuWrap}>
    <button type="button" className={`${css.btn} ${css.ask}`} style={{ width: "100%" }} onClick={load} aria-expanded={open} disabled={busy}><Sparkles size={16} aria-hidden="true" />Ask AI about this doc</button>
    {open ? <div className={css.menu} role="menu" style={{ left: 0, right: 0, top: "auto", bottom: "calc(100% + 6px)" }}>
      <p className={css.menuNote}>Pick who answers. Their chat opens with this doc’s link written; add your question and send.</p>
      {ais === null ? <p className={css.menuNote}>Looking…</p> : ais.length ? ais.map((a) => <button key={a.id} type="button" role="menuitem" onClick={() => void ask(a)}><Sparkles size={15} aria-hidden="true" />{a.label}</button>)
        : <p className={css.menuNote}>Your company has no AI employees yet.</p>}
      <hr />
      <Link role="menuitem" href="/settings?tab=connect-ai"><ExternalLink size={15} aria-hidden="true" />Use your own Claude or ChatGPT</Link>
    </div> : null}
  </div>;
}

export function DetailsPanel({ picked, onClose, onStar, onFolderAccess }: { picked: Picked | null; onClose: () => void; onStar: (kind: "doc" | "folder", id: string, on: boolean) => void;
  onFolderAccess: (id: string) => void }) {
  const [d, setD] = useState<Details | null>(null), [error, setError] = useState<string | null>(null);
  const docId = picked?.kind === "doc" ? picked.id : null;
  useEffect(() => {
    if (!docId) return;
    let live = true;
    void fetch(`/api/v0/docs/${docId}/details`, { cache: "no-store" }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "Details are unavailable."); return j as Details; })
      .then((x) => { if (live) { setD(x); setError(null); } }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Details are unavailable."); });
    return () => { live = false; };
  }, [docId]);
  const head = (icon: React.ReactNode, title: string, extra?: React.ReactNode) => <div className={css.detailsHead}>{icon}<h2>{title}</h2>{extra}
    <button type="button" className={`${css.btn} ${css.icon} ${css.quiet}`} onClick={onClose} aria-label="Close details"><X size={18} aria-hidden="true" /></button></div>;
  if (!picked) return <aside className={css.details} aria-label="Details">
    {head(<Eye size={20} aria-hidden="true" />, "Details")}
    <p className={css.tileSub}>Pick a doc, folder or file to see its details here: who can see it, who read it, its versions and what it is linked to.</p>
  </aside>;
  if (picked.kind === "folder") return <aside className={css.details} aria-label={`Details of ${picked.name}`}>
    {head(<FolderGlyph size={22} />, picked.name)}
    <ul className={css.facts}>
      <li><span className={css.factHead}>Holds<small>{countWords({ docs: picked.docs, folders: picked.folders, files: picked.files })}</small></span></li>
      <li><span className={css.factHead}>{picked.access === "people" ? <Lock size={15} aria-hidden="true" /> : <Users size={15} aria-hidden="true" />}Who can see
        <small>{picked.access === "people" ? `Only ${picked.people.map((p) => p.name).join(", ")}` : "Everyone in the company"}</small></span>
        <span className={css.tileSub}>{picked.access === "people" ? "Everything inside is hidden from everyone else, admins too." : "Each doc inside keeps its own sharing too."}</span>
        {picked.canShare ? <button type="button" className={`${css.btn} ${css.small}`} onClick={() => onFolderAccess(picked.id)}><Users size={14} aria-hidden="true" />Change who can see</button> : null}</li>
    </ul>
    <Link href={`/docs?folder=${picked.id}`} className={`${css.btn} ${css.primary}`}>Open folder</Link>
  </aside>;
  if (picked.kind === "file") return <aside className={css.details} aria-label={`Details of ${picked.name}`}>
    {head(<TypeIcon type="doc" />, picked.name)}
    <ul className={css.facts}>
      <li><span className={css.factHead}>Added<small>{picked.addedBy ? `${picked.addedBy}, ` : ""}{ago(picked.addedAt)}</small></span></li>
      <li><span className={css.factHead}>Size<small>{picked.size >= 1048576 ? `${(picked.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(picked.size / 1024))} KB`}</small></span></li>
    </ul>
    <FileOpen file={{ url: picked.url, name: picked.name, mime: picked.mime, size: picked.size }} className={`${css.btn} ${css.primary}`}>Open</FileOpen>
  </aside>;
  const x = d && d.doc.id === picked.id ? d : null;
  const type = typeOf(x?.doc.category);
  return <aside className={css.details} aria-label={`Details of ${picked.title}`} aria-busy={!x && !error}>
    {head(<TypeIcon type={type} size={18} />, x?.doc.title ?? picked.title,
      x ? <button type="button" className={`${css.btn} ${css.icon} ${css.quiet}`} aria-pressed={x.starred} aria-label={x.starred ? "Take the star off" : "Star it"}
        onClick={() => { onStar("doc", x.doc.id, !x.starred); setD({ ...x, starred: !x.starred }); }}><Star size={18} className={x.starred ? css.starOn : undefined} fill={x.starred ? "currentColor" : "none"} aria-hidden="true" /></button> : null)}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    {!x && !error ? <><div className={css.skel} style={{ height: 180 }} /><div className={css.skel} style={{ height: 22 }} /><div className={css.skel} style={{ height: 22, width: "70%" }} /></> : null}
    {x ? <>
      <div className={css.chips}><TypeChip type={type} />{x.path.length ? <span className={css.tileSub}>in {x.path.map((p) => p.name).join(" / ")}</span> : <span className={css.tileSub}>in My Docs</span>}</div>
      <Link href={`/docs/${x.doc.id}`} className={css.preview} aria-label={`Open ${x.doc.title}`} style={{ color: "inherit", textDecoration: "none", display: "block" }}>
        <div dangerouslySetInnerHTML={{ __html: x.preview || "<p><em>No words yet.</em></p>" }} /></Link>
      <ul className={css.facts}>
        <li><span className={css.factHead}>{x.doc.access === "private" ? <Lock size={15} aria-hidden="true" /> : <Users size={15} aria-hidden="true" />}Who can see
          <small>{x.doc.access === "private" ? "Only the owner" : x.doc.access === "company" ? (x.path.some((p) => p.private) ? `People in ${x.path.filter((p) => p.private).at(-1)?.name}` : "Everyone in the company") : `${x.shares.length} ${x.shares.length === 1 ? "person" : "people"}`}</small></span>
          {x.doc.access === "people" && x.shares.length ? <ul className={css.factList}>{x.shares.slice(0, 8).map((s) => <li key={s.personId}><span>{s.name}</span><span className={css.muted}>{ROLE(s)}</span></li>)}</ul> : null}
          <span className={css.tileSub}>Owner: {x.doc.owner ?? "someone"}{x.doc.access === "company" ? x.doc.companyEdits ? " · everyone who sees it can edit" : " · others can read" : ""}</span>
          {x.doc.canShare ? <Link href={`/docs/${x.doc.id}?share=1`} className={`${css.btn} ${css.small}`}><Users size={14} aria-hidden="true" />Share</Link> : null}</li>
        <li><span className={css.factHead}><BookOpenCheck size={15} aria-hidden="true" />Activity<small>{x.comments.open ? `${x.comments.open} open ${x.comments.open === 1 ? "comment" : "comments"}` : ""}</small></span>
          <span className={css.tileSub}><Clock size={12} aria-hidden="true" /> Changed {ago(x.doc.updatedAt)}{x.doc.updatedBy ? ` by ${x.doc.updatedBy}` : ""}</span>
          {x.reads.length ? <ul className={css.factList}>{x.reads.slice(0, 6).map((r) => <li key={r.name}><span>{r.name}</span><span className={css.muted}>{r.summary}</span></li>)}</ul>
            : x.doc.canShare ? <span className={css.tileSub}>Nobody it was sent to has read it yet. Send it from the doc to see who reads it.</span> : null}</li>
        <li><span className={css.factHead}><History size={15} aria-hidden="true" />Versions<small>version {x.doc.version}</small></span>
          <ul className={css.factList}>{x.versions.slice(0, 4).map((v) => <li key={v.id}><span>{v.savedBy ?? "Someone"} {REASON[v.reason] ?? "saved it"}</span><span className={css.muted}>{ago(v.savedAt)}</span></li>)}</ul>
          <Link href={`/docs/${x.doc.id}?history=1`} className={css.tileSub}>See all versions</Link></li>
        <li><span className={css.factHead}><Tag size={15} aria-hidden="true" />Tags</span>
          {x.doc.tags.length ? <ul className={css.tags}>{x.doc.tags.map((t) => <li key={t}><Link className={css.tag} href={`/docs?tag=${encodeURIComponent(t)}`}>{t}</Link></li>)}</ul> : <span className={css.tileSub}>No tags yet.</span>}</li>
        <li><span className={css.factHead}><Link2 size={15} aria-hidden="true" />Linked</span>
          {x.links.length || x.mentions.length ? <ul className={css.factList}>
            {x.links.map((l) => <li key={l.id}>{l.hidden ? <span>Hidden from you</span> : <Link href={l.href}>{l.label}</Link>}<span className={css.muted}>{l.role === "brief" ? `${l.kind}'s brief` : l.kind}</span></li>)}
            {x.mentions.filter((m) => !x.links.some((l) => l.href.endsWith(m.id))).slice(0, 8).map((m) => <li key={`${m.kind}:${m.id}`}><Link href={`${HREF[m.kind] ?? "/"}${m.id}`}>{m.label}</Link><span className={css.muted}>{m.kind}</span></li>)}
          </ul> : <span className={css.tileSub}>Not linked to a task, project or contract yet.</span>}</li>
      </ul>
      <div className={css.titleRow}><Link href={`/docs/${x.doc.id}`} className={`${css.btn} ${css.primary}`} style={{ flex: 1 }}>Open</Link>
        <Link href={`/docs/${x.doc.id}?comments=1`} className={css.btn}><MessageSquare size={15} aria-hidden="true" />Comments</Link></div>
      <AskAI docId={x.doc.id} title={x.doc.title} />
    </> : null}
  </aside>;
}
