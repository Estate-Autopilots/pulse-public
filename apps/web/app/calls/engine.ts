// CHAT-VOICE: the call engine, one per page. It holds the stream of call events (GET /api/v0/calls/events), the
// calls ringing me, and the one call I am in: my microphone (and camera), and a WebRTC connection to each other
// person in it (a mesh, up to 8 people). Connections use "perfect negotiation" (either side may renegotiate, e.g.
// to turn a camera on; a collision is settled by who is polite), with ICE restarts when a network changes. Signals
// to the others are batched (40 ms) and posted to the API; theirs arrive on the stream.
// CALLS-V2: calls that survive real networks and say how they went.
//  - Reconnects: a connection that drops restarts ICE after 2-4 s (not ~30 s later, when the browser gives up), and at
//    once when the device changes network (Wi-Fi to mobile data, back online); signals are posted in order and retried
//    while the network is down; the event stream is reopened from its last event when it went quiet on a dead
//    connection or was closed for good (an API restart), and calls are read directly while it is down.
//  - Measured: setup time (from the answer to the media flowing), the media path (direct, STUN or the TURN relay over
//    UDP/TCP), round trip, jitter and loss, reconnects, and why a call failed (POST /api/v0/calls/:id/quality, also the
//    app telemetry). Each connection's quality shows on its tile when it is weak.
//  - Screen sharing (computers): the screen goes on the video line in place of the camera; the others see it whole.
//  - Video is capped per connection by how many people are in the mesh, so a group call does not choke an uplink.
import { shell } from "../lib/native-shell";
import { telemetryEvent } from "../lib/telemetry.mjs";
import { tones } from "./tones";

export type Party = { id: string; name: string; photoAt: string | null; state: "ringing" | "joined" | "declined" | "missed" | "left" | "busy"; muted: boolean; video: boolean; screen?: boolean; joinedAt: string | null; invitedBy: string | null };
export type Call = { id: string; channelId: string; channelKind: string; channelName: string | null; video: boolean; state: "ringing" | "live" | "ended"; endReason: string | null;
  startedBy: string; messageId: string | null; createdAt: string; answeredAt: string | null; endedAt: string | null; now: string; parties: Party[];
  /** CALLS-V2: the recording going on (everyone in the call sees it), and whether I may start one. */
  recording?: { id: string; by: string; byName: string; startedAt: string; acked: boolean } | null; mayRecord?: boolean; mayInvite?: boolean; aiNotes?: boolean; aiRecap?: boolean };
type Ice = { iceServers: RTCIceServer[]; relay?: boolean };
type Signal = { callId: string; from: string; kind: "description" | "candidate"; body: unknown };
/** How a connection is doing: good, weak (some loss or a long round trip) or poor. */
export type Quality = "good" | "weak" | "poor";
export type PeerView = { id: string; stream: MediaStream | null; state: RTCPeerConnectionState | "new"; level: number; quality: Quality };
export type SessionView = { call: Call; muted: boolean; camera: boolean; facing: "user" | "environment"; local: MediaStream | null; peers: PeerView[]; minimized: boolean; output: string | null; error: string | null; connecting: boolean; speaker: boolean | null;
  /** CALLS-V2: my screen is being shared; the browser can share a screen at all. */
  sharing: boolean; canShare: boolean;
  /** CALLS-V2: I am recording this call (my browser mixes and uploads it); the recording notice is still to be seen. */
  recordingMine: boolean; recordingNotice: boolean; recordingBusy: boolean };
export type Snapshot = { me: string | null; live: boolean; calls: Call[]; session: SessionView | null; ended: { call: Call; at: number } | null; error: string | null };

class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
/** `priority`: what keeps the call alive (signals, the heartbeat) goes ahead of the page's other requests and the
 *  recording's uploads (a browser queues requests by priority while its connections to Pulse are busy: over HTTP/1.1 on
 *  a loaded server, a recorder's page once went 30 s without a heartbeat and Pulse ended the call). */
async function post<T>(path: string, body: unknown = {}, priority: RequestPriority = "auto"): Promise<T> {
  let r: Response;
  try { r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), priority }); }
  catch { throw new ApiError("Pulse can’t be reached. Check the connection and try again.", 0); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((d as { error?: string }).error ?? "That did not go through. Try again.", r.status);
  return d as T;
}
const mediaReason = (e: unknown) => { const name = (e as DOMException)?.name; return name === "NotAllowedError" || name === "SecurityError" ? "media-denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "media-missing" : name === "NotReadableError" ? "media-busy" : "media-unsupported"; };
const mediaError = (e: unknown, video: boolean) => {
  const reason = e === null ? "media-unsupported" : mediaReason(e);
  if (reason === "media-denied") return video ? "Pulse needs your microphone and camera for a video call. Allow them for this site, then try again." : "Pulse needs your microphone for calls. Allow it for this site, then try again.";
  if (reason === "media-missing") return video ? "No camera or microphone was found." : "No microphone was found.";
  if (reason === "media-busy") return "Your microphone or camera is in use by another app.";
  return "Calls need a browser with a microphone (Chrome, Edge, Safari or Firefox).";
};
class MediaFailure extends Error { constructor(message: string, public reason: string) { super(message); } }
async function media(video: boolean, facing: "user" | "environment" = "user") {
  if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new MediaFailure(mediaError(null, video), "media-unsupported");
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } } : false });
  } catch (e) {
    // A video call still goes ahead without a camera.
    if (video && ((e as DOMException)?.name === "NotFoundError" || (e as DOMException)?.name === "NotReadableError")) { try { return await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { /* fall through */ } }
    throw new MediaFailure(mediaError(e, video), mediaReason(e));
  }
}

// ---- CALLS-V2: what this device is, for the notes. ----
function where() {
  if (typeof window === "undefined") return {};
  const ua = navigator.userAgent, s = shell() ? (/iPhone|iPad|iOS/.test(ua) ? "ios" : "android") : null;
  const coarse = window.matchMedia("(pointer: coarse)").matches, short = Math.min(window.screen?.width ?? window.innerWidth, window.screen?.height ?? window.innerHeight);
  const device = /iPad|Tablet/.test(ua) || (coarse && short >= 600 && !/Mobile/.test(ua)) ? "tablet" : /iPhone|iPod|Android.+Mobile|PulseShell/.test(ua) || (coarse && short < 600) ? "phone" : "desktop";
  const c = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string } }).connection;
  const network = (c?.type && c.type !== "unknown" ? c.type : c?.effectiveType) ?? undefined;
  return { platform: s ?? "web", device, ...(network && /^[a-z0-9-]{1,20}$/.test(network) ? { network } : {}) };
}
/** A note about a call (or, without one, a call that could not start). Never in the way of the call. */
function note(callId: string | null, body: Record<string, unknown>) {
  try { void fetch(callId ? `/api/v0/calls/${callId}/quality` : "/api/v0/calls/quality", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...where(), ...body }) }).catch(() => {}); } catch { /* never in the way */ }
}
/** The media path of a connection, from its selected candidate pair. */
async function pathOf(pc: RTCPeerConnection): Promise<{ path: string; rtt: number | null }> {
  try {
    const stats = await pc.getStats();
    type Pair = { localCandidateId?: string; remoteCandidateId?: string; currentRoundTripTime?: number; state?: string; nominated?: boolean; selected?: boolean };
    let pair: Pair | undefined;
    stats.forEach((r) => { if (r.type === "transport" && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId) as Pair; });
    if (!pair) stats.forEach((r) => { if (r.type === "candidate-pair" && (r.selected || (r.nominated && r.state === "succeeded"))) pair ??= r as Pair; });
    if (!pair) return { path: "unknown", rtt: null };
    const local = stats.get(pair.localCandidateId ?? "") as { candidateType?: string; relayProtocol?: string; protocol?: string } | undefined;
    const remote = stats.get(pair.remoteCandidateId ?? "") as { candidateType?: string } | undefined;
    const rtt = typeof pair.currentRoundTripTime === "number" ? Math.round(pair.currentRoundTripTime * 1000) : null;
    if (local?.candidateType === "relay") { const p = local.relayProtocol ?? local.protocol; return { path: p === "tls" ? "relay-tls" : p === "tcp" ? "relay-tcp" : "relay-udp", rtt }; }
    if (remote?.candidateType === "relay") return { path: "relay-udp", rtt };
    const t = local?.candidateType === "srflx" || remote?.candidateType === "srflx" ? "srflx" : local?.candidateType === "prflx" || remote?.candidateType === "prflx" ? "prflx" : "host";
    return { path: t, rtt };
  } catch { return { path: "unknown", rtt: null }; }
}
/** The most a connection's video may use: less the more people share my uplink (a mesh sends to each). */
const videoCap = (peers: number, screen: boolean) => screen ? (peers <= 1 ? 2_500_000 : peers <= 3 ? 1_200_000 : 700_000) : (peers <= 1 ? 1_500_000 : peers <= 2 ? 900_000 : peers <= 4 ? 500_000 : 300_000);

class Peer {
  pc: RTCPeerConnection; stream: MediaStream | null = null; making = false; ignore = false; polite: boolean; level = 0;
  quality: Quality = "good"; restarts = 0; connectedOnce = false; down = false; relayGathered = false;
  private analyser: AnalyserNode | null = null; private buf: Uint8Array<ArrayBuffer> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null; private lastRestart = 0;
  /** CALLS-V2: a connection not up after a while is pushed along (see kick). */
  private kickTimer: ReturnType<typeof setTimeout> | null = null; private kicks = 0;
  private last: { lost: number; got: number } | null = null; private prev: Quality = "good";
  constructor(private s: Session, public id: string) {
    this.polite = s.me > id;
    this.pc = new RTCPeerConnection({ iceServers: s.ice.iceServers, bundlePolicy: "max-bundle" });
    // CALLS-V2: a screen being shared goes on the video line in place of the camera, also to someone who joins later.
    for (const t of s.local?.getTracks() ?? []) this.pc.addTrack(t.kind === "video" && s.screen ? s.screen : t, s.local!);
    if (s.screen && !s.local?.getVideoTracks().length) this.pc.addTrack(s.screen, s.local ?? new MediaStream([s.screen]));
    // A video call keeps a video line even with the camera off, so turning it on later needs no new offer.
    else if (s.camera === false && s.call.video && !s.local?.getVideoTracks().length) this.pc.addTransceiver("video", { direction: "sendrecv" });
    this.pc.onnegotiationneeded = async () => {
      try { this.making = true; await this.pc.setLocalDescription(); s.signal(id, "description", this.pc.localDescription); }
      catch { /* a newer negotiation replaces this one */ } finally { this.making = false; }
    };
    this.pc.onicecandidate = ({ candidate }) => { if (candidate) { if (candidate.type === "relay") this.relayGathered = true; s.signal(id, "candidate", candidate.toJSON()); } };
    this.pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] ?? this.stream ?? new MediaStream();
      if (!stream.getTracks().includes(track)) stream.addTrack(track);
      this.stream = stream; if (track.kind === "audio") { this.listen(stream); s.trackAdded(); } s.changed();
      track.onunmute = () => s.changed(); track.onmute = () => s.changed(); track.onended = () => s.changed();
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      if (st === "failed") this.restart(true);
      if (st === "connected") { this.clearRetry(); if (!this.connectedOnce) { this.connectedOnce = true; void s.connected(this); } else if (this.down) s.reconnected(); this.down = false; void s.tune(this); }
      if (st === "disconnected" || st === "failed") this.down = true;
      s.changed();
    };
    // CALLS-V2: a dropped connection restarts ICE after a short wait (the impolite side first, so both rarely collide);
    // the browser itself would only give up ("failed") about 30 s later.
    this.scheduleKick();
    this.pc.oniceconnectionstatechange = () => {
      const st = this.pc.iceConnectionState;
      if (st === "failed") this.restart(true);
      else if (st === "disconnected") { this.down = true; this.clearRetry(); this.retry = setTimeout(() => { if (["disconnected", "failed"].includes(this.pc.iceConnectionState)) this.restart(true); }, this.polite ? 4000 : 2000); }
      else if (st === "connected" || st === "completed") this.clearRetry();
    };
  }
  private clearRetry() { if (this.retry) { clearTimeout(this.retry); this.retry = null; } }
  /** CALLS-V2: a first connection that is not up 8 s after this side joined (then 12, 16, 20 s later) is pushed along:
   *  an offer still waiting for its answer is sent again (it, or its answer, may have been lost while two offers crossed
   *  on a busy device); an offer received but not yet answered is answered; with nothing pending, the impolite side
   *  restarts ICE (a fresh offer and new candidates). Seen on a loaded server: both sides had exchanged offers and relay
   *  candidates, and the call never connected. */
  private scheduleKick() { if (this.kicks < 4) this.kickTimer = setTimeout(() => void this.kick(), 8000 + this.kicks * 4000); }
  /** Read afresh (the awaits in kick may close the connection meanwhile). */
  private closed() { return this.pc.signalingState === "closed"; }
  private async kick() {
    this.kickTimer = null;
    if (this.connectedOnce || this.closed()) return;
    this.kicks++;
    try {
      const st = this.pc.signalingState;
      if (st === "have-local-offer" && this.pc.localDescription) this.s.signal(this.id, "description", this.pc.localDescription);
      else if (st === "have-remote-offer") { await this.pc.setLocalDescription(); this.s.signal(this.id, "description", this.pc.localDescription); }
      // ICE still checking may be a slow relay on mobile data making progress: left alone for the first two kicks (one
      // that is really stuck ends in "failed", which restarts it anyway).
      else if (st === "stable" && !this.polite && (this.pc.iceConnectionState !== "checking" || this.kicks >= 3)) this.restart(true);
    } catch { /* the next kick tries again */ }
    if (!this.connectedOnce && !this.closed()) this.scheduleKick();
  }
  /** A new ICE round: new candidates on whatever network the device is on now. At most every 3 s. */
  restart(counted = false) {
    if (this.pc.signalingState === "closed" || Date.now() - this.lastRestart < 3000) return;
    this.lastRestart = Date.now(); if (counted) this.restarts++;
    try { this.pc.restartIce(); } catch { /* an older browser: the next negotiation restarts */ }
  }
  private listen(stream: MediaStream) {
    try { const ctx = this.s.audioCtx(); const src = ctx.createMediaStreamSource(stream); this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512; src.connect(this.analyser); this.buf = new Uint8Array(this.analyser.fftSize); } catch { /* no level meter */ }
  }
  measure() {
    if (!this.analyser || !this.buf) return 0;
    this.analyser.getByteTimeDomainData(this.buf); let sum = 0; for (const b of this.buf) { const x = (b - 128) / 128; sum += x * x; }
    this.level = Math.min(1, Math.sqrt(sum / this.buf.length) * 6); return this.level;
  }
  /** CALLS-V2: round trip, jitter and loss since the last sample (audio, as it is what a call lives on). */
  async sample(): Promise<{ rtt: number | null; jitter: number | null; loss: number | null } | null> {
    if (this.pc.connectionState !== "connected") return null;
    try {
      const stats = await this.pc.getStats(); let lost = 0, got = 0, jitter: number | null = null, rtt: number | null = null;
      stats.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "audio") { lost += r.packetsLost ?? 0; got += r.packetsReceived ?? 0; if (typeof r.jitter === "number") jitter = Math.round(r.jitter * 1000); }
        if (r.type === "candidate-pair" && (r.nominated || r.selected) && r.state === "succeeded" && typeof r.currentRoundTripTime === "number") rtt = Math.round(r.currentRoundTripTime * 1000);
      });
      let loss: number | null = null;
      if (this.last) { const dl = lost - this.last.lost, dg = got - this.last.got; if (dl + dg > 20) loss = Math.max(0, Math.min(100, (dl / (dl + dg)) * 100)); }
      this.last = { lost, got };
      const q: Quality = (loss ?? 0) > 8 || (rtt ?? 0) > 700 ? "poor" : (loss ?? 0) > 3 || (rtt ?? 0) > 350 || (jitter ?? 0) > 60 ? "weak" : "good";
      // One bad moment (a busy computer, a burst) does not raise "Weak connection": it changes when two samples in a
      // row (8 s) agree, either way (it flickered on calls between two browsers on one loaded machine).
      const rank = { good: 0, weak: 1, poor: 2 } as const, a = rank[this.prev], b = rank[q], now = rank[this.quality];
      this.prev = q;
      const next = Math.min(a, b) > now ? Math.min(a, b) : Math.max(a, b) < now ? Math.max(a, b) : now;
      if (next !== now) { this.quality = (["good", "weak", "poor"] as const)[next]; this.s.changed(); }
      return { rtt, jitter, loss };
    } catch { return null; }
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
  close() { this.clearRetry(); if (this.kickTimer) clearTimeout(this.kickTimer); try { this.pc.close(); } catch { /* closed */ } this.stream?.getTracks().forEach((t) => t.stop()); }
}

/** CALLS-V2: a recording of the call, made in the recorder's browser: my microphone and everyone else's voice mixed,
 *  recorded in 5-second parts that are uploaded in order as they come (tried again while the network is down), so a
 *  browser that drops loses seconds, not the call. Stopping uploads what is left, then tells Pulse its length. */
const RECORD_MIMES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
export const recordMime = () => typeof MediaRecorder === "undefined" ? null : RECORD_MIMES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
const base64 = async (b: Blob) => { const u = new Uint8Array(await b.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
class Recorder {
  private ctx = new AudioContext(); private dest = this.ctx.createMediaStreamDestination(); private srcs = new Map<string, MediaStreamAudioSourceNode>();
  private mr: MediaRecorder; private seq = 0; private queue: { seq: number; blob: Blob }[] = []; private sending = false; private fails = 0; private t0 = performance.now(); stopped = false;
  constructor(private s: Session, public id: string, mime: string) {
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    this.sync();
    this.mr = new MediaRecorder(this.dest.stream, { mimeType: mime, audioBitsPerSecond: 24000 });
    this.mr.ondataavailable = (e) => { if (e.data.size) { this.queue.push({ seq: this.seq++, blob: e.data }); this.pump(); } };
    this.mr.start(5000);
  }
  /** Everyone's voice in the mix: mine and each connection's (as people join, leave or renegotiate). */
  sync() {
    if (this.stopped) return;
    const want = new Map<string, MediaStreamTrack>();
    for (const t of this.s.local?.getAudioTracks() ?? []) want.set(t.id, t);
    for (const p of this.s.peers.values()) for (const t of p.stream?.getAudioTracks() ?? []) if (t.readyState === "live") want.set(t.id, t);
    for (const [k, n] of this.srcs) if (!want.has(k)) { try { n.disconnect(); } catch { /* gone */ } this.srcs.delete(k); }
    for (const [k, t] of want) if (!this.srcs.has(k)) { try { const n = this.ctx.createMediaStreamSource(new MediaStream([t])); n.connect(this.dest); this.srcs.set(k, n); } catch { /* not mixable */ } }
  }
  private pump() {
    if (this.sending || !this.queue.length) return;
    this.sending = true; const part = this.queue[0];
    void base64(part.blob).then((bytes) => post(`calls/recordings/${this.id}/parts`, { seq: part.seq, bytes }, "low"))
      .then(() => { this.queue.shift(); this.fails = 0; })
      .catch((e: ApiError) => { if (e.status >= 400 && e.status < 500) { this.queue = []; return; } this.fails++; if (this.fails > 12) this.queue.shift(); })
      .finally(() => { this.sending = false; if (this.queue.length) setTimeout(() => this.pump(), this.fails ? Math.min(5000, 300 * 2 ** this.fails) : 0); });
  }
  /** Stop: the last part goes up (waiting up to 20 s for the upload), then Pulse is told the length (`tell` false: it already knows). */
  async stop(tell = true) {
    if (this.stopped) return; this.stopped = true;
    const seconds = Math.round((performance.now() - this.t0) / 1000);
    await new Promise<void>((done) => { this.mr.onstop = () => done(); try { if (this.mr.state === "inactive") done(); else this.mr.stop(); } catch { done(); } setTimeout(done, 3000); });
    for (let i = 0; i < 40 && (this.queue.length || this.sending); i++) await new Promise((r) => setTimeout(r, 500));
    for (const n of this.srcs.values()) { try { n.disconnect(); } catch { /* gone */ } }
    void this.ctx.close().catch(() => {});
    if (tell) await post(`calls/recordings/${this.id}/stop`, { seconds }).catch(() => {});
  }
}

class Session {
  peers = new Map<string, Peer>(); muted = false; minimized = false; output: string | null = null; error: string | null = null; facing: "user" | "environment" = "user";
  /** CALLS-V2: the screen being shared (on the video line instead of the camera). */
  screen: MediaStreamTrack | null = null;
  /** CALLS-V2: my recording of this call (null when I am not recording), the notices I have seen, a start in flight. */
  rec: Recorder | null = null; private acked = new Set<string>(); private recBusy = false;
  private out: { to: string; kind: string; body: unknown }[] = []; private flush: ReturnType<typeof setTimeout> | null = null; private sending = false; private fails = 0;
  private beat: ReturnType<typeof setInterval>; private meter: ReturnType<typeof setInterval>; private stats: ReturnType<typeof setInterval>; private ctx: AudioContext | null = null; private early = new Map<string, Signal[]>();
  closed = false;
  /** The Pulse phone app: loudspeaker (video calls) or earpiece (voice calls), switchable; null in a browser. */
  speaker: boolean | null = null;
  // CALLS-V2: the measurements behind the notes.
  private joinAt: number | null; private connectedAt: number | null = null; private noConnect: ReturnType<typeof setTimeout> | null = null; private noConnectSaid = false; private reconnects = 0; private path = "unknown"; private maxPeers = 0;
  private sum = { rtt: 0, rttN: 0, jitter: 0, jitterN: 0, loss: 0, lossN: 0 };
  constructor(private e: Engine, public me: string, public call: Call, public ice: Ice, public local: MediaStream | null, public camera: boolean, private role: "caller" | "callee" | "joiner", private t0: number, private mediaMs: number) {
    // The caller's clock for the setup starts when someone answers; the one who answers starts it themselves.
    this.joinAt = role === "caller" ? null : t0;
    if (shell()?.setSpeaker) void this.setSpeaker(camera || call.video);
    // CALLS-NATIVE: on the phone app, a call answered from the lock screen stays above it until it ends.
    void shell()?.setInCall?.({ on: true }).catch(() => {});
    this.beat = setInterval(() => void this.sendBeat(), 8000);
    this.meter = setInterval(() => { let any = false; for (const p of this.peers.values()) { const before = p.level; if (Math.abs(p.measure() - before) > 0.05) any = true; } if (any) this.changed(); }, 220);
    this.stats = setInterval(() => void this.sampleAll(), 4000);
    void this.sendBeat();
    this.update(call);
  }
  audioCtx() { if (!this.ctx) this.ctx = new AudioContext(); if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {}); return this.ctx; }
  changed() { this.e.emit(); }
  signal(to: string, kind: "description" | "candidate", body: unknown) {
    if (this.closed) return;
    this.out.push({ to, kind, body: body && typeof body === "object" && "toJSON" in body ? (body as { toJSON: () => unknown }).toJSON() : body });
    if (!this.flush) this.flush = setTimeout(() => { this.flush = null; this.pump(); }, 40);
  }
  /** CALLS-V2: one post at a time, in order; a post that fails (no network) is tried again with a growing wait, so an
   *  offer or an answer is not lost while the phone changes network. Given up after ~30 s (an ICE restart follows). */
  pump() {
    if (this.sending || !this.out.length || this.closed) return;
    this.sending = true; const batch = this.out.slice(0, 60);
    post(`calls/${this.call.id}/signal`, { signals: batch }, "high")
      .then(() => { this.out.splice(0, batch.length); this.fails = 0; })
      .catch((e: ApiError) => { if (e.status >= 400 && e.status < 500) { this.out.splice(0, batch.length); return; } this.fails++; if (this.fails > 9) { this.out = []; this.fails = 0; } })
      .finally(() => { this.sending = false; if (this.out.length) { if (this.fails) setTimeout(() => this.pump(), Math.min(5000, 250 * 2 ** this.fails)); else this.pump(); } });
  }
  async sendBeat() { if (this.closed) return; try { const r = await post<{ inCall: boolean }>(`calls/${this.call.id}/beat`, { muted: this.muted, video: this.camera, screen: !!this.screen }, "high"); if (!r.inCall && !this.closed && this.call.state !== "ended") void this.e.refresh(this.call.id); } catch { /* the next beat tries again */ } }
  update(call: Call) {
    this.call = call;
    const mine = call.parties.find((p) => p.id === this.me);
    if (call.state === "ended" || !mine || mine.state !== "joined") { this.e.endSession(call); return; }
    const joined = new Set(call.parties.filter((p) => p.state === "joined" && p.id !== this.me).map((p) => p.id));
    if (joined.size && this.joinAt === null) this.joinAt = performance.now();
    let added = false;
    for (const id of joined) if (!this.peers.has(id)) { this.addPeer(id); added = true; }
    for (const [id, p] of this.peers) if (!joined.has(id)) { p.close(); this.peers.delete(id); added = true; }
    this.maxPeers = Math.max(this.maxPeers, this.peers.size);
    if (added) for (const p of this.peers.values()) void this.tune(p);
    // CALLS-V2: my recording follows the call: everyone's voice in it; stopped elsewhere (or by Pulse), it stops here.
    if (this.rec && call.recording?.id !== this.rec.id) { const r = this.rec; this.rec = null; void r.stop(false); }
    else this.rec?.sync();
    if (call.recording && !this.notified.has(call.recording.id)) { this.notified.add(call.recording.id); tones.notice(); }
    this.changed();
  }
  private notified = new Set<string>();
  /** A voice arrived or changed: the recording mixes it in. */
  trackAdded() { this.rec?.sync(); }
  /** CALLS-V2: start recording (the confirm is the call screen's); everyone in the call is told by the call's state. */
  async record(on: boolean) {
    if (this.recBusy) return;
    if (!on) { const r = this.rec, live = this.call.recording; this.rec = null; this.changed(); if (r) await r.stop(); else if (live) await post(`calls/recordings/${live.id}/stop`, {}).catch(() => {}); return; }
    const mime = recordMime(); if (!mime) { this.error = "This browser can’t record calls. Try Chrome, Edge or Firefox."; this.changed(); return; }
    this.recBusy = true; this.error = null; this.changed();
    try { const r = await post<{ recording: string }>(`calls/${this.call.id}/recording`, { mime }); if (!this.closed) { this.rec = new Recorder(this, r.recording, mime); this.acked.add(r.recording); } }
    catch (e) { this.error = (e as Error).message; }
    finally { this.recBusy = false; this.changed(); }
  }
  /** I saw the recording notice and stay. */
  ack(id: string) { this.acked.add(id); this.changed(); void post(`calls/recordings/${id}/ack`, {}).catch(() => {}); }
  private addPeer(id: string) {
    const p = new Peer(this, id); this.peers.set(id, p);
    for (const s of this.early.get(id) ?? []) void p.handle(s.kind, s.body);
    this.early.delete(id);
    // CALLS-V2: nobody connected 25 s after the first connection began: say why it might be (was a relay offered and
    // gathered?) once per call.
    if (!this.noConnect && this.connectedAt === null) this.noConnect = setTimeout(() => {
      if (!this.closed && this.connectedAt === null && this.peers.size) this.sayNoConnect();
    }, 25000);
    return p;
  }
  private sayNoConnect() {
    if (this.noConnectSaid) return; this.noConnectSaid = true;
    const gathered = [...this.peers.values()].some((x) => x.relayGathered);
    note(this.call.id, { kind: "failure", reason: "no-connect", role: this.role, video: this.call.video, relayOffered: !!this.ice.relay, relayGathered: gathered, peers: this.peers.size,
      ...(this.joinAt !== null ? { seconds: Math.round((performance.now() - this.joinAt) / 1000) } : {}) });
    telemetryEvent("error.call", { n: "no-connect", x: { relay: !!this.ice.relay, gathered } });
  }
  /** The first connection of the call is up: how long it took from the answer, and which way the media goes. */
  async connected(p: Peer) {
    if (this.connectedAt !== null) return;
    this.connectedAt = performance.now(); if (this.noConnect) { clearTimeout(this.noConnect); this.noConnect = null; }
    const setupMs = Math.round(this.connectedAt - (this.joinAt ?? this.t0));
    const { path, rtt } = await pathOf(p.pc); this.path = path;
    note(this.call.id, { kind: "setup", role: this.role, video: this.call.video, setupMs, mediaMs: Math.round(this.mediaMs), path, ...(rtt !== null ? { rttMs: rtt } : {}), peers: this.peers.size, relayOffered: !!this.ice.relay, relayGathered: p.relayGathered });
    telemetryEvent("app.call_setup", { n: path, d: setupMs, x: { role: this.role, video: this.call.video } });
  }
  reconnected() { this.reconnects++; note(this.call.id, { kind: "reconnect", role: this.role, reconnects: this.reconnects }); }
  private async sampleAll() {
    for (const p of this.peers.values()) {
      const s = await p.sample(); if (!s) continue;
      if (s.rtt !== null) { this.sum.rtt += s.rtt; this.sum.rttN++; } if (s.jitter !== null) { this.sum.jitter += s.jitter; this.sum.jitterN++; } if (s.loss !== null) { this.sum.loss += s.loss; this.sum.lossN++; }
    }
  }
  /** CALLS-V2: audio first on a crowded link; video capped by how many people my uplink carries. */
  async tune(p: Peer) {
    const n = Math.max(1, this.peers.size);
    for (const sender of p.pc.getSenders()) {
      if (!sender.track) continue;
      try {
        const params = sender.getParameters(); if (!params.encodings?.length) params.encodings = [{}];
        const enc = params.encodings[0] as RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType };
        if (sender.track.kind === "audio") { enc.priority = "high"; enc.networkPriority = "high"; }
        else { const screen = sender.track === this.screen; enc.maxBitrate = videoCap(n, screen); enc.scaleResolutionDownBy = screen ? 1 : n >= 5 ? 2 : n >= 3 ? 1.5 : 1; }
        await sender.setParameters(params);
      } catch { /* not negotiated yet, or not supported: the browser's own limits apply */ }
    }
  }
  /** Connections that are down restart now (the page was in the background). */
  recover() { if (this.closed) return; for (const p of this.peers.values()) if (p.down || ["disconnected", "failed"].includes(p.pc.iceConnectionState)) p.restart(true); this.pump(); }
  /** CALLS-V2: the device changed network: new candidates now, and anything waiting goes out. */
  networkChanged() { if (this.closed) return; for (const p of this.peers.values()) if (p.pc.connectionState !== "connected" || p.down) p.restart(true); else p.restart(); this.fails = 0; this.pump(); void this.sendBeat(); }
  onSignal(s: Signal) {
    if (this.closed || s.callId !== this.call.id) return;
    const p = this.peers.get(s.from);
    if (p) void p.handle(s.kind, s.body);
    else { const list = this.early.get(s.from) ?? []; list.push(s); this.early.set(s.from, list.slice(-80)); void this.e.refresh(this.call.id); }
  }
  toggleMute() { this.muted = !this.muted; this.local?.getAudioTracks().forEach((t) => { t.enabled = !this.muted; }); void this.sendBeat(); this.changed(); }
  private videoSender(p: Peer) { return p.pc.getTransceivers().find((t) => t.receiver.track.kind === "video" && t.currentDirection !== "stopped")?.sender ?? null; }
  /** What goes on each connection's video line: the screen while sharing, else the camera (or nothing). */
  private async sendVideo(track: MediaStreamTrack | null) {
    for (const p of this.peers.values()) {
      const sender = this.videoSender(p);
      if (sender) { await sender.replaceTrack(track).catch(() => {}); const tr = p.pc.getTransceivers().find((t) => t.sender === sender); if (track && tr && tr.direction !== "sendrecv") tr.direction = "sendrecv"; }
      else if (track) p.pc.addTrack(track, this.local ?? new MediaStream([track]));
      void this.tune(p);
    }
  }
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
      // While the screen is shared the camera waits (self view only) and goes on the line when sharing stops.
      if (!this.screen) await this.sendVideo(track);
      this.camera = true;
    } else {
      this.local?.getVideoTracks().forEach((t) => { t.stop(); this.local!.removeTrack(t); });
      if (!this.screen) for (const p of this.peers.values()) for (const t of p.pc.getTransceivers()) if (t.currentDirection !== "stopped" && (t.sender.track?.kind === "video" || t.receiver.track.kind === "video")) await t.sender.replaceTrack(null).catch(() => {});
      this.camera = false;
    }
    void this.sendBeat(); this.changed();
  }
  flip() { return this.setCamera(true, this.facing === "user" ? "environment" : "user"); }
  /** CALLS-V2: share my screen (a window or a tab) in place of my camera; stop and the camera comes back. */
  async share(on: boolean) {
    this.error = null;
    if (on) {
      if (this.screen) return;
      let track: MediaStreamTrack;
      try { track = (await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false })).getVideoTracks()[0]; }
      catch (e) { if ((e as DOMException)?.name !== "NotAllowedError" && (e as DOMException)?.name !== "AbortError") { this.error = "Your screen could not be shared. Try again, or pick a window."; this.changed(); } return; }
      if (this.closed) { track.stop(); return; }
      try { track.contentHint = "detail"; } catch { /* older browser */ }
      track.onended = () => { if (this.screen === track) void this.share(false); };
      this.screen = track; await this.sendVideo(track);
      telemetryEvent("app.call_share", { x: { peers: this.peers.size } });
    } else {
      const t = this.screen; if (!t) return; this.screen = null; t.onended = null; t.stop();
      await this.sendVideo(this.camera ? this.local?.getVideoTracks()[0] ?? null : null);
    }
    void this.sendBeat(); this.changed();
  }
  async setSpeaker(on: boolean) { try { await shell()?.setSpeaker?.({ on }); this.speaker = on; } catch { /* older shell */ } this.changed(); }
  async setOutput(id: string) { this.output = id; this.changed(); }
  view(): SessionView {
    return { call: this.call, muted: this.muted, camera: this.camera, facing: this.facing, local: this.local, minimized: this.minimized, output: this.output, error: this.error, speaker: this.speaker,
      recordingMine: !!this.rec, recordingNotice: !!this.call.recording && this.call.recording.by !== this.me && !this.call.recording.acked && !this.acked.has(this.call.recording.id), recordingBusy: this.recBusy,
      sharing: !!this.screen, canShare: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && !window.matchMedia("(pointer: coarse)").matches,
      connecting: this.call.state === "live" && [...this.peers.values()].length > 0 && ![...this.peers.values()].some((p) => p.pc.connectionState === "connected"),
      peers: [...this.peers.values()].map((p) => ({ id: p.id, stream: p.stream, state: p.pc.connectionState, level: p.level, quality: p.quality })) };
  }
  close() {
    if (this.closed) return; this.closed = true;
    clearInterval(this.beat); clearInterval(this.meter); clearInterval(this.stats); if (this.flush) clearTimeout(this.flush); if (this.noConnect) clearTimeout(this.noConnect);
    // CALLS-V2: how the call went, from this side (or that it never connected, when someone had joined 5 s before).
    if (this.connectedAt === null && this.peers.size && this.joinAt !== null && performance.now() - this.joinAt > 5000) this.sayNoConnect();
    if (this.connectedAt !== null) {
      const avg = (s: number, n: number) => n ? s / n : null, rtt = avg(this.sum.rtt, this.sum.rttN), jitter = avg(this.sum.jitter, this.sum.jitterN), loss = avg(this.sum.loss, this.sum.lossN);
      note(this.call.id, { kind: "end", role: this.role, video: this.call.video, path: this.path, seconds: Math.round((performance.now() - this.connectedAt) / 1000), peers: this.maxPeers,
        reconnects: this.reconnects, restarts: [...this.peers.values()].reduce((n, p) => n + p.restarts, 0),
        ...(rtt !== null ? { rttMs: Math.round(rtt) } : {}), ...(jitter !== null ? { jitterMs: Math.round(jitter) } : {}), ...(loss !== null ? { lossPct: Math.round(loss * 100) / 100 } : {}) });
    }
    // My recording keeps what it has: the last part goes up and Pulse is told (the call ending closes it there too).
    if (this.rec) { const r = this.rec; this.rec = null; void r.stop(); }
    for (const p of this.peers.values()) p.close(); this.peers.clear();
    this.local?.getTracks().forEach((t) => t.stop()); this.screen?.stop(); this.screen = null;
    void this.ctx?.close().catch(() => {});
    if (this.speaker !== null) void shell()?.setSpeaker?.({ on: false }).catch(() => {});
    void shell()?.setInCall?.({ on: false }).catch(() => {});
  }
}

export class Engine {
  me: string | null = null; calls = new Map<string, Call>(); session: Session | null = null; ended: { call: Call; at: number } | null = null; error: string | null = null; live = false;
  private subs = new Set<() => void>(); private snap: Snapshot = { me: null, live: false, calls: [], session: null, ended: null, error: null }; private dirty = true;
  private es: EventSource | null = null; private starting = false;
  // CALLS-V2: the stream's place (its last event id), when it last said anything, and how long to wait to reopen it.
  private lastId: string | null = null; private heard = 0; private reopen: ReturnType<typeof setTimeout> | null = null; private backoff = 0; private polled = 0; private watching = false;
  subscribe = (f: () => void) => { this.subs.add(f); return () => { this.subs.delete(f); }; };
  snapshot = () => {
    if (this.dirty) { this.dirty = false; this.snap = { me: this.me, live: this.live, calls: [...this.calls.values()], session: this.session?.view() ?? null, ended: this.ended, error: this.error }; }
    return this.snap;
  };
  emit() { this.dirty = true; this.subs.forEach((f) => f()); this.sound(); }
  connect(me: string) {
    if (this.es && this.me === me) return;
    this.me = me; this.open();
    if (this.watching) return; this.watching = true;
    // Leaving the page hangs up (the others see it at once instead of after 30 s).
    window.addEventListener("pagehide", () => { const s = this.session; if (s) navigator.sendBeacon?.(`/api/v0/calls/${s.call.id}/leave`, new Blob(["{}"], { type: "application/json" })); });
    // CALLS-V2: a new network reopens the stream and restarts the call's ICE. Only a change of kind counts (Wi-Fi to
    // mobile data): desktop browsers report bandwidth estimates through the same event.
    const changed = () => { this.open(); this.session?.networkChanged(); };
    window.addEventListener("online", changed);
    const conn = (navigator as Navigator & { connection?: EventTarget & { type?: string } }).connection;
    let kind = conn?.type ?? null;
    conn?.addEventListener?.("change", () => { const k = conn.type ?? null; if (k && k !== kind) { kind = k; changed(); } });
    // Back in front after a while: a stream that went quiet is reopened, a connection that dropped restarts.
    document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "visible") return; if (Date.now() - this.heard > 20000) this.open(); this.session?.recover(); });
    // A stream that has said nothing for 25 s sits on a dead connection; while it is down, calls are read directly.
    setInterval(() => {
      if (!this.me) return;
      if (this.es && Date.now() - this.heard > 25000) this.open();
      if (!this.live && Date.now() - this.polled > 10000) { this.polled = Date.now(); void this.poll(); }
    }, 5000);
  }
  private open() {
    if (!this.me) return;
    if (this.reopen) { clearTimeout(this.reopen); this.reopen = null; }
    this.es?.close();
    const es = new EventSource(this.lastId ? `/api/v0/calls/events?after=${encodeURIComponent(this.lastId)}` : "/api/v0/calls/events"); this.es = es; this.heard = Date.now();
    const heard = (ev: Event) => { if (this.es !== es) return false; this.heard = Date.now(); const id = (ev as MessageEvent).lastEventId; if (id && /^\d{1,18}$/.test(id)) this.lastId = id; return true; };
    es.onopen = () => { if (this.es !== es) return; this.live = true; this.backoff = 0; this.heard = Date.now(); this.emit(); };
    es.onerror = () => {
      if (this.es !== es) return; this.live = false; this.emit();
      // The browser reconnects by itself unless the answer was not a stream (the API restarting answers 502): then it
      // stops for good, and the stream is opened again here with a growing wait.
      if (es.readyState === EventSource.CLOSED) { this.backoff = Math.min(15000, this.backoff ? this.backoff * 2 : 1000); this.reopen = setTimeout(() => this.open(), this.backoff); }
    };
    es.addEventListener("calls", (ev) => { if (!heard(ev)) return; try { const d = JSON.parse((ev as MessageEvent).data) as { calls: Call[] }; for (const c of d.calls) this.upsert(c); this.forget(d.calls); } catch { /* ignore */ } });
    es.addEventListener("call", (ev) => { if (!heard(ev)) return; try { this.upsert(JSON.parse((ev as MessageEvent).data) as Call); } catch { /* ignore */ } });
    es.addEventListener("signal", (ev) => { if (!heard(ev)) return; try { this.session?.onSignal(JSON.parse((ev as MessageEvent).data) as Signal); } catch { /* ignore */ } });
    es.addEventListener("ping", (ev) => { heard(ev); });
  }
  /** Calls ringing me that the server no longer lists (ended while the stream was away) stop ringing. */
  private forget(current: Call[]) { const ids = new Set(current.map((c) => c.id)); let gone = false; for (const id of [...this.calls.keys()]) if (!ids.has(id) && this.session?.call.id !== id) { this.calls.delete(id); gone = true; } if (gone) this.emit(); }
  /** One read at a time, given up after 8 s: an API that hangs must not pile requests up (a browser opens only ~6 at
   *  once per site, and the page's own reads would wait behind them). */
  private polling = false;
  private async poll() {
    if (this.polling) return; this.polling = true;
    try { const r = await fetch("/api/v0/calls", { cache: "no-store", signal: AbortSignal.timeout(8000) }); if (!r.ok) return; const d = (await r.json()) as { calls: Call[] }; for (const c of d.calls) this.upsert(c); this.forget(d.calls); }
    catch { /* still down */ } finally { this.polling = false; }
  }
  disconnect() { this.es?.close(); this.es = null; this.live = false; }
  upsert(call: Call) {
    const mine = call.parties.find((p) => p.id === this.me);
    if (this.session?.call.id === call.id) this.session.update(call);
    if (call.state === "ended" || !mine || !["ringing", "joined"].includes(mine.state)) this.calls.delete(call.id);
    else this.calls.set(call.id, call);
    this.emit();
  }
  async refresh(id: string) { try { const r = await fetch(`/api/v0/calls/${id}`, { cache: "no-store", signal: AbortSignal.timeout(8000) }); if (r.ok) this.upsert(((await r.json()) as { call: Call }).call); } catch { /* the stream catches up */ } }
  ringing() { return [...this.calls.values()].filter((c) => c.state !== "ended" && c.parties.find((p) => p.id === this.me)?.state === "ringing" && this.session?.call.id !== c.id); }
  async start(channelId: string, video: boolean, invite?: string[]) {
    if (this.session) { this.session.minimized = false; this.emit(); if (this.session.call.channelId === channelId) return; this.fail("You are already in a call. Hang up first."); return; }
    if (this.starting) return; this.starting = true; this.error = null; this.emit();
    tones.unlock(); const t0 = performance.now();
    try {
      let local: MediaStream;
      try { local = await media(video); } catch (e) { const f = e as MediaFailure; note(null, { kind: "failure", reason: f.reason ?? "media-unsupported", role: "caller", video }); telemetryEvent("error.call", { n: f.reason ?? "media-unsupported" }); throw e; }
      const mediaMs = performance.now() - t0;
      try {
        const r = await post<{ call: Call } & Ice>("calls", { channelId, video, invite });
        // Starting where a call is already on joins it.
        const role = r.call.startedBy === this.me ? "caller" : "joiner";
        this.begin(r.call, r, local, video && local.getVideoTracks().length > 0, role, role === "caller" ? t0 : performance.now(), mediaMs);
      } catch (e) { local.getTracks().forEach((t) => t.stop()); if ((e as ApiError).status === 0 || (e as ApiError).status >= 500) note(null, { kind: "failure", reason: "api-down", role: "caller", video }); throw e; }
    } catch (e) { this.fail((e as Error).message); } finally { this.starting = false; this.emit(); }
  }
  async answer(callId: string, video: boolean) {
    if (this.starting) return; this.starting = true; tones.unlock(); const t0 = performance.now();
    try {
      if (this.session) await this.hangup();
      let local: MediaStream;
      try { local = await media(video); } catch (e) { const f = e as MediaFailure; note(callId, { kind: "failure", reason: f.reason ?? "media-unsupported", role: "callee", video }); telemetryEvent("error.call", { n: f.reason ?? "media-unsupported" }); throw e; }
      const mediaMs = performance.now() - t0;
      try { const r = await post<{ call: Call } & Ice>(`calls/${callId}/answer`); this.begin(r.call, r, local, video && local.getVideoTracks().length > 0, "callee", t0, mediaMs); }
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
  share(on: boolean) { void this.session?.share(on); }
  record(on: boolean) { void this.session?.record(on); }
  ackRecording(id: string) { this.session?.ack(id); }
  output(id: string) { void this.session?.setOutput(id); }
  speaker(on: boolean) { void this.session?.setSpeaker(on); }
  minimize(on: boolean) { if (this.session) { this.session.minimized = on; this.emit(); } }
  private begin(call: Call, ice: Ice, local: MediaStream, camera: boolean, role: "caller" | "callee" | "joiner", t0: number, mediaMs: number) {
    this.calls.set(call.id, call); this.ended = null;
    this.session = new Session(this, this.me!, call, ice, local, camera, role, t0, mediaMs);
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
