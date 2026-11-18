"use client";
// KAZUK-REST slice 4 (D1/D3): one meeting. Its consent, the audio, the transcript (made on the server, the page updates by
// itself while it is being made) or the notes typed for it, and the action items read from it: each a draft until a
// person makes it a task (title, who and the day can be changed first) or drops it.
// MEETING-CAPTURE (1946): its summary and speakers, the transcript line by line (find a word in it; `?line=N` opens at
// the line a task came from), and a narrated problem's drafts, each sent as a bug report or made a task.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bug, Check, CircleCheck, FileText, ListTodo, Loader2, MapPin, PartyPopper, Search, ShieldCheck, Trash2, Users, X } from "lucide-react";
import { celebrate } from "../kit/game";
import { FORMAT } from "./importer";
import { day, dayTime } from "../lib/format";
import { say } from "../lib/words.mjs";
import { useWords } from "../org-code";
import css from "./meetings.module.css";
import { useConfirm } from "../kit/dialogs";

type Action = { id: string; title: string; quote: string | null; assigneeId: string | null; assignee: string | null; dueOn: string | null; state: "draft" | "confirmed" | "dropped"; taskId: string | null;
  kind?: "task" | "bug"; route?: string | null; lineNo?: number | null; bugId?: string | null; bugNumber?: number | null };
type MLine = { n: number; speaker?: string; at?: number; text: string };
export type Meeting = { id: string; title: string; kind: "recording" | "notes"; state: string; seconds: number | null; startedAt: string; byName: string; mine: boolean; canRemove: boolean; canEdit: boolean;
  project: { id: string; name: string } | null; client: { id: string; name: string } | null; attendees: { id: string; name: string }[];
  consent: { at: string; by: string; text: string } | null; transcriptState: string; transcript: string | null; segments: { s: number; e: number; t: string }[] | null;
  actionsState: string; actions: Action[]; transcripts: boolean;
  source?: string; sourceFormat?: string | null; sourceName?: string | null; purpose?: "meeting" | "problem"; summary?: string | null; speakers?: string[]; heldOn?: string | null; lines?: MLine[] };
type Person = { id: string; name: string };

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!r) throw new Error("Pulse can’t be reached. Try again.");
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? "That did not go through. Try again.");
  return d as T;
}
const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function MeetingView({ initial }: { initial: Meeting }) {
  const confirm = useConfirm();
  const words = useWords();
  const router = useRouter();
  const search = useSearchParams();
  const wantNotes = search.get("notes") === "1", saved = search.get("saved") === "1", wantLine = Number(search.get("line")) || null;
  const [m, setM] = useState(initial), [people, setPeople] = useState<Person[]>([]), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const working = m.transcriptState === "queued" || m.transcriptState === "working";
  const [editing, setEditing] = useState(wantNotes || (!working && m.transcriptState !== "done" && m.canEdit)), [notes, setNotes] = useState(initial.transcript ?? ""), [saving, setSaving] = useState(false);
  useEffect(() => { fetch("/api/v0/meetings/options").then((r) => r.ok ? r.json() : null).then((d) => { if (d) setPeople(d.people); }).catch(() => {}); }, []);
  // While the server transcribes, the page asks every 5 s.
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => { fetch(`/api/v0/meetings/${m.id}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d) => { if (d?.meeting) setM(d.meeting); }).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [working, m.id]);
  async function saveNotes() {
    if (!notes.trim() || saving) return; setSaving(true); setError("");
    try { const r = await post<{ meeting: Meeting }>(`meetings/${m.id}/notes`, { text: notes }); setM(r.meeting); setEditing(false); }
    catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  async function remove() {
    if (!(await confirm({ title: "Delete this meeting?", body: "Its recording, what was said and the drafts go away. Tasks you already made from it stay.", confirmLabel: "Delete meeting", danger: true }))) return;
    try { await post(`meetings/${m.id}/remove`); router.push("/meetings"); } catch (e) { setError((e as Error).message); }
  }
  const drafts = m.actions.filter((a) => a.state === "draft"), decided = m.actions.filter((a) => a.state !== "draft");
  const problem = m.purpose === "problem", lines = m.lines ?? [];
  const savedRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (saved) celebrate(savedRef.current, { id: `meeting-saved-${initial.id}` }); }, [saved, initial.id]);
  const from = m.source === "file" ? `From ${m.sourceName ?? "a file"}` : m.source === "paste" ? (problem ? "Typed in" : "Pasted") : null;
  return <div className={css.view}>
    {saved ? <><p className={css.savedLine} role="status" data-saved="" ref={savedRef}><PartyPopper size={18} aria-hidden="true" />
      <span><b>Meeting saved.</b> {drafts.length ? <a href="#actions-h" className={css.lineLink}>Confirm the {drafts.length === 1 ? "action item" : `${drafts.length} action items`} ↓</a> : "It is kept line by line, and you can search it."}</span></p></> : null}
    <section className={css.card}>
      <p className={css.meta}>{[m.heldOn ? day(m.heldOn) : dayTime(m.startedAt), m.seconds ? stamp(m.seconds) : null, `by ${m.byName}`, from, m.sourceFormat ? FORMAT[m.sourceFormat] : null].filter(Boolean).join(" · ")}
        {/* What to do next, above the fold: the drafts are under the transcript. */}
        {drafts.length && !saved ? <> · <a href="#actions-h" className={css.lineLink} data-next="">{drafts.length === 1 ? "1 action item" : `${drafts.length} action items`} to confirm ↓</a></> : null}</p>
      {m.summary ? <p className={css.summary} data-summary="">{m.summary}</p> : null}
      {m.speakers?.length ? <p className={css.chips} aria-label="Who spoke"><Users size={15} aria-hidden="true" className={css.chipIcon} />{m.speakers.map((sp) => <span key={sp} className={css.chip}>{sp}</span>)}</p> : null}
      <p className={css.chips}>
        {m.project ? <Link href={`/tasks/projects/${m.project.id}`} className={css.chip}>{say("{Project}", words)}: {m.project.name}</Link> : null}
        {m.client ? <Link href={`/clients/${m.client.id}`} className={css.chip}>{say("{Client}", words)}: {m.client.name}</Link> : null}
        {m.attendees.filter((a) => !m.speakers?.some((sp) => sp.toLowerCase() === a.name.toLowerCase())).map((a) => <span key={a.id} className={css.chip}>{a.name}</span>)}
      </p>
      {m.consent ? <p className={css.consentLine} data-consent-line=""><ShieldCheck size={15} aria-hidden="true" />Consent confirmed by {m.consent.by}, {dayTime(m.consent.at)}: “{m.consent.text}”</p> : null}
      {m.kind === "recording" && m.state === "saved" ? <audio className={css.audio} controls preload="none" src={`/api/v0/meetings/${m.id}/audio`} /> : null}
      {m.kind === "recording" && m.state === "failed" ? <p className={css.note}>Nothing was recorded (no audio reached Pulse). Write the notes below instead.</p> : null}
    </section>

    <section className={css.card} aria-labelledby="transcript-h">
      <h2 id="transcript-h" className={css.h2}>{problem ? "What you said" : m.kind === "notes" && m.source !== "paste" && m.source !== "file" ? "Notes" : "Transcript"}</h2>
      {working ? <p className={css.note} role="status"><Loader2 size={15} aria-hidden="true" className={css.spin} />Transcribing on Pulse’s own server. This page updates by itself; the action items follow.</p>
        : editing ? <div className={css.notes}>
          {m.transcriptState === "off" && m.kind === "recording" ? <p className={css.note}>Transcripts are not switched on for this Pulse. Write or paste the meeting’s notes and Pulse finds the action items.</p> : null}
          {m.transcriptState === "failed" ? <p className={css.note}>The transcript could not be made. Write or paste the notes instead.</p> : null}
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={8} maxLength={400000} aria-label="Meeting notes"
            placeholder={"One point per line works best, for example:\nAsha will send the brochure by Monday.\nAction: book the site visit tomorrow."} />
          <span className={css.actions}>{m.transcriptState === "done" ? <button type="button" className={css.ghost} onClick={() => setEditing(false)}>Cancel</button> : null}
            <button type="button" className={css.primaryBtn} onClick={() => void saveNotes()} disabled={saving || !notes.trim()}><FileText size={16} aria-hidden="true" />{saving ? "Reading…" : "Save and find action items"}</button></span>
        </div>
        : lines.length ? <><Lines lines={lines} want={wantLine} />
          {m.canEdit ? <button type="button" className={css.link} onClick={() => { setNotes(m.transcript ?? ""); setEditing(true); }}>Correct the text</button> : null}</>
        : m.transcript ? <>
          {m.segments?.length ? <ol className={css.segments}>{m.segments.map((s, i) => <li key={i}><time>{stamp(s.s)}</time><span>{s.t}</span></li>)}</ol> : <p className={css.transcript}>{m.transcript}</p>}
          {m.canEdit ? <button type="button" className={css.link} onClick={() => { setNotes(m.transcript ?? ""); setEditing(true); }}>Correct the text</button> : null}
        </> : <p className={css.note}>No transcript.</p>}
    </section>

    <section className={css.card} aria-labelledby="actions-h" data-actions="">
      <h2 id="actions-h" className={css.h2}>{problem ? "Bug reports and tasks" : "Action items"}</h2>
      {!m.actions.length ? <p className={css.note}>{working ? "They show once the transcript is ready." : m.transcriptState === "done" ? "No action items were found. Add a line like “Asha will send the brochure by Monday” to the notes." : "Write the notes to find them."}</p> : null}
      {drafts.length ? <p className={css.note}>{problem ? "Pulse’s draft from what you said: check it, then send it or drop it. Nothing is sent until you press the button." : <>Drafts from the {m.kind === "notes" && m.source === "notes" ? "notes" : "transcript"}: change what you need, then make each a task or drop it. Nothing is created until you confirm.</>}</p> : null}
      <ul className={css.items}>{drafts.map((a) => <Draft key={a.id} a={a} people={people} meeting={m.id} onDone={(next, ask) => { setM(next); setNotice(ask ? `The task is yours for now: your role does not give ${ask} tasks. Ask them, or their lead, to take it.` : ""); }} onError={setError} />)}</ul>
      {decided.length ? <ul className={css.items}>{decided.map((a) => <li key={a.id} className={css.item} data-state={a.state}>
        {a.state === "confirmed" ? <CircleCheck size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
        <span className={css.main}><b>{a.title}</b><small>{a.state === "confirmed" ? a.kind === "bug" ? `Bug report${a.bugNumber ? ` #${a.bugNumber}` : ""} sent to the team that fixes Pulse`
          : [a.assignee, a.dueOn ? `due ${day(a.dueOn)}` : null].filter(Boolean).join(" · ") || "Task made" : "Dropped"}{a.lineNo ? <> · <Link href={`/meetings/${m.id}?line=${a.lineNo}#line-${a.lineNo}`} className={css.lineLink}>line {a.lineNo}</Link></> : null}</small></span>
        {a.taskId ? <Link href={`/tasks/${a.taskId}`} className={css.link}>Open the task</Link> : null}
      </li>)}</ul> : null}
    </section>
    {notice ? <p className={css.note} role="status">{notice}</p> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    {m.canRemove ? <p><button type="button" className={css.danger} onClick={() => void remove()}><Trash2 size={15} aria-hidden="true" />Delete this meeting</button></p> : null}
  </div>;
}

/** The transcript, one row per line (time, speaker, words), in its own scrolling box; a word typed in Find marks every
 *  line it is in; `want` (a task's line) is marked and scrolled to. */
function Lines({ lines, want }: { lines: MLine[]; want: number | null }) {
  const [q, setQ] = useState(""), box = useRef<HTMLOListElement>(null);
  const needle = q.trim().toLowerCase();
  const hits = useMemo(() => needle.length < 2 ? [] : lines.filter((l) => `${l.speaker ?? ""} ${l.text}`.toLowerCase().includes(needle)).map((l) => l.n), [lines, needle]);
  useEffect(() => {
    const n = hits[0] ?? (needle ? null : want);
    if (!n || !box.current) return;
    const el = box.current.querySelector<HTMLElement>(`[data-line="${n}"]`);
    if (el) box.current.scrollTo({ top: el.offsetTop - box.current.offsetTop - 12, behavior: needle ? "smooth" : "auto" });
  }, [hits, want, needle]);
  const mark = (t: string) => {
    if (needle.length < 2) return t;
    const i = t.toLowerCase().indexOf(needle);
    return i < 0 ? t : <>{t.slice(0, i)}<mark>{t.slice(i, i + needle.length)}</mark>{t.slice(i + needle.length)}</>;
  };
  const timed = lines.some((l) => l.at !== undefined);
  return <div className={css.linesWrap}>
    <label className={css.find}><Search size={15} aria-hidden="true" /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a word" aria-label="Find in this transcript" />
      {needle.length >= 2 ? <small aria-live="polite">{hits.length ? `${hits.length} ${hits.length === 1 ? "line" : "lines"}` : "Not found"}</small> : <small>{lines.length} lines</small>}</label>
    <ol className={css.lines} ref={box} data-lines="" data-timed={timed ? "" : undefined}>{lines.map((l) => <li key={l.n} id={`line-${l.n}`} data-line={l.n}
      data-on={(needle ? hits.includes(l.n) : want === l.n) ? "" : undefined}>
      <span className={css.lineNo}>{l.at !== undefined ? stamp(l.at) : l.n}</span>
      <span className={css.lineText}>{!needle && want === l.n ? <em className={css.lineTag}>From your task</em> : null}{l.speaker ? <b>{mark(l.speaker)}</b> : null}{mark(l.text)}</span>
    </li>)}</ol>
  </div>;
}

function Draft({ a, people, meeting, onDone, onError }: { a: Action; people: Person[]; meeting: string; onDone: (m: Meeting, ask?: string) => void; onError: (e: string) => void }) {
  const [title, setTitle] = useState(a.title), [who, setWho] = useState(a.assigneeId ?? ""), [due, setDue] = useState(a.dueOn ?? ""), [busy, setBusy] = useState(false);
  const known = people.some((p) => p.id === who);
  async function decide(confirm: boolean, kind?: "task" | "bug") {
    if (busy) return; setBusy(true); onError("");
    const body = !confirm ? {} : (kind ?? a.kind) === "bug" ? { title, kind: "bug" } : { title, kind: "task", assigneeId: who || null, dueOn: due || null };
    try { const r = await post<{ meeting: Meeting; result: { askNeeded?: string } }>(`meetings/${meeting}/actions/${a.id}/${confirm ? "confirm" : "drop"}`, body); onDone(r.meeting, r.result?.askNeeded); }
    catch (e) { onError((e as Error).message); setBusy(false); }
  }
  if (a.kind === "bug") return <li className={css.draft} data-draft="" data-kind="bug">
    <p className={css.draftTop}><span className={css.kindChip}><Bug size={14} aria-hidden="true" />Bug report</span>
      <span className={css.pageChip}><MapPin size={14} aria-hidden="true" />{a.route ? <>Page: <b>{a.route}</b></> : "No page named"}</span></p>
    {a.quote ? <q className={css.quote}>{a.quote}</q> : null}
    <label className={css.field}><span>What’s wrong</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} /></label>
    <span className={css.actions}><button type="button" className={css.ghost} onClick={() => void decide(false)} disabled={busy}>Drop</button>
      <button type="button" className={css.ghost} onClick={() => void decide(true, "task")} disabled={busy || !title.trim()}><ListTodo size={16} aria-hidden="true" />Make it a task</button>
      <button type="button" className={css.primaryBtn} onClick={() => void decide(true, "bug")} disabled={busy || !title.trim()}><Bug size={16} aria-hidden="true" />Send bug report</button></span>
  </li>;
  return <li className={css.draft} data-draft="">
    {a.quote ? <q className={css.quote}>{a.quote}</q> : null}
    <label className={css.field}><span>Task</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} /></label>
    <div className={css.two}>
      <label className={css.field}><span>Who</span><select value={who} onChange={(e) => setWho(e.target.value)}>
        <option value="">Me</option>{!known && a.assigneeId ? <option value={a.assigneeId}>{a.assignee ?? "Named in the meeting"}</option> : null}
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className={css.field}><span>Due</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
    </div>
    <span className={css.actions}><button type="button" className={css.ghost} onClick={() => void decide(false)} disabled={busy}>Drop</button>
      <button type="button" className={css.primaryBtn} onClick={() => void decide(true, "task")} disabled={busy || !title.trim()}><Check size={16} aria-hidden="true" />Make it a task</button></span>
  </li>;
}
