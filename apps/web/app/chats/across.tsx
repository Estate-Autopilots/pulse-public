"use client";
// CHAT-ALL (owner, 18 Nov 2026: "Chat should be multi-organisation: a quick switch between All and one company, and
// company-specific groups"). The chat list's switch at its top: "All" (every company I am in, each chat tagged with its
// company, unread summed) and each company. The other companies' lists come from one read (GET chats/across: each
// company read inside its own, as My day), kept in this browser so the switch draws at once, refreshed every 30 s
// while the page is in view. Opening another company's chat moves this tab there smoothly (openCompany: no password on
// a trusted browser, SWITCH-SMOOTH) and the list stays on the same switch; a new chat or group asks which company first.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Layers, Lock, X } from "lucide-react";
import { notify as toast } from "@pulse/ui-shell";
import { cacheFits, chipName, hasSwitch, newsSince, rebase, switchSeats, toCache, unreadMap, validScope, type AcrossRead, type AcrossSeat, type Tagged } from "../lib/chat-across.mjs";
import { openCompany, proveHere } from "../orgs/client";
import { get } from "./net";
import type { Channel, ChatData } from "./types";
import x from "./across.module.css";
import css from "./chats.module.css";

const SCOPE_KEY = "pulse.chats.scope";
const CACHE_KEY = "pulse.chats.across.v1";
const EVERY = 30000;
export type Scoped = Channel & Tagged;

/** Opens another company's chat in that company (this tab moves there; the list keeps its switch). */
export async function openElsewhere(org: string, name: string, path: string) {
  try { await openCompany(org, name, path); }
  catch (e) { toast({ id: `chat-across-open-${org}`, tone: "error", title: `Could not open ${chipName(name)}`, message: (e as Error).message || "Try again.", timeout: 8000 }); }
}

/** The other companies' chats: the kept read first (when it is this account's), then a fresh one. */
export function useAcross(data: ChatData | null) {
  const viewer = data?.viewer ?? null;
  const [read, setRead] = useState<AcrossRead | null>(null);
  const before = useRef<Map<string, number> | null>(null), current = useRef<Channel[]>([]);
  // SPEED: one company only (most people): one read when Chats opens, no polling (there is no switch to keep fresh).
  const single = useRef(false);
  useEffect(() => { current.current = data?.channels ?? []; }, [data]);
  useEffect(() => {
    if (!viewer) return;
    queueMicrotask(() => { try { const kept: unknown = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null"); if (cacheFits(kept, viewer)) setRead((r) => r ?? rebase(kept, viewer)); } catch { /* none kept */ } });
  }, [viewer]);
  const refresh = useCallback(async () => {
    try {
      const r = await get<AcrossRead>("chats/across");
      if (!Array.isArray(r?.seats)) return;
      const news = newsSince(before.current, r.seats);
      before.current = unreadMap(r.seats);
      single.current = !hasSwitch(r.seats);
      setRead(r);
      try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(toCache(r, current.current))); } catch { /* storage full or private */ }
      // Notifications across companies: a new message in another company says so here, with one tap to open it.
      const c = news[0];
      if (c) toast({ id: `chat-across-${c.id}`, tone: "info", title: `New message in ${chipName(c.orgName)}`,
        message: `${c.name}${c.preview ? `: ${c.previewAuthor ? `${c.previewAuthor.split(" ")[0]}: ` : ""}${c.preview}` : ""}`.slice(0, 160),
        action: { label: "Open", run: () => void openElsewhere(c.org, c.orgName, `/chats?channel=${c.id}`) }, timeout: 10000 });
    } catch { /* keep what is shown; the next tick tries again */ }
  }, []);
  useEffect(() => {
    if (!viewer) return;
    queueMicrotask(() => void refresh());
    const tick = window.setInterval(() => { if (document.visibilityState === "visible" && !single.current) void refresh(); }, EVERY);
    const back = () => { if (document.visibilityState === "visible" && !single.current) void refresh(); };
    document.addEventListener("visibilitychange", back);
    return () => { window.clearInterval(tick); document.removeEventListener("visibilitychange", back); };
  }, [viewer, refresh]);
  return { read, refresh };
}

const never = () => () => {};
/** "all", one company's id, or "current" (one company only: the page's own list). Kept in this browser. */
export function useScope(seats: AcrossSeat[] | undefined) {
  const ready = useSyncExternalStore(never, () => true, () => false);
  const [raw, setRaw] = useState<string | null>(null);
  const kept = ready ? (() => { try { return window.localStorage.getItem(SCOPE_KEY); } catch { return null; } })() : null;
  const set = useCallback((v: string) => { setRaw(v); try { window.localStorage.setItem(SCOPE_KEY, v); } catch { /* private window */ } }, []);
  return [validScope(raw ?? kept ?? "all", seats), set] as const;
}

/** A company's square logo, or its initials. */
export function Mark({ name, src, size = 18 }: { name: string; src?: string | null; size?: number }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  // eslint-disable-next-line @next/next/no-img-element -- the company's logo is served by the API, already small
  return src ? <img className={x.mark} src={src} alt="" width={size} height={size} style={{ width: size, height: size }} />
    : <span className={x.mark} aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.48) }}>{initials}</span>;
}

const label = (s: Pick<AcrossSeat, "name" | "personal">) => s.personal ? "My workspace" : chipName(s.name);

/** The switch: All, then each company (the one this tab is in first), with its unread chats. */
export function CompanySwitch({ seats, scope, totals, onScope, onRefresh }: { seats: AcrossSeat[]; scope: string; totals: Record<string, number>; onScope: (v: string) => void; onRefresh: () => Promise<void> }) {
  const list = switchSeats(seats);
  const count = (n: number | undefined) => n ? <i aria-label={`${n} unread`}>{n > 99 ? "99+" : n}</i> : null;
  const unlock = async (s: AcrossSeat) => {
    // SWITCH-SMOOTH: a company this sign-in may not open yet asks once (a code to your own e-mail, or a passkey).
    try { if (await proveHere(s.name)) { await onRefresh(); onScope(s.org); } } catch { /* the dialog said why */ }
  };
  return <div className={x.switch} role="tablist" aria-label="Show chats from" data-chat-scope="">
    <button type="button" role="tab" aria-selected={scope === "all"} data-scope="all" onClick={() => onScope("all")} title="Chats from all your companies">
      <Layers size={15} aria-hidden="true" />All{count(totals.all)}</button>
    {list.map((s) => <button key={s.org} type="button" role="tab" aria-selected={scope === s.org} data-scope={s.org} data-locked={s.state === "locked" || undefined}
      title={s.state === "locked" ? `Confirm it's you once to see ${s.name}'s chats` : s.state === "unavailable" ? `${s.name}: couldn't load its chats just now` : s.name}
      onClick={() => s.state === "locked" ? void unlock(s) : onScope(s.org)}>
      <Mark name={s.name} src={s.mark} />{label(s)}{s.state === "locked" ? <Lock size={12} aria-label="Locked" /> : count(totals[s.org])}</button>)}
  </div>;
}

/** The company a chat is in, on its row: logo and short name. */
export function OrgTag({ c }: { c: Scoped }) {
  if (!c.orgName) return null;
  return <span className={x.tag} data-org-tag="" data-remote={c.remote || undefined} title={c.remote ? `In ${c.orgName}. Opens there.` : `In ${c.orgName}`}>
    <Mark name={c.orgName} src={c.orgMark} size={14} />{chipName(c.orgName)}</span>;
}

/** A new chat or group: in which company? (Only asked in All; a company's own view starts it there.) */
export function PickCompany({ seats, what, onHere, onClose }: { seats: AcrossSeat[]; what: "new" | "group"; onHere: () => void; onClose: () => void }) {
  const list = switchSeats(seats);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  const pick = async (s: AcrossSeat) => {
    if (s.current) { onHere(); return; }
    setBusy(s.org);
    await openElsewhere(s.org, s.name, what === "group" ? "/chats?new=group" : "/chats?new=1");
    setBusy(null);
  };
  const title = what === "group" ? "New group in which company?" : "New chat in which company?";
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`${css.dialog} ${x.pick}`} role="dialog" aria-modal="true" aria-label={title} data-pick-company="">
      <header><h2>{title}</h2><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button></header>
      <p className={css.hint}>{what === "group" ? "Everyone in the group must be in that company." : "You can chat with the people of that company."}</p>
      <div className={x.pickList}>{list.map((s, i) =>
        <button key={s.org} type="button" className={x.pickRow} onClick={() => void pick(s)} disabled={!!busy} autoFocus={i === 0} data-pick-org={s.org}>
          <Mark name={s.name} src={s.mark} size={32} />
          <span><b>{s.personal ? "My workspace" : s.name}</b><small>{busy === s.org ? `Opening ${chipName(s.name)}…` : s.current ? "You're here now" : s.state === "locked" ? "Confirm it's you once to open it" : "Opens there"}</small></span>
          {s.state === "locked" ? <Lock size={14} aria-hidden="true" /> : null}
        </button>)}</div>
    </div>
  </div>;
}
