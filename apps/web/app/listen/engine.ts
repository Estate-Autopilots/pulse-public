"use client";
// LISTEN-FAST (owner, 14 Nov 2026: "I'm waiting fifteen seconds... Not snappy like Wispr Flow"): the listening room's
// sound. One microphone, one audio graph:
//  * the level meter (so you can see it hears you), drawn straight onto an element, no re-render per frame;
//  * live words: the sound as 16 kHz PCM over a WebSocket to the speech service, with a one-use token the API made from
//    the server's key (the key never reaches the browser). Words still changing show at once (interim); each finished
//    sentence becomes a transcript line on the server (/words). Google's streams last 10 minutes, so a new one opens
//    before that (and when the service says goAway) while the sound waits in a small backlog: nothing is lost.
//  * the fallback, the server's own Whisper: pieces cut at a pause (3.5 to 8 s), uploaded in order, as before.
// The room asks for live words; the API says no (company switched them off, no key, month's budget used, service down)
// or the stream fails twice, and it records pieces instead. Nothing here keeps any sound.
import { post } from "../records";
import { liveEvent, liveSetup, meterLevel, pauseCutter, pickMime, rmsOf, toBase64, toPcm16 } from "../lib/listen-model.mjs";

export type Mode = "starting" | "instant" | "pieces";
export type Line = { seq: number; part: number; startMs: number; endMs: number; text: string };
export type Why = "off" | "not-set-up" | "budget" | "provider" | null;
type Grant = { ok: true; useId: string; model: string; url: string } | { ok: false; why: Exclude<Why, null> };
type Events = { mode(mode: Mode, why: Why): void; interim(text: string): void; final(line: Line): void; error(text: string): void };

const ROTATE_MS = 9.5 * 60000, BEAT_MS = 15000, BACKLOG = 16000 * 20; // 20 s of sound waits while a stream (re)opens

export class ListenEngine {
  mode: Mode = "starting";
  meterEl: HTMLElement | null = null;
  lastLoud = Date.now();
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private proc: ScriptProcessorNode | null = null;
  private ws: WebSocket | null = null;
  private recorder: MediaRecorder | null = null;
  private id = "";
  private seq = 0;
  private on = false;
  private queue: Promise<void> = Promise.resolve();
  private useId: string | null = null;
  private backlog: Int16Array[] = [];
  private backlogLen = 0;
  private utterAt: number | null = null;
  private interim = "";
  private timers: number[] = [];
  private rotateTimer = 0;
  private raf = 0;
  private retries = 0;
  private reconnecting = false;
  private finalWaiters: (() => void)[] = [];
  private cutter = pauseCutter();
  private lastTick = 0;
  private buf: Float32Array<ArrayBuffer> = new Float32Array(2048);

  constructor(private since: number, private ev: Events) {}

  /** The microphone and the audio graph; the meter moves from here on. */
  async open() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("This browser can't record. Use Chrome, Edge or Safari.");
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    this.on = true;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    void this.ctx.resume().catch(() => undefined);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 2048;
    src.connect(this.analyser);
    // The PCM tap for live words (ScriptProcessor: every browser has it; it must reach the output to run, so through a mute).
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    src.connect(this.proc); this.proc.connect(mute); mute.connect(this.ctx.destination);
    this.proc.onaudioprocess = (e) => { if (this.on && this.mode !== "pieces") this.sound(toPcm16(e.inputBuffer.getChannelData(0), this.ctx?.sampleRate ?? 48000)); };
    const draw = () => {
      const r = this.rms();
      if (r > 0.015) this.lastLoud = Date.now();
      this.meterEl?.style.setProperty("--lvl", meterLevel(r).toFixed(2));
      if (this.on) this.raf = requestAnimationFrame(draw);
    };
    this.raf = requestAnimationFrame(draw);
  }

  /** Start writing for this session: live words if the room wants them and the API grants a stream, else pieces. */
  async begin(id: string, instant: boolean) {
    this.id = id;
    if (instant && await this.connect()) {
      this.setMode("instant", null);
      this.timers.push(window.setInterval(() => void this.beat(), BEAT_MS));
    } else this.toPieces(instant ? this.why : null);
  }

  private why: Why = null;
  private setMode(mode: Mode, why: Why) { this.mode = mode; this.ev.mode(mode, why); }

  private rms() {
    if (!this.analyser) return 0;
    if (this.buf.length !== this.analyser.fftSize) this.buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(this.buf);
    return rmsOf(this.buf);
  }

  /** A block of 16 kHz sound: to the open stream, or into the backlog while one opens. */
  private sound(pcm: Int16Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.reconnecting) { this.send(pcm); return; }
    this.backlog.push(pcm); this.backlogLen += pcm.length;
    while (this.backlogLen > BACKLOG && this.backlog.length) this.backlogLen -= this.backlog.shift()!.length;
  }
  private send(pcm: Int16Array) {
    try { this.ws?.send(JSON.stringify({ realtimeInput: { audio: { data: toBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)), mimeType: "audio/pcm;rate=16000" } } })); }
    catch { /* the close handler takes over */ }
  }
  private flush() { const b = this.backlog; this.backlog = []; this.backlogLen = 0; for (const p of b) this.send(p); }

  /** Ask the API for a stream and open it; true once the service said it is ready. */
  private async connect(): Promise<boolean> {
    const g = await post<Grant>(`listen/sessions/${this.id}/live`, {}).catch((): Grant => ({ ok: false, why: "provider" }));
    if (!g.ok) { this.why = g.why; return false; }
    // A new stream replaces the old one: the old stream's meter gets its last beat now, so no minute goes uncounted.
    if (this.useId && this.useId !== g.useId) void post(`listen/sessions/${this.id}/live/beat`, { useId: this.useId }).catch(() => null);
    this.useId = g.useId;
    return new Promise<boolean>((resolve) => {
      let ws: WebSocket, settled = false;
      const done = (ok: boolean) => { if (settled) return; settled = true; window.clearTimeout(t); if (!ok) { this.why = "provider"; try { ws?.close(); } catch { /* closed */ } } resolve(ok); };
      const t = window.setTimeout(() => done(false), 6000);
      try { ws = new WebSocket(g.url); } catch { done(false); return; }
      ws.onopen = () => ws.send(JSON.stringify(liveSetup(g.model)));
      ws.onmessage = async (m) => {
        const e = liveEvent(typeof m.data === "string" ? m.data : await (m.data as Blob).text().catch(() => ""));
        if (!e) return;
        if (e.type === "ready") {
          const old = this.ws; this.ws = ws; this.reconnecting = false; this.retries = 0;
          if (old && old !== ws) { old.onclose = null; try { old.close(); } catch { /* closed */ } }
          this.flush(); done(true);
          window.clearTimeout(this.rotateTimer); this.rotateTimer = window.setTimeout(() => void this.reconnect(), ROTATE_MS);
        } else if (e.type === "interim") {
          if (!e.text) return;
          this.utterAt ??= Date.now() - 400; this.interim = e.text; this.ev.interim(e.text);
        } else if (e.type === "final") { if (e.text) this.line(e.text); }
        else if (e.type === "goAway") void this.reconnect();
        else if (e.type === "error") { if (!settled) done(false); else this.lost(); }
      };
      ws.onerror = () => { if (!settled) done(false); };
      ws.onclose = () => { if (!settled) done(false); else if (this.ws === ws) this.lost(); };
    });
  }

  /** A finished sentence: a transcript line here at once, and on the server (in order). */
  private line(text: string) {
    const now = Date.now(), at = this.utterAt ?? now - 1500;
    const l: Line = { seq: this.seq++, part: 0, startMs: Math.max(0, at - this.since), endMs: Math.max(0, now - this.since), text };
    this.utterAt = null; this.interim = ""; this.ev.interim(""); this.ev.final(l);
    this.queue = this.queue.then(() => post(`listen/sessions/${this.id}/words`, l).then(() => undefined).catch((e: unknown) => this.ev.error(e instanceof Error ? e.message : "A line did not reach Pulse.")));
    for (const w of this.finalWaiters.splice(0)) w();
  }

  /** A new stream before the old one ends (10 minutes, goAway, the month's beat said stop). */
  private async reconnect() {
    if (!this.on || this.reconnecting || this.mode !== "instant") return;
    this.reconnecting = true;
    if (this.interim) this.line(this.interim);
    if (!(await this.connect())) { this.reconnecting = false; this.toPieces(this.why); }
  }
  private lost() {
    if (!this.on || this.mode !== "instant") return;
    if (this.retries++ < 2) void this.reconnect(); else this.toPieces("provider");
  }
  private async beat() {
    if (!this.useId || !this.on) return;
    const r = await post<{ stop?: boolean }>(`listen/sessions/${this.id}/live/beat`, { useId: this.useId }).catch(() => null);
    if (r?.stop && this.on) void this.reconnect();
  }

  /** The fallback: pieces for the server's Whisper, each ending at a pause. */
  private toPieces(why: Why) {
    if (this.interim) this.line(this.interim);
    const ws = this.ws; this.ws = null; if (ws) { ws.onclose = null; try { ws.close(); } catch { /* closed */ } }
    window.clearTimeout(this.rotateTimer); this.backlog = []; this.backlogLen = 0;
    this.setMode("pieces", why);
    this.lastTick = performance.now();
    this.timers.push(window.setInterval(() => {
      const now = performance.now(), dt = now - this.lastTick; this.lastTick = now;
      if (this.recorder?.state === "recording" && this.cutter.step(this.rms(), dt)) this.recorder.stop();
    }, 100));
    this.piece();
  }
  private piece() {
    if (!this.on || !this.stream || this.mode !== "pieces") return;
    const mime = pickMime((m: string) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    const parts: Blob[] = [], began = Date.now();
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.onstop = () => {
      const seq = this.seq++, ms = Date.now() - began, type = rec.mimeType || mime || "audio/webm";
      this.queue = this.queue.then(async () => {
        const blob = new Blob(parts, { type });
        if (!blob.size) return;
        const audio = toBase64(new Uint8Array(await blob.arrayBuffer()));
        await post(`listen/sessions/${this.id}/audio`, { seq, ms, mime: type.split(";")[0], audio }).catch((e: unknown) => this.ev.error(e instanceof Error ? e.message : "A piece of audio did not reach Pulse."));
      });
      this.piece();
    };
    this.recorder = rec; this.cutter.reset();
    rec.start();
  }

  /** Stop: the last sentence is finished (up to 1.5 s), the last piece is sent, the microphone is let go. */
  async stop() {
    const wasInstant = this.mode === "instant" && this.ws;
    this.on = false;
    for (const t of this.timers) window.clearInterval(t);
    window.clearTimeout(this.rotateTimer);
    if (wasInstant && this.ws) {
      try { this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch { /* closed */ }
      if (this.interim) await new Promise<void>((ok) => { this.finalWaiters.push(ok); window.setTimeout(ok, 1500); });
      if (this.interim) this.line(this.interim);
      const ws = this.ws; this.ws = null; ws.onclose = null; try { ws.close(); } catch { /* closed */ }
    }
    if (this.recorder?.state === "recording") this.recorder.stop();
    await new Promise((ok) => setTimeout(ok, 50));
    await this.queue;
    if (this.useId) await post(`listen/sessions/${this.id}/live/beat`, { useId: this.useId }).catch(() => null);
    this.close();
  }

  /** Let the microphone go at once (leaving the page, or a start that failed). */
  close() {
    this.on = false;
    for (const t of this.timers) window.clearInterval(t);
    window.clearTimeout(this.rotateTimer); cancelAnimationFrame(this.raf);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch { /* closed */ } this.ws = null; }
    if (this.recorder?.state === "recording") { this.recorder.onstop = null; this.recorder.stop(); }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.proc) this.proc.onaudioprocess = null;
    void this.ctx?.close().catch(() => undefined);
    this.meterEl?.style.setProperty("--lvl", "0");
  }
}
