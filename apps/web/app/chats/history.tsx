"use client";
// R47: a conversation's imported WhatsApp history, read-only, for its members (the API answers members only). It stays
// apart from the live conversation: no replies, reactions, unread counts, search or notifications.
import { useEffect, useState } from "react";
import { History, ImageOff, X } from "lucide-react";
import { get } from "./net";
import type { Channel } from "./types";
import css from "./chats.module.css";
import own from "./history.module.css";

export type ImportedMessage = { id: string; at: string; local: string; exact: boolean; authorId: string | null; name: string; label: string; kind: "text" | "media"; body: string; edited: boolean; batchId: string; cursor: string };
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
      <header><h2><History size={18} aria-hidden="true" /> Imported WhatsApp history</h2><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close" autoFocus><X size={18} aria-hidden="true" /></button></header>
      <p className={own.note}>
        {live.length ? <>Imported by {[...new Set(live.map((b) => b.approvedBy))].join(", ")} on {live.map((b) => dateOf(b.approvedAt)).join(", ")}, with the owner’s approval. Times are as the exporting phone showed them ({zones}). </> : null}
        Only the members of {channel.kind === "direct" ? "this chat" : channel.name} read it. It is not searched, counted or used anywhere else in Pulse; photos, files and voice notes were not imported.
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
              {!run ? <b title={m.authorId ? undefined : "Not a Pulse colleague: kept as the export names them"}>{m.authorId === viewer ? "You" : m.name}{m.authorId ? null : <small> · not in Pulse</small>}</b> : null}
              {m.kind === "media" ? <span className={own.media}><ImageOff size={14} aria-hidden="true" />Photo, file or voice note (not imported)</span> : null}
              {m.body ? <p>{m.body}</p> : null}
              <time dateTime={m.at} title={m.exact ? undefined : "Around a clock change: this time happened twice or not at all"}>{m.edited ? "Edited · " : ""}{timeOf(m.local)}{m.exact ? "" : " ?"}</time>
            </div>
          </div>;
        })}
      </div>
    </div>
  </div>;
}
