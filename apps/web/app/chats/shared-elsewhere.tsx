"use client";
// CONNECT: groups another organisation shares with me (I am in them through my seat there), listed in my own Chats with
// "with <organisation>". Opening one moves to that organisation's shared space (only what is shared with me is there).
import { ChevronRight, Handshake } from "lucide-react";
import { useEffect, useState } from "react";
import { arrive, post, type Moved } from "../orgs/client";
import css from "./chats.module.css";

/** CONNECT: the "with <organisation>" pill gives way to the conversation's own name (it shrinks with an ellipsis). */
export const WITH_ORG = { flex: "0 3 auto", minWidth: 0, maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

type Shared = { id: string; ref: string; title: string; hostOrg: string; hostName: string; lastAt: string | null; last: string | null; lastBy: string | null };

export function SharedElsewhere() {
  const [items, setItems] = useState<Shared[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { let live = true; void fetch("/api/v0/connections/shared-chats", { cache: "no-store" }).then((r) => r.ok ? r.json() : { chats: [] }).then((d) => { if (live) setItems(d.chats ?? []); }).catch(() => {}); return () => { live = false; }; }, []);
  if (!items.length) return null;
  const open = async (s: Shared) => {
    setBusy(s.id); window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: { name: s.hostName } }));
    try { arrive(await post<Moved>("account/switch", { org: s.hostOrg }), `/chats?channel=${s.ref}`); }
    catch { setBusy(null); window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: null })); }
  };
  return <section className={css.channels} aria-label="Shared with other organisations"><h2>With other organisations</h2>{items.map((s) =>
    <button key={s.id} type="button" className={css.row} data-shared-chat="" onClick={() => void open(s)} disabled={!!busy}>
      <span className={css.channelIcon} aria-hidden="true"><Handshake size={20} /></span>
      <span className={css.rowMain}><span className={css.rowTop}><b style={{ flex: "1 1 auto" }}>{s.title}</b><em data-kind="connect" title={`Shared with ${s.hostName}`} style={WITH_ORG}>with {s.hostName}</em></span>
        <span className={css.rowBottom}><span className={css.preview}>{busy === s.id ? `Opening in ${s.hostName}…` : s.last ? `${s.lastBy ? s.lastBy.split(" ")[0] + ": " : ""}${s.last}` : "No messages yet"}</span></span></span>
      <ChevronRight size={16} aria-hidden="true" className={css.chev} />
    </button>)}</section>;
}
