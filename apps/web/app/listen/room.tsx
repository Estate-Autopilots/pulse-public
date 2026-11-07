"use client";
// AGENT-CHANNELS (1685): always-on listening. Start (after confirming everyone was told), the microphone goes to the
// server's own Whisper in short pieces, the live transcript shows here, and the chosen AI employee reacts in its chat
// (drafts a quotation, flags a requirement, creates a task); its replies show beside the transcript. Stop any time.
// Audio is deleted on the server once transcribed; transcripts go after the company's retention.
import { Bot, CircleStop, Mic, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { post } from "../records";
import { clock, lastSeq, mergeSegments, pickMime, PIECE_MS, PURPOSES, toBase64 } from "../lib/listen-model.mjs";
import css from "./listen.module.css";

type Agent = { id: string; name: string };
type Session = { id: string; title: string; purpose: string; startedAt: string; stoppedAt: string | null; agent: string | null; by: string; segments: number; purgeAfter: string };
type Home = { on: boolean; retentionDays: number; canEdit: boolean; sessions: Session[]; agents: Agent[] };
type Segment = { seq: number; part: number; startMs: number; endMs: number; text: string };
type Reply = { id: string; at: string; body: string };
type View = { id: string; title: string; live: boolean; agent: string | null; waiting: number; segments: Segment[]; replies: Reply[]; purgeAfter: string };

async function getJson<T>(path: string): Promise<T | null> {
  try { const r = await fetch(`/api/v0/${path}`, { cache: "no-store" }); return r.ok ? await r.json() as T : null; } catch { return null; }
}
type Rec = { stream: MediaStream | null; recorder: MediaRecorder | null; seq: number; on: boolean; mime: string; queue: Promise<void> };

/** One piece: record PIECE_MS, then send it (pieces go one after another, in order) and start the next while on. Each
 *  piece is its own file (a new recorder), so the server's Whisper can read every piece alone. */
function recordPieces(r: Rec, id: string, onError: (text: string) => void) {
  if (!r.on || !r.stream) return;
  const recorder = new MediaRecorder(r.stream, r.mime ? { mimeType: r.mime } : undefined);
  const parts: Blob[] = [], began = Date.now();
  recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  recorder.onstop = () => {
    const seq = r.seq++, ms = Date.now() - began, type = recorder.mimeType || r.mime || "audio/webm";
    r.queue = r.queue.then(async () => {
      const blob = new Blob(parts, { type });
      if (!blob.size) return;
      const audio = toBase64(new Uint8Array(await blob.arrayBuffer()));
      await post(`listen/sessions/${id}/audio`, { seq, ms, mime: type.split(";")[0], audio }).catch((e: unknown) => onError(e instanceof Error ? e.message : "A piece of audio did not reach Vitals."));
    });
    if (r.on) recordPieces(r, id, onError);
  };
  r.recorder = recorder;
  recorder.start();
  setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, PIECE_MS);
}

const day = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function ListenRoom({ initialAgent }: { initialAgent?: string }) {
  const [home, setHome] = useState<Home | null>(null), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const [agentId, setAgentId] = useState(initialAgent ?? ""), [title, setTitle] = useState(""), [purpose, setPurpose] = useState("general");
  const [consent, setConsent] = useState(false), [view, setView] = useState<View | null>(null), [segments, setSegments] = useState<Segment[]>([]);
  const [live, setLive] = useState<{ id: string; since: number } | null>(null), [now, setNow] = useState(() => Date.now());
  const [days, setDays] = useState(30);
  const rec = useRef<Rec>({ stream: null, recorder: null, seq: 0, on: false, mime: "", queue: Promise.resolve() });
  const segRef = useRef<Segment[]>([]);

  const load = useCallback(() => getJson<Home>("listen").then((h) => { if (h) { setHome(h); setDays(h.retentionDays); } }), []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  const open = useCallback(async (id: string) => {
    const v = await getJson<View>(`listen/sessions/${id}?after=${lastSeq(segRef.current)}`);
    if (!v) return;
    segRef.current = mergeSegments(segRef.current, v.segments);
    setSegments(segRef.current); setView(v);
  }, []);
  // While a session is open, the transcript and the AI employee's replies refresh every two seconds.
  useEffect(() => {
    if (!view) return;
    const t = setInterval(() => { setNow(Date.now()); if (view.live || view.waiting || live) void open(view.id); }, 2000);
    return () => clearInterval(t);
  }, [view, live, open]);

  const piece = (id: string) => recordPieces(rec.current, id, (text) => setNote(text));

  async function start() {
    setBusy(true); setNote("");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("This browser can't record. Use Chrome, Edge or Safari.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const s = await post<{ id: string }>("listen/sessions", { agentId: agentId || null, title: title.trim() || "Conversation", purpose, consent });
      rec.current = { stream, recorder: null, seq: 0, on: true, mime: pickMime((m: string) => MediaRecorder.isTypeSupported(m)), queue: Promise.resolve() };
      segRef.current = []; setSegments([]);
      setLive({ id: s.id, since: Date.now() }); setNow(Date.now());
      piece(s.id);
      await open(s.id);
    } catch (e) {
      setNote(e instanceof Error ? (e.name === "NotAllowedError" ? "Allow the microphone for Vitals to listen." : e.message) : "Could not start listening.");
    } finally { setBusy(false); }
  }
  async function stop() {
    if (!live) return;
    setBusy(true);
    const r = rec.current;
    r.on = false;
    if (r.recorder?.state === "recording") r.recorder.stop();
    await new Promise((ok) => setTimeout(ok, 50));
    await r.queue;
    r.stream?.getTracks().forEach((t) => t.stop());
    try { await post(`listen/sessions/${live.id}/stop`, {}); } catch (e) { setNote(e instanceof Error ? e.message : "Could not stop."); }
    setLive(null); setBusy(false);
    await open(live.id); void load();
  }
  // Leaving the page stops the microphone (the server stops a silent session by itself after an hour).
  useEffect(() => () => { rec.current.on = false; rec.current.stream?.getTracks().forEach((t) => t.stop()); }, []);

  async function remove(id: string) {
    if (!window.confirm("Delete this transcript? This can't be undone.")) return;
    try { await post(`listen/sessions/${id}/delete`, {}); if (view?.id === id) { setView(null); segRef.current = []; setSegments([]); } void load(); }
    catch (e) { setNote(e instanceof Error ? e.message : "Could not delete."); }
  }
  async function saveSettings(change: Record<string, unknown>) {
    setBusy(true); setNote("");
    try {
      const r = await fetch("/api/v0/agent-channels", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
      const d = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(d.error ?? "Could not save.");
      await load(); setNote("Saved.");
    } catch (e) { setNote(e instanceof Error ? e.message : "Could not save."); }
    finally { setBusy(false); }
  }

  if (!home) return <p className={css.muted} role="status">Loading…</p>;
  const chosen = PURPOSES.find((p) => p.value === purpose);
  return <div className={css.room}>
    {home.canEdit ? <section className={css.card} aria-label="Listening for the company">
      <div className={css.row}><ShieldCheck size={18} aria-hidden="true" /><b>Listening for the company</b></div>
      <label className={css.check}><input type="checkbox" checked={home.on} disabled={busy} onChange={(e) => void saveSettings({ listenOn: e.target.checked })} />
        <span>Let people turn on listening so an AI employee can follow a conversation. Off by default.</span></label>
      <label className={css.field}><span>Keep transcripts for (days)</span>
        <span className={css.inline}><input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          <button type="button" className={css.quiet} disabled={busy || days === home.retentionDays} onClick={() => void saveSettings({ listenRetentionDays: days })}>Save</button></span></label>
      <small className={css.muted}>Audio is deleted as soon as it is turned into text. Transcripts, and the copies sent to the AI employee, are deleted after {home.retentionDays} days.</small>
    </section> : null}

    {!home.on ? <section className={css.card}><b>Listening is off for this company</b><small className={css.muted}>{home.canEdit ? "Switch it on above." : "An admin can switch it on."}</small></section>
      : live ? <section className={css.live} aria-live="polite">
        <div className={css.banner} role="status"><span className={css.dot} aria-hidden="true" /><b>Listening</b><span>{clock(now - live.since)}</span></div>
        <p className={css.consent}>Recording: everyone in this conversation has been told it is being recorded and transcribed{view?.agent ? ` for ${view.agent}` : ""}.</p>
        <button type="button" className={css.stop} disabled={busy} onClick={() => void stop()}><CircleStop size={18} aria-hidden="true" />Stop listening</button>
      </section>
      : <section className={css.card} aria-label="Start listening">
        <label className={css.field}><span>AI employee who follows along</span>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Nobody (transcript only)</option>
            {home.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></label>
        <label className={css.field}><span>What is it?</span>
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>{PURPOSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
          {chosen ? <small className={css.muted}>{chosen.hint}</small> : null}</label>
        <label className={css.field}><span>Name</span><input value={title} maxLength={120} placeholder="e.g. Call with a client about signboards" onChange={(e) => setTitle(e.target.value)} /></label>
        <div className={css.notice} role="note"><ShieldCheck size={16} aria-hidden="true" /><span>Before you start, tell everyone in the conversation that it will be recorded and transcribed, and why. Audio stays on the company&apos;s server.</span></div>
        <label className={css.check}><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>I have told everyone that this conversation is being recorded and transcribed.</span></label>
        <button type="button" className={css.primary} disabled={busy || !consent} onClick={() => void start()}><Mic size={18} aria-hidden="true" />Start listening</button>
      </section>}

    {note ? <p role="status" className={css.note}>{note}</p> : null}

    {view ? <div className={css.split}>
      <section className={css.card} aria-label="Live transcript">
        <div className={css.row}><b>{view.title}</b>{view.waiting ? <small className={css.muted}>· {view.waiting} piece{view.waiting === 1 ? "" : "s"} being transcribed</small> : null}</div>
        {segments.length ? <ol className={css.transcript} data-testid="transcript">{segments.map((s) => <li key={`${s.seq}:${s.part}`}><time>{clock(s.startMs)}</time><span>{s.text}</span></li>)}</ol>
          : <p className={css.muted}>{view.live ? "Listening… the first words show in about fifteen seconds." : "Nothing was heard."}</p>}
      </section>
      <section className={css.card} aria-label="What the AI employee did">
        <div className={css.row}><Bot size={18} aria-hidden="true" /><b>{view.agent ?? "No AI employee"}</b></div>
        {view.replies.length ? <ul className={css.replies}>{view.replies.map((r) => <li key={r.id}><time>{day(r.at)}</time><p>{r.body}</p></li>)}</ul>
          : <p className={css.muted}>{view.agent ? `${view.agent} gets the transcript about every 45 seconds and answers in your chat with it.` : "Choose an AI employee next time to have it react."}</p>}
      </section>
    </div> : null}

    {home.sessions.length ? <section className={css.card} aria-label="Earlier sessions">
      <b>Earlier sessions</b>
      <ul className={css.sessions}>{home.sessions.map((s) => <li key={s.id}>
        <button type="button" className={css.link} onClick={() => { segRef.current = []; setSegments([]); void open(s.id); }}>{s.title}</button>
        <small className={css.muted}>{day(s.startedAt)} · {s.segments} lines{s.agent ? ` · ${s.agent}` : ""}{s.stoppedAt ? "" : " · live"}</small>
        <button type="button" className={css.icon} aria-label={`Delete ${s.title}`} onClick={() => void remove(s.id)}><Trash2 size={16} aria-hidden="true" /></button>
      </li>)}</ul>
    </section> : null}
  </div>;
}
