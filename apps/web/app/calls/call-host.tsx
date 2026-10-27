"use client";
// CHAT-VOICE: calls everywhere in Pulse. Mounted once in the shell: it listens for calls (ringing me, or with me in
// them), rings, and shows the call: a card to answer or decline (full screen on a phone), the call itself (people,
// cameras, who is speaking, mute, camera, speaker, add someone, minimise, hang up) and, minimised, a pill under the
// top bar that keeps the call going while you work anywhere in Pulse. Anything can start a call with
//   window.dispatchEvent(new CustomEvent("pulse:call", { detail: { channelId, video } }))
// (the chat header and the chat's /call command do).
// CALLS-V2: decline with a message (one-to-one), screen sharing with the shared screen large, each connection's quality
// on its tile, and minimised a small call window that can be dragged to any corner (video or the speaker's face, mute,
// hang up), with picture-in-picture for the video when the browser has it (also on its own when Pulse goes to the back).
// CALLS-V2: recording, opt-in: Record asks first; while it runs everyone sees "Recording" (and hears two notes when it
// starts), and everyone but the recorder gets a notice to stay or leave.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, CircleDot, Maximize2, MessageSquare, Mic, MicOff, MonitorUp, MonitorX, Phone, PhoneOff, PictureInPicture2, RefreshCcw, SignalLow, Square, UserPlus, Video, VideoOff, Volume2, X } from "lucide-react";
import { Avatar } from "../ui";
import { engine, type Call, type Party, type PeerView, type SessionView, type Snapshot } from "./engine";
import css from "./calls.module.css";

const never = () => () => {};
const empty: Snapshot = { me: null, live: false, calls: [], session: null, ended: null, error: null };
const first = (name: string) => name.replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
export const callClock = (s: number) => { const t = Math.max(0, Math.floor(s)); const h = Math.floor(t / 3600); return `${h ? `${h}:` : ""}${String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, "0")}:${String(t % 60).padStart(2, "0")}`; };
/** Start a call from anywhere in Pulse. */
export const startCall = (channelId: string, video = false, invite?: string[]) => window.dispatchEvent(new CustomEvent("pulse:call", { detail: { channelId, video, invite } }));
/** The calls snapshot, for the chat (a call going on in a conversation, the button state). */
export function useCalls() { return useSyncExternalStore(engine ? engine.subscribe : never, engine ? engine.snapshot : () => empty, () => empty); }
/** CALLS-V2: what a declined one-to-one call can answer with, in the chat. */
const QUICK_REPLIES = ["Can’t talk now. I’ll call you back.", "In a meeting. I’ll call you in 10 minutes.", "Please message me here."];

/** Who a call is with, as its people see it: the other person, or the group's name. */
function title(call: Call, me: string | null) {
  const others = call.parties.filter((p) => p.id !== me);
  if (call.channelKind !== "direct" && call.channelName) return call.channelName;
  return others.map((p) => p.name).join(", ") || "Call";
}
/** Seconds since the call was answered, on the server's clock. */
function useElapsed(call: Call | null) {
  const [secs, setSecs] = useState(0);
  const answered = call?.answeredAt ?? null, serverNow = call?.now ?? null;
  useEffect(() => {
    if (!answered || !serverNow) return;
    const skew = Date.now() - Date.parse(serverNow);
    const tick = () => setSecs(Math.max(0, (Date.now() - skew - Date.parse(answered)) / 1000));
    const soon = setTimeout(tick, 0), t = setInterval(tick, 1000);
    return () => { clearTimeout(soon); clearInterval(t); };
  }, [answered, serverNow]);
  return answered ? secs : 0;
}

export function CallHost({ person }: { person: string }) {
  const ready = useSyncExternalStore(never, () => true, () => false);
  const snap = useCalls();
  useEffect(() => { if (!engine) return; engine.connect(person); }, [person]);
  useEffect(() => {
    const start = (e: Event) => { const d = (e as CustomEvent<{ channelId: string; video?: boolean; invite?: string[] }>).detail; if (d?.channelId) void engine.start(d.channelId, !!d.video, d.invite); };
    window.addEventListener("pulse:call", start); return () => window.removeEventListener("pulse:call", start);
  }, []);
  const ringing = useMemo(() => snap.calls.filter((c) => c.state !== "ended" && c.parties.find((p) => p.id === snap.me)?.state === "ringing" && snap.session?.call.id !== c.id), [snap]);
  // Answer from a notification (web push or the phone app): /chats?channel=…&call=…&answer=1.
  useEffect(() => {
    const u = new URL(window.location.href), id = u.searchParams.get("call");
    if (!id || u.searchParams.get("answer") !== "1") return;
    const c = ringing.find((x) => x.id === id); if (!c) return;
    u.searchParams.delete("answer"); window.history.replaceState(window.history.state, "", u.toString());
    void engine.answer(c.id, c.video);
  }, [ringing]);
  // The tab says who is calling while it rings.
  useEffect(() => {
    if (!ringing.length) return;
    const was = document.title, who = ringing[0].parties.find((p) => p.id === ringing[0].startedBy)?.name ?? "Someone";
    let on = false; const t = setInterval(() => { on = !on; document.title = on ? `📞 ${first(who)} is calling…` : was; }, 1000);
    return () => { clearInterval(t); document.title = was; };
  }, [ringing]);
  useAutoPip(snap.session);
  if (!ready) return null;
  return createPortal(<>
    {snap.session ? (snap.session.minimized ? <Mini s={snap.session} me={snap.me} /> : <Stage s={snap.session} me={snap.me} />) : null}
    {ringing.map((c, i) => <Incoming key={c.id} call={c} me={snap.me} waiting={!!snap.session} index={i} />)}
    {snap.error ? <div className={css.toast} role="alert"><span>{snap.error}</span><button type="button" onClick={() => { engine.error = null; engine.emit(); }} aria-label="Close"><X size={15} aria-hidden="true" /></button></div> : null}
    {!snap.session && snap.ended ? <Ended call={snap.ended.call} /> : null}
  </>, document.body);
}

function Incoming({ call, me, waiting, index }: { call: Call; me: string | null; waiting: boolean; index: number }) {
  const caller = call.parties.find((p) => p.id === (call.parties.find((x) => x.id === me)?.invitedBy ?? call.startedBy)) ?? call.parties[0];
  const group = call.channelKind !== "direct";
  const accept = useRef<HTMLButtonElement>(null);
  const [replies, setReplies] = useState(false), [sent, setSent] = useState<string | null>(null);
  useEffect(() => { accept.current?.focus({ preventScroll: true }); }, []);
  const kind = call.video ? "video call" : "voice call";
  // CALLS-V2: decline and say why, in the conversation (one-to-one calls).
  async function declineWith(text: string) {
    setSent(text); void engine.decline(call.id);
    try { await fetch(`/api/v0/chats/${call.channelId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: text, attachments: [], clientId: crypto.randomUUID() }) }); } catch { /* the decline still went */ }
  }
  return <div className={css.incoming} data-waiting={waiting || undefined} data-video={call.video || undefined} style={{ "--i": index } as CSSProperties} role="alertdialog" aria-modal="false" aria-label={`${caller?.name ?? "Someone"} is calling`} data-float-avoid="">
    <div className={css.incomingWho}>
      <span className={css.ringAvatar}><Avatar name={caller?.name ?? "?"} id={caller?.id} photoAt={caller?.photoAt} size={waiting ? 44 : 84} /></span>
      <span><b>{group ? call.channelName : caller?.name}</b><small>{waiting ? `Also calling: ${caller?.name ?? ""}` : group ? `${first(caller?.name ?? "Someone")} · group ${kind}` : `Incoming ${kind}`}</small></span>
    </div>
    {replies && !waiting ? <div className={css.replies} role="group" aria-label="Decline with a message">
      {QUICK_REPLIES.map((r) => <button key={r} type="button" disabled={!!sent} onClick={() => void declineWith(r)}>{r}</button>)}
    </div> : null}
    <div className={css.incomingActions}>
      <button type="button" className={css.decline} onClick={() => void engine.decline(call.id)} aria-label="Decline"><PhoneOff size={22} aria-hidden="true" /><span>Decline</span></button>
      {!group && !waiting ? <button type="button" className={css.acceptAlt} aria-expanded={replies} onClick={() => setReplies(!replies)} aria-label="Decline with a message" title="Decline with a message"><MessageSquare size={19} aria-hidden="true" /><span>Message</span></button> : null}
      {call.video ? <button type="button" className={css.acceptAlt} onClick={() => void engine.answer(call.id, false)} aria-label="Answer with audio only"><Phone size={20} aria-hidden="true" /><span>Audio</span></button> : null}
      <button ref={accept} type="button" className={css.accept} onClick={() => void engine.answer(call.id, call.video)} aria-label={waiting ? "End your call and answer" : call.video ? "Answer with video" : "Answer"}>
        {call.video ? <Video size={22} aria-hidden="true" /> : <Phone size={22} aria-hidden="true" />}<span>{waiting ? "End & answer" : "Answer"}</span></button>
    </div>
  </div>;
}

/** Sounds from the others: one audio element per person, on the chosen speaker where the browser allows it. */
function Sounds({ peers, output }: { peers: PeerView[]; output: string | null }) {
  return <>{peers.map((p) => <PeerAudio key={p.id} stream={p.stream} output={output} />)}</>;
}
function PeerAudio({ stream, output }: { stream: MediaStream | null; output: string | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => { const el = ref.current; if (!el) return; if (el.srcObject !== stream) el.srcObject = stream; if (stream) void el.play().catch(() => {}); }, [stream]);
  useEffect(() => { const el = ref.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null; if (el?.setSinkId && output) void el.setSinkId(output).catch(() => {}); }, [output]);
  return <audio ref={ref} autoPlay playsInline hidden />;
}
function VideoOf({ stream, mirror, className, main }: { stream: MediaStream; mirror?: boolean; className?: string; main?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { const el = ref.current; if (el && el.srcObject !== stream) { el.srcObject = stream; void el.play().catch(() => {}); } }, [stream]);
  return <video ref={ref} className={className} data-mirror={mirror || undefined} data-call-main-video={main || undefined} autoPlay playsInline muted />;
}
const hasVideo = (s: MediaStream | null) => !!s?.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);
const showsVideo = (p: Party, peer?: PeerView) => p.state === "joined" && (p.video || !!p.screen) && hasVideo(peer?.stream ?? null);
/** The person whose picture leads: someone sharing a screen, else the loudest one with video, else the first. */
function lead(others: Party[], peers: PeerView[]) {
  const of = (id: string) => peers.find((p) => p.id === id);
  return others.find((p) => p.screen && showsVideo(p, of(p.id))) ?? [...others].filter((p) => showsVideo(p, of(p.id))).sort((a, b) => (of(b.id)?.level ?? 0) - (of(a.id)?.level ?? 0))[0] ?? others[0] ?? null;
}

/** CALLS-V2: the video of a call in its own small window on top of other apps, where the browser can. */
const canPip = () => typeof document !== "undefined" && !!(document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled;
function popOut() { const v = document.querySelector<HTMLVideoElement>("video[data-call-main-video]"); if (v && v.readyState >= 1) void v.requestPictureInPicture?.().catch(() => {}); }
/** Pulse sent to the back during a video call: the browser may put the call's video in picture-in-picture by itself. */
function useAutoPip(s: SessionView | null) {
  const on = !!s && s.peers.some((p) => hasVideo(p.stream));
  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? (navigator.mediaSession as MediaSession & { setActionHandler: (a: string, h: (() => void) | null) => void }) : null;
    if (!on || !ms || !canPip()) return;
    try { ms.setActionHandler("enterpictureinpicture", popOut); } catch { return; }
    return () => { try { ms.setActionHandler("enterpictureinpicture", null); } catch { /* not supported */ } };
  }, [on]);
}

function status(s: SessionView, me: string | null, elapsed: number) {
  const c = s.call;
  if (c.state === "ringing") return c.parties.some((p) => p.state === "ringing") ? (c.startedBy === me ? "Ringing…" : "Joining…") : "Calling…";
  if (s.peers.some((p) => p.state === "disconnected" || p.state === "failed")) return "Reconnecting…";
  if (s.connecting) return "Connecting…";
  return callClock(elapsed);
}

function Stage({ s, me }: { s: SessionView; me: string | null }) {
  const c = s.call, elapsed = useElapsed(c);
  const [adding, setAdding] = useState(false), [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]), [menu, setMenu] = useState(false), [asking, setAsking] = useState(false);
  const rec = c.recording ?? null;
  const others = c.parties.filter((p) => p.id !== me && (p.state === "joined" || p.state === "ringing"));
  const peerOf = (id: string) => s.peers.find((p) => p.id === id);
  const canPick = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  useEffect(() => {
    if (!canPick) return;
    void navigator.mediaDevices?.enumerateDevices().then((d) => setOutputs(d.filter((x) => x.kind === "audiooutput" && x.deviceId !== "communications"))).catch(() => {});
  }, [canPick]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !adding) engine.minimize(true); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [adding]);
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  // CALLS-V2: a screen being shared leads, large and whole; everyone else is a strip beside (or under) it.
  const presenter = others.find((p) => p.screen && showsVideo(p, peerOf(p.id))) ?? null;
  const solo = !presenter && others.length <= 1;
  const anyVideo = s.camera || s.sharing || others.some((p) => p.video || p.screen);
  const pipOk = canPip() && s.peers.some((p) => hasVideo(p.stream));
  const main = lead(others, s.peers);
  return <div className={css.stage} role="dialog" aria-modal="true" aria-label={`Call with ${title(c, me)}`} data-video={anyVideo || undefined} data-present={presenter ? "" : undefined}>
    <Sounds peers={s.peers} output={s.output} />
    <header className={css.stageHead}>
      <button type="button" className={css.round} onClick={() => engine.minimize(true)} aria-label="Minimise the call" title="Minimise (Esc)"><ChevronDown size={20} aria-hidden="true" /></button>
      <span className={css.stageTitle}><b>{title(c, me)}</b><small aria-live="polite">{status(s, me, elapsed)}</small>
        {rec ? <span className={css.rec} role="status" data-call-recording=""><i aria-hidden="true" />{rec.by === me ? "Recording" : `Recording · ${first(rec.byName)}`}</span> : null}</span>
      {pipOk ? <button type="button" className={css.round} onClick={popOut} aria-label="Picture in picture" title="Keep the video on top of other windows"><PictureInPicture2 size={18} aria-hidden="true" /></button> : <span className={css.lockNote}>{c.video ? "Video" : "Voice"} call</span>}
    </header>
    {presenter ? <div className={css.present}>
      <Tile p={presenter} peer={peerOf(presenter.id)} big presenting main />
      {others.length > 1 ? <div className={css.strip}>{others.filter((p) => p.id !== presenter.id).map((p) => <Tile key={p.id} p={p} peer={peerOf(p.id)} big={false} />)}</div> : null}
    </div> : <div className={css.tiles} data-count={Math.min(others.length, 8)} data-solo={solo || undefined}>
      {others.map((p) => <Tile key={p.id} p={p} peer={peerOf(p.id)} big={solo} main={p.id === main?.id} />)}
      {!others.length ? <p className={css.alone}>Waiting for others to join…</p> : null}
    </div>}
    {s.sharing ? <p className={css.sharing} role="status"><MonitorUp size={16} aria-hidden="true" />You are sharing your screen<button type="button" onClick={() => engine.share(false)}>Stop sharing</button></p>
      : s.camera && s.local ? <VideoOf stream={s.local} mirror={s.facing === "user"} className={css.self} /> : null}
    {s.error ? <p className={css.stageError} role="alert">{s.error}</p> : null}
    {rec && s.recordingNotice ? <div className={css.notice} role="alertdialog" aria-label="This call is being recorded" data-recording-notice="">
      <p><CircleDot size={16} aria-hidden="true" /><span><b>{first(rec.byName)} is recording this call.</b> The recording and its transcript are kept in this chat for its members.{c.aiNotes ? " An AI employee writes notes from it for the team." : ""}{c.aiRecap ? " An AI employee drafts a recap for the team to check before anything is shared." : ""}</span></p>
      <span><button type="button" className={css.noticeLeave} onClick={() => void engine.hangup()}>Leave the call</button><button type="button" className={css.noticeOk} onClick={() => engine.ackRecording(rec.id)}>OK, stay</button></span>
    </div> : null}
    <footer className={css.controls}>
      <Control on={s.muted} label={s.muted ? "Unmute" : "Mute"} onClick={() => engine.toggleMute()}>{s.muted ? <MicOff size={22} /> : <Mic size={22} />}</Control>
      <Control on={s.camera} label={s.camera ? "Turn camera off" : "Turn camera on"} onClick={() => engine.camera(!s.camera)}>{s.camera ? <Video size={22} /> : <VideoOff size={22} />}</Control>
      {s.camera && touch ? <Control label="Switch camera" onClick={() => engine.flip()}><RefreshCcw size={21} /></Control> : null}
      {s.canShare ? <Control on={s.sharing} label={s.sharing ? "Stop sharing your screen" : "Share your screen"} onClick={() => engine.share(!s.sharing)}>{s.sharing ? <MonitorX size={22} /> : <MonitorUp size={22} />}</Control> : null}
      {s.speaker !== null ? <Control on={s.speaker} label={s.speaker ? "Speaker on" : "Speaker off"} onClick={() => engine.speaker(!s.speaker)}><Volume2 size={22} /></Control> : null}
      {s.speaker === null && outputs.length > 1 ? <span className={css.menuWrap}>
        <Control label="Speaker" onClick={() => setMenu(!menu)} expanded={menu}><Volume2 size={22} /></Control>
        {menu ? <span className={css.menu} role="menu">{outputs.map((d, i) => <button key={d.deviceId || i} type="button" role="menuitemradio" aria-checked={(s.output ?? "default") === d.deviceId} onClick={() => { engine.output(d.deviceId); setMenu(false); }}>{d.label || `Speaker ${i + 1}`}</button>)}</span> : null}
      </span> : null}
      {c.mayRecord || rec ? <Control on={!!rec} label={rec ? "Stop recording" : "Record the call"} onClick={() => rec ? engine.record(false) : setAsking(true)}>{rec ? <Square size={18} fill="currentColor" /> : <CircleDot size={22} />}</Control> : null}
      {c.mayInvite !== false ? <Control label="Add someone" onClick={() => setAdding(true)}><UserPlus size={22} /></Control> : null}
      <button type="button" className={css.hangup} onClick={() => void engine.hangup()} aria-label="Hang up" title="Hang up"><PhoneOff size={24} aria-hidden="true" /></button>
    </footer>
    {adding ? <AddPeople call={c} me={me} onClose={() => setAdding(false)} /> : null}
    {asking ? <RecordConfirm busy={s.recordingBusy} aiNotes={!!c.aiNotes} onClose={() => setAsking(false)} onRecord={() => { setAsking(false); engine.record(true); }} /> : null}
  </div>;
}

/** CALLS-V2: recording asks first, and says who will know and where it goes. */
function RecordConfirm({ busy, aiNotes, onRecord, onClose }: { busy: boolean; aiNotes: boolean; onRecord: () => void; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }; document.addEventListener("keydown", k, true); return () => document.removeEventListener("keydown", k, true); }, [onClose]);
  return <div className={css.sheetBack} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={css.sheet} role="dialog" aria-modal="true" aria-label="Record this call?" data-record-confirm="">
      <header><b>Record this call?</b><small /><button type="button" className={css.round} onClick={onClose} aria-label="Close"><X size={17} aria-hidden="true" /></button></header>
      <ul className={css.recordList}>
        <li>Everyone in the call sees “Recording” and is asked to stay or leave.</li>
        <li>The recording goes into this chat for its members, with a transcript made on Pulse’s own server.</li>
        <li>{aiNotes ? "An AI employee writes short notes and action items from the transcript, for the team." : "No AI notes for this call (your company’s choice)."} You or an admin can delete it.</li>
      </ul>
      <footer><button type="button" className={css.ghost} onClick={onClose}>Cancel</button><button type="button" className={css.rec2} disabled={busy} onClick={onRecord} autoFocus><CircleDot size={16} aria-hidden="true" />Start recording</button></footer>
    </div>
  </div>;
}

function Control({ on, label, onClick, children, expanded }: { on?: boolean; label: string; onClick: () => void; children: ReactNode; expanded?: boolean }) {
  return <button type="button" className={css.control} aria-pressed={on === undefined ? undefined : on} aria-expanded={expanded} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function Tile({ p, peer, big, presenting, main }: { p: Party; peer?: PeerView; big: boolean; presenting?: boolean; main?: boolean }) {
  const video = showsVideo(p, peer);
  const speaking = (peer?.level ?? 0) > 0.12 && !p.muted;
  const weak = p.state === "joined" && peer && peer.state === "connected" && peer.quality !== "good" ? peer.quality : null;
  return <div className={css.tile} data-state={p.state} data-speaking={speaking || undefined} data-video={video || undefined} data-screen={(video && p.screen) || undefined}>
    {video ? <VideoOf stream={peer!.stream!} className={css.tileVideo} main={main} /> : <span className={css.tileAvatar} style={{ "--level": String(peer?.level ?? 0) } as CSSProperties}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={big ? 128 : 72} /></span>}
    <span className={css.tileName}>{p.muted ? <MicOff size={13} aria-label="Muted" /> : null}{p.name}{presenting ? <em> · presenting</em> : null}{p.state === "ringing" ? <em> · ringing…</em> : peer && peer.state !== "connected" && peer.state !== "new" ? <em> · {peer.state === "connecting" ? "connecting…" : "reconnecting…"}</em> : null}</span>
    {weak ? <span className={css.weak} data-quality={weak} title={weak === "poor" ? "Poor connection: the call may break up" : "Weak connection"}><SignalLow size={13} aria-hidden="true" />{weak === "poor" ? "Poor connection" : "Weak connection"}</span> : null}
  </div>;
}

/** CALLS-V2: the call, minimised: a small window (the leading video, or the speaker's face) in a corner (top right
 *  at first, under the top bar, so it never covers the message box), dragged anywhere and settling in the nearest corner,
 *  which it remembers. Tap it to open the call. */
const CORNER_KEY = "pulse.call.mini.corner";
type Corner = "tl" | "tr" | "bl" | "br";
function Mini({ s, me }: { s: SessionView; me: string | null }) {
  const elapsed = useElapsed(s.call);
  const others = s.call.parties.filter((p) => p.id !== me && (p.state === "joined" || p.state === "ringing"));
  const top = lead(others, s.peers) ?? s.call.parties.find((p) => p.id !== me) ?? null;
  const peer = top ? s.peers.find((p) => p.id === top.id) : undefined;
  const video = !!top && showsVideo(top, peer);
  const speaking = s.peers.some((p) => p.level > 0.12);
  const [corner, setCorner] = useState<Corner>(() => { try { const c = window.localStorage.getItem(CORNER_KEY); return c === "tl" || c === "tr" || c === "bl" || c === "br" ? c : "tr"; } catch { return "tr"; } });
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const from = useRef<{ x: number; y: number; dx: number; dy: number; moved: boolean } | null>(null), box = useRef<HTMLDivElement>(null), dragged = useRef(false);
  function down(e: ReactPointerEvent) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-mini-act]")) return;
    const r = box.current?.getBoundingClientRect(); if (!r) return;
    from.current = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false }; dragged.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function move(e: ReactPointerEvent) {
    const f = from.current; if (!f) return;
    if (!f.moved && Math.hypot(e.clientX - f.x, e.clientY - f.y) < 6) return;
    f.moved = true; setDrag({ x: e.clientX - f.dx, y: e.clientY - f.dy });
  }
  function up(e: ReactPointerEvent) {
    const f = from.current; from.current = null; if (!f?.moved) return;
    dragged.current = true; setDrag(null);
    const c: Corner = `${e.clientY < window.innerHeight / 2 ? "t" : "b"}${e.clientX < window.innerWidth / 2 ? "l" : "r"}` as Corner;
    setCorner(c); try { window.localStorage.setItem(CORNER_KEY, c); } catch { /* storage off */ }
  }
  const style = drag ? { left: Math.max(4, Math.min(window.innerWidth - 120, drag.x)), top: Math.max(4, Math.min(window.innerHeight - 80, drag.y)), right: "auto", bottom: "auto" } as CSSProperties : undefined;
  return <div ref={box} className={css.mini} data-corner={corner} data-video={video || undefined} data-dragging={drag ? "" : undefined} style={style} data-float-avoid="" role="region" aria-label="Call in progress"
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { from.current = null; setDrag(null); }}>
    <Sounds peers={s.peers} output={s.output} />
    <button type="button" className={css.miniMain} onClick={() => { if (dragged.current) { dragged.current = false; return; } engine.minimize(false); }} aria-label="Open the call" title="Open the call (drag to move)">
      {video ? <VideoOf stream={peer!.stream!} className={css.miniVideo} main /> : <span className={css.miniAvatar} data-speaking={speaking || undefined}><Avatar name={top?.name ?? "?"} id={top?.id} photoAt={top?.photoAt} size={36} /></span>}
      <span className={css.miniText}><b>{s.call.recording ? <i className={css.recDot} aria-label="Recording" /> : null}{title(s.call, me)}</b><small>{status(s, me, elapsed)}{s.sharing ? " · sharing" : ""}{s.call.recording ? " · recording" : ""}</small></span>
      <Maximize2 size={14} aria-hidden="true" className={css.miniOpen} />
    </button>
    <span className={css.miniBar}>
      {video && canPip() ? <button type="button" data-mini-act="" className={css.pillBtn} onClick={popOut} aria-label="Picture in picture" title="Keep the video on top of other windows"><PictureInPicture2 size={16} aria-hidden="true" /></button> : null}
      <button type="button" data-mini-act="" className={css.pillBtn} aria-pressed={s.muted} onClick={() => engine.toggleMute()} aria-label={s.muted ? "Unmute" : "Mute"}>{s.muted ? <MicOff size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}</button>
      <button type="button" data-mini-act="" className={css.pillEnd} onClick={() => void engine.hangup()} aria-label="Hang up"><PhoneOff size={17} aria-hidden="true" /></button>
    </span>
  </div>;
}

function Ended({ call }: { call: Call }) {
  const secs = call.answeredAt ? (Date.parse(call.endedAt ?? call.now) - Date.parse(call.answeredAt)) / 1000 : 0;
  const text = call.endReason === "declined" ? "Declined" : call.endReason === "busy" ? "On another call" : call.endReason === "failed" ? "The call didn’t connect" : call.endReason === "missed" && !call.answeredAt ? "No answer" : `Call ended${secs > 0 ? ` · ${callClock(secs)}` : ""}`;
  return <div className={css.ended} role="status">{text}</div>;
}

type Person = { id: string; name: string; photoAt?: string | null; agent?: boolean; team?: string | null };
function AddPeople({ call, me, onClose }: { call: Call; me: string | null; onClose: () => void }) {
  const [people, setPeople] = useState<Person[] | null>(null), [q, setQ] = useState(""), [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    const ac = new AbortController();
    const members = fetch(`/api/v0/chats/${call.channelId}/messages?flat=1`, { cache: "no-store", signal: ac.signal }).then((r) => r.ok ? r.json() : null).catch(() => null);
    const everyone = fetch("/api/v0/chats", { cache: "no-store", signal: ac.signal }).then((r) => r.ok ? r.json() : null).catch(() => null);
    void Promise.all([members, everyone]).then(([m, all]) => {
      const list: Person[] = call.channelKind === "direct" ? (all?.people ?? []) : (m?.members ?? []);
      setPeople(list.filter((p) => !p.agent && p.id !== me));
    });
    return () => ac.abort();
  }, [call.channelId, call.channelKind, me]);
  const inCall = new Set(call.parties.filter((p) => p.state === "joined" || p.state === "ringing").map((p) => p.id));
  const room = 8 - inCall.size;
  const shown = (people ?? []).filter((p) => !inCall.has(p.id) && p.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 50);
  return <div className={css.sheetBack} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={css.sheet} role="dialog" aria-modal="true" aria-label="Add someone to the call">
      <header><b>Add someone</b><small>{room > 0 ? `Up to ${room} more` : "The call is full"}</small><button type="button" className={css.round} onClick={onClose} aria-label="Close"><X size={17} aria-hidden="true" /></button></header>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people" />
      <div className={css.sheetList}>{people === null ? <p className={css.alone}>Loading…</p> : !shown.length ? <p className={css.alone}>Nobody else to add here.</p>
        : shown.map((p) => <label key={p.id} className={css.person}><input type="checkbox" checked={picked.includes(p.id)} disabled={!picked.includes(p.id) && picked.length >= room} onChange={(e) => setPicked((x) => e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id))} />
          <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={34} /><span><b>{p.name}</b>{p.team ? <small>{p.team}</small> : null}</span></label>)}</div>
      <footer><button type="button" className={css.ghost} onClick={onClose}>Cancel</button><button type="button" className={css.go} disabled={!picked.length} onClick={() => { void engine.invite(picked); onClose(); }}><Phone size={16} aria-hidden="true" />Ring {picked.length || ""}</button></footer>
    </div>
  </div>;
}
