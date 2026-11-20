"use client";
// CHAT-VOICE: voice messages, WhatsApp style. Hold the mic to record and let go to send; slide left to cancel, slide
// up (or just tap the mic) to lock and record hands free, with pause, delete and send. A note is a chat file (the same
// 5 MB attachment as any other) with its length and waveform beside it; it plays in the bubble with speed 1× · 1.5× · 2×,
// one at a time, the next unplayed note following on. Played state: a blue mic on mine once someone has listened, a
// dot on theirs until I have.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronUp, CircleAlert, Download, Ear, FileText, Lock, Mic, Pause, Play, SendHorizontal, Trash2 } from "lucide-react";
import { get, readBase64, send } from "./net";
import type { Attachment, ChatMessage } from "./types";
import v from "./voice.module.css";
import { fileUrl, waUrl } from "./files";
import { MIC_EVENT, type MicRequest } from "../agent-ui/events";
import { transcriptAction } from "../lib/voice-note.mjs";

export const isVoice = (a: Attachment) => !!a.id && !!a.voice;
const MAX_SECONDS = 15 * 60;
const BARS = 48;
/** "0:07", "12:40". */
export const clockOf = (s: number) => { const t = Math.max(0, Math.floor(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

function pickMime() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}
/** The loudness of the whole note in `BARS` bars, each 4–100. */
export function peaksOf(levels: number[], n = BARS) {
  if (!levels.length) return Array.from({ length: n }, () => 4);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * levels.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n));
    let m = 0; for (let j = a; j < b && j < levels.length; j++) m = Math.max(m, levels[j]);
    out.push(m);
  }
  const top = Math.max(...out, 0.0001);
  return out.map((x) => Math.max(4, Math.round((x / top) * 100)));
}

type Recording = { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; levels: number[]; ctx: AudioContext; timer: number; started: number; pausedFor: number; pausedAt: number | null };
type Mode = "idle" | "starting" | "holding" | "locked" | "sending";

/** The mic in the composer (where Send is while nothing is typed) and the recording bar it opens. */
export function VoiceRecorder({ channelId, disabled, onSend, onError }: { channelId: string; disabled?: boolean; onSend: (a: Attachment) => void; onError: (message: string) => void }) {
  const [mode, setMode] = useState<Mode>("idle"), [elapsed, setElapsed] = useState(0), [live, setLive] = useState<number[]>([]);
  const [drag, setDrag] = useState({ x: 0, y: 0 }), [paused, setPaused] = useState(false);
  const rec = useRef<Recording | null>(null), press = useRef<{ x: number; y: number; at: number; id: number } | null>(null), modeNow = useRef<Mode>("idle");
  const to = useCallback((m: Mode) => { modeNow.current = m; setMode(m); }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { onError("This browser can’t record voice messages."); return false; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { onError((e as DOMException).name === "NotAllowedError" ? "Pulse needs your microphone for voice messages. Allow it for this site, then try again." : "No microphone was found."); return false; }
    const mime = pickMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    const ctx = new AudioContext(), analyser = ctx.createAnalyser(); analyser.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const r: Recording = { recorder, stream, chunks: [], levels: [], ctx, timer: 0, started: performance.now(), pausedFor: 0, pausedAt: null };
    recorder.ondataavailable = (e) => { if (e.data.size) r.chunks.push(e.data); };
    recorder.start(250);
    r.timer = window.setInterval(() => {
      if (r.pausedAt !== null) return;
      analyser.getByteTimeDomainData(buf); let sum = 0; for (const b of buf) { const x = (b - 128) / 128; sum += x * x; }
      r.levels.push(Math.sqrt(sum / buf.length));
      const secs = (performance.now() - r.started - r.pausedFor) / 1000;
      setElapsed(secs); setLive(r.levels.slice(-40));
      if (secs >= MAX_SECONDS) { recorder.pause(); r.pausedAt = performance.now(); setPaused(true); press.current = null; to("locked"); }
    }, 100);
    rec.current = r; navigator.vibrate?.(15);
    return true;
  }, [onError, to]);

  const finish = useCallback(async (keep: boolean) => {
    const r = rec.current; press.current = null; setDrag({ x: 0, y: 0 });
    if (!r) { to("idle"); return; }
    rec.current = null; window.clearInterval(r.timer);
    const seconds = (performance.now() - r.started - r.pausedFor - (r.pausedAt !== null ? performance.now() - r.pausedAt : 0)) / 1000;
    await new Promise<void>((done) => { r.recorder.onstop = () => done(); if (r.recorder.state === "inactive") done(); else r.recorder.stop(); });
    r.stream.getTracks().forEach((t) => t.stop()); void r.ctx.close().catch(() => {});
    setElapsed(0); setLive([]); setPaused(false);
    if (!keep) { to("idle"); return; }
    if (seconds < 0.8) { to("idle"); onError("Hold the mic to record, let go to send. Or tap it to record hands free."); return; }
    to("sending");
    try {
      const type = (r.recorder.mimeType || "audio/webm").split(";")[0], blob = new Blob(r.chunks, { type });
      if (blob.size > 5 * 1024 * 1024) throw new Error("That voice message is over 5 MB. Record a shorter one.");
      const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      const stamp = new Date().toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).replace(/[,:]/g, (c) => c === ":" ? "." : "");
      const name = `Voice message ${stamp}.${ext}`;
      const a = await send<Attachment>(`chats/${channelId}/files`, { name, mime: type, bytes: await readBase64(new File([blob], name, { type })) });
      onSend({ id: a.id, name: a.name, mime: a.mime, voice: { seconds: Math.max(1, Math.round(seconds)), peaks: peaksOf(r.levels) } });
    } catch (e) { onError((e as Error).message); } finally { to("idle"); }
  }, [channelId, onError, onSend, to]);

  // Leaving the chat (or the page) while recording drops the recording; Escape cancels it.
  useEffect(() => () => { const r = rec.current; if (r) { window.clearInterval(r.timer); try { r.recorder.stop(); } catch { /* already stopped */ } r.stream.getTracks().forEach((t) => t.stop()); void r.ctx.close().catch(() => {}); rec.current = null; } }, []);
  useEffect(() => {
    if (mode === "idle" || mode === "sending") return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); void finish(false); } };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [mode, finish]);

  // AGENT-UI-CONTROL: the person tapped "Start" on an AI employee's ask (Pulse never opens a microphone by itself): record
  // hands free; asked to stop, the note is sent as Send would.
  useEffect(() => {
    const mic = (e: Event) => {
      const on = (e as CustomEvent<MicRequest>).detail?.on;
      if (on === true && modeNow.current === "idle" && !disabled) { e.preventDefault(); press.current = null; to("starting"); void start().then((ok) => to(ok ? "locked" : "idle")); }
      else if (on === false && (modeNow.current === "locked" || modeNow.current === "holding")) { e.preventDefault(); void finish(true); }
    };
    window.addEventListener(MIC_EVENT, mic);
    return () => window.removeEventListener(MIC_EVENT, mic);
  }, [disabled, start, finish, to]);
  function down(e: ReactPointerEvent<HTMLButtonElement>) {
    if (disabled || modeNow.current !== "idle" || e.button > 0) return;
    e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    press.current = { x: e.clientX, y: e.clientY, at: performance.now(), id: e.pointerId };
    to("starting");
    void start().then((ok) => {
      if (!ok) { press.current = null; to("idle"); return; }
      // Still held: record while held. Let go already (a tap, or the browser's permission prompt took the press): hands free.
      to(press.current ? "holding" : "locked");
    });
  }
  function move(e: ReactPointerEvent<HTMLButtonElement>) {
    const p = press.current; if (!p || e.pointerId !== p.id || modeNow.current !== "holding") return;
    const dx = Math.min(0, e.clientX - p.x), dy = Math.min(0, e.clientY - p.y);
    if (dx < -120) { navigator.vibrate?.(30); void finish(false); return; }
    if (dy < -70) { navigator.vibrate?.(10); press.current = null; setDrag({ x: 0, y: 0 }); to("locked"); return; }
    setDrag(Math.abs(dx) > Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: dy });
  }
  function up(e: ReactPointerEvent<HTMLButtonElement>) {
    const p = press.current; if (!p || e.pointerId !== p.id) return;
    press.current = null; setDrag({ x: 0, y: 0 });
    if (modeNow.current !== "holding") return; // still starting: it becomes hands free when the mic opens
    if (performance.now() - p.at < 300) { to("locked"); return; }
    void finish(true);
  }
  function cancelled(e: ReactPointerEvent<HTMLButtonElement>) { if (press.current?.id === e.pointerId) { press.current = null; setDrag({ x: 0, y: 0 }); if (modeNow.current === "holding") to("locked"); } }
  function pause() {
    const r = rec.current; if (!r) return;
    if (r.pausedAt === null) { r.recorder.pause(); r.pausedAt = performance.now(); setPaused(true); }
    else if (elapsed < MAX_SECONDS) { r.pausedFor += performance.now() - r.pausedAt; r.pausedAt = null; r.recorder.resume(); setPaused(false); }
  }

  const recording = mode === "holding" || mode === "locked";
  const bars = live.length < 40 ? [...Array.from({ length: 40 - live.length }, () => 0), ...live] : live;
  const top = Math.max(0.02, ...live);
  return <>
    {recording ? <div className={v.recording} data-mode={mode} role="status" aria-live="polite" aria-label={paused ? `Recording paused at ${clockOf(elapsed)}` : `Recording ${clockOf(elapsed)}`}>
      {mode === "locked" ? <button type="button" className={v.trash} onClick={() => void finish(false)} aria-label="Delete the recording" title="Delete"><Trash2 size={19} aria-hidden="true" /></button> : null}
      <span className={v.dot} data-paused={paused || undefined} aria-hidden="true" />
      <time className={v.time}>{clockOf(elapsed)}</time>
      <span className={v.live} aria-hidden="true">{bars.map((x, i) => <i key={i} style={{ "--h": `${Math.max(8, Math.min(100, (x / top) * 100))}%` } as CSSProperties} />)}</span>
      {mode === "holding" ? <span className={v.slide} style={{ transform: `translateX(${Math.max(drag.x, -120) * 0.6}px)`, opacity: 1 + drag.x / 160 }}><ChevronLeft size={16} aria-hidden="true" />Slide to cancel</span>
        : <>
          <button type="button" className={v.pause} onClick={pause} aria-label={paused ? "Go on recording" : "Pause"} disabled={paused && elapsed >= MAX_SECONDS}>{paused ? <Mic size={18} aria-hidden="true" /> : <Pause size={18} aria-hidden="true" />}</button>
          <button type="button" className={v.sendNow} onClick={() => void finish(true)} aria-label="Send the voice message"><SendHorizontal size={20} aria-hidden="true" /></button>
        </>}
    </div> : null}
    {mode === "holding" ? <span className={v.lockHint} style={{ transform: `translateY(${Math.max(drag.y, -70) * 0.5}px)` }} aria-hidden="true"><Lock size={15} /><ChevronUp size={14} /></span> : null}
    <button type="button" className={v.mic} data-voice-mic="" data-mode={mode} disabled={disabled || mode === "sending"} aria-label="Record a voice message" title="Hold to record, let go to send · tap to record hands free"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancelled} onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && modeNow.current === "idle") { e.preventDefault(); press.current = null; to("starting"); void start().then((ok) => to(ok ? "locked" : "idle")); } }}
      style={mode === "holding" ? { transform: `translate(${drag.x}px, ${drag.y}px) scale(1.5)` } : undefined}>
      {mode === "sending" ? <span className={v.spin} aria-hidden="true" /> : <Mic size={21} aria-hidden="true" />}
    </button>
  </>;
}

// ---- Playback: one note at a time across the page. ----
// CHAT-VOICE-FIX (owner, 14 Nov 2026: Kazuk's note "does not play, I'm on full speaker, nothing"): the old player
// downloaded the whole note before it called play(); on a slow answer (~4 s) the tap's permission to start sound had
// run out, play() was refused and the refusal was swallowed. Now the page has one <audio> element, made and started
// inside the tap itself, that streams the note (range requests: it starts as the first bytes come and seeks), takes the
// AAC copy where WebM/Opus does not play (Safari, iPhone), and says so when a note cannot play: Try again · Download.
type Now = { id: string | null; playing: boolean; loading: boolean; time: number; rate: number; failed: string | null };
const readRate = () => { try { const r = Number(localStorage.getItem("pulse.voiceRate")); return r === 1.5 || r === 2 ? r : 1; } catch { return 1; } };
let now: Now = { id: null, playing: false, loading: false, time: 0, rate: 1, failed: null };
let rateRead = false;
const subs = new Set<() => void>();
const set = (p: Partial<Now>) => { now = { ...now, ...p }; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const snapshot = () => { if (!rateRead) { rateRead = true; now = { ...now, rate: readRate() }; } return now; };
const idle: Now = { id: null, playing: false, loading: false, time: 0, rate: 1, failed: null };
/** How long a note may take to start before it counts as not playing (a slow server answers in ~5 s). */
const START_MS = 20000;
type Play = { id: string; mime: string; chain: boolean; onStart: () => void; aac: boolean; started: boolean; attempt: number };
let audio: HTMLAudioElement | null = null, playing: Play | null = null, watchdog = 0;
/** Where a note streams from: an imported WhatsApp note is its playable copy already; a Pulse note asks for the AAC
 *  copy where this browser cannot play WebM/Opus. */
export function playUrl(id: string, aac: boolean) {
  return id.startsWith("wa-") ? waUrl(id.slice(3)) : `/api/v0/chats/files/${id}/play${aac ? "?as=aac" : ""}`;
}
const opusPlays = (a: HTMLAudioElement) => { try { return !!a.canPlayType('audio/webm; codecs="opus"'); } catch { return false; } };
const needsAac = (a: HTMLAudioElement, mime: string) => /^audio\/(webm|ogg)/.test(mime) && !opusPlays(a);
function failed(p: Play) { window.clearTimeout(watchdog); if (playing === p) { try { audio?.pause(); } catch { /* gone */ } set({ playing: false, loading: false, failed: p.id }); } }
/** The page's one player, made in the first tap (that is what lets iPhones and Android shells play it later too). */
function player() {
  if (audio) return audio;
  const a = new Audio(); a.preload = "auto";
  const mine = () => !!playing && now.id === playing.id;
  a.ontimeupdate = () => { if (mine()) set({ time: a.currentTime }); };
  a.onplaying = () => { const p = playing; if (!p || now.id !== p.id) return; window.clearTimeout(watchdog); set({ playing: true, loading: false, failed: null }); if (!p.started) { p.started = true; p.onStart(); } };
  a.onwaiting = () => { if (mine() && !a.paused) set({ loading: true }); };
  // A pause before the note started is this element moving to another note (or the tap that stopped it, which says so
  // itself): the new note keeps its spinner.
  a.onpause = () => { if (mine() && playing!.started) set({ playing: false, loading: false }); };
  a.onended = () => { const p = playing; if (!p) return; playing = null; set({ id: null, playing: false, loading: false, time: 0 }); if (p.chain) playNext(p.id); };
  a.onerror = () => {
    const p = playing; if (!p || !a.getAttribute("src")) return;
    // The WebM would not play in this browser after all: the AAC copy once (after this error is done), then say so.
    if (!p.aac && !p.id.startsWith("wa-") && !p.started) { p.aac = true; const at = now.time; window.setTimeout(() => { if (playing === p) startPlay(a, p, at); }, 0); return; }
    failed(p);
  };
  audio = a; return a;
}
function startPlay(a: HTMLAudioElement, p: Play, from: number) {
  const attempt = ++p.attempt;
  a.src = playUrl(p.id, p.aac); a.defaultPlaybackRate = now.rate; a.playbackRate = now.rate;
  if (from > 0) { const seek = () => { a.removeEventListener("loadedmetadata", seek); try { a.currentTime = from; } catch { /* not seekable yet */ } }; a.addEventListener("loadedmetadata", seek); }
  window.clearTimeout(watchdog);
  watchdog = window.setTimeout(() => { if (playing === p && !p.started) failed(p); }, START_MS);
  // Called inside the tap, so the browser lets the sound start; it starts as soon as the first bytes arrive.
  const go = a.play();
  // A refusal (NotAllowedError) is said; a file that will not play fires `error` too (handled there: the AAC copy first);
  // AbortError is this element moving on to another note.
  go?.catch((e: DOMException) => { if (playing !== p || p.attempt !== attempt || e?.name === "AbortError" || e?.name === "NotSupportedError") return; failed(p); });
}
function setRate(rate: number) { set({ rate }); if (audio) { audio.playbackRate = rate; audio.defaultPlaybackRate = rate; } try { localStorage.setItem("pulse.voiceRate", String(rate)); } catch { /* private mode */ } }
/** The next unplayed note below this one, in page order, plays on by itself (as on WhatsApp). */
function playNext(id: string) {
  const all = [...document.querySelectorAll<HTMLElement>("[data-voice-note]")];
  const i = all.findIndex((el) => el.dataset.voiceNote === id);
  const next = all.slice(i + 1).find((el) => el.dataset.unplayed !== undefined);
  next?.querySelector<HTMLButtonElement>("[data-voice-play]")?.click();
}
/** Play, pause or seek a note. Synchronous on purpose: it runs inside the tap. */
function toggle(id: string, mime: string, from: number | null, onStart: () => void, chain: boolean) {
  const a = player();
  if (now.id === id && playing?.id === id && now.failed !== id) {
    if (from !== null) { try { a.currentTime = from; } catch { /* not seekable yet */ } set({ time: from }); }
    const p = playing;
    if (a.paused) {
      set({ loading: !p.started });
      if (!p.started) { window.clearTimeout(watchdog); watchdog = window.setTimeout(() => { if (playing === p && !p.started) failed(p); }, START_MS); }
      a.play()?.catch((e: DOMException) => { if (e?.name !== "AbortError" && e?.name !== "NotSupportedError" && playing === p) failed(p); });
    } else if (from === null) {
      // Stopped while it was still starting: not a failure, just stopped.
      a.pause(); if (!p.started) { window.clearTimeout(watchdog); set({ playing: false, loading: false }); }
    }
    return;
  }
  a.pause();
  const p: Play = { id, mime, chain, onStart, aac: needsAac(a, mime), started: false, attempt: 0 };
  playing = p;
  set({ id, playing: false, loading: true, time: from ?? 0, failed: null });
  startPlay(a, p, from ?? 0);
}

/** CHAT-VOICE-FIX: "unclear" = transcribed, but the server is not sure of the words, so they are not shown (the English
 *  gist is, when there is one). */
export type VoiceState = { played: boolean; playedBy: number; transcript: string | null; transcriptState: "queued" | "done" | "failed" | "unclear" | null; gist?: string | null };
/** Who has played which note in this conversation (and transcripts, when the server has them switched on). */
/** `version` moves whenever the conversation is synced (someone playing a note re-syncs it through the live stream). */
export function useVoiceState(channelId: string, messages: ChatMessage[], version = 0) {
  const ids = useMemo(() => messages.filter((m) => !m.pending && !m.removed && m.attachments.some(isVoice)).map((m) => m.id), [messages]);
  const key = ids.join(",");
  const [state, setState] = useState<{ notes: Record<string, VoiceState>; transcripts: boolean }>({ notes: {}, transcripts: false });
  const stamp = messages.length ? `${messages.length}:${messages[messages.length - 1].id}` : "";
  useEffect(() => {
    if (!key) return;
    const ac = new AbortController();
    const t = setTimeout(() => { void get<{ notes: Record<string, VoiceState>; transcripts: boolean }>(`chats/${channelId}/voice`, ac.signal).then((d) => { if (!ac.signal.aborted && d?.notes) setState(d); }).catch(() => {}); }, 60);
    return () => { clearTimeout(t); ac.abort(); };
  }, [channelId, key, stamp, version]);
  const played = useCallback((id: string) => {
    setState((s) => s.notes[id]?.played ? s : { ...s, notes: { ...s.notes, [id]: { ...(s.notes[id] ?? { playedBy: 0, transcript: null, transcriptState: null }), played: true } } });
    void send(`chats/messages/${id}/played`).catch(() => {});
  }, []);
  // PULSE-BUGS-2 (EA #34): a refused request says so (Try the transcript again), not "Transcribing…" until the next sync.
  const transcribe = useCallback((id: string) => {
    const mark = (transcriptState: VoiceState["transcriptState"]) => setState((s) => ({ ...s, notes: { ...s.notes, [id]: { ...(s.notes[id] ?? { played: false, playedBy: 0, transcript: null }), transcriptState } } }));
    mark("queued");
    void send(`chats/messages/${id}/transcript`).catch(() => mark("failed"));
  }, []);
  return { notes: state.notes, transcripts: state.transcripts, played, transcribe };
}

/** A voice note in its bubble: play, the waveform (tap or drag to seek), its length, the speed while it plays. */
export function VoiceNote({ messageId, a, mine, state, transcripts, onPlayed, onTranscribe }: { messageId: string; a: Attachment; mine: boolean; state?: VoiceState; transcripts: boolean; onPlayed: () => void; onTranscribe: () => void }) {
  const n = useSyncExternalStore(subscribe, snapshot, () => idle);
  const id = a.id!, seconds = a.voice?.seconds ?? 0, peaks = a.voice?.peaks?.length ? a.voice.peaks : Array.from({ length: BARS }, () => 20);
  const current = n.id === id, at = current ? n.time : 0, progress = seconds ? Math.min(1, at / seconds) : 0, broken = n.failed === id;
  const unplayed = !mine && !state?.played, ask = transcriptAction({ id, transcripts, state });
  const wave = useRef<HTMLSpanElement>(null), seeking = useRef(false);
  const begin = () => { if (!mine && !state?.played) onPlayed(); };
  const seekTo = (clientX: number) => {
    const el = wave.current; if (!el || !seconds) return;
    const r = el.getBoundingClientRect(), f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    toggle(id, a.mime ?? "audio/webm", f * seconds, begin, unplayed);
  };
  return <div className={v.note} data-voice-note={messageId} data-unplayed={unplayed || undefined} data-mine={mine || undefined} data-failed={broken || undefined}>
    <button type="button" className={v.play} data-voice-play="" onClick={() => toggle(id, a.mime ?? "audio/webm", null, begin, unplayed)}
      aria-label={broken ? "Try again" : current && n.playing ? "Pause the voice message" : `Play the voice message, ${clockOf(seconds)}`} title={broken ? "Try again" : undefined} aria-busy={(current && n.loading) || undefined}>
      {broken ? <CircleAlert size={24} strokeWidth={2.6} aria-hidden="true" /> : current && n.loading ? <span className={v.spin} aria-hidden="true" /> : current && n.playing ? <Pause size={20} aria-hidden="true" fill="currentColor" /> : <Play size={20} aria-hidden="true" fill="currentColor" />}
    </button>
    <span className={v.body}>
      {/* Could not play: said where the waveform is (an icon and words, not colour alone; nothing moves); the play button
          shows the alert (tapping it tries again too), and Download takes the Transcript link's place in the length row. */}
      {broken ? <span className={v.failed} role="alert">Couldn’t play
        <button type="button" className={v.retry} onClick={() => toggle(id, a.mime ?? "audio/webm", null, begin, unplayed)}>Try again</button></span> : <>
      <span ref={wave} className={v.wave} role="slider" tabIndex={0} aria-label="Position in the voice message" aria-valuemin={0} aria-valuemax={Math.round(seconds)} aria-valuenow={Math.round(at)} aria-valuetext={`${clockOf(at)} of ${clockOf(seconds)}`}
        onPointerDown={(e) => { seeking.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ } seekTo(e.clientX); }}
        onPointerMove={(e) => { if (seeking.current && current) seekTo(e.clientX); }} onPointerUp={() => { seeking.current = false; }} onPointerCancel={() => { seeking.current = false; }}
        onKeyDown={(e) => { if (!current || !audio) return; if (e.key === "ArrowRight") audio.currentTime = Math.min(seconds, audio.currentTime + 5); if (e.key === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 5); }}>
        {peaks.map((p, i) => <i key={i} data-on={i / peaks.length < progress || undefined} style={{ "--h": `${Math.max(12, p)}%` } as CSSProperties} />)}
        <b className={v.knob} style={{ left: `${progress * 100}%` }} aria-hidden="true" />
      </span>
      </>}
      <span className={v.under}>
        <time>{clockOf(current && (n.playing || at > 0) ? at : seconds)}</time>
        <i className={v.mark} data-played={(mine ? !!state?.playedBy : !!state?.played) || undefined} title={mine ? (state?.playedBy ? "Played" : "Not played yet") : undefined}><Mic size={13} aria-hidden="true" /></i>
        {mine && state?.playedBy ? <span className={v.srOnly}>Played</span> : null}
        {broken ? <a className={v.textBtn} href={fileUrl({ id })} download={a.name ?? "Voice message"} data-voice-failed=""><Download size={12} aria-hidden="true" />Download</a>
          : ask ? <button type="button" className={v.textBtn} onClick={onTranscribe} disabled={ask === "working"} data-voice-transcript={ask}><FileText size={12} aria-hidden="true" />{ask === "working" ? "Transcribing…" : ask === "retry" ? "Try the transcript again" : "Transcript"}</button> : null}
      </span>
    </span>
    {current && !broken && (n.playing || n.time > 0) ? <button type="button" className={v.rate} onClick={() => setRate(n.rate === 1 ? 1.5 : n.rate === 1.5 ? 2 : 1)} aria-label={`Playback speed ${n.rate}×. Change it`}>{n.rate}×</button> : null}
    {/* CHAT-VOICE-FIX: what the note says, across the whole bubble (under the play button too). */}
    {state?.transcript ? <span className={v.transcript}>{state.transcript}</span> : null}
    {state?.transcriptState === "unclear" ? <span className={v.unclear} data-voice-unclear="">
      <span className={v.unclearHead}><Ear size={15} aria-hidden="true" />Not clear — listen</span>
      {state.gist ? <span className={v.gist}><span>Pulse’s guess:</span> {state.gist}</span> : null}</span> : null}
  </div>;
}
