"use client";
// CHAT-VOICE: calls everywhere in Pulse. Mounted once in the shell: it listens for calls (ringing me, or with me in
// them), rings, and shows the call: a card to answer or decline (full screen on a phone), the call itself (people,
// cameras, who is speaking, mute, camera, speaker, add someone, minimise, hang up) and, minimised, a pill under the
// top bar that keeps the call going while you work anywhere in Pulse. Anything can start a call with
//   window.dispatchEvent(new CustomEvent("pulse:call", { detail: { channelId, video } }))
// (the chat header and the chat's /call command do).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Maximize2, Mic, MicOff, Phone, PhoneOff, RefreshCcw, UserPlus, Video, VideoOff, Volume2, X } from "lucide-react";
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
  if (!ready) return null;
  return createPortal(<>
    {snap.session ? (snap.session.minimized ? <Pill s={snap.session} me={snap.me} /> : <Stage s={snap.session} me={snap.me} />) : null}
    {ringing.map((c, i) => <Incoming key={c.id} call={c} me={snap.me} waiting={!!snap.session} index={i} />)}
    {snap.error ? <div className={css.toast} role="alert"><span>{snap.error}</span><button type="button" onClick={() => { engine.error = null; engine.emit(); }} aria-label="Close"><X size={15} aria-hidden="true" /></button></div> : null}
    {!snap.session && snap.ended ? <Ended call={snap.ended.call} /> : null}
  </>, document.body);
}

function Incoming({ call, me, waiting, index }: { call: Call; me: string | null; waiting: boolean; index: number }) {
  const caller = call.parties.find((p) => p.id === (call.parties.find((x) => x.id === me)?.invitedBy ?? call.startedBy)) ?? call.parties[0];
  const group = call.channelKind !== "direct";
  const accept = useRef<HTMLButtonElement>(null);
  useEffect(() => { accept.current?.focus({ preventScroll: true }); }, []);
  const kind = call.video ? "video call" : "voice call";
  return <div className={css.incoming} data-waiting={waiting || undefined} style={{ "--i": index } as CSSProperties} role="alertdialog" aria-modal="false" aria-label={`${caller?.name ?? "Someone"} is calling`} data-float-avoid="">
    <div className={css.incomingWho}>
      <span className={css.ringAvatar}><Avatar name={caller?.name ?? "?"} id={caller?.id} photoAt={caller?.photoAt} size={waiting ? 44 : 84} /></span>
      <span><b>{group ? call.channelName : caller?.name}</b><small>{waiting ? `Also calling: ${caller?.name ?? ""}` : group ? `${first(caller?.name ?? "Someone")} · group ${kind}` : `Incoming ${kind}`}</small></span>
    </div>
    <div className={css.incomingActions}>
      <button type="button" className={css.decline} onClick={() => void engine.decline(call.id)} aria-label="Decline"><PhoneOff size={22} aria-hidden="true" /><span>Decline</span></button>
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
function VideoOf({ stream, mirror, className }: { stream: MediaStream; mirror?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { const el = ref.current; if (el && el.srcObject !== stream) { el.srcObject = stream; void el.play().catch(() => {}); } }, [stream]);
  return <video ref={ref} className={className} data-mirror={mirror || undefined} autoPlay playsInline muted />;
}
const hasVideo = (s: MediaStream | null) => !!s?.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);

function status(s: SessionView, me: string | null, elapsed: number) {
  const c = s.call;
  if (c.state === "ringing") return c.parties.some((p) => p.state === "ringing") ? (c.startedBy === me ? "Ringing…" : "Joining…") : "Calling…";
  if (s.peers.some((p) => p.state === "disconnected" || p.state === "failed")) return "Reconnecting…";
  if (s.connecting) return "Connecting…";
  return callClock(elapsed);
}

function Stage({ s, me }: { s: SessionView; me: string | null }) {
  const c = s.call, elapsed = useElapsed(c);
  const [adding, setAdding] = useState(false), [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]), [menu, setMenu] = useState(false);
  const others = c.parties.filter((p) => p.id !== me && (p.state === "joined" || p.state === "ringing"));
  const peerOf = (id: string) => s.peers.find((p) => p.id === id);
  const canPick = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  useEffect(() => {
    if (!canPick) return;
    void navigator.mediaDevices?.enumerateDevices().then((d) => setOutputs(d.filter((x) => x.kind === "audiooutput" && x.deviceId !== "communications"))).catch(() => {});
  }, [canPick]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !adding) engine.minimize(true); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [adding]);
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  const solo = others.length <= 1;
  return <div className={css.stage} role="dialog" aria-modal="true" aria-label={`Call with ${title(c, me)}`} data-video={(s.camera || others.some((p) => p.video)) || undefined}>
    <Sounds peers={s.peers} output={s.output} />
    <header className={css.stageHead}>
      <button type="button" className={css.round} onClick={() => engine.minimize(true)} aria-label="Minimise the call" title="Minimise (Esc)"><ChevronDown size={20} aria-hidden="true" /></button>
      <span className={css.stageTitle}><b>{title(c, me)}</b><small aria-live="polite">{status(s, me, elapsed)}</small></span>
      <span className={css.lockNote}>{c.video ? "Video" : "Voice"} call</span>
    </header>
    <div className={css.tiles} data-count={Math.min(others.length, 8)} data-solo={solo || undefined}>
      {others.map((p) => <Tile key={p.id} p={p} peer={peerOf(p.id)} big={solo} />)}
      {!others.length ? <p className={css.alone}>Waiting for others to join…</p> : null}
    </div>
    {s.camera && s.local ? <VideoOf stream={s.local} mirror={s.facing === "user"} className={css.self} /> : null}
    {s.error ? <p className={css.stageError} role="alert">{s.error}</p> : null}
    <footer className={css.controls}>
      <Control on={s.muted} label={s.muted ? "Unmute" : "Mute"} onClick={() => engine.toggleMute()}>{s.muted ? <MicOff size={22} /> : <Mic size={22} />}</Control>
      <Control on={s.camera} label={s.camera ? "Turn camera off" : "Turn camera on"} onClick={() => engine.camera(!s.camera)}>{s.camera ? <Video size={22} /> : <VideoOff size={22} />}</Control>
      {s.camera && touch ? <Control label="Switch camera" onClick={() => engine.flip()}><RefreshCcw size={21} /></Control> : null}
      {s.speaker !== null ? <Control on={s.speaker} label={s.speaker ? "Speaker on" : "Speaker off"} onClick={() => engine.speaker(!s.speaker)}><Volume2 size={22} /></Control> : null}
      {s.speaker === null && outputs.length > 1 ? <span className={css.menuWrap}>
        <Control label="Speaker" onClick={() => setMenu(!menu)} expanded={menu}><Volume2 size={22} /></Control>
        {menu ? <span className={css.menu} role="menu">{outputs.map((d, i) => <button key={d.deviceId || i} type="button" role="menuitemradio" aria-checked={(s.output ?? "default") === d.deviceId} onClick={() => { engine.output(d.deviceId); setMenu(false); }}>{d.label || `Speaker ${i + 1}`}</button>)}</span> : null}
      </span> : null}
      <Control label="Add someone" onClick={() => setAdding(true)}><UserPlus size={22} /></Control>
      <button type="button" className={css.hangup} onClick={() => void engine.hangup()} aria-label="Hang up"><PhoneOff size={24} aria-hidden="true" /></button>
    </footer>
    {adding ? <AddPeople call={c} me={me} onClose={() => setAdding(false)} /> : null}
  </div>;
}

function Control({ on, label, onClick, children, expanded }: { on?: boolean; label: string; onClick: () => void; children: ReactNode; expanded?: boolean }) {
  return <button type="button" className={css.control} aria-pressed={on === undefined ? undefined : on} aria-expanded={expanded} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function Tile({ p, peer, big }: { p: Party; peer?: PeerView; big: boolean }) {
  const video = p.state === "joined" && p.video && hasVideo(peer?.stream ?? null);
  const speaking = (peer?.level ?? 0) > 0.12 && !p.muted;
  return <div className={css.tile} data-state={p.state} data-speaking={speaking || undefined} data-video={video || undefined}>
    {video ? <VideoOf stream={peer!.stream!} className={css.tileVideo} /> : <span className={css.tileAvatar} style={{ "--level": String(peer?.level ?? 0) } as CSSProperties}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={big ? 128 : 72} /></span>}
    <span className={css.tileName}>{p.muted ? <MicOff size={13} aria-label="Muted" /> : null}{p.name}{p.state === "ringing" ? <em> · ringing…</em> : peer && peer.state !== "connected" && peer.state !== "new" ? <em> · {peer.state === "connecting" ? "connecting…" : "reconnecting…"}</em> : null}</span>
  </div>;
}

function Pill({ s, me }: { s: SessionView; me: string | null }) {
  const elapsed = useElapsed(s.call);
  const other = s.call.parties.find((p) => p.id !== me && p.state === "joined") ?? s.call.parties.find((p) => p.id !== me);
  const speaking = s.peers.some((p) => p.level > 0.12);
  return <div className={css.pill} data-float-avoid="" role="region" aria-label="Call in progress">
    <Sounds peers={s.peers} output={s.output} />
    <button type="button" className={css.pillMain} onClick={() => engine.minimize(false)} aria-label="Open the call">
      <span className={css.pillAvatar} data-speaking={speaking || undefined}><Avatar name={other?.name ?? "?"} id={other?.id} photoAt={other?.photoAt} size={28} /></span>
      <span className={css.pillText}><b>{title(s.call, me)}</b><small>{status(s, me, elapsed)}</small></span>
      <Maximize2 size={15} aria-hidden="true" />
    </button>
    <button type="button" className={css.pillBtn} aria-pressed={s.muted} onClick={() => engine.toggleMute()} aria-label={s.muted ? "Unmute" : "Mute"}>{s.muted ? <MicOff size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}</button>
    <button type="button" className={css.pillEnd} onClick={() => void engine.hangup()} aria-label="Hang up"><PhoneOff size={17} aria-hidden="true" /></button>
  </div>;
}

function Ended({ call }: { call: Call }) {
  const secs = call.answeredAt ? (Date.parse(call.endedAt ?? call.now) - Date.parse(call.answeredAt)) / 1000 : 0;
  const text = call.endReason === "declined" ? "Declined" : call.endReason === "busy" ? "On another call" : call.endReason === "missed" && !call.answeredAt ? "No answer" : `Call ended${secs > 0 ? ` · ${callClock(secs)}` : ""}`;
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
