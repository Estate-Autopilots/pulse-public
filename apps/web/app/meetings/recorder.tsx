"use client";
// KAZUK-REST slice 4 (D1/D2): record a meeting in the room. First the consent notice (the person confirms everyone present
// was told and agreed; Pulse keeps that with the meeting), then the browser records in 5-second parts that go up as they
// come (tried again while the network is down), so a dropped phone loses seconds, not the meeting. Stop uploads what is
// left and opens the meeting's page, where the transcript (the server's own Whisper) or typed notes give the action items.
// The microphone's problems are said plainly with Try again (lib/call-trouble.mjs, as calls).
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CircleDot, FileText, Mic, MicOff, ShieldCheck, Square } from "lucide-react";
import { MEDIA_WAIT_MS, mediaProblem, mediaReason, withTimeout, type Problem } from "../lib/call-trouble.mjs";
import { say } from "../lib/words.mjs";
import { useWords } from "../org-code";
import css from "./meetings.module.css";
import phone from "./recorder-phone.module.css";

type Options = { projects: { id: string; name: string; clientName: string | null }[]; clients: { id: string; name: string }[]; people: { id: string; name: string }[]; transcripts: boolean; consentText: string };
const MIMES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
const pickMime = () => typeof MediaRecorder === "undefined" ? null : MIMES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const base64 = async (b: Blob) => { const u = new Uint8Array(await b.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
async function post<T>(path: string, body: unknown): Promise<T> {
  let r: Response;
  try { r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch { throw Object.assign(new Error("Pulse can’t be reached. Check the connection and try again."), { status: 0 }); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((d as { error?: string }).error ?? "That did not go through. Try again."), { status: r.status });
  return d as T;
}

/** `purpose="problem"` (MEETING-CAPTURE, Narrate a problem): the person records only themself, so it starts at once with
 *  no project, people or consent form; the meeting's page shows the drafted bug report once the transcript is made. */
export function Recorder({ project, client, purpose = "meeting" }: { project: string | null; client: string | null; purpose?: "meeting" | "problem" }) {
  const solo = purpose === "problem";
  const words = useWords();
  const router = useRouter();
  const [opts, setOpts] = useState<Options | null>(null), [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState(""), [projectId, setProjectId] = useState(project ?? ""), [clientId, setClientId] = useState(client ?? ""), [people, setPeople] = useState<string[]>([]);
  const [consent, setConsent] = useState(solo), [busy, setBusy] = useState(false), [error, setError] = useState(""), [problem, setProblem] = useState<Problem | null>(null);
  const [live, setLive] = useState<{ id: string; t0: number } | null>(null), [secs, setSecs] = useState(0), [pending, setPending] = useState(0);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; queue: { seq: number; blob: Blob }[]; seq: number; sending: boolean; fails: number } | null>(null);
  useEffect(() => { fetch("/api/v0/meetings/options").then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Could not load"); setOpts(d); }).catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load")); }, []);
  useEffect(() => { if (!live) return; const t = setInterval(() => setSecs((performance.now() - live.t0) / 1000), 500); return () => clearInterval(t); }, [live]);
  // Leaving the page while recording asks first (the browser's own question).
  useEffect(() => { if (!live) return; const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [live]);
  useEffect(() => () => { rec.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  const pump = (id: string) => {
    const r = rec.current; if (!r || r.sending || !r.queue.length) { setPending(r?.queue.length ?? 0); return; }
    r.sending = true; const part = r.queue[0]; setPending(r.queue.length);
    void base64(part.blob).then((bytes) => post(`meetings/${id}/parts`, { seq: part.seq, bytes }))
      .then(() => { r.queue.shift(); r.fails = 0; })
      .catch((e: { status?: number }) => { if (e.status && e.status >= 400 && e.status < 500) { r.queue = []; return; } r.fails++; if (r.fails > 12) r.queue.shift(); })
      .finally(() => { r.sending = false; setPending(r.queue.length); if (r.queue.length) setTimeout(() => pump(id), r.fails ? Math.min(5000, 300 * 2 ** r.fails) : 0); });
  };

  async function start() {
    if (busy) return; // FIX-DOCS-WORK: pressing Start recording is the consent (the notice sits right above it)
    const mime = pickMime();
    if (!mime) { setProblem({ reason: "media-unsupported", title: "This browser can’t record", text: "Record meetings in Chrome, Edge, Firefox or Safari, or the Pulse phone app. Or write the notes instead." }); return; }
    setBusy(true); setError(""); setProblem(null);
    let stream: MediaStream;
    try { stream = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }), MEDIA_WAIT_MS, (s) => s.getTracks().forEach((t) => t.stop())); }
    catch (e) { setProblem(mediaProblem(mediaReason((e as DOMException)?.name))); setBusy(false); return; }
    try {
      const r = await post<{ id: string }>("meetings", solo ? { title: "A problem I described", purpose: "problem", consent: true, mime }
        : { title, projectId: projectId || null, clientId: clientId || null, attendees: people, consent: true, mime });
      const mr = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 24000 });
      rec.current = { mr, stream, queue: [], seq: 0, sending: false, fails: 0 };
      mr.ondataavailable = (e) => { const x = rec.current; if (x && e.data.size) { x.queue.push({ seq: x.seq++, blob: e.data }); pump(r.id); } };
      mr.start(5000);
      setLive({ id: r.id, t0: performance.now() }); setSecs(0);
    } catch (e) { stream.getTracks().forEach((t) => t.stop()); setError(e instanceof Error ? e.message : "The meeting did not start. Try again."); }
    finally { setBusy(false); }
  }
  async function stop() {
    const r = rec.current; if (!r || !live || busy) return;
    setBusy(true);
    await new Promise<void>((done) => { r.mr.onstop = () => done(); try { if (r.mr.state === "inactive") done(); else r.mr.stop(); } catch { done(); } setTimeout(done, 3000); });
    r.stream.getTracks().forEach((t) => t.stop());
    for (let i = 0; i < 60 && (r.queue.length || r.sending); i++) await new Promise((x) => setTimeout(x, 500));
    try { await post(`meetings/${live.id}/stop`, { seconds: Math.round((performance.now() - live.t0) / 1000) }); } catch { /* the page shows what was saved */ }
    rec.current = null; setLive(null);
    router.push(`/meetings/${live.id}`);
  }
  async function notesOnly() {
    if (busy) return; setBusy(true); setError("");
    try { const r = await post<{ id: string }>("meetings", { kind: "notes", title, projectId: projectId || null, clientId: clientId || null, attendees: people }); router.push(`/meetings/${r.id}?notes=1`); }
    catch (e) { setError(e instanceof Error ? e.message : "That did not go through. Try again."); setBusy(false); }
  }

  if (live) return <section className={css.card} aria-live="polite" data-recording="">
    <p className={css.recLine}><span className={css.recDot} aria-hidden="true" /><b>Recording</b><span className={css.clock}>{clock(secs)}</span></p>
    <p className={css.note}>{solo ? "Say what went wrong, and on which page" : title || "Meeting"}. Keep this page open; the audio goes to Pulse every few seconds{pending > 1 ? ` (${pending} parts waiting for the network)` : ""}.</p>
    <button type="button" className={css.stop} onClick={() => void stop()} disabled={busy}><Square size={16} fill="currentColor" aria-hidden="true" />{busy ? "Saving…" : "Stop and save"}</button>
  </section>;

  const clientWord = say("{client}", words);
  if (solo) return <section className={css.card} data-problem-recorder="">
    <p className={css.private}><ShieldCheck size={14} aria-hidden="true" />Pulse records only you, and writes it down on its own server. Nothing goes to an outside service.</p>
    <p className={css.note}>{opts && !opts.transcripts ? "Recording needs this Pulse’s own transcripts switched on. Type it instead." : "Tap, say what went wrong and on which page, then Stop. Pulse drafts the bug report for you to send."}</p>
    {problem ? <div className={css.problem} role="alert" data-meeting-problem={problem.reason}><p><MicOff size={18} aria-hidden="true" /><span><b>{problem.title}</b>{problem.text}</span></p></div> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.actions}><button type="button" className={css.primaryBtn} onClick={() => void start()} disabled={busy || !opts?.transcripts}>
      {busy ? <CircleDot size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}{busy ? "Starting…" : "Record the problem"}</button></div>
  </section>;
  return <section className={css.card}>
    {loadError ? <p className={css.error} role="alert">{loadError}</p> : null}
    <label className={css.field}><span>What is it about?</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="Site visit, weekly review…" /></label>
    {/* FIX-DOCS-WORK (owner, 10 Nov 2026: "very poor UI; recording should be on by default; client communication is top
        priority; test it from a phone"): the client first; teammates fold away; one short notice; Start recording is the
        first, primary action (pressing it confirms everyone was told), kept in sight above a phone's bottom bar. */}
    <div className={css.two}>
      <label className={css.field}><span>{say("{Client}", words)}</span>
        <select value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!opts} className={`${phone.select} ${clientId ? "" : phone.unset}`}><option value="">{`Pick a ${clientWord} (optional)`}</option>
          {opts?.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className={css.field}><span>{say("{Project}", words)}</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={!opts} className={`${phone.select} ${projectId ? "" : phone.unset}`}><option value="">{say("Pick a {project} (optional)", words)}</option>
          {opts?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.clientName ? ` · ${p.clientName}` : ""}</option>)}</select></label>
    </div>
    {opts?.people.length ? <details className={phone.people}><summary>Who else is here? <em>{people.length ? `${people.length} picked` : "(optional)"}</em></summary>
      <div className={css.people}><div>{opts.people.map((p) => <label key={p.id}><input type="checkbox" checked={people.includes(p.id)} onChange={(e) => setPeople((x) => e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id))} />{p.name}</label>)}</div></div>
    </details> : null}
    {problem ? <div className={css.problem} role="alert" data-meeting-problem={problem.reason}><p><MicOff size={18} aria-hidden="true" /><span><b>{problem.title}</b>{problem.text}</span></p>
      <span><button type="button" className={css.ghost} onClick={() => setProblem(null)}>Close</button><button type="button" className={css.primaryBtn} onClick={() => void start()} disabled={busy}>Try again</button></span></div> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={phone.go} data-consented={consent ? "" : undefined}>
      <p className={phone.notice} id="consent-why"><ShieldCheck size={16} aria-hidden="true" /><span><b>Tell everyone first.</b> Pressing Start means everyone here agrees to be recorded.</span></p>
      <button type="button" className={`${css.primaryBtn} ${phone.record}`} onClick={() => { setConsent(true); void start(); }} disabled={busy || !opts} aria-describedby="consent-why" data-start-recording="">
        {busy ? <CircleDot size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}{busy ? "Starting…" : "Start recording"}</button>
      <p className={phone.cheer}>When you stop, Pulse writes the notes and finds the tasks for you to confirm.</p>
      <button type="button" className={phone.notes} onClick={() => void notesOnly()} disabled={busy || !opts}><FileText size={15} aria-hidden="true" />Write notes instead</button>
    </div>
  </section>;
}
