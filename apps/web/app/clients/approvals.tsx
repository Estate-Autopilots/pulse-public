"use client";
// PORTAL-2: a client page's Approvals tab. The team shares designs, videos, documents or links into the client's space
// for approval, sees each one's versions, what the client pinned on it and their answer, replies, and sends a new
// version. Who hears the answer is chosen per deliverable (the client's contact by default); asking for changes gives
// them a task. Nothing goes to anyone outside the client's people on Pulse.
import { ArrowRight, FileImage, FileText, Link2, Music, Paperclip, Send, Upload, Video } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import css from "../client/client.module.css";
import { Review, STATE, when, type Deliverable } from "../client/review/review";
import { uploadFile } from "../client/upload";

export type ApprovalsData = { onPulse: boolean; items: Deliverable[]; projects: { id: string; title: string }[]; owner: string | null; me: string | null; team: { id: string; name: string }[] };
const KIND_ICON = { image: FileImage, video: Video, audio: Music, document: FileText, link: Link2, other: Paperclip } as const;

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "That did not work. Try again.");
  return data as T;
}

export function ClientApprovals({ clientId, name, initial, open: openId }: { clientId: string; name: string; initial: ApprovalsData | null; open?: string }) {
  const [data, setData] = useState(initial);
  const [open, setOpen] = useState<string | null>(openId ?? null);
  const [sharing, setSharing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const reload = async () => { const r = await fetch(`/api/v0/clients/${clientId}/deliverables`, { cache: "no-store" }); if (r.ok) setData(await r.json()); };
  if (!data) return <p className={css.note} data-tone="error" role="alert">Approvals could not be read. Try again in a moment.</p>;
  const shown = data.items.find((d) => d.id === open);
  if (shown) return <div className={css.page} data-enter="">
    <Review key={shown.id + shown.updatedAt} data={shown} side="team" />
    <button type="button" className={css.linkBtn} onClick={async () => { setOpen(null); await reload(); }}>Back to all approvals for {name}</button>
  </div>;
  const waiting = data.items.filter((d) => d.state === "waiting").length;
  return <div className={css.page} data-enter="">
    <section className={css.section} aria-labelledby="approvals-h">
      <div className={css.sectionHead}>
        <h2 id="approvals-h">Shared for {name}&apos;s approval{data.items.length ? <span className={css.count}>{data.items.length}</span> : null}</h2>
        {data.onPulse ? <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => setSharing((x) => !x)} aria-expanded={sharing}><Upload size={15} aria-hidden="true" />Share for approval</button> : null}
      </div>
      <p className={css.meta}>{data.onPulse ? `${waiting ? `${waiting} waiting for their answer. ` : ""}They see these in their space, comment on the file and approve or ask for changes; the person you choose hears it, and asking for changes makes them a task.`
        : `Nobody of ${name} is on Pulse yet. Invite them in the Pulse access tab, then share creatives here for their approval.`}</p>
      {note ? <p className={css.note} data-tone="ok" role="status">{note}</p> : null}
      {sharing ? <ShareForm clientId={clientId} name={name} data={data} onShared={async (t) => { setSharing(false); setNote(t); await reload(); }} /> : null}
      {data.items.length ? data.items.map((d) => { const Icon = KIND_ICON[d.kind as keyof typeof KIND_ICON] ?? Paperclip; const v = d.versions[0];
        const openComments = d.comments.filter((c) => c.version === d.version && !c.resolvedAt && c.side === "client").length;
        return <button key={d.id} type="button" className={`${css.item} ${css.rowBtn}`} data-tone={d.state === "changes" ? "todo" : undefined} onClick={() => setOpen(d.id)}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a private file streamed by the API */}
          {v?.fileId && v.mime?.startsWith("image/") ? <img className={css.thumb} src={`/api/v0/client-files/${v.fileId}`} alt="" loading="lazy" /> : <span className={css.thumb} aria-hidden="true"><Icon size={20} /></span>}
          <span className={css.itemMain}><b>{d.title}</b>
            <small>{[`v${d.version}`, d.project?.title, d.state === "waiting" ? (d.seenAt ? `Seen ${when(d.seenAt)}` : "Not opened yet") : d.decidedAt ? `${d.decidedName ?? "Client"} · ${when(d.decidedAt)}` : null,
              openComments ? `${openComments} open ${openComments === 1 ? "comment" : "comments"}` : null, d.owner ? `for ${d.owner.name}` : null].filter(Boolean).join(" · ")}</small></span>
          <span className={css.pill} data-tone={STATE[d.state][1]}>{STATE[d.state][0]}</span>
          <ArrowRight size={14} aria-hidden="true" />
        </button>; })
        : data.onPulse ? <p className={css.empty}>Nothing shared yet. Share a design, a video, a PDF or a Drive link: {name} sees it at the top of their space.</p> : null}
      {!data.onPulse ? <Link className={css.btn} href={`/clients/${clientId}?tab=access`}>Open Pulse access</Link> : null}
    </section>
  </div>;
}

function ShareForm({ clientId, name, data, onShared }: { clientId: string; name: string; data: ApprovalsData; onShared: (t: string) => Promise<void> }) {
  const [title, setTitle] = useState(""), [file, setFile] = useState<File | null>(null), [url, setUrl] = useState(""), [project, setProject] = useState(data.projects[0]?.id ?? "");
  const [owner, setOwner] = useState(data.owner ?? data.me ?? ""), [answerBy, setAnswerBy] = useState(""), [noteText, setNoteText] = useState("");
  const [busy, setBusy] = useState(false), [share, setShare] = useState(0), [error, setError] = useState<string | null>(null);
  const send = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(null);
    try {
      const fileId = file ? await uploadFile("/api/v0/client-files", file, { clientId }, setShare) : null;
      await post(`clients/${clientId}/deliverables`, { title: title || file?.name.replace(/\.[^.]+$/, "") || "", ...(fileId ? { fileId } : { url }), projectId: project || null, ownerId: owner || null, answerBy: answerBy || null, note: noteText });
      await onShared(`Shared. ${name} sees it at the top of their space and has been told.`);
    } catch (err) { setError((err as Error).message); setBusy(false); } };
  return <form className={css.form} onSubmit={send} aria-label="Share for approval">
    <label className={css.field}>What is it<input className={css.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Launch poster, square" maxLength={160} required={!file} /></label>
    <label className={css.field}>File <small>(picture, video, PDF, Word, PowerPoint, up to 300 MB)</small><input className={css.input} type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
    {!file ? <label className={css.field}>…or a link <small>(Drive, YouTube, Figma, any https link)</small><input className={css.input} type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} /></label> : null}
    <div className={css.twoCols}>
      {data.projects.length ? <label className={css.field}>Project<select className={css.input} value={project} onChange={(e) => setProject(e.target.value)}><option value="">No project</option>{data.projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label> : null}
      <label className={css.field}>Who hears the answer<select className={css.input} value={owner} onChange={(e) => setOwner(e.target.value)}>{data.team.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === data.me ? " (you)" : p.id === data.owner ? " (their contact)" : ""}</option>)}</select></label>
      <label className={css.field}>Answer by <small>(optional)</small><input className={css.input} type="date" value={answerBy} onChange={(e) => setAnswerBy(e.target.value)} /></label>
    </div>
    <label className={css.field}>A note for them <small>(optional)</small><textarea className={css.input} rows={2} value={noteText} onChange={(e) => setNoteText(e.target.value)} maxLength={2000} /></label>
    {busy && file ? <progress className={css.progress} value={share} max={1} aria-label="Uploading" /> : null}
    {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
    <div className={css.actions}><button className={`${css.btn} ${css.primary}`} disabled={busy || (!file && !url)}><Send size={15} aria-hidden="true" />{busy ? (file ? `Uploading ${Math.round(share * 100)}%` : "Sharing…") : `Share with ${name}`}</button></div>
  </form>;
}
