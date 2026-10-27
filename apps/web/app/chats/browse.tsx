"use client";
// GROUP-ACCESS (1098): the client groups an organisation lets a colleague read without being a member (Settings →
// Chats). Chats → All client groups lists every client group they read; one they are not in opens read-only ("browsing",
// no read marks, no notifications) with Join to post, which makes them a member.
import { useEffect, useState } from "react";
import { Eye, LogIn } from "lucide-react";
import { listTime } from "../lib/chat-format.mjs";
import { get, send } from "./net";
import { GroupAvatar } from "./parts";
import type { Channel } from "./types";
import css from "./chats.module.css";
import own from "./browse.module.css";

export type ClientGroup = { id: string; name: string; member: boolean; members: number; lastAt: string | null; photoAt: string | null; client: string | null; pod: string | null; imported: boolean };
const PAGE = 80;

/** The conversation a link, the hub or All client groups opened that is not in the chat list: a group the viewer reads (or,
 *  as an admin, moderates) without being in it. Null while it loads; `channel` null when it is not readable. */
export function useBrowsed(selected: string | null, inList: boolean) {
  const [state, setState] = useState<{ id: string; channel: Channel | null } | null>(null);
  useEffect(() => {
    if (!selected || inList) return;
    let live = true;
    get<{ channel?: Channel; member?: boolean }>(`chats/${selected}/browse`)
      .then((r) => { if (live) setState({ id: selected, channel: r.channel ?? null }); })
      .catch(() => { if (live) setState({ id: selected, channel: null }); });
    return () => { live = false; };
  }, [selected, inList]);
  return state && state.id === selected && !inList ? state : null;
}

/** Chats → All client groups: every client group the viewer reads, latest first; the ones they are not in say so. */
export function ClientGroups({ query, selected, onOpen }: { query: string; selected: string | null; onOpen: (id: string) => void }) {
  const [groups, setGroups] = useState<ClientGroup[] | null>(null), [error, setError] = useState(""), [shown, setShown] = useState(PAGE);
  useEffect(() => {
    let live = true;
    get<{ groups: ClientGroup[] }>("chats/client-groups").then((r) => { if (live) setGroups(r.groups); }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, []);
  if (error) return <p className={css.sideError} role="alert">{error}</p>;
  if (!groups) return <p className={css.empty} role="status">Opening client groups…</p>;
  const q = query.trim().toLowerCase();
  const found = groups.filter((g) => !q || `${g.name} ${g.client ?? ""} ${g.pod ?? ""}`.toLowerCase().includes(q));
  const reading = groups.filter((g) => !g.member).length;
  return <section aria-label="All client groups" data-client-groups="">
    <p className={own.note}>{reading ? `${reading} of ${groups.length} client groups open read-only: you are not in them. Join one to post in it.` : `The ${groups.length} client groups you are in.`}</p>
    {found.slice(0, shown).map((g) => <button key={g.id} type="button" className={css.row} aria-current={g.id === selected ? "true" : undefined} onClick={() => onOpen(g.id)} data-client-group={g.member ? "member" : "read"}>
      <GroupAvatar channel={{ id: g.id, name: g.name, kind: "custom", photoAt: g.photoAt }} size={48} />
      <span className={css.rowMain}>
        <span className={css.rowTop}><b>{g.name}</b>{g.member ? null : <em className={own.tag}><Eye size={11} aria-hidden="true" />Read only</em>}<time dateTime={g.lastAt ?? undefined}>{listTime(g.lastAt)}</time></span>
        <span className={css.rowBottom}><span className={css.preview}>{[g.client, g.pod, `${g.members} member${g.members === 1 ? "" : "s"}`, g.imported ? "from WhatsApp" : null].filter(Boolean).join(" · ")}</span></span>
      </span>
    </button>)}
    {found.length > shown ? <button type="button" className={css.searchAll} onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, found.length - shown)} more of {found.length - shown}</button> : null}
    {!found.length ? <p className={css.empty}>{q ? `No client groups match “${query.trim()}”.` : "No client groups to read yet."}</p> : null}
  </section>;
}

/** Join to post: the reader becomes a member (the database checks they may read the group). */
export function JoinButton({ channel, onJoined, className }: { channel: Channel; onJoined: () => Promise<void> | void; className?: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function join() {
    setBusy(true); setError("");
    try { await send(`chats/${channel.id}/join`); await onJoined(); } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <>
    {error ? <span className={own.error} role="alert">{error}</span> : null}
    <button type="button" className={`${css.primary} ${className ?? ""}`} disabled={busy} onClick={() => void join()} data-join=""><LogIn size={16} aria-hidden="true" />{busy ? "Joining…" : "Join to post"}</button>
  </>;
}

/** In place of the message box while browsing. */
export function JoinBar({ channel, onJoined }: { channel: Channel; onJoined: () => Promise<void> | void }) {
  return <div className={own.bar} data-join-bar="">
    <Eye size={16} aria-hidden="true" className={own.eye} />
    <span><b>You’re reading this client group.</b> Only its members write here. Joining makes you a member: you can post and you get its messages like everyone in it.</span>
    <JoinButton channel={channel} onJoined={onJoined} />
  </div>;
}
