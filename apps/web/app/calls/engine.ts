// CHAT-VOICE: the call engine, one per page. It holds the stream of call events (GET /api/v0/calls/events), the
// calls ringing me, and the one call I am in: my microphone (and camera), and a WebRTC connection to each other
// person in it (a mesh, up to 8 people). Connections use "perfect negotiation" (either side may renegotiate, e.g.
// to turn a camera on; a collision is settled by who is polite), with ICE restarts when a network changes. Signals
// to the others are batched (40 ms) and posted to the API; theirs arrive on the stream.
import { shell } from "../lib/native-shell";
import { tones } from "./tones";

export type Party = { id: string; name: string; photoAt: string | null; state: "ringing" | "joined" | "declined" | "missed" | "left" | "busy"; muted: boolean; video: boolean; joinedAt: string | null; invitedBy: string | null };
export type Call = { id: string; channelId: string; channelKind: string; channelName: string | null; video: boolean; state: "ringing" | "live" | "ended"; endReason: string | null;
  startedBy: string; messageId: string | null; createdAt: string; answeredAt: string | null; endedAt: string | null; now: string; parties: Party[] };
type Ice = { iceServers: RTCIceServer[]; relay?: boolean };
type Signal = { callId: string; from: string; kind: "description" | "candidate"; body: unknown };
export type PeerView = { id: string; stream: MediaStream | null; state: RTCPeerConnectionState | "new"; level: number };
export type SessionView = { call: Call; muted: boolean; camera: boolean; facing: "user" | "environment"; local: MediaStream | null; peers: PeerView[]; minimized: boolean; output: string | null; error: string | null; connecting: boolean; speaker: boolean | null };
export type Snapshot = { me: string | null; live: boolean; calls: Call[]; session: SessionView | null; ended: { call: Call; at: number } | null; error: string | null };

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? "That did not go through. Try again.");
  return d as T;
}
const mediaError = (e: unknown, video: boolean) => {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return video ? "Pulse needs your microphone and camera for a video call. Allow them for this site, then try again." : "Pulse needs your microphone for calls. Allow it for this site, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return video ? "No camera or microphone was found." : "No microphone was found.";
  if (name === "NotReadableError") return "Your microphone or camera is in use by another app.";
  return "Calls need a browser with a microphone (Chrome, Edge, Safari or Firefox).";
};
async function media(video: boolean, facing: "user" | "environment" = "user") {
  if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error(mediaError(null, video));
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } } : false });
  } catch (e) {
    // A video call still goes ahead without a camera.
    if (video && ((e as DOMException)?.name === "NotFoundError" || (e as DOMException)?.name === "NotReadableError")) { try { return await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { /* fall through */ } }
    throw new Error(mediaError(e, video));
  }
}

class Peer {
  pc: RTCPeerConnection; stream: MediaStream | null = null; making = false; ignore = false; polite: boolean; level = 0;
  private analyser: AnalyserNode | null = null; private buf: Uint8Array<ArrayBuffer> | null = null;
  constructor(private s: Session, public id: string) {
    this.polite = s.me > id;
    this.pc = new RTCPeerConnection({ iceServers: s.ice.iceServers, bundlePolicy: "max-bundle" });
    for (const t of s.local?.getTracks() ?? []) this.pc.addTrack(t, s.local!);
    // A video call keeps a video line even with the camera off, so turning it on later needs no new offer.
    if (s.camera === false && s.call.video && !s.local?.getVideoTracks().length) this.pc.addTransceiver("video", { direction: "sendrecv" });
    this.pc.onnegotiationneeded = async () => {
      try { this.making = true; await this.pc.setLocalDescription(); s.signal(id, "description", this.pc.localDescription); }
      catch { /* a newer negotiation replaces this one */ } finally { this.making = false; }
    };
    this.pc.onicecandidate = ({ candidate }) => { if (candidate) s.signal(id, "candidate", candidate.toJSON()); };
    this.pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] ?? this.stream ?? new MediaStream();
      if (!stream.getTracks().includes(track)) stream.addTrack(track);
      this.stream = stream; if (track.kind === "audio") this.listen(stream); s.changed();
      track.onunmute = () => s.changed(); track.onended = () => s.changed();
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "failed") this.pc.restartIce();
      s.changed();
    };
    this.pc.oniceconnectionstatechange = () => { if (this.pc.iceConnectionState === "failed") this.pc.restartIce(); };
  }
  private listen(stream: MediaStream) {
    try { const ctx = this.s.audioCtx(); const src = ctx.createMediaStreamSource(stream); this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512; src.connect(this.analyser); this.buf = new Uint8Array(this.analyser.fftSize); } catch { /* no level meter */ }
  }
  measure() {
    if (!this.analyser || !this.buf) return 0;
    this.analyser.getByteTimeDomainData(this.buf); let sum = 0; for (const b of this.buf) { const x = (b - 128) / 128; sum += x * x; }
    this.level = Math.min(1, Math.sqrt(sum / this.buf.length) * 6); return this.level;
  }
  async handle(kind: Signal["kind"], body: unknown) {
    try {
      if (kind === "description") {
        const d = body as RTCSessionDescriptionInit;
        const collision = d.type === "offer" && (this.making || this.pc.signalingState !== "stable");
        this.ignore = !this.polite && collision;
        if (this.ignore) return;
        await this.pc.setRemoteDescription(d);
        if (d.type === "offer") { await this.pc.setLocalDescription(); this.s.signal(this.id, "description", this.pc.localDescription); }
      } else if (body) {
        try { await this.pc.addIceCandidate(body as RTCIceCandidateInit); } catch (e) { if (!this.ignore) throw e; }
      }
    } catch { /* a stale message from an earlier negotiation */ }
  }
  close() { try { this.pc.close(); } catch { /* closed */ } this.stream?.getTracks().forEach((t) => t.stop()); }
}

class Session {
  peers = new Map<string, Peer>(); muted = false; minimized = false; output: string | null = null; error: string | null = null; facing: "user" | "environment" = "user";
  private out: { to: string; kind: string; body: unknown }[] = []; private flush: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval>; private meter: ReturnType<typeof setInterval>; private ctx: AudioContext | null = null; private early = new Map<string, Signal[]>();
  closed = false;
  /** The Pulse phone app: loudspeaker (video calls) or earpiece (voice calls), switchable; null in a browser. */
  speaker: boolean | null = null;
  constructor(private e: Engine, public me: string, public call: Call, public ice: Ice, public local: MediaStream | null, public camera: boolean) {
    if (shell()?.setSpeaker) void this.setSpeaker(camera || call.video);
    this.beat = setInterval(() => void this.sendBeat(), 8000);
    this.meter = setInterval(() => { let any = false; for (const p of this.peers.values()) { const before = p.level; if (Math.abs(p.measure() - before) > 0.05) any = true; } if (any) this.changed(); }, 220);
    void this.sendBeat();
    this.update(call);
  }
  audioCtx() { if (!this.ctx) this.ctx = new AudioContext(); if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {}); return this.ctx; }
  changed() { this.e.emit(); }
  signal(to: string, kind: "description" | "candidate", body: unknown) {
    if (this.closed) return;
    this.out.push({ to, kind, body: body && typeof body === "object" && "toJSON" in body ? (body as { toJSON: () => unknown }).toJSON() : body });
    if (!this.flush) this.flush = setTimeout(() => {
      this.flush = null;
      while (this.out.length) { const batch = this.out.splice(0, 60); void post(`calls/${this.call.id}/signal`, { signals: batch }).catch(() => {}); }
    }, 40);
  }
  async sendBeat() { if (this.closed) return; try { const r = await post<{ inCall: boolean }>(`calls/${this.call.id}/beat`, { muted: this.muted, video: this.camera }); if (!r.inCall && !this.closed && this.call.state !== "ended") void this.e.refresh(this.call.id); } catch { /* the next beat tries again */ } }
  update(call: Call) {
    this.call = call;
    const mine = call.parties.find((p) => p.id === this.me);
    if (call.state === "ended" || !mine || mine.state !== "joined") { this.e.endSession(call); return; }
    const joined = new Set(call.parties.filter((p) => p.state === "joined" && p.id !== this.me).map((p) => p.id));
    for (const id of joined) if (!this.peers.has(id)) this.addPeer(id);
    for (const [id, p] of this.peers) if (!joined.has(id)) { p.close(); this.peers.delete(id); }
    this.changed();
  }
  private addPeer(id: string) {
    const p = new Peer(this, id); this.peers.set(id, p);
    for (const s of this.early.get(id) ?? []) void p.handle(s.kind, s.body);
    this.early.delete(id);
    return p;
  }
  onSignal(s: Signal) {
    if (this.closed || s.callId !== this.call.id) return;
    const p = this.peers.get(s.from);
    if (p) void p.handle(s.kind, s.body);
    else { const list = this.early.get(s.from) ?? []; list.push(s); this.early.set(s.from, list.slice(-80)); void this.e.refresh(this.call.id); }
  }
  toggleMute() { this.muted = !this.muted; this.local?.getAudioTracks().forEach((t) => { t.enabled = !this.muted; }); void this.sendBeat(); this.changed(); }
  async setCamera(on: boolean, facing = this.facing) {
    this.error = null;
    if (on) {
      let track: MediaStreamTrack;
      try { track = (await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } } })).getVideoTracks()[0]; }
      catch (e) { this.error = mediaError(e, true); this.changed(); return; }
      if (this.closed) { track.stop(); return; }
      this.local?.getVideoTracks().forEach((t) => { t.stop(); this.local!.removeTrack(t); });
      if (!this.local) this.local = new MediaStream();
      this.local.addTrack(track); this.facing = facing;
      for (const p of this.peers.values()) {
        const sender = p.pc.getTransceivers().find((t) => t.receiver.track.kind === "video" && t.currentDirection !== "stopped")?.sender;
        if (sender) { await sender.replaceTrack(track).catch(() => {}); const tr = p.pc.getTransceivers().find((t) => t.sender === sender); if (tr && tr.direction !== "sendrecv") tr.direction = "sendrecv"; }
        else p.pc.addTrack(track, this.local);
      }
      this.camera = true;
    } else {
      this.local?.getVideoTracks().forEach((t) => { t.stop(); this.local!.removeTrack(t); });
      for (const p of this.peers.values()) for (const t of p.pc.getTransceivers()) if (t.currentDirection !== "stopped" && (t.sender.track?.kind === "video" || t.receiver.track.kind === "video")) await t.sender.replaceTrack(null).catch(() => {});
      this.camera = false;
    }
    void this.sendBeat(); this.changed();
  }
  flip() { return this.setCamera(true, this.facing === "user" ? "environment" : "user"); }
  async setSpeaker(on: boolean) { try { await shell()?.setSpeaker?.({ on }); this.speaker = on; } catch { /* older shell */ } this.changed(); }
  async setOutput(id: string) { this.output = id; this.changed(); }
  view(): SessionView {
    return { call: this.call, muted: this.muted, camera: this.camera, facing: this.facing, local: this.local, minimized: this.minimized, output: this.output, error: this.error, speaker: this.speaker,
      connecting: this.call.state === "live" && [...this.peers.values()].length > 0 && ![...this.peers.values()].some((p) => p.pc.connectionState === "connected"),
      peers: [...this.peers.values()].map((p) => ({ id: p.id, stream: p.stream, state: p.pc.connectionState, level: p.level })) };
  }
  close() {
    if (this.closed) return; this.closed = true;
    clearInterval(this.beat); clearInterval(this.meter); if (this.flush) clearTimeout(this.flush);
    for (const p of this.peers.values()) p.close(); this.peers.clear();
    this.local?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    if (this.speaker !== null) void shell()?.setSpeaker?.({ on: false }).catch(() => {});
  }
}

export class Engine {
  me: string | null = null; calls = new Map<string, Call>(); session: Session | null = null; ended: { call: Call; at: number } | null = null; error: string | null = null; live = false;
  private subs = new Set<() => void>(); private snap: Snapshot = { me: null, live: false, calls: [], session: null, ended: null, error: null }; private dirty = true;
  private es: EventSource | null = null; private starting = false;
  subscribe = (f: () => void) => { this.subs.add(f); return () => { this.subs.delete(f); }; };
  snapshot = () => {
    if (this.dirty) { this.dirty = false; this.snap = { me: this.me, live: this.live, calls: [...this.calls.values()], session: this.session?.view() ?? null, ended: this.ended, error: this.error }; }
    return this.snap;
  };
  emit() { this.dirty = true; this.subs.forEach((f) => f()); this.sound(); }
  connect(me: string) {
    if (this.es && this.me === me) return;
    this.me = me; this.es?.close();
    const es = new EventSource("/api/v0/calls/events"); this.es = es;
    es.onopen = () => { this.live = true; this.emit(); };
    es.onerror = () => { this.live = false; this.emit(); };
    es.addEventListener("calls", (ev) => { try { const d = JSON.parse((ev as MessageEvent).data) as { calls: Call[] }; for (const c of d.calls) this.upsert(c); } catch { /* ignore */ } });
    es.addEventListener("call", (ev) => { try { this.upsert(JSON.parse((ev as MessageEvent).data) as Call); } catch { /* ignore */ } });
    es.addEventListener("signal", (ev) => { try { this.session?.onSignal(JSON.parse((ev as MessageEvent).data) as Signal); } catch { /* ignore */ } });
    // Leaving the page hangs up (the others see it at once instead of after 30 s).
    window.addEventListener("pagehide", () => { const s = this.session; if (s) navigator.sendBeacon?.(`/api/v0/calls/${s.call.id}/leave`, new Blob(["{}"], { type: "application/json" })); });
  }
  disconnect() { this.es?.close(); this.es = null; this.live = false; }
  upsert(call: Call) {
    const mine = call.parties.find((p) => p.id === this.me);
    if (this.session?.call.id === call.id) this.session.update(call);
    if (call.state === "ended" || !mine || !["ringing", "joined"].includes(mine.state)) this.calls.delete(call.id);
    else this.calls.set(call.id, call);
    this.emit();
  }
  async refresh(id: string) { try { const r = await fetch(`/api/v0/calls/${id}`, { cache: "no-store" }); if (r.ok) this.upsert(((await r.json()) as { call: Call }).call); } catch { /* the stream catches up */ } }
  ringing() { return [...this.calls.values()].filter((c) => c.state !== "ended" && c.parties.find((p) => p.id === this.me)?.state === "ringing" && this.session?.call.id !== c.id); }
  async start(channelId: string, video: boolean, invite?: string[]) {
    if (this.session) { this.session.minimized = false; this.emit(); if (this.session.call.channelId === channelId) return; this.fail("You are already in a call. Hang up first."); return; }
    if (this.starting) return; this.starting = true; this.error = null; this.emit();
    tones.unlock();
    try {
      const local = await media(video);
      try { const r = await post<{ call: Call } & Ice>("calls", { channelId, video, invite }); this.begin(r.call, r, local, video && local.getVideoTracks().length > 0); }
      catch (e) { local.getTracks().forEach((t) => t.stop()); throw e; }
    } catch (e) { this.fail((e as Error).message); } finally { this.starting = false; this.emit(); }
  }
  async answer(callId: string, video: boolean) {
    if (this.starting) return; this.starting = true; tones.unlock();
    try {
      if (this.session) await this.hangup();
      const local = await media(video);
      try { const r = await post<{ call: Call } & Ice>(`calls/${callId}/answer`); this.begin(r.call, r, local, video && local.getVideoTracks().length > 0); }
      catch (e) { local.getTracks().forEach((t) => t.stop()); throw e; }
    } catch (e) { this.fail((e as Error).message); void this.refresh(callId); } finally { this.starting = false; this.emit(); }
  }
  async decline(callId: string) { const c = this.calls.get(callId); this.calls.delete(callId); this.emit(); try { const r = await post<{ call: Call | null }>(`calls/${callId}/decline`); if (r.call) this.upsert(r.call); } catch { if (c) this.calls.set(callId, c); this.emit(); } }
  async hangup() {
    const s = this.session; if (!s) return;
    this.endSession(s.call, true);
    try { const r = await post<{ call: Call | null }>(`calls/${s.call.id}/leave`); if (r.call && this.ended?.call.id === r.call.id) this.showEnded(r.call); } catch { /* the server ends it after 30 s */ }
  }
  async invite(personIds: string[]) { const s = this.session; if (!s) return; try { const r = await post<{ call: Call }>(`calls/${s.call.id}/invite`, { personIds }); this.upsert(r.call); } catch (e) { this.fail((e as Error).message); } }
  toggleMute() { this.session?.toggleMute(); }
  camera(on: boolean) { void this.session?.setCamera(on); }
  flip() { void this.session?.flip(); }
  output(id: string) { void this.session?.setOutput(id); }
  speaker(on: boolean) { void this.session?.setSpeaker(on); }
  minimize(on: boolean) { if (this.session) { this.session.minimized = on; this.emit(); } }
  private begin(call: Call, ice: Ice, local: MediaStream, camera: boolean) {
    this.calls.set(call.id, call); this.ended = null;
    this.session = new Session(this, this.me!, call, ice, local, camera);
    this.emit();
  }
  endSession(call: Call, local = false) {
    const s = this.session; if (!s || s.call.id !== call.id) return;
    this.session = null; s.close(); this.calls.delete(call.id);
    if (!local) tones.hangup();
    this.showEnded(call);
  }
  private showEnded(call: Call) {
    const ended = { call, at: Date.now() }; this.ended = ended; this.emit();
    setTimeout(() => { if (this.ended === ended) { this.ended = null; this.emit(); } }, 2600);
  }
  fail(message: string) { this.error = message; this.emit(); setTimeout(() => { if (this.error === message) { this.error = null; this.emit(); } }, 6000); }
  /** The ring for a call ringing me; the ringback while I wait for an answer. */
  private sound() {
    const s = this.session;
    const waiting = !!s && s.call.state === "ringing" && s.call.startedBy === this.me;
    const ringing = !s && this.ringing().length > 0;
    tones.set(ringing ? "ring" : waiting ? "ringback" : null);
  }
}

export const engine = typeof window === "undefined" ? (null as unknown as Engine) : ((window as unknown as { __pulseCalls?: Engine }).__pulseCalls ??= new Engine());
