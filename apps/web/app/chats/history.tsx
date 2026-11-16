"use client";
// R47: a conversation's imported WhatsApp history, read-only, for its members (the API answers members only). It stays
// apart from the live conversation: no replies, reactions, unread counts, search or notifications.
import { useEffect, useRef, useState } from "react";
import { Download, History, ImageOff, Mic, Pause, Play, X } from "lucide-react";
import { get } from "./net";
import type { Channel } from "./types";
import css from "./chats.module.css";
import own from "./history.module.css";

/** CHAT-VOICE-FIX (2136): a file that came with the export (.zip), shown or downloaded from /chats/history/files/<id>. */
export type ImportedFile = { id: string; name: string; mime: string; size: number };
export type ImportedMessage = { id: string; at: string; local: string; exact: boolean; authorId: string | null; name: string; label: string; kind: "text" | "media"; body: string; edited: boolean; batchId: string; cursor: string; files?: ImportedFile[] };
export type ImportBatch = { id: string; approvedBy: string; approvedAt: string; timeZone: string; added: number; duplicates: number; withdrawnAt: string | null };
type Page = { messages: ImportedMessage[]; hasMore: boolean; batches: ImportBatch[] };

const dayOf = (local: string) => new Date(`${local.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const timeOf = (local: string) => local.slice(11, 16);
const dateOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function ImportedHistory({ channel, viewer, onClose }: { channel: Channel; viewer: string; onClose: () => void }) {
  const [page, setPage] = useState<Page | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  useEffect(() => {
    const abort = new AbortController();
    get<Page>(`chats/${channel.id}/history`, abort.signal).then(setPage).catch((e) => { if (!abort.signal.aborted) setError((e as Error).message); });
    return () => abort.abort();
  }, [channel.id]);
  async function earlier() {
    if (!page?.messages.length || busy) return;
    setBusy(true);
    try { const d = await get<Page>(`chats/${channel.id}/history?before=${encodeURIComponent(page.messages[0].cursor)}`); setPage({ ...d, messages: [...d.messages, ...page.messages] }); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const live = page?.batches.filter((b) => !b.withdrawnAt) ?? [];
  const zones = [...new Set(live.map((b) => b.timeZone))].join(", ");
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`${css.dialog} ${own.dialog}`} role="dialog" aria-modal="true" aria-label="Imported WhatsApp history">
      <header><h2><History size={18} aria-hidden="true" /> WhatsApp history</h2><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close" autoFocus><X size={18} aria-hidden="true" /></button></header>
      <p className={own.note}>
        {live.length ? <>Brought in by {[...new Set(live.map((b) => b.approvedBy))].join(", ")} on {live.map((b) => dateOf(b.approvedAt)).join(", ")}. Times are as shown on the phone{zones === "Asia/Kolkata" ? " (India time)" : ` (${zones})`}. </> : null}
        Only people in {channel.kind === "direct" ? "this chat" : channel.name} can see it.
      </p>
      {error ? <p role="alert" className={css.hint}>{error}</p> : null}
      <div className={own.list} role="log" aria-label="Imported messages" aria-busy={!page || undefined}>
        {!page && !error ? <span className={css.spinner} aria-label="Opening the history" /> : null}
        {page?.hasMore ? <button type="button" className={css.older} disabled={busy} onClick={() => void earlier()}>Earlier messages</button> : null}
        {page && !page.messages.length ? <p className={css.hint}>No imported messages to show.</p> : null}
        {page?.messages.map((m, i) => {
          const prev = page.messages[i - 1], chip = !prev || prev.local.slice(0, 10) !== m.local.slice(0, 10);
          const run = !chip && prev && prev.label === m.label && prev.authorId === m.authorId;
          return <div key={m.id} className={own.slot}>
            {chip ? <div className={css.day}><span>{dayOf(m.local)}</span></div> : null}
            <div className={own.message} data-mine={m.authorId === viewer || undefined}>
              {!run && m.authorId !== viewer ? <b title={m.authorId ? undefined : "Not a Pulse colleague: kept as the export names them"}>{m.name}{m.authorId ? null : <small> · not in Pulse</small>}</b> : null}
              {m.kind === "media" && m.files?.length ? m.files.map((f) => <MediaFile key={f.id} f={f} />) : null}
              {m.kind === "media" && !m.files?.length ? <span className={own.media}><ImageOff size={14} aria-hidden="true" />Photo, file or voice note (not in the export)</span> : null}
              {m.body ? <p>{m.body}</p> : null}
              <time dateTime={m.at} title={m.exact ? undefined : "Around a clock change: this time happened twice or not at all"}>{m.edited ? "Edited · " : ""}{timeOf(m.local)}{m.exact ? "" : " ?"}</time>
            </div>
          </div>;
        })}
      </div>
    </div>
  </div>;
}

const fileUrl = (f: ImportedFile) => `/api/v0/chats/history/files/${f.id}`;
const sizeOf = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
/** A photo shows, a voice note or video plays (where this browser can), anything else downloads. */
function MediaFile({ f }: { f: ImportedFile }) {
  if (/^image\//.test(f.mime)) return <a className={own.photo} href={fileUrl(f)} target="_blank" rel="noreferrer" data-imported-file="photo">
    {/* eslint-disable-next-line @next/next/no-img-element -- member-only file served by the API */}
    <img src={fileUrl(f)} alt={f.name} loading="lazy" /></a>;
  if (/^audio\//.test(f.mime)) return <HistoryVoice f={f} />;
  if (/^video\//.test(f.mime)) return <video className={own.video} controls preload="metadata" src={fileUrl(f)} aria-label={`Video ${f.name}`} data-imported-file="video" />;
  return <a className={own.doc} href={fileUrl(f)} download={f.name} data-imported-file="file"><Download size={14} aria-hidden="true" /><span>{f.name}</span><small>{sizeOf(f.size)}</small></a>;
}

/** A waveform-like row for an imported note (its real levels are not known): steady per file, like the chat's notes. */
const bars = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return Array.from({ length: 26 }, (_, i) => 28 + ((h >>> (i % 24)) + i * 37) % 72); };
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/** An imported voice note in Pulse's style: play or pause, how far it is, and its length once the player knows it. */
function HistoryVoice({ f }: { f: ImportedFile }) {
  const audio = useRef<HTMLAudioElement>(null), [playing, setPlaying] = useState(false), [at, setAt] = useState(0), [length, setLength] = useState(0), [failed, setFailed] = useState(false);
  const toggle = () => { const a = audio.current; if (!a) return; if (a.paused) a.play().catch(() => setFailed(true)); else a.pause(); };
  return <span className={own.voice} data-imported-file="audio">
    <audio ref={audio} preload="metadata" src={fileUrl(f)} aria-label={`Voice note ${f.name}`} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setAt(0); }}
      onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)} onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d)) setLength(d); }} onError={() => setFailed(true)} />
    <button type="button" className={own.voicePlay} onClick={toggle} aria-label={playing ? "Pause the voice note" : "Play the voice note"}>{playing ? <Pause size={18} fill="currentColor" aria-hidden="true" /> : <Play size={18} fill="currentColor" aria-hidden="true" />}</button>
    {failed ? <span className={own.voiceMeta}><Mic size={12} aria-hidden="true" /><a href={fileUrl(f)} download={f.name}>Can’t play here · Download</a></span> : <>
      <span className={own.voiceWave} aria-hidden="true">{bars(f.id).map((h, i, all) => <i key={i} data-on={length && i / all.length < at / length ? "" : undefined} style={{ height: `${h}%` }} />)}</span>
      <span className={own.voiceMeta}>{playing || at ? clock(at) : length ? clock(length) : <Mic size={13} aria-label="Voice note" />}</span></>}
  </span>;
}

