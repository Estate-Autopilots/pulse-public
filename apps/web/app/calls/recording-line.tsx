"use client";
// CALLS-V2: a call's recording as a line in its conversation (the members of the conversation see it): play it and
// seek; its transcript with times (a line moves the player there), made on Pulse's own server; the notes an AI
// employee wrote (a summary, what was decided, action items, each one a task in a tap) when the company allows it.
// Who recorded it and who saw the notice and stayed are on it. The recorder or an admin deletes it.
// XRAY-LINK seam: someone of the team with Sales X-Ray connected sends it there for analysis (their upload, linked to
// this call), after confirming the people on the call agree; the analysis' state shows here.
import { useEffect, useRef, useState } from "react";
import { CircleDot, ExternalLink, FileText, Info, ListChecks, ScanSearch, Sparkles, Trash2 } from "lucide-react";
import { openCreate } from "../create";
import css from "./calls.module.css";

export type RecordingAttachment = { recording: string; recordingState?: string; seconds?: number | null; transcript?: string; summary?: string };
export const recordingOf = (attachments: { recording?: string }[] | undefined) => attachments?.find((a) => a.recording) as RecordingAttachment | undefined;
type Segment = { s: number; e: number; t: string };
type Notes = { summary: string; decisions?: string[]; actions?: { title: string; who: string | null; due: string | null }[] };
type View = { id: string; callId: string; mime: string; startedAt: string; state: string; seconds: number | null; byName: string; canRemove: boolean; transcriptState: string; transcript: string | null; segments: Segment[] | null;
  summaryState: string; summary: Notes | null; summaryBy: string | null; acks: string[]; people: string[] };
const clock = (s: number) => { const t = Math.max(0, Math.floor(s)); const h = Math.floor(t / 3600); return `${h ? `${h}:` : ""}${String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, "0")}:${String(t % 60).padStart(2, "0")}`; };
const first = (n: string) => n.split(" ")[0];

export function RecordingLine({ a, channelId, at }: { a: RecordingAttachment; channelId: string; at: string }) {
  const [open, setOpen] = useState<null | "transcript" | "notes" | "about">(null), [view, setView] = useState<View | null>(null), [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const state = a.recordingState ?? "recording", saved = state === "saved";
  const tState = a.transcript ?? "none", nState = a.summary ?? "none";
  // Read again when it is opened and whenever the line says something changed (the transcript or the notes are ready);
  // with notes on the line, read it at once (whether this viewer may see them: in a chat with a client, the team only).
  useEffect(() => {
    if (!saved || (!open && nState !== "done")) return;
    const ac = new AbortController();
    void fetch(`/api/v0/calls/recordings/${a.recording}`, { cache: "no-store", signal: ac.signal }).then(async (r) => {
      const d = await r.json().catch(() => ({})) as { recording?: View; error?: string };
      if (!r.ok || !d.recording) throw new Error(d.error ?? "The recording could not be opened.");
      setView(d.recording); setError("");
    }).catch((e: Error) => { if (e.name !== "AbortError") setError(e.message); });
    return () => ac.abort();
  }, [open, saved, nState, a.recording, a.transcript, a.summary]);
  const time = new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  const label = state === "recording" ? "Call recording · recording now" : saved ? `Call recording${a.seconds ? ` · ${clock(a.seconds)}` : ""}` : state === "failed" ? "Call recording · nothing was saved" : "Call recording · deleted";
  const seek = (s: number) => { const el = audio.current; if (!el) return; el.currentTime = s; void el.play().catch(() => {}); };
  async function remove() {
    if (!window.confirm("Delete this recording, its transcript and its notes for everyone in this chat?")) return;
    const r = await fetch(`/api/v0/calls/recordings/${a.recording}/remove`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    if (!r?.ok) setError(((await r?.json().catch(() => ({}))) as { error?: string })?.error ?? "The recording was not deleted. Try again.");
  }
  return <div className={css.recLine} data-state={state} data-recording-line={a.recording}>
    <span className={css.line}>
      <span className={css.lineIcon} data-rec="" aria-hidden="true"><CircleDot size={16} /></span>
      <span className={css.lineText}><b>{label}</b><small>{time}{view?.byName ? ` · recorded by ${first(view.byName)}` : ""}</small></span>
      {saved && (tState === "queued" || tState === "working") ? <span className={css.recBusy}>Transcribing…</span> : null}
      {saved && tState === "done" ? <button type="button" className={css.lineBtn} aria-expanded={open === "transcript"} onClick={() => setOpen(open === "transcript" ? null : "transcript")}><FileText size={13} aria-hidden="true" />Transcript</button> : null}
      {saved && tState === "done" && (nState === "queued" || nState === "working") ? <span className={css.recBusy}>Writing notes…</span> : null}
      {saved && nState === "done" && view?.summaryState === "done" ? <button type="button" className={css.lineBtn} aria-expanded={open === "notes"} onClick={() => setOpen(open === "notes" ? null : "notes")}><Sparkles size={13} aria-hidden="true" />Notes</button> : null}
      {saved ? <button type="button" className={css.recInfo} aria-expanded={open === "about"} onClick={() => setOpen(open === "about" ? null : "about")} aria-label="About this recording" title="Who was in it, delete"><Info size={15} aria-hidden="true" /></button> : null}
    </span>
    {saved ? <audio ref={audio} className={css.recAudio} controls preload="none" src={`/api/v0/calls/recordings/${a.recording}/audio`} aria-label="Play the call recording" /> : null}
    {open && saved ? <div className={css.recPanel}>
      {error ? <p className={css.recError} role="alert">{error}</p> : !view ? <p className={css.recMuted}>Opening…</p> : open === "about" ? <p className={css.recMuted}>Recorded by {view.byName}.</p> : open === "transcript" ? <>
        {view.segments?.length ? <ol className={css.segments}>{view.segments.map((g, i) => <li key={i}><button type="button" onClick={() => seek(g.s)} aria-label={`Play from ${clock(g.s)}`}>{clock(g.s)}</button><span>{g.t}</span></li>)}</ol>
          : <p className={css.recMuted}>{view.transcript || "Nothing was said that could be written down."}</p>}
        <p className={css.recMuted}>Made by speech recognition on Pulse’s own server: it may mishear words and does not say who spoke.</p>
      </> : view.summary ? <>
        <p className={css.recSummary}>{view.summary.summary}</p>
        {view.summary.decisions?.length ? <><h4>Decided</h4><ul>{view.summary.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></> : null}
        {view.summary.actions?.length ? <><h4>Action items</h4><ul className={css.actions}>{view.summary.actions.map((x, i) => <li key={i}><span>{x.title}{x.who ? <small> · {x.who}</small> : null}{x.due ? <small> · by {x.due}</small> : null}</span>
          <button type="button" className={css.lineBtn} onClick={() => openCreate({ kind: "task", title: x.title.slice(0, 120), chat: { channelId }, source: { label: "From the call’s notes", quote: x.title } })}><ListChecks size={13} aria-hidden="true" />Make a task</button></li>)}</ul></> : null}
        <p className={css.recMuted}>Notes by {view.summaryBy ?? "an AI employee"} from the transcript: check them before you rely on them.</p>
      </> : <p className={css.recMuted}>No notes yet.</p>}
      {view ? <p className={css.recMuted}>{view.people.length ? `In the call: ${view.people.map(first).join(", ")}.` : ""}{view.acks.length ? ` Saw the recording notice: ${view.acks.map(first).join(", ")}.` : ""}</p> : null}
      {view ? <XrayAction rec={view} /> : null}
      {view?.canRemove ? <button type="button" className={css.recRemove} onClick={() => void remove()}><Trash2 size={13} aria-hidden="true" />Delete the recording</button> : null}
    </div> : null}
  </div>;
}

type Linked = { sxCallId: string; status: string; openUrl: string | null };
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new Error(d.error ?? "That did not go through. Try again.");
  return d;
}
const b64 = async (b: Blob) => { const u = new Uint8Array(await b.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
/** XRAY-LINK: send the recording to Sales X-Ray (POST /api/v0/sales-xray/recordings, parts, send), linked to this call. */
function XrayAction({ rec }: { rec: View }) {
  const [connected, setConnected] = useState(false), [linked, setLinked] = useState<Linked[]>([]), [busy, setBusy] = useState(false), [note, setNote] = useState("");
  useEffect(() => {
    const ac = new AbortController();
    void fetch("/api/v0/sales-xray/status", { cache: "no-store", signal: ac.signal }).then((r) => r.ok ? r.json() : null).then(async (d: { connected?: boolean } | null) => {
      if (!d?.connected) return; setConnected(true);
      const l = await fetch(`/api/v0/sales-xray/linked?call=${rec.callId}`, { cache: "no-store", signal: ac.signal }).then((r) => r.ok ? r.json() : null) as { calls?: Linked[] } | null;
      setLinked(l?.calls ?? []);
    }).catch(() => {});
    return () => ac.abort();
  }, [rec.callId]);
  if (!connected) return null;
  async function send() {
    if (!window.confirm("The people on this call were told it is recorded. Do they also agree to its analysis in Sales X-Ray?")) return;
    setBusy(true); setNote("");
    try {
      const audio = await (await fetch(`/api/v0/calls/recordings/${rec.id}/audio`)).blob();
      const ext = rec.mime === "audio/mp4" ? "m4a" : rec.mime === "audio/ogg" ? "ogg" : "webm";
      const start = await postJson<{ uploadId: string; partSize: number; parts: number }>("sales-xray/recordings", { size: audio.size, mime: rec.mime, name: `call-recording.${ext}`,
        title: `Call with ${rec.people.join(", ")}`.slice(0, 120), callAt: rec.startedAt, pulseCallId: rec.callId, consent: true });
      for (let i = 0; i < start.parts; i++) await postJson(`sales-xray/recordings/${start.uploadId}/parts`, { index: i, bytes: await b64(audio.slice(i * start.partSize, (i + 1) * start.partSize)) });
      const r = await postJson<{ sent: boolean; words: string; id?: string; status?: string }>(`sales-xray/recordings/${start.uploadId}/send`, {});
      setNote(r.words); if (r.sent && r.id) setLinked((l) => [{ sxCallId: r.id!, status: r.status ?? "waiting", openUrl: null }, ...l]);
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  }
  return <p className={css.recMuted}>
    {linked.length ? <>In Sales X-Ray: {linked.map((x, i) => <span key={x.sxCallId}>{i ? ", " : ""}{x.status === "ready" ? "report ready" : x.status === "failed" ? "analysis failed" : "being analysed"}{x.openUrl ? <> · <a href={x.openUrl} target="_blank" rel="noreferrer">open<ExternalLink size={11} aria-hidden="true" /></a></> : null}</span>)}</>
      : <button type="button" className={css.lineBtn} disabled={busy} onClick={() => void send()} data-xray-send=""><ScanSearch size={13} aria-hidden="true" />{busy ? "Sending to Sales X-Ray…" : "Analyse in Sales X-Ray"}</button>}
    {note ? <span role="status"> {note}</span> : null}
  </p>;
}
