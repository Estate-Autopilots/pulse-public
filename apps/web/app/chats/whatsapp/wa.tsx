"use client";
// WA-IMPORT: a WhatsApp group imported whole, read-only: every message as written, photos, videos, voice notes,
// documents, contact cards and locations, deletions, edits and group notices, in time order. Read by the chat's
// members and admins (the API decides). Nothing here writes: replies, reactions and forwarding belong to the live chat.
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { ArrowDown, Building2, Contact, Download, ExternalLink, FileText, FolderKanban, History, ImageOff, MapPin, Mic, Pause, Phone, Play, Search, Trash2, Users, Video, X } from "lucide-react";
import { segments } from "../../lib/chat-format.mjs";
import { Avatar, hueStyle } from "../../ui";
import { get, send } from "../net";
import { useOrgZone } from "../../org-code";
import css from "./wa.module.css";

export type WaParticipant = { id: string; label: string; kind: "colleague" | "client" | "contact" | "number" | "unknown"; personId: string | null; name: string | null; side: string | null; messages: number; firstAt: string | null; lastAt: string | null };
export type WaBatch = { id: string; runBy: string; startedAt: string; finishedAt: string | null; added: number; duplicates: number; approvalRef: string; withdrawnAt: string | null };
export type WaChatMeta = { id: string; channelId: string; title: string; titles: string[]; timeZone: string; clientId: string | null; client: string | null; projectId: string | null; project: string | null;
  messages: number; firstAt: string | null; lastAt: string | null; counts: { kinds?: Record<string, number>; files?: Record<string, number>; participants?: Record<string, number> }; participants: WaParticipant[]; batches: WaBatch[]; canWithdraw: boolean };
type FileMeta = { width?: number; height?: number; seconds?: number; peaks?: number[]; pages?: number; poster?: string; playable?: string; names?: string[]; playableOriginal?: boolean };
type WaFile = { sha256: string | null; name: string | null; state: "attached" | "omitted" | "missing" | null; type: string | null; mime: string | null; size: number | null; kind: string | null; meta: FileMeta | null; complete: boolean | null };
export type WaMessage = { id: string; seq: number; at: string; local: string; participantId: string | null; kind: string; subtype: string | null; body: string; edited: boolean; exports: number;
  extra: { location?: { lat?: number; lon?: number; url?: string; live?: boolean }; contact?: { names?: string[] }; call?: { missed?: boolean }; viewOnce?: boolean; fileTitle?: string; pagesStated?: number } | null; file: WaFile | null };
type Page = { messages: WaMessage[]; older: boolean; newer: boolean };
type Hit = { id: string; at: string; participantId: string | null; body: string; fileName: string | null; transcript?: boolean };
type Insights = { stages: { stage: string; firstAt: string; lastAt: string; messages: number; evidence: string[] }[]; responses: Record<string, { answers: number; medianMinutes: number; p90Minutes: number; workingMedianMinutes: number }>;
  signals: { kind: string; at: string; messageId: string | null; score: number; amount: number | null; note: string | null }[]; places: { kind: string; lat: number | null; lng: number | null; label: string | null; url: string | null }[] };
const STAGE: Record<string, string> = { onboarding: "Onboarding", brief: "Brief and material", shoot: "Shoot", creative: "Creatives sent", revision: "Changes asked", approval: "Approved", live: "Campaign live", leads: "Leads", payment: "Payments", quiet: "Quiet spells" };
const SIGNAL: Record<string, string> = { complaint: "Complaint", churn_risk: "Churn risk", upsell: "Upsell", renewal: "Renewal", referral: "Referral", payment: "Payment", invoice: "Invoice", quotation: "Quotation", approval: "Approval", delay: "Delay", lead_quality: "Lead quality" };
const minutes = (m: number | null | undefined) => m == null ? "–" : m < 60 ? `${m} min` : m < 1440 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} days`;

const fileUrl = (sha: string, inline = false) => `/api/v0/chats/whatsapp/files/${sha}${inline ? "?inline=1" : ""}`;
const dayOf = (local: string) => new Date(`${local.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", day: "numeric", month: "long", year: "numeric" });
const timeOf = (local: string) => local.slice(11, 16);
const dateOf = (iso: string | null, timeZone: string) => iso ? new Date(iso).toLocaleDateString(undefined, { timeZone, day: "numeric", month: "short", year: "numeric" }) : "";
const sizeOf = (n: number | null) => n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const clockOf = (s: number) => { const t = Math.max(0, Math.floor(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const KIND: Record<WaParticipant["kind"], string> = { colleague: "", client: "Client", contact: "Contact", number: "Not in Pulse", unknown: "Not in Pulse" };
const OMITTED: Record<string, string> = { image: "Photo", video: "Video", audio: "Audio", voice: "Voice message", document: "Document", sticker: "Sticker", gif: "GIF", contact: "Contact card", unknown: "Media" };

function Text({ body }: { body: string }) {
  return <p className={css.text}>{segments(body).map((s: { type: string; value: string; label?: string; rest?: string }, i: number) => s.type === "link"
    ? <span key={i}><a href={s.value} target="_blank" rel="noopener noreferrer nofollow">{s.label}</a>{s.rest}</span> : <span key={i}>{s.value}</span>)}</p>;
}

/** One voice note or audio file: play / pause, the waveform (click to seek), its length and the speed. */
function Voice({ file, voice }: { file: WaFile; voice: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null), [playing, setPlaying] = useState(false), [at, setAt] = useState(0), [rate, setRate] = useState(1), [failed, setFailed] = useState(false);
  const meta = file.meta ?? {}, seconds = meta.seconds ?? 0, peaks = meta.peaks?.length ? meta.peaks : Array.from({ length: 48 }, () => 20);
  const [script, setScript] = useState<{ text: string; language: string | null } | null | "none" | "open">(null);
  const transcript = () => {
    if (script && script !== "none") { setScript(null); return; }
    setScript("open");
    get<{ text: string; language: string | null }>(`chats/whatsapp/files/${file.sha256}/transcript`).then(setScript).catch(() => setScript("none"));
  };
  const src = useMemo(() => {
    if (typeof document === "undefined" || !file.sha256) return "";
    const probe = document.createElement("audio"), mime = file.mime === "audio/ogg" ? 'audio/ogg; codecs="opus"' : file.mime ?? "";
    return !meta.playable || probe.canPlayType(mime) ? fileUrl(file.sha256) : fileUrl(meta.playable);
  }, [file.sha256, file.mime, meta.playable]);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const el = () => {
    if (!audio.current) {
      const a = new Audio(src); a.preload = "metadata"; a.playbackRate = rate;
      a.ontimeupdate = () => setAt(a.currentTime); a.onended = () => { setPlaying(false); setAt(0); }; a.onpause = () => setPlaying(false); a.onplay = () => setPlaying(true);
      a.onerror = () => { if (meta.playable && !a.src.endsWith(meta.playable)) { a.src = fileUrl(meta.playable); void a.play(); } else setFailed(true); };
      audio.current = a;
    }
    return audio.current;
  };
  const toggle = () => { const a = el(); if (a.paused) { document.dispatchEvent(new CustomEvent("wa-play", { detail: a })); void a.play().catch(() => setFailed(true)); } else a.pause(); };
  useEffect(() => { const stop = (e: Event) => { if ((e as CustomEvent).detail !== audio.current) audio.current?.pause(); }; document.addEventListener("wa-play", stop); return () => document.removeEventListener("wa-play", stop); }, []);
  const progress = seconds ? Math.min(1, at / seconds) : 0;
  return <div className={css.voice} data-voice={voice || undefined}>
    <button type="button" className={css.play} onClick={toggle} aria-label={playing ? "Pause" : `Play the ${voice ? "voice message" : "audio"}, ${clockOf(seconds)}`}>
      {playing ? <Pause size={18} fill="currentColor" aria-hidden="true" /> : <Play size={18} fill="currentColor" aria-hidden="true" />}
    </button>
    <span className={css.wave} role="slider" tabIndex={0} aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(seconds)} aria-valuenow={Math.round(at)} aria-valuetext={`${clockOf(at)} of ${clockOf(seconds)}`}
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(), a = el(); a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (seconds || a.duration || 0); setAt(a.currentTime); }}
      onKeyDown={(e) => { const a = el(); if (e.key === "ArrowRight") a.currentTime = Math.min(seconds, a.currentTime + 5); if (e.key === "ArrowLeft") a.currentTime = Math.max(0, a.currentTime - 5); setAt(a.currentTime); }}>
      {peaks.map((p, i) => <i key={i} data-on={i / peaks.length < progress || undefined} style={{ "--h": `${Math.max(12, p)}%` } as CSSProperties} />)}
    </span>
    <span className={css.under}><time>{clockOf(playing || at > 0 ? at : seconds)}</time>{voice ? <Mic size={12} aria-hidden="true" /> : null}
      {playing || at > 0 ? <button type="button" className={css.rate} onClick={() => { const r = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1; setRate(r); el().playbackRate = r; }} aria-label={`Speed ${rate}×. Change it`}>{rate}×</button> : null}
      {failed ? <a href={fileUrl(file.sha256!)} download>Download</a> : null}
      <button type="button" className={css.rate} onClick={transcript} aria-expanded={!!script && script !== "none"}>{script && script !== "none" && script !== "open" ? "Hide text" : "Transcript"}</button></span>
    {script === "open" ? <span className={css.transcript} role="status">Opening the transcript…</span> : null}
    {script === "none" ? <span className={css.transcript}>No transcript yet: voice notes are transcribed on the server, oldest last.</span> : null}
    {script && typeof script === "object" ? <span className={css.transcript} lang={script.language ?? undefined}>{script.text || "(no speech)"}<small> · transcribed on Pulse’s server{script.language ? ` · ${script.language}` : ""}</small></span> : null}
  </div>;
}

function Media({ m, onImage }: { m: WaMessage; onImage: (sha: string, name: string | null) => void }) {
  const f = m.file!;
  if (f.state !== "attached" || !f.sha256) {
    const what = OMITTED[f.type ?? "unknown"] ?? "Media";
    return <span className={css.omitted}><ImageOff size={15} aria-hidden="true" />{f.state === "missing" ? `${what}: the file was not in the export` : `${what} not included in the WhatsApp export`}{m.extra?.viewOnce ? " (view once)" : ""}{m.extra?.fileTitle ? ` · ${m.extra.fileTitle}` : ""}</span>;
  }
  const meta = f.meta ?? {}, kind = f.kind ?? f.type;
  if (kind === "image" || kind === "sticker" || kind === "gif") {
    const src = fileUrl(meta.playable && f.mime === "image/heic" ? meta.playable : f.sha256), w = meta.width ?? 4, h = meta.height ?? 3;
    return <button type="button" className={kind === "sticker" ? css.sticker : css.photo} onClick={() => onImage(meta.playable && f.mime === "image/heic" ? meta.playable : f.sha256!, f.name)} style={{ aspectRatio: `${w} / ${h}` }} aria-label={`Open the photo${f.name ? ` ${f.name}` : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" loading="lazy" width={w} height={h} />
    </button>;
  }
  if (kind === "video") {
    const w = meta.width ?? 16, h = meta.height ?? 9;
    return <div className={css.video} style={{ aspectRatio: `${w} / ${h}` }}>
      <video controls preload="none" playsInline poster={meta.poster ? fileUrl(meta.poster) : undefined}>
        {meta.playable ? <source src={fileUrl(meta.playable)} type="video/mp4" /> : null}
        <source src={fileUrl(f.sha256)} type={f.mime === "video/quicktime" ? "video/mp4" : f.mime ?? "video/mp4"} />
      </video>
      <span className={css.mediaFoot}><Video size={12} aria-hidden="true" />{meta.seconds ? clockOf(meta.seconds) : ""} · {sizeOf(f.size)}<a href={fileUrl(f.sha256)} download={f.name ?? true} aria-label="Download the video"><Download size={12} aria-hidden="true" /></a></span>
    </div>;
  }
  if (kind === "audio" || kind === "voice") return <Voice file={f} voice={f.type === "voice" || /^PTT-/i.test(f.name ?? "")} />;
  if (kind === "contact") {
    const names = meta.names?.length ? meta.names : m.extra?.contact?.names ?? [];
    return <a className={css.card} href={fileUrl(f.sha256)} download={f.name ?? "contact.vcf"}><Contact size={22} aria-hidden="true" /><span><b>{names.join(", ") || "Contact card"}</b><small>Contact card · download</small></span></a>;
  }
  const pdf = f.mime === "application/pdf";
  return <span className={css.doc}>
    <FileText size={24} aria-hidden="true" />
    <span><b>{f.name ?? m.extra?.fileTitle ?? "Document"}</b><small>{[meta.pages ? `${meta.pages} page${meta.pages === 1 ? "" : "s"}` : null, sizeOf(f.size), (f.name?.split(".").pop() ?? "").toUpperCase() || null].filter(Boolean).join(" · ")}</small></span>
    {pdf ? <a href={fileUrl(f.sha256, true)} target="_blank" rel="noopener noreferrer" aria-label="Open the PDF"><ExternalLink size={16} aria-hidden="true" /></a> : null}
    <a href={fileUrl(f.sha256)} download={f.name ?? true} aria-label="Download"><Download size={16} aria-hidden="true" /></a>
  </span>;
}

function Bubble({ m, p, run, mine, flash, onImage }: { m: WaMessage; p: WaParticipant | undefined; run: boolean; mine: boolean; flash: boolean; onImage: (sha: string, name: string | null) => void }) {
  if (m.kind === "system") return <div className={css.notice} id={`m-${m.id}`} data-flash={flash || undefined}><span>{m.body}</span></div>;
  const name = p ? (p.name ?? p.label) : "Unknown sender";
  const media = m.file && (m.kind === "media" || m.kind === "contact");
  return <div className={css.msg} id={`m-${m.id}`} data-mine={mine || undefined} data-run={run || undefined} data-flash={flash || undefined}>
    <div className={css.bubble} data-media={media && m.file?.state === "attached" && ["image", "video"].includes(m.file?.kind ?? "") ? "" : undefined}>
      {!run && !mine ? <span className={css.who} style={hueStyle(name)}>{p?.personId ? <Link href={p.kind === "colleague" ? `/people/${p.personId}` : `/contacts/${p.personId}`}>{name}</Link> : name}
        {p && KIND[p.kind] ? <small>{KIND[p.kind]}</small> : null}</span> : null}
      {m.kind === "deleted" ? <span className={css.deleted}><Trash2 size={13} aria-hidden="true" />{m.body || "This message was deleted"}</span> : null}
      {media ? <Media m={m} onImage={onImage} /> : null}
      {m.kind === "location" ? <a className={css.card} href={m.extra?.location?.url ?? (m.extra?.location?.lat != null ? `https://maps.google.com/?q=${m.extra.location.lat},${m.extra.location.lon}` : "#")} target="_blank" rel="noopener noreferrer nofollow">
        <MapPin size={22} aria-hidden="true" /><span><b>{m.extra?.location?.live ? "Live location" : "Location"}</b><small>{m.extra?.location?.lat != null ? `${m.extra.location.lat.toFixed(5)}, ${m.extra.location.lon?.toFixed(5)}` : "Open the map"}</small></span></a> : null}
      {m.kind === "call" ? <span className={css.call}><Phone size={14} aria-hidden="true" />{m.body}</span> : null}
      {m.body && !["deleted", "call", "system"].includes(m.kind) ? <Text body={m.body} /> : null}
      <span className={css.meta}>{m.edited ? "Edited · " : ""}<time dateTime={m.at} title={`${m.local.replace("T", " ")} (${m.exports} export${m.exports === 1 ? "" : "s"})`}>{timeOf(m.local)}</time></span>
    </div>
  </div>;
}

function Lightbox({ sha, name, onClose }: { sha: string; name: string | null; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  return <div className={css.lightbox} role="dialog" aria-modal="true" aria-label="Photo" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <header><span>{name ?? ""}</span><a href={fileUrl(sha)} download={name ?? true} aria-label="Download the photo"><Download size={18} aria-hidden="true" /></a><button type="button" onClick={onClose} aria-label="Close" autoFocus><X size={20} aria-hidden="true" /></button></header>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={fileUrl(sha)} alt={name ?? "Photo"} />
  </div>;
}

/** The whole imported chat: messages (newest first loaded, older on scroll up), the people in it, search. */
export function WaChat({ chat, viewer, focus }: { chat: WaChatMeta; viewer: string | null; focus?: string }) {
  const [msgs, setMsgs] = useState<WaMessage[]>([]), [older, setOlder] = useState(false), [newer, setNewer] = useState(false);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [image, setImage] = useState<{ sha: string; name: string | null } | null>(null);
  const [flash, setFlash] = useState<string | null>(focus ?? null), [q, setQ] = useState(""), [hits, setHits] = useState<Hit[] | null>(null), [side, setSide] = useState(false);
  const [insights, setInsights] = useState<Insights | null>(null);
  useEffect(() => { const a = new AbortController(); get<Insights>(`chats/whatsapp/${chat.id}/insights`, a.signal).then(setInsights).catch(() => {}); return () => a.abort(); }, [chat.id]);
  const list = useRef<HTMLDivElement>(null), keep = useRef<{ height: number; top: number } | null>(null), stick = useRef(true);
  const people = useMemo(() => new Map(chat.participants.map((p) => [p.id, p])), [chat.participants]);
  const day = (iso: string | null) => dateOf(iso, chat.timeZone);
  const load = useCallback((around?: string, signal?: AbortSignal) => get<Page>(`chats/whatsapp/${chat.id}/messages?limit=120${around ? `&around=${around}` : ""}`, signal)
    .then((d) => { stick.current = !around; setMsgs(d.messages); setOlder(d.older); setNewer(d.newer); setFlash(around ?? null); setError(""); })
    .catch((e) => { if (!signal?.aborted) setError((e as Error).message); }), [chat.id]);
  useEffect(() => { const a = new AbortController(); void load(focus, a.signal); return () => a.abort(); }, [load, focus]);
  const open = (around?: string) => { setBusy(true); void load(around).finally(() => setBusy(false)); };
  const earlier = useCallback(async () => {
    if (busy || !older || !msgs.length) return;
    setBusy(true); const el = list.current; keep.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    try { const d = await get<Page>(`chats/whatsapp/${chat.id}/messages?limit=120&before=${msgs[0].id}`); stick.current = false; setMsgs((x) => [...d.messages, ...x]); setOlder(d.older); }
    catch (e) { setError((e as Error).message); keep.current = null; } finally { setBusy(false); }
  }, [busy, older, msgs, chat.id]);
  const later = useCallback(async () => {
    if (busy || !newer || !msgs.length) return;
    setBusy(true);
    try { const d = await get<Page>(`chats/whatsapp/${chat.id}/messages?limit=120&after=${msgs[msgs.length - 1].id}`); stick.current = false; setMsgs((x) => [...x, ...d.messages]); setNewer(d.newer); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [busy, newer, msgs, chat.id]);
  useLayoutEffect(() => {
    const el = list.current; if (!el) return;
    if (keep.current) { el.scrollTop = el.scrollHeight - keep.current.height + keep.current.top; keep.current = null; return; }
    if (flash) { document.getElementById(`m-${flash}`)?.scrollIntoView({ block: "center" }); return; }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, flash]);
  const onScroll = () => { const el = list.current; if (!el) return; if (el.scrollTop < 400) void earlier(); if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) void later(); };
  async function search(e: FormEvent) {
    e.preventDefault(); if (q.trim().length < 2) { setHits(null); return; }
    try { setHits((await get<{ hits: Hit[] }>(`chats/whatsapp/${chat.id}/search?q=${encodeURIComponent(q.trim())}`)).hits); } catch (err) { setError((err as Error).message); }
  }
  async function withdraw(batch: string) {
    const note = window.prompt("Why withdraw this import? (3 to 300 characters; it is kept with the import)");
    if (!note) return;
    try { await send(`chats/whatsapp/batches/${batch}/withdraw`, { note }); window.location.reload(); } catch (e) { setError((e as Error).message); }
  }
  const rows: ReactNode[] = [];
  msgs.forEach((m, i) => {
    const prev = msgs[i - 1];
    if (!prev || prev.local.slice(0, 10) !== m.local.slice(0, 10)) rows.push(<div key={`d-${m.id}`} className={css.day}><span>{dayOf(m.local)}</span></div>);
    const run = !!prev && prev.participantId === m.participantId && prev.kind !== "system" && prev.local.slice(0, 10) === m.local.slice(0, 10);
    const p = m.participantId ? people.get(m.participantId) : undefined;
    rows.push(<Bubble key={m.id} m={m} p={p} run={run} mine={!!viewer && p?.personId === viewer} flash={flash === m.id} onImage={(sha, name) => setImage({ sha, name })} />);
  });
  const files = chat.counts.files ?? {}, attached = Object.entries(files).filter(([k]) => k.endsWith(":attached")).reduce((n, [, v]) => n + v, 0);
  const omitted = Object.entries(files).filter(([k]) => !k.endsWith(":attached")).reduce((n, [, v]) => n + v, 0);
  return <div className={css.shell}>
    <section className={css.pane} aria-label="Messages">
      <p className={css.banner}><History size={14} aria-hidden="true" />Imported from WhatsApp · read-only · {chat.messages.toLocaleString()} messages, {day(chat.firstAt)} – {day(chat.lastAt)} · times as the phone showed them ({chat.timeZone})
        <button type="button" className={css.sideBtn} onClick={() => setSide((s) => !s)} aria-expanded={side}><Users size={14} aria-hidden="true" />People and search</button></p>
      {error ? <p role="alert" className={css.error}>{error}<button type="button" onClick={() => void open(focus)}>Retry</button></p> : null}
      <div ref={list} className={css.list} role="log" aria-label="Imported messages" aria-busy={busy || undefined} onScroll={onScroll}>
        {older ? <button type="button" className={css.more} disabled={busy} onClick={() => void earlier()}>Earlier messages</button> : <p className={css.start}>The start of the exported history</p>}
        {!msgs.length && !error ? <span className={css.spinner} aria-label="Opening the chat" /> : rows}
        {newer ? <button type="button" className={css.more} disabled={busy} onClick={() => void later()}>Later messages</button> : null}
      </div>
      {newer || (flash && msgs.length) ? <button type="button" className={css.toEnd} onClick={() => void open()} aria-label="Go to the latest messages"><ArrowDown size={18} aria-hidden="true" /></button> : null}
    </section>
    <aside className={css.side} data-open={side || undefined} aria-label="About this chat">
      <form className={css.search} onSubmit={(e) => void search(e)} role="search">
        <Search size={15} aria-hidden="true" /><input value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value) setHits(null); }} placeholder="Search this chat" aria-label="Search this chat" />
      </form>
      {hits ? <ul className={css.hits} aria-label="Search results">{hits.length ? hits.map((h) => <li key={h.id}><button type="button" onClick={() => void open(h.id)}>
        <small>{day(h.at)} · {h.participantId ? people.get(h.participantId)?.name ?? people.get(h.participantId)?.label : "Notice"}{h.transcript ? " · said in a voice note" : ""}</small><span>{h.body || h.fileName}</span></button></li>) : <li className={css.none}>Nothing found</li>}</ul> : null}
      <dl className={css.facts}>
        {chat.client ? <><dt><Building2 size={14} aria-hidden="true" />Client</dt><dd><Link href={`/clients/${chat.clientId}`}>{chat.client}</Link></dd></> : null}
        {chat.project ? <><dt><FolderKanban size={14} aria-hidden="true" />Project</dt><dd><Link href={`/projects/${chat.projectId}`}>{chat.project}</Link></dd></> : null}
        <dt>Files</dt><dd>{attached.toLocaleString()} in Pulse{omitted ? ` · ${omitted.toLocaleString()} not in the export` : ""}</dd>
        {chat.titles.length > 1 ? <><dt>Earlier names</dt><dd>{chat.titles.filter((t) => t !== chat.title).slice(0, 4).join(" · ")}</dd></> : null}
      </dl>
      {insights && (insights.stages.length || insights.signals.length) ? <>
        <h3>What happened</h3>
        <ol className={css.stages}>{insights.stages.filter((st) => st.stage !== "quiet").map((st) => <li key={st.stage}><button type="button" onClick={() => st.evidence[0] ? void open(st.evidence[0]) : undefined}>
          <b>{STAGE[st.stage] ?? st.stage}</b><small>{day(st.firstAt)}{st.lastAt.slice(0, 10) !== st.firstAt.slice(0, 10) ? ` – ${day(st.lastAt)}` : ""} · {st.messages.toLocaleString()}</small></button></li>)}</ol>
        {insights.responses.team || insights.responses.client ? <dl className={css.facts}>
          {insights.responses.team ? <><dt>Team answers</dt><dd>{minutes(insights.responses.team.workingMedianMinutes)} typical (working hours) · {insights.responses.team.answers.toLocaleString()}</dd></> : null}
          {insights.responses.client ? <><dt>Client answers</dt><dd>{minutes(insights.responses.client.workingMedianMinutes)} typical (working hours) · {insights.responses.client.answers.toLocaleString()}</dd></> : null}
        </dl> : null}
        {insights.signals.length ? <ul className={css.signals}>{insights.signals.slice(0, 24).map((g, i) => <li key={i} data-kind={g.kind}><button type="button" onClick={() => g.messageId ? void open(g.messageId) : undefined}>
          <b>{SIGNAL[g.kind] ?? g.kind}</b><small>{day(g.at)}{g.amount ? ` · ₹${Math.round(g.amount).toLocaleString("en-IN")}` : ""}</small></button></li>)}</ul> : null}
        <p className={css.fine}>Read from the messages on Pulse’s server (local models and rules); a guide, not a verdict.</p>
      </> : null}
      <h3>{chat.participants.length} people</h3>
      <ul className={css.people}>{chat.participants.map((p) => {
        const name = p.name ?? p.label;
        const body = <><Avatar name={name} id={p.personId ?? undefined} size={28} /><span><b>{name}</b><small>{[KIND[p.kind] || "Colleague", `${p.messages.toLocaleString()} message${p.messages === 1 ? "" : "s"}`, p.lastAt ? `last ${day(p.lastAt)}` : null].filter(Boolean).join(" · ")}</small></span></>;
        return <li key={p.id}>{p.personId ? <Link href={p.kind === "colleague" ? `/people/${p.personId}` : `/contacts/${p.personId}`}>{body}</Link> : <span>{body}</span>}</li>;
      })}</ul>
      <h3>Imports</h3>
      <ul className={css.batches}>{chat.batches.map((b) => <li key={b.id}>{day(b.startedAt)} · {b.added.toLocaleString()} added{b.duplicates ? `, ${b.duplicates.toLocaleString()} already there` : ""}{b.withdrawnAt ? " · withdrawn" : ""}
        {chat.canWithdraw && !b.withdrawnAt ? <button type="button" className={css.rate} onClick={() => void withdraw(b.id)}>Withdraw</button> : null}</li>)}</ul>
      {chat.canWithdraw ? <p className={css.fine}>Withdrawing hides an import’s messages and files from everyone; nothing is deleted.</p> : null}
    </aside>
    {image ? <Lightbox sha={image.sha} name={image.name} onClose={() => setImage(null)} /> : null}
  </div>;
}

export type WaRow = { id: string; channelId: string; title: string; clientId: string | null; client: string | null; projectId: string | null; project: string | null; messages: number; firstAt: string | null; lastAt: string | null;
  counts: WaChatMeta["counts"]; personMessages?: number | null; personLastAt?: string | null };

/** A list of imported chats (the index page, or a person's, client's or project's chats). */
export function WaList({ rows, person }: { rows: WaRow[]; person?: boolean }) {
  const zone = useOrgZone();
  if (!rows.length) return <p className={css.empty}>No imported WhatsApp chats here.</p>;
  return <ul className={css.rows}>{rows.map((r) => <li key={r.id}><Link href={`/chats/whatsapp/${r.id}`}>
    <span className={css.rowIcon} aria-hidden="true"><History size={16} /></span>
    <span className={css.rowMain}><b>{r.title}</b><small>{[r.client, r.project].filter(Boolean).join(" · ") || "No client or project linked"}</small></span>
    <span className={css.rowNums}><b>{(person ? r.personMessages ?? 0 : r.messages).toLocaleString()}</b><small>{person ? `of ${r.messages.toLocaleString()} messages` : "messages"}</small></span>
    <span className={css.rowWhen}><small>{person && r.personLastAt ? `last wrote ${dateOf(r.personLastAt, zone)}` : `last ${dateOf(r.lastAt, zone)}`}</small></span>
  </Link></li>)}</ul>;
}

/** "Chats they're in" on a person's, client's or project's page: loads in the browser, says nothing when there are none. */
export function WaChatsSection({ filter, title = "WhatsApp chats", person, empty }: { filter: { person?: string; client?: string; project?: string }; title?: string; person?: boolean; /** Said when there are none (else the section is left out). */ empty?: string }) {
  const [d, setD] = useState<{ total: number; chats: WaRow[] } | null>(null), [error, setError] = useState("");
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  useEffect(() => { const a = new AbortController(); get<{ total: number; chats: WaRow[] }>(`chats/whatsapp?${qs}&limit=50`, a.signal).then(setD).catch((e) => { if (!a.signal.aborted) setError((e as Error).message); }); return () => a.abort(); }, [qs]);
  if (error) return <section className={css.section} aria-label={title}><h2>{title}</h2><p className={css.empty}>{error}</p></section>;
  if (!d) return null;
  if (!d.total) return empty ? <p className={css.empty}>{empty}</p> : null;
  const total = d.chats.reduce((n, r) => n + (person ? r.personMessages ?? 0 : r.messages), 0);
  return <section className={css.section} aria-label={title} data-wa-chats="">
    <h2>{title} <small>{d.total} chat{d.total === 1 ? "" : "s"} · {total.toLocaleString()} message{total === 1 ? "" : "s"}{person ? " by them" : ""}</small></h2>
    <WaList rows={d.chats} person={person} />
    {d.total > d.chats.length ? <Link className={css.all} href={`/chats/whatsapp?${qs}`}>All {d.total} chats</Link> : null}
  </section>;
}

type Metrics = Record<string, unknown>;
const pct = (x: unknown) => typeof x === "number" ? `${Math.round(x * 100)}%` : "–";
const num = (x: unknown) => typeof x === "number" ? x.toLocaleString() : "–";
/** WA-IMPORT (1016): what the imported chats say about a client, project or person, for those who may read it
 *  (admins and leadership; a person their own). Nothing when there is nothing or it is not theirs to read. */
export function WaInsightKpis({ subject, id }: { subject: "client" | "project" | "person"; id: string }) {
  const [m, setM] = useState<Metrics | null>(null);
  useEffect(() => { const a = new AbortController(); get<{ insight: { metrics: Metrics } | null }>(`chats/whatsapp/insight?subject=${subject}&id=${id}`, a.signal).then((d) => setM(d.insight?.metrics ?? null)).catch(() => {}); return () => a.abort(); }, [subject, id]);
  if (!m) return null;
  const sig = (m.signals ?? {}) as Record<string, number>;
  const items: [string, string][] = subject === "client" ? [
    ["Messages (client · team)", `${num(m.messages_client)} · ${num(m.messages_team)}`], ["Team answers in", minutes(m.team_median_answer_working_min as number)],
    ["Client answers in", minutes(m.client_median_answer_working_min as number)], ["Creative → approval", m.median_days_creative_to_approval != null ? `${m.median_days_creative_to_approval} days` : "–"],
    ["Negative messages", pct(m.negative_share)], ["Voice notes (client)", pct(m.voice_share)],
    ["Complaints · delays", `${num(sig.complaint ?? 0)} · ${num(sig.delay ?? 0)}`], ["Upsell signals", num(m.upsell_signals)], ["Churn risk", pct(m.churn_risk)]]
    : subject === "project" ? [["Chats · messages", `${num(m.chats)} · ${num(m.messages)}`], ["Brief → creatives", m.daysBriefToCreative != null ? `${m.daysBriefToCreative} days` : "–"],
      ["Creative → approval", m.daysCreativeToApproval != null ? `${m.daysCreativeToApproval} days` : "–"], ["Start → live", m.daysStartToLive != null ? `${m.daysStartToLive} days` : "–"],
      ["Changes asked", num(m.revisions)], ["Team answers in", minutes(m.teamMedianAnswerMinutes as number)]]
    : [["WhatsApp messages", num(m.waMessages)], ["Answers to clients", num(m.answers)], ["Typical answer", minutes(m.medianAnswerWorkingMinutes as number)], ["After hours", pct(m.afterHoursShare)]];
  return <dl className={css.kpis} aria-label="From the imported WhatsApp chats">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

/** A date in the company's own time zone (for server-rendered lists). */
export function WaDay({ iso }: { iso: string | null }) {
  const zone = useOrgZone();
  return <>{dateOf(iso, zone)}</>;
}
