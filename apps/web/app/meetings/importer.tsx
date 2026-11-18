"use client";
// MEETING-CAPTURE (1946): bring a meeting in from its transcript. Paste it (Wispr Flow, Loom's copied transcript, Otter,
// notes) or drop / choose a file (.txt, .vtt, .srt). Pulse reads it on its own server as you paste (POST
// /api/v0/meetings/preview saves nothing): the name from its content and day, the speakers, a short summary and the
// action items it found. Save keeps it line by line; the action items are drafts a person confirms on the meeting's page.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { CircleCheck, CircleDashed, FileText, FileUp, Loader2, ShieldCheck, Sparkles, UserRound, Users, X } from "lucide-react";
import { say } from "../lib/words.mjs";
import { useWords } from "../org-code";
import { Skeleton } from "../kit/game";
import css from "./meetings.module.css";

type Options = { projects: { id: string; name: string; clientName: string | null }[]; clients: { id: string; name: string }[]; people: { id: string; name: string }[] };
export type Preview = { format: string; speakers: string[]; lineCount: number; title: string; heldOn: string | null; summary: string | null;
  sample: { speaker: string | null; at: number | null; text: string }[]; drafts: { kind: string; title: string; quote?: string; route?: string | null; who?: string | null }[]; attendees: string[] };

export const FORMAT: Record<string, string> = { plain: "Plain text", speakers: "Names on each line", loom: "Loom (times on each line)", otter: "Otter export",
  vtt: "Captions file", srt: "Subtitles file" };
const MAX_FILE = 1_500_000;

export async function post<T>(path: string, body: unknown): Promise<T> {
  let r: Response;
  try { r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch { throw new Error("Pulse can’t be reached. Check the connection and try again."); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? "That did not go through. Try again.");
  return d as T;
}

export function Importer({ project, client }: { project: string | null; client: string | null }) {
  const words = useWords();
  const router = useRouter();
  const [opts, setOpts] = useState<Options | null>(null);
  const [text, setText] = useState(""), [fileName, setFileName] = useState<string | null>(null), [drag, setDrag] = useState(false);
  const [read, setRead] = useState<{ text: string; fileName: string | null; preview: Preview | null; error: string } | null>(null), [error, setError] = useState("");
  const [title, setTitle] = useState(""), [titleSet, setTitleSet] = useState(false), [heldOn, setHeldOn] = useState(""), [people, setPeople] = useState<string[]>([]), [peopleSet, setPeopleSet] = useState(false);
  // Captions (.vtt, .srt) or a file, once read, show as one line, not their raw timing marks.
  const [showText, setShowText] = useState(false);
  const [projectId, setProjectId] = useState(project ?? ""), [clientId, setClientId] = useState(client ?? ""), [saving, setSaving] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { fetch("/api/v0/meetings/options").then((r) => r.ok ? r.json() : null).then((d) => { if (d) setOpts(d); }).catch(() => {}); }, []);
  // Read it as it is pasted (half a second after the last change); the last reading stays on screen meanwhile.
  useEffect(() => {
    if (!text.trim()) return;
    let live = true;
    const t = setTimeout(() => {
      post<Preview>("meetings/preview", { text, fileName }).then((p) => {
        if (!live) return;
        setRead({ text, fileName, preview: p, error: "" });
        if (!titleSet) setTitle(p.title);
        if (!heldOn && p.heldOn) setHeldOn(p.heldOn);
        if (!peopleSet) setPeople(p.attendees);
      }).catch((e) => { if (live) setRead({ text, fileName, preview: null, error: (e as Error).message }); });
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [text, fileName]); // eslint-disable-line react-hooks/exhaustive-deps
  const has = !!text.trim(), current = has && read?.text === text && read.fileName === fileName, reading = has && !current;
  const preview = has ? read?.preview ?? null : null, readError = current ? read!.error : "";
  const collapsed = !!preview && !showText && (!!fileName || preview.format === "vtt" || preview.format === "srt");

  async function choose(f: File | undefined) {
    if (!f) return;
    setError("");
    if (f.size > MAX_FILE) { setError("That file is too big (up to 1.5 MB). Choose the transcript file, not the recording."); return; }
    if (!/\.(txt|vtt|srt|md|text)$/i.test(f.name) && !/^text\//.test(f.type)) { setError("Choose a transcript file: .txt, .vtt or .srt."); return; }
    const t = await f.text().catch(() => "");
    if (!t.trim()) { setError("That file has no words in it."); return; }
    setFileName(f.name); setText(t);
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); void choose(e.dataTransfer.files?.[0]); };
  function clear() { setText(""); setFileName(null); setRead(null); setShowText(false); setTitle(""); setTitleSet(false); setHeldOn(""); setPeople([]); setPeopleSet(false); if (file.current) file.current.value = ""; }

  async function save() {
    if (!preview || saving) return; setSaving(true); setError("");
    try {
      const r = await post<{ id: string }>("meetings/import", { text, fileName, title: title.trim() || preview.title, heldOn: heldOn || preview.heldOn, projectId: projectId || null, clientId: clientId || null, attendees: people });
      router.push(`/meetings/${r.id}?saved=1`);
    } catch (e) { setError((e as Error).message); setSaving(false); }
  }

  const drafts = preview?.drafts ?? [];
  return <div className={css.view}>
    <section className={css.card} data-importer="">
      <div className={css.cardHead}><h2 className={css.h2}>The transcript</h2><span className={css.formats}>Wispr Flow · Loom · Otter · .txt · .vtt · .srt</span></div>
      <div className={css.drop} data-drag={drag ? "" : undefined} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
        {collapsed ? <p className={css.fileChip} data-read-chip=""><CircleCheck size={15} aria-hidden="true" className={css.spark} /><span>{fileName ?? (preview!.format === "srt" ? "Subtitles" : "Captions")} · {preview!.lineCount} {preview!.lineCount === 1 ? "line" : "lines"} read</span>
          <button type="button" className={css.link} onClick={() => setShowText(true)}>Show the text</button>
          <button type="button" className={css.iconBtn} onClick={clear} aria-label="Start again"><X size={15} aria-hidden="true" /></button></p>
        : fileName ? <p className={css.fileChip}><FileText size={15} aria-hidden="true" /><span>{fileName}</span>
          <button type="button" className={css.iconBtn} onClick={clear} aria-label="Remove the file"><X size={15} aria-hidden="true" /></button></p> : null}
        {collapsed ? null : <textarea value={text} onChange={(e) => { setText(e.target.value); if (fileName && !e.target.value) setFileName(null); }} rows={preview ? 4 : 9} data-read={preview ? "" : undefined} maxLength={400000} aria-label="Transcript" data-transcript=""
          placeholder={"Paste the transcript here, or drop its file.\n\nFor example:\nAsha: Welcome. Let’s plan the launch.\nRavi: I will send the brochure by Monday."} />}
        <div className={css.dropFoot}>
          <button type="button" className={css.ghost} onClick={() => file.current?.click()}><FileUp size={16} aria-hidden="true" />Choose a file</button>
          <input ref={file} type="file" accept=".txt,.vtt,.srt,.md,text/plain,text/vtt" hidden onChange={(e) => void choose(e.target.files?.[0])} aria-label="Transcript file" />
          <span className={css.private}><ShieldCheck size={14} aria-hidden="true" />Read on Pulse’s own server. Nothing goes to an outside AI.</span>
        </div>
      </div>
      {error || readError ? <p className={css.error} role="alert">{error || readError}</p> : null}
    </section>

    {reading && !preview ? <section className={css.card} aria-busy="true" data-preview-loading=""><p className={css.note} role="status"><Loader2 size={15} aria-hidden="true" className={css.spin} />Reading the transcript…</p>
      <Skeleton width="60%" height={14} /><Skeleton width="90%" height={14} /><Skeleton width="75%" height={14} /></section> : null}

    {preview ? <section className={css.card} aria-labelledby="found-h" data-preview="" aria-busy={reading || undefined}>
      <div className={css.cardHead}><h2 id="found-h" className={css.h2}><Sparkles size={16} aria-hidden="true" className={css.spark} />What Pulse read</h2>
        <button type="button" className={css.primaryBtn} onClick={() => void save()} disabled={saving || reading || !title.trim()} data-save-meeting="">
          {saving || reading ? <Loader2 size={16} aria-hidden="true" className={css.spin} /> : <CircleCheck size={16} aria-hidden="true" />}{saving ? "Saving…" : reading ? "Reading…" : "Save meeting"}</button></div>
      <div className={css.two}>
        <label className={css.field}><span>Name</span><input value={title} onChange={(e) => { setTitle(e.target.value); setTitleSet(true); }} maxLength={160} data-meeting-name="" /></label>
        <label className={css.field}><span>Day it happened</span><input type="date" value={heldOn || preview.heldOn || ""} onChange={(e) => setHeldOn(e.target.value)} /></label>
      </div>
      <p className={css.chips}>{preview.speakers.length ? <><Users size={15} aria-hidden="true" className={css.chipIcon} />{preview.speakers.map((s) => <span key={s} className={css.chip}>{s}</span>)}</> : null}
        <span className={css.fact}>{FORMAT[preview.format] ?? "Transcript"}</span><span className={css.fact}>{preview.lineCount} {preview.lineCount === 1 ? "line" : "lines"}</span></p>
      {preview.summary ? <><p className={css.label}>Summary</p><p className={css.summary} data-summary="">{preview.summary}</p></> : null}
      <div className={css.found}>
        <p className={css.foundHead}><b>{drafts.length ? `${drafts.length} action ${drafts.length === 1 ? "item" : "items"} to confirm` : "No action items yet"}</b>
          <small>{drafts.length ? "You confirm each one next. Nothing is made until you do." : "Add a line like “Asha will send the brochure by Monday” and Pulse finds it."}</small></p>
        {drafts.length ? <ul className={css.draftList}>{drafts.slice(0, 3).map((d, i) => <li key={i}><CircleDashed size={15} aria-hidden="true" /><span>{d.title}</span>
          <span className={css.draftTag}>Draft</span>{d.who ? <span className={css.whoTag}><UserRound size={13} aria-hidden="true" />{d.who}</span> : <span />}</li>)}
          {drafts.length > 3 ? <li className={css.more}>and {drafts.length - 3} more</li> : null}</ul> : null}
      </div>
      <details className={css.more2}>
        <summary>Who was there, and the {say("{project}", words)}</summary>
        <div className={css.moreBody}>
          {opts?.people.length ? <fieldset className={css.people}><legend>Who was there (from the team)</legend>
            <div>{opts.people.map((p) => <label key={p.id}><input type="checkbox" checked={people.includes(p.id)} onChange={(e) => { setPeopleSet(true); setPeople((x) => e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)); }} />{p.name}</label>)}</div>
          </fieldset> : null}
          <p className={css.note}>The people ticked here can open this meeting and search its transcript. So can leadership.</p>
          <div className={css.two}>
            <label className={css.field}><span>{say("{Project}", words)}</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={!opts}><option value="">{say("No {project}", words)}</option>
                {opts?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.clientName ? ` · ${p.clientName}` : ""}</option>)}</select></label>
            <label className={css.field}><span>{say("{Client}", words)}</span>
              <select value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!opts}><option value="">{say("No {client}", words)}</option>
                {opts?.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          </div>
        </div>
      </details>
    </section> : null}
  </div>;
}
