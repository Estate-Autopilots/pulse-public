"use client";
// CHAT-V4 (24 Oct 2026): "edited" under a message opens what it said before, newest first, with when each was replaced
// (chat_message_revision; members of the conversation only; a deleted message takes its history with it).
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { fullTime } from "../lib/chat-format.mjs";
import { get } from "./net";
import type { ChatMessage } from "./types";
import css from "./chats.module.css";

type Revisions = { body: string; editedAt: string | null; createdAt: string; earlier: { body: string; replacedAt: string }[] };

export function EditHistory({ m, onClose }: { m: ChatMessage; onClose: () => void }) {
  const [data, setData] = useState<Revisions | null>(null), [error, setError] = useState("");
  useEffect(() => { let live = true; get<Revisions>(`chats/messages/${m.id}/revisions`).then((d) => { if (live) setData(d); }, (e) => { if (live) setError((e as Error).message); }); return () => { live = false; }; }, [m.id]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  // Newest first: the words now, then each earlier version with when it was written (the time the one before replaced it).
  const versions = data ? [{ body: data.body, at: data.editedAt ?? data.createdAt, now: true },
    ...data.earlier.map((r, i) => ({ body: r.body, at: i === 0 ? data.createdAt : data.earlier[i - 1].replacedAt, now: false })).reverse()] : [];
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={css.dialog} role="dialog" aria-modal="true" aria-label="Edit history" data-edit-history="">
      <header className={css.editsHead}><h2>Edit history</h2><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={18} aria-hidden="true" /></button></header>
      {error ? <p className={css.hint} role="alert">{error}</p> : !data ? <p className={css.hint}>Opening…</p>
        : <ol className={css.edits}>{versions.map((v, i) => <li key={i} data-now={v.now || undefined}>
          <small>{v.now ? "Now" : i === versions.length - 1 ? "First written" : "Before"} · <time dateTime={v.at}>{fullTime(v.at)}</time></small>
          <p>{v.body || "(no words)"}</p></li>)}
          {!data.earlier.length ? <li><small>Earlier words were not kept (edited before Pulse kept them).</small></li> : null}</ol>}
    </div>
  </div>;
}
