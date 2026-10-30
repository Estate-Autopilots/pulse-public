"use client";
// PORTAL-2: one deliverable for approval, for the client (approve / ask for changes) and for the team (reply, resolve,
// a new version, withdraw). Comments are pinned to a point of a picture (tap it), a moment of a video or audio
// ("Comment at 0:12"), a page of a document, or on the whole. Versions stay: older ones open read-only.
import { ArrowLeft, Check, CheckCircle2, Download, ExternalLink, FileText, Link2, MessageSquare, MonitorPlay, RotateCcw, Upload, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { embedUrl, moment, size } from "../../lib/client-pay.mjs";
import css from "../client.module.css";
import { uploadFile } from "../upload";

export type Version = { version: number; name: string; mime: string | null; size: number | null; url: string | null; fileId: string | null; note: string | null;
  at: string; by: string | null; decision: "approved" | "changes" | null; decidedAt: string | null };
export type Comment = { id: string; version: number; body: string; x: number | null; y: number | null; at: number | null; page: number | null; side: "client" | "team";
  by: string | null; mine: boolean; resolvedAt: string | null; createdAt: string };
export type Deliverable = { id: string; title: string; kind: string; note: string | null; state: "waiting" | "approved" | "changes" | "withdrawn"; version: number;
  sharedAt: string; sharedBy: string | null; answerBy: string | null; project: { id: string; title: string } | null; owner: { id: string; name: string } | null;
  decidedAt: string | null; decidedName: string | null; decisionNote: string | null; updatedAt: string; seenAt?: string | null; taskId?: string | null;
  client?: { id: string; name: string } | null; versions: Version[]; comments: Comment[]; provider?: string; me?: string };

const ZONE = "Asia/Kolkata";
export const when = (s: string | null | undefined) => s ? new Date(s.length === 10 ? `${s}T12:00:00+05:30` : s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: s.length === 10 ? undefined : "numeric", minute: s.length === 10 ? undefined : "2-digit", timeZone: ZONE }) : "";
export const STATE: Record<Deliverable["state"], [string, string]> = { waiting: ["Waiting for an answer", "info"], approved: ["Approved", "ok"], changes: ["Changes asked", "warn"], withdrawn: ["Withdrawn", "muted"] };

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "That did not work. Try again.");
  return data as T;
}

type Draft = { x?: number; y?: number; at?: number };

export function Review({ data: initial, side, back }: { data: Deliverable; side: "client" | "team"; back?: { href: string; label: string } }) {
  const [d, setD] = useState(initial);
  const [shown, setShown] = useState(initial.version);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const api = side === "client" ? "client-portal/deliverables" : "client-deliverables";
  const fileBase = side === "client" ? "/api/v0/client-portal/files" : "/api/v0/client-files";
  const v = d.versions.find((x) => x.version === shown) ?? d.versions[0];
  const current = shown === d.version;
  const comments = useMemo(() => d.comments.filter((c) => c.version === shown), [d.comments, shown]);
  const number = (c: Comment) => comments.indexOf(c) + 1;
  const reload = async () => {
    const r = await fetch(`/api/v0/${side === "client" ? "client-portal/deliverables" : "client-deliverables"}/${d.id}`, { cache: "no-store" });
    if (r.ok) { const next = await r.json() as Deliverable; setD(next); return next; }
    return d;
  };
  const src = v?.fileId ? `${fileBase}/${v.fileId}` : null;
  const kind = v?.mime?.startsWith("image/") ? "image" : v?.mime?.startsWith("video/") ? "video" : v?.mime?.startsWith("audio/") ? "audio" : v?.mime === "application/pdf" ? "pdf" : v?.url ? "link" : "file";
  const frame = v?.url ? embedUrl(v.url) : null;
  const pinAt = (e: MouseEvent<HTMLDivElement>) => {
    if (!current || d.state === "withdrawn") return;
    const box = e.currentTarget.getBoundingClientRect();
    setDraft({ x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)) });
  };
  const atNow = () => { const t = media.current?.currentTime ?? 0; media.current?.pause(); setDraft({ at: Math.round(t * 10) / 10 }); };
  const seek = (c: Comment) => { setFocus(c.id); if (c.at !== null && media.current) { media.current.currentTime = c.at; void media.current.play().catch(() => {}); } };

  return <div className={css.page}>
    <header className={css.reviewHead}>
      {back ? <Link href={back.href} className={css.linkBtn}><ArrowLeft size={15} aria-hidden="true" />{back.label}</Link> : null}
      <div className={css.cardHead}>
        <h2 className={css.reviewTitle}>{d.title}</h2>
        <span className={css.pill} data-tone={STATE[d.state][1]}>{side === "client" && d.state === "waiting" ? "Waiting for you" : STATE[d.state][0]}</span>
      </div>
      <p className={css.meta}>{[d.project?.title, d.sharedBy ? `Shared by ${d.sharedBy} ${when(d.sharedAt)}` : `Shared ${when(d.sharedAt)}`, d.answerBy && d.state === "waiting" ? `Answer by ${when(d.answerBy)}` : null,
        side === "team" && d.owner ? `${d.owner.name} hears the answer` : null, side === "team" ? (d.seenAt ? `Seen ${when(d.seenAt)}` : "Not opened yet") : null].filter(Boolean).join(" · ")}</p>
      {d.note ? <p className={css.quote}>{d.note}</p> : null}
      {d.versions.length > 1 ? <div className={css.chips} role="radiogroup" aria-label="Versions">
        {d.versions.map((x) => <button key={x.version} type="button" role="radio" aria-checked={x.version === shown} className={css.chip} onClick={() => { setShown(x.version); setDraft(null); }}>
          v{x.version}{x.version === d.version ? " · latest" : x.decision === "changes" ? " · changes asked" : x.decision === "approved" ? " · approved" : ""}</button>)}
      </div> : null}
    </header>
    {note ? <p className={css.note} data-tone={note.tone} role={note.tone === "error" ? "alert" : "status"}>{note.text}</p> : null}

    <div className={css.reviewGrid}>
      <section className={css.stageWrap} aria-label={`Version ${shown}`}>
        {!current ? <p className={css.fine}>You are looking at version {shown}. The latest is version {d.version}.</p> : null}
        {kind === "image" && src ? <div className={css.stage} onClick={pinAt} role="presentation" data-pinnable={current && d.state !== "withdrawn" ? "" : undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a private file streamed by the API */}
          <img src={src} alt={v.name} />
          {comments.filter((c) => c.x !== null).map((c) => <button key={c.id} type="button" className={css.pin} data-done={c.resolvedAt ? "" : undefined} data-focus={focus === c.id ? "" : undefined}
            style={{ left: `${(c.x ?? 0) * 100}%`, top: `${(c.y ?? 0) * 100}%` }} onClick={(e) => { e.stopPropagation(); setFocus(c.id); document.getElementById(`c-${c.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }}
            aria-label={`Comment ${number(c)}: ${c.body}`}>{number(c)}</button>)}
          {draft?.x !== undefined ? <span className={css.pin} data-draft="" style={{ left: `${draft.x * 100}%`, top: `${(draft.y ?? 0) * 100}%` }} aria-hidden="true">+</span> : null}
        </div> : null}
        {kind === "video" && src ? <video ref={media} className={css.player} src={src} controls playsInline preload="metadata" /> : null}
        {kind === "audio" && src ? <audio ref={media} className={css.audio} src={src} controls preload="metadata" /> : null}
        {/* Phones do not draw a PDF inside a page: they get the file card, a computer the document itself. */}
        {kind === "pdf" && src ? <>
          <iframe className={css.doc} data-pdf="" src={src} title={v.name} />
          <div className={`${css.fileCard} ${css.pdfCard}`}><FileText size={22} aria-hidden="true" /><span className={css.itemMain}><b>{v.name}</b><small>PDF{v.size ? ` · ${size(v.size)}` : ""}</small></span>
            <a className={`${css.btn} ${css.primary}`} href={src} target="_blank" rel="noreferrer"><ExternalLink size={15} aria-hidden="true" />Open the PDF</a></div>
        </> : null}
        {kind === "link" && v?.url ? frame ? <iframe className={css.doc} src={frame} title={v.name} allow="autoplay; fullscreen" allowFullScreen referrerPolicy="no-referrer" />
          : <div className={css.fileCard}><Link2 size={22} aria-hidden="true" /><span className={css.itemMain}><b>{v.name}</b><small>{v.url}</small></span>
            <a className={`${css.btn} ${css.primary}`} href={v.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={15} aria-hidden="true" />Open</a></div> : null}
        {kind === "file" && src ? <div className={css.fileCard}><FileText size={22} aria-hidden="true" /><span className={css.itemMain}><b>{v.name}</b><small>{v.size ? size(v.size) : ""}</small></span>
          <a className={`${css.btn} ${css.primary}`} href={src}><Download size={15} aria-hidden="true" />Download</a></div> : null}
        <div className={css.actions}>
          {kind === "image" && current && d.state !== "withdrawn" ? <p className={css.fine}>Tap the picture where something should change to pin a comment there.</p> : null}
          {(kind === "video" || kind === "audio") && current && d.state !== "withdrawn" ? <button type="button" className={css.btn} onClick={atNow}><MonitorPlay size={15} aria-hidden="true" />Comment at this moment</button> : null}
          {src && kind !== "file" ? <a className={`${css.btn} ${css.quiet}`} href={src} target="_blank" rel="noreferrer"><Download size={15} aria-hidden="true" />Open the file</a> : null}
          {v?.url && frame ? <a className={`${css.btn} ${css.quiet}`} href={v.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={15} aria-hidden="true" />Open the link</a> : null}
        </div>
        {v?.note ? <p className={css.meta}>Version {v.version}{v.by ? ` by ${v.by}` : ""}: {v.note}</p> : null}
      </section>

      <aside className={css.side} aria-label="Comments and answer">
        <section className={css.section} aria-labelledby="comments-h">
          <div className={css.sectionHead}><h2 id="comments-h"><MessageSquare size={16} aria-hidden="true" />Comments{comments.length ? <span className={css.count}>{comments.length}</span> : null}</h2></div>
          {comments.length ? <ol className={css.comments}>{comments.map((c) => <li key={c.id} id={`c-${c.id}`} data-side={c.side} data-done={c.resolvedAt ? "" : undefined} data-focus={focus === c.id ? "" : undefined}>
            <button type="button" className={css.commentPin} onClick={() => seek(c)} aria-label={`Show comment ${number(c)}`}>{number(c)}</button>
            <div className={css.itemMain}>
              <small>{c.by ?? "Someone"}{c.side === "team" && side === "client" ? " (team)" : ""} · {when(c.createdAt)}{c.at !== null ? ` · at ${moment(c.at)}` : ""}{c.page ? ` · page ${c.page}` : ""}{c.x !== null ? " · on the picture" : ""}</small>
              <p className={css.commentBody}>{c.body}</p>
            </div>
            {current && d.state !== "withdrawn" ? <button type="button" className={`${css.btn} ${css.quiet}`} aria-label={c.resolvedAt ? "Mark as not done" : "Mark as done"} title={c.resolvedAt ? "Done · mark as not done" : "Mark as done"}
              onClick={async () => { try { await post(`${side === "client" ? "client-portal/comments" : "client-deliverables/comments"}/${c.id}/resolve`, { done: !c.resolvedAt }); await reload(); } catch (e) { setNote({ tone: "error", text: (e as Error).message }); } }}>
              {c.resolvedAt ? <RotateCcw size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}</button> : null}
          </li>)}</ol> : <p className={css.empty}>{current ? (kind === "image" ? "No comments yet. Tap the picture to pin one, or write below." : "No comments yet.") : "No comments on this version."}</p>}
          {current && d.state !== "withdrawn" ? <CommentForm api={api} id={d.id} version={shown} draft={draft} pdf={kind === "pdf"} onClear={() => setDraft(null)}
            onSent={async () => { setDraft(null); await reload(); }} onError={(t) => setNote({ tone: "error", text: t })} /> : null}
        </section>
        {side === "client" ? <Answer d={d} current={current} onDone={async (t) => { await reload(); setNote({ tone: "ok", text: t }); }} />
          : <TeamTools d={d} onChanged={async (t) => { const next = await reload(); setShown(next.version); setNote({ tone: "ok", text: t }); }} />}
      </aside>
    </div>
  </div>;
}

function CommentForm({ api, id, version, draft, pdf, onClear, onSent, onError }: { api: string; id: string; version: number; draft: Draft | null; pdf: boolean;
  onClear: () => void; onSent: () => Promise<void>; onError: (t: string) => void }) {
  const [body, setBody] = useState(""), [page, setPage] = useState(""), [busy, setBusy] = useState(false);
  const send = async (e: FormEvent) => { e.preventDefault(); if (!body.trim()) return; setBusy(true);
    try { await post(`${api}/${id}/comments`, { body, version, ...(draft ?? {}), ...(pdf && page ? { page: Number(page) } : {}) }); setBody(""); setPage(""); await onSent(); }
    catch (err) { onError((err as Error).message); } finally { setBusy(false); } };
  return <form className={css.form} onSubmit={send} aria-label="Add a comment">
    {draft ? <p className={css.fine}>{draft.at !== undefined ? `At ${moment(draft.at)} of the video.` : "Pinned where you tapped."} <button type="button" className={css.linkBtn} onClick={onClear}>Not pinned</button></p> : null}
    <label className={css.field}>Your comment<textarea className={css.input} rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} placeholder="For example: make the logo bigger" required /></label>
    {pdf ? <label className={css.field}>Page <small>(optional)</small><input className={css.input} inputMode="numeric" pattern="[0-9]*" value={page} onChange={(e) => setPage(e.target.value.replace(/\D/g, "").slice(0, 4))} /></label> : null}
    <div className={css.actions}><button className={css.btn} disabled={busy || !body.trim()}>{busy ? "Sending…" : "Add comment"}</button></div>
  </form>;
}

function Answer({ d, current, onDone }: { d: Deliverable; current: boolean; onDone: (t: string) => Promise<void> }) {
  const [open, setOpen] = useState<"approved" | "changes" | null>(null), [name, setName] = useState(d.me ?? ""), [text, setText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const pinned = d.comments.filter((c) => c.version === d.version && c.side === "client" && !c.resolvedAt).length;
  if (d.state !== "waiting" || !current) {
    if (d.state === "waiting") return null;
    return <section className={css.section}><div className={css.cardHead}><CheckCircle2 size={18} aria-hidden="true" />
      <b>{d.state === "approved" ? `${d.decidedName ?? "You"} approved version ${d.version}` : d.state === "changes" ? `${d.decidedName ?? "You"} asked for changes to version ${d.version}` : "This was withdrawn"}</b></div>
      <p className={css.meta}>{when(d.decidedAt)}{d.state === "changes" ? ` · ${d.provider ?? "Your team"} is on it and will share a new version here.` : ""}</p>
      {d.decisionNote ? <p className={css.quote}>{d.decisionNote}</p> : null}</section>;
  }
  const send = async (e: FormEvent) => { e.preventDefault(); if (!open) return; setBusy(true); setError(null);
    try { await post(`client-portal/deliverables/${d.id}/answer`, { version: d.version, decision: open, name, note: text });
      await onDone(open === "approved" ? `Thank you. ${d.provider ?? "Your team"} has been told it is approved.` : `Sent. ${d.provider ?? "Your team"} has your comments and will share a new version.`); setOpen(null); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  return <section className={css.section} data-sticky="" aria-label="Your answer">
    <div className={css.actions}>
      <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => setOpen("approved")} aria-pressed={open === "approved"}><Check size={15} aria-hidden="true" />Approve</button>
      <button type="button" className={css.btn} onClick={() => setOpen("changes")} aria-pressed={open === "changes"}>Ask for changes{pinned ? ` (${pinned})` : ""}</button>
    </div>
    {open ? <form className={css.form} onSubmit={send}>
      {open === "approved" ? <label className={css.field}>Your name<input className={css.input} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} autoComplete="name" /></label>
        : <label className={css.field}>What should change? {pinned ? <small>(optional: your {pinned} {pinned === 1 ? "comment goes" : "comments go"} with it)</small> : null}
          <textarea className={css.input} rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} required={!pinned} /></label>}
      {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
      <div className={css.actions}><button className={`${css.btn} ${css.primary}`} disabled={busy}>{busy ? "Sending…" : open === "approved" ? `Approve version ${d.version}` : "Send to the team"}</button>
        <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setOpen(null)}>Back</button></div>
      {open === "approved" ? <p className={css.fine}>Approving records your name and the time against version {d.version}.</p> : null}
    </form> : null}
  </section>;
}

/** The team: send a new version (a file or a link), or withdraw it. */
export function TeamTools({ d, onChanged }: { d: Deliverable; onChanged: (t: string) => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null), [url, setUrl] = useState(""), [noteText, setNoteText] = useState(""), [share, setShare] = useState(0);
  if (d.state === "withdrawn") return null;
  const send = async (e: FormEvent) => { e.preventDefault(); setBusy("version"); setError(null);
    try {
      const fileId = file ? await uploadFile("/api/v0/client-files", file, { clientId: d.client?.id }, setShare) : null;
      const r = await post<{ version: number }>(`client-deliverables/${d.id}/versions`, { ...(fileId ? { fileId } : { url }), versionNote: noteText });
      setOpen(false); setFile(null); setUrl(""); setNoteText(""); setShare(0); await onChanged(`Version ${r.version} is in the client's space. They have been told.`);
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); } };
  return <section className={css.section} aria-label="Team">
    {d.taskId ? <Link className={css.item} href={`/tasks/${d.taskId}`}><CheckCircle2 size={18} aria-hidden="true" /><span className={css.itemMain}><b>The task for the changes</b><small>Made when the client asked for changes</small></span></Link> : null}
    <div className={css.actions}>
      <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => setOpen((x) => !x)} aria-expanded={open}><Upload size={15} aria-hidden="true" />Send a new version</button>
      <button type="button" className={`${css.btn} ${css.quiet}`} disabled={!!busy} onClick={async () => { if (!confirm("Withdraw it from the client's space?")) return; setBusy("withdraw");
        try { await post(`client-deliverables/${d.id}/withdraw`); await onChanged("Withdrawn. The client no longer sees it."); } catch (err) { setError((err as Error).message); } finally { setBusy(null); } }}><X size={15} aria-hidden="true" />Withdraw</button>
    </div>
    {open ? <form className={css.form} onSubmit={send}>
      <label className={css.field}>File <small>(up to 300 MB)</small><input className={css.input} type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      {!file ? <label className={css.field}>…or a link <small>(Drive, YouTube, Figma…)</small><input className={css.input} type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} /></label> : null}
      <label className={css.field}>What changed <small>(optional)</small><textarea className={css.input} rows={2} value={noteText} onChange={(e) => setNoteText(e.target.value)} maxLength={2000} /></label>
      {busy === "version" && file ? <progress className={css.progress} value={share} max={1} aria-label="Uploading" /> : null}
      {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
      <div className={css.actions}><button className={`${css.btn} ${css.primary}`} disabled={!!busy || (!file && !url)}>{busy === "version" ? (file ? `Uploading ${Math.round(share * 100)}%` : "Sharing…") : "Share version " + (d.version + 1)}</button></div>
    </form> : null}
    {!open && error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
  </section>;
}
