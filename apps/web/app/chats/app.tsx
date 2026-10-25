"use client";
// CHATS-2: chats like WhatsApp. The list on the left (search, All · Unread · Groups · People, pinned first, latest
// next), the conversation on the right; on a phone the list, then the chat full screen, then back. Everything draws
// from the local cache first and syncs behind it: the list and recent conversations are on screen before the network
// answers, sends are optimistic, the live-updates stream names what changed, and the top conversations are prefetched.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { AlarmClock, Archive, ArrowLeft, BellOff, Building2, LayoutGrid, Clock3, ChevronRight, History, Lock, Mail, MessageCircle, MoreVertical, Pin, Search, Send, Shield, Smartphone, SquarePen, Star, Users, X } from "lucide-react";
import { Avatar } from "../ui";
import { AiBadge } from "../kit/ai-badge";
import { StatusDialog, usePresenceStore } from "../presence";
import { filterChats, kindLabel, listTime, preview, sortChats } from "../lib/chat-format.mjs";
import { cachedList, cachedThread, saveList, storeVersion, subscribe } from "./store";
import { Conversation, setDraft } from "./conversation";
import { GroupAvatar, go, syncThread, useFitHeight } from "./parts";
import { InfoPanel, NewChat, NewGroup } from "./panels";
import { DIRECT_EVENT } from "./ask";
import { RowMenu, type RowMenuAt } from "./row-menu";
import { ChannelSetup } from "./channels";
import { SharedElsewhere } from "./shared-elsewhere";
import { get, send } from "./net";
import type { Channel, ChatData, ChatMessage, Member } from "./types";
import { warmMail } from "./email";
import { ContextPanel, usePanel } from "./workspace/panel";
import { IntentProvider } from "./workspace/intent";
import { Start } from "./workspace/start";
import { LAST_CHANNEL, draftStore } from "./drafts";
import css from "./chats.module.css";
// CHAT-V3: typing in the list, sections (Pods, Clients, AI, Archived), saved messages, search with filters.
import { typingEvent, typingLine, useTypingChannels } from "./live";
import { Saved, mutedNow } from "./v3";
import v3 from "./v3.module.css";
// CHAT-V5: the Threads inbox.
import { LIST_REFRESH, ThreadsInbox } from "./v5";
import v5 from "./v5.module.css";
import { notify as toast } from "@pulse/ui-shell";
import { JumpDialog, OfflineBanner, ShortcutsDialog, useChatKeys } from "./sweep";
import { SelectField } from "../kit/select-field";
// CHAT-V6: my reminders and scheduled messages in one place.
import { LATER_EVENT, LaterList } from "./v6";

const never = () => () => {};
const onResize = (done: () => void) => { window.addEventListener("resize", done); return () => window.removeEventListener("resize", done); };
// LAYOUT-SWEEP chat mode: from 900 px the list's header and the open conversation's header live in Pulse's top bar.
const WIDE = "(min-width: 900px)";
const onWide = (done: () => void) => { const m = window.matchMedia(WIDE); m.addEventListener("change", done); return () => m.removeEventListener("change", done); };
// Server data handed to a page is shown as is until it has gone into the cache; after that the cache (kept fresh) leads.
const handed = new WeakSet<ChatData>();
/** Rows of a fixed height, drawn only around what is on screen once a list grows past a few screens. */
function useWindow(count: number, row: number, box: RefObject<HTMLElement | null>) {
  const [range, setRange] = useState({ top: 0, height: 900 });
  useEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => setRange({ top: el.scrollTop, height: el.clientHeight || 900 });
    measure(); el.addEventListener("scroll", measure, { passive: true }); const ro = new ResizeObserver(measure); ro.observe(el);
    return () => { el.removeEventListener("scroll", measure); ro.disconnect(); };
  }, [box]);
  if (count <= 40) return { start: 0, end: count, before: 0, after: 0 };
  const start = Math.max(0, Math.floor(range.top / row) - 10), end = Math.min(count, Math.ceil((range.top + range.height) / row) + 10);
  return { start, end, before: start * row, after: (count - end) * row };
}

/** CHAT-SHELL: `role` (the shell's role label) and `modulesOff` decide what the side panel and intent detection offer. */
export function ChatsApp({ initial, initialError, boot = false, role, modulesOff }: { initial: ChatData | null; initialError?: string; boot?: boolean; role?: string; modulesOff?: readonly string[] }) {
  const params = useSearchParams();
  const selected = params.get("channel"), source = params.get("source"), focus = params.get("message"), threadParam = params.get("thread");
  const ready = useSyncExternalStore(never, () => true, () => false);
  useSyncExternalStore(subscribe, storeVersion, () => 0);
  const cached = ready ? cachedList() : null;
  const data: ChatData | null = initial && !handed.has(initial) ? initial : cached ?? initial;
  const [error, setError] = useState(initialError ?? ""), [live, setLive] = useState<boolean | null>(null);
  const [filter, setFilter] = useState("all"), [query, setQuery] = useState("");
  const [panel, setPanel] = useState<null | "new" | "group">(null), [info, setInfo] = useState(false), [status, setStatus] = useState(false), [moderation, setModeration] = useState(false);
  const [menu, setMenu] = useState(false), [hits, setHits] = useState<ChatMessage[] | null>(null), [saved, setSaved] = useState(false), [later, setLater] = useState(false);
  // CHAT-V3: search filters: from a person, what it has, when.
  const [from, setFrom] = useState(""), [has, setHas] = useState(""), [when, setWhen] = useState("");
  const typingIn = useTypingChannels();
  const box = useRef<HTMLElement>(null), app = useRef<HTMLDivElement>(null);
  const presence = usePresenceStore();
  // CHAT-V4: a row's quick actions (right-click, press and hold, or the menu key).
  const [rowMenu, setRowMenu] = useState<RowMenuAt | null>(null), closeRowMenu = useCallback(() => setRowMenu(null), []);
  const press = useRef(0), held = useRef(false);
  // Chat mode: the top bar becomes the chat's own header (the list's header beside the conversation's identity, search
  // in it and its details) instead of a page title, and a phone's open chat is full screen under it.
  const wide = useSyncExternalStore(onWide, () => window.matchMedia(WIDE).matches, () => true);
  const bar = useSyncExternalStore(never, () => document.querySelector<HTMLElement>("[data-shell-toolbar]"), () => null);
  const [chatSlot, setChatSlot] = useState<HTMLElement | null>(null);
  // CHAT-SHELL: beside an open side panel on a laptop the list narrows to its avatars, so the conversation keeps its room.
  const side = usePanel();
  const roomy = useSyncExternalStore(onResize, () => window.innerWidth - 64 - (side.open ? side.width : 0) - (window.innerWidth >= 1280 ? 380 : 330) >= 640, () => true);
  const slim = wide && side.open && !roomy && !!selected;
  // Owner workbench UI: with the list aside, the conversation header's Chats button shows it over the conversation.
  const [peek, setPeek] = useState(false);
  useEffect(() => { if (!slim) queueMicrotask(() => setPeek(false)); }, [slim]);
  // CHAT-SHELL v2: the dock on other pages shows the conversation last opened here.
  useEffect(() => { if (selected) try { window.localStorage.setItem(LAST_CHANNEL, selected); } catch { /* storage unavailable */ } }, [selected]);
  useEffect(() => { const root = document.documentElement; if (slim) root.dataset.chatSlim = ""; else delete root.dataset.chatSlim; return () => { delete root.dataset.chatSlim; }; }, [slim]);

  const refreshList = useCallback(async () => { try { saveList(await get<ChatData>("chats")); setError(""); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { if (boot) return; if (initial) { handed.add(initial); saveList(initial); } else queueMicrotask(() => void refreshList()); }, [boot, initial, refreshList]);
  useEffect(() => { const on = () => void refreshList(); window.addEventListener(LIST_REFRESH, on); return () => window.removeEventListener(LIST_REFRESH, on); }, [refreshList]);
  // EST-1204: with nothing cached, the list never waits for good. When the read fails, or 8 s pass with no answer, it
  // says Pulse can't be reached and offers Retry (a cached list shows as before, with its own Retry).
  const [slow, setSlow] = useState(false), [retrying, setRetrying] = useState(false);
  useEffect(() => { if (data) return; const timer = window.setTimeout(() => setSlow(true), 8000); return () => window.clearTimeout(timer); }, [data]);
  // E2E-4P (owner check): with nothing cached and Pulse not answering, the list asks again by itself (5, 10, 20, 30 s...).
  useEffect(() => {
    if (boot || data || !(error || slow)) return; let tries = 0, timer = 0, live = true;
    const again = () => { timer = window.setTimeout(async () => { if (!live) return; await refreshList(); tries++; again(); }, Math.min(30000, 5000 * 2 ** tries)); };
    again(); return () => { live = false; window.clearTimeout(timer); };
  }, [boot, data, error, slow, refreshList]);
  const retry = async () => { if (boot) { window.location.reload(); return; } setRetrying(true); await refreshList(); setRetrying(false); };

  // On a phone the chat is a window of its own: it fills the screen between the top bar and the bottom navigation.
  useFitHeight(app);

  // Live updates: the stream names the conversations that changed; the list is refetched (one small read) and the open
  // conversation only when it is among them. A fallback poll covers a stream that cannot connect.
  const open = useRef(selected);
  useEffect(() => { open.current = selected; }, [selected]);
  useEffect(() => {
    if (boot) return;
    let timer: ReturnType<typeof setTimeout> | null = null; const pendingThreads = new Set<string>(); let all = false;
    const flush = () => { timer = null; void refreshList(); const ids = all && open.current ? [open.current] : [...pendingThreads]; pendingThreads.clear(); all = false; for (const id of ids) if (id === open.current || cachedThread(id)) void syncThread(id).catch(() => {}); };
    const changed = (channels: string[], everything = false) => { channels.forEach((c) => pendingThreads.add(c)); all ||= everything; if (!timer) timer = setTimeout(flush, 40); };
    const events = new EventSource("/api/v0/chats/events");
    events.onopen = () => setLive(true); events.onerror = () => setLive(false);
    events.addEventListener("typing", (e) => { try { typingEvent(JSON.parse((e as MessageEvent).data)); } catch { /* malformed */ } });
    events.addEventListener("changed", (e) => { try { const d = JSON.parse((e as MessageEvent).data) as { channels?: string[]; all?: boolean }; changed(d.channels ?? [], !!d.all); } catch { changed([], true); } });
    const visible = () => { if (document.visibilityState === "visible") changed([], true); };
    document.addEventListener("visibilitychange", visible);
    const fallback = window.setInterval(() => { if (document.visibilityState === "visible" && events.readyState !== EventSource.OPEN) changed([], true); }, 15000);
    return () => { events.close(); window.clearInterval(fallback); document.removeEventListener("visibilitychange", visible); if (timer) clearTimeout(timer); };
  }, [boot, refreshList]);

  // Prefetch: the top conversations load quietly in the background, one after another, so opening them is instant.
  const prefetched = useRef(false);
  useEffect(() => {
    if (boot || !data || !cached || prefetched.current) return; prefetched.current = true;
    const top = sortChats(filterChats(data.channels, "all")).filter((c) => c.lastAt && (cachedThread(c.id)?.at ?? 0) < Date.parse(c.lastAt)).slice(0, 5);
    let cancelled = false;
    const idle = (fn: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 400));
    idle(async () => {
      for (const c of top) { if (cancelled) return; if (c.id !== open.current) await syncThread(c.id).catch(() => {}); }
      // POLISH-1: and the mail's first page, once per phone, when this person has a mailbox here.
      if (!cancelled && data.connections?.email?.connected) warmMail();
    });
    return () => { cancelled = true; };
  }, [boot, data, cached]);

  // CHAT-V5: a reminder that rings while the chats are open says so (the bell and push say it too; the row keeps a chip).
  const rang = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    if (!data) return; const now = new Map(data.channels.map((c) => [c.id, c.reminders ?? 0]));
    const before = rang.current; rang.current = now; if (!before) return;
    const c = data.channels.find((x) => (x.reminders ?? 0) > (before.get(x.id) ?? 0));
    if (c && c.id !== open.current) toast({ id: `chat-reminder-${c.id}`, tone: "info", title: "Reminder", message: `A message in ${c.name} you asked to be reminded about.`, action: { label: "Open", run: () => choose(c.id) }, timeout: 12000 });
  }, [data]);
  const channels = useMemo(() => data ? sortChats(filterChats(data.channels, filter, query)) : [], [data, filter, query]);
  const moderated = useMemo(() => data?.canModerate ? data.channels.filter((c) => c.moderationOnly && !c.duplicateOf) : [], [data]);
  const channel = data?.channels.find((c) => c.id === selected) ?? null;
  const unread = data ? filterChats(data.channels, "unread").length : 0;
  const people = useMemo(() => {
    if (!data || !query.trim()) return [];
    const dm = new Set(data.channels.filter((c) => c.kind === "direct").map((c) => c.peerId));
    const q = query.trim().toLowerCase();
    return data.people.filter((p) => p.id !== data.viewer && !dm.has(p.id) && `${p.name} ${p.username ?? ""} ${p.team ?? ""}`.toLowerCase().includes(q)).slice(0, 8);
  }, [data, query]);
  const win = useWindow(channels.length, 72, box);
  // CHAT-V5: Ctrl+K jumps to a chat, Ctrl+/ lists the shortcuts, Alt+Up / Alt+Down open the chat above or below.
  const [jump, setJump] = useState(false), [keys, setKeys] = useState(false);
  useChatKeys({ onJump: () => setJump(true), onJumpClose: () => setJump(false), onKeys: () => setKeys(true), onStep: (by) => {
    const list = channels.length ? channels : []; const i = list.findIndex((c) => c.id === selected);
    const next = list[i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + by))]; if (next && next.id !== selected) choose(next.id);
  } });
  const me = data?.people.find((p) => p.id === data.viewer);
  const myStatus = presence.me;

  // CHAT-V6: "Reminders and scheduled" opens in the list (from ⋮, or the message box's clock: on a phone the list comes back).
  useEffect(() => {
    const on = () => { setPanel(null); setHits(null); setSaved(false); setLater(true); setQuery(""); if (!window.matchMedia(WIDE).matches) go("", false); };
    window.addEventListener(LATER_EVENT, on); return () => window.removeEventListener(LATER_EVENT, on);
  }, []);
  function choose(id: string) {
    setPanel(null); setInfo(false); setHits(null); setPeek(false); go(`channel=${id}`);
    // POLISH-1: opened from the list, so Android back (below) can step back to it instead of adding the list again.
    try { window.history.replaceState({ ...(window.history.state ?? {}), pulseFromList: true }, "", window.location.href); } catch { /* history unavailable */ }
  }
  // POLISH-1: Android back in an open chat on a phone returns to the chat list (the phone app asks the page first).
  useEffect(() => {
    const back = (event: Event) => {
      if (!selected || window.matchMedia(WIDE).matches) return;
      event.preventDefault();
      if ((window.history.state as { pulseFromList?: boolean } | null)?.pulseFromList) window.history.back(); else go("", false);
    };
    window.addEventListener("pulse:back", back);
    return () => window.removeEventListener("pulse:back", back);
  }, [selected]);
  // CHAT-V4: /ask for an AI employee who is not in this conversation opens their direct chat with the question written.
  const directLater = useRef<(p: Member, draft?: string) => Promise<void>>(async () => {});
  useEffect(() => { directLater.current = direct; });
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<{ personId: string; draft?: string }>).detail; const p = cachedList()?.people.find((x) => x.id === d?.personId); if (p) void directLater.current(p, d.draft ?? ""); };
    window.addEventListener(DIRECT_EVENT, on); return () => window.removeEventListener(DIRECT_EVENT, on);
  }, []);
  async function direct(p: Member, draft = "") { try { const d = await send<{ id: string }>("chats/direct", { personId: p.id }); if (draft.trim()) setDraft(d.id, draft); await refreshList(); setQuery(""); choose(d.id); } catch (e) { setError((e as Error).message); } }
  async function searchMessages(over: { from?: string; has?: string; when?: string } = {}) {
    const f = { from, has, when, ...over }; if (!query.trim() && !f.from && !f.has && !f.when) return;
    const days = f.when === "today" ? 0 : f.when === "week" ? 6 : f.when === "month" ? 29 : null;
    const after = days === null ? "" : new Date(Date.now() - days * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
    const qs = new URLSearchParams({ ...(query.trim() ? { q: query.trim() } : {}), ...(f.from ? { from: f.from } : {}), ...(f.has ? { has: f.has } : {}), ...(after ? { after } : {}) });
    try { setSaved(false); setHits((await get<{ messages: ChatMessage[] }>(`chats/search?${qs}`)).messages); } catch (e) { setError((e as Error).message); }
  }
  // CHAT-V3 (fast search): messages are searched as you type (from 3 letters, after a short pause); Enter searches at once.
  const searchNow = useRef(searchMessages);
  useEffect(() => { searchNow.current = searchMessages; });
  useEffect(() => { if (query.trim().length < 3) return; const t = setTimeout(() => void searchNow.current(), 350); return () => clearTimeout(t); }, [query]);
  const refine = (over: { from?: string; has?: string; when?: string }) => { if (over.from !== undefined) setFrom(over.from); if (over.has !== undefined) setHas(over.has); if (over.when !== undefined) setWhen(over.when); void searchMessages(over); };
  async function pin(c: Channel) { try { await send(`chats/${c.id}/pin`, { on: !c.pinnedAt }); await refreshList(); } catch (e) { setError((e as Error).message); } }

  const view = selected || source === "telegram" || source === "whatsapp" ? "chat" : "list";
  useEffect(() => {
    const root = document.documentElement; root.dataset.mode = "chat"; root.dataset.chatView = view;
    return () => { delete root.dataset.mode; delete root.dataset.chatView; };
  }, [view]);
  if (!data) return <Skeleton stuck={!!error || slow} retrying={retrying} onRetry={() => void retry()} />;
  const archivedCount = data.channels.filter((c) => c.archivedAt && !c.moderationOnly).length, archivedUnread = data.channels.filter((c) => c.archivedAt && c.unread).length;
  const row = (c: Channel) => {
    // CHAT-V4: a plain group needs no "Group" tag on every row (its avatar says it); pods, teams and Google groups keep theirs.
    const label = c.kind === "custom" ? "" : kindLabel(c.kind);
    const isMuted = mutedNow(c.mutedUntil);
    const typing = typingLine(typingIn.get(c.id) ?? [], c.kind === "direct");
    // CHAT-V3: words written but not sent show on the row, as in WhatsApp.
    // (read only after hydration: the server cannot know this browser's drafts)
    const draft = !ready || c.id === selected ? "" : (draftStore.get(c.id) ?? "").trim();
    return <button key={c.id} type="button" data-chat-row="" data-unread={c.unread || c.markedUnread ? "" : undefined} className={css.row} aria-current={c.id === selected ? "true" : undefined}
      onClick={() => { if (held.current) { held.current = false; return; } choose(c.id); }} aria-haspopup="menu"
      onContextMenu={c.moderationOnly ? undefined : (e) => { e.preventDefault(); setRowMenu({ channel: c, x: e.clientX, y: e.clientY }); }}
      onKeyDown={c.moderationOnly ? undefined : (e) => { if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setRowMenu({ channel: c, x: r.left + 60, y: r.bottom - 8 }); } }}
      onTouchStart={c.moderationOnly ? undefined : (e) => { const t = e.touches[0]; const at = { x: t.clientX, y: t.clientY }; clearTimeout(press.current); press.current = window.setTimeout(() => { held.current = true; navigator.vibrate?.(12); setRowMenu({ channel: c, ...at }); }, 500); }}
      onTouchMove={() => clearTimeout(press.current)} onTouchEnd={() => clearTimeout(press.current)} onTouchCancel={() => clearTimeout(press.current)}>
      <GroupAvatar channel={c} size={48} />
      <span className={css.rowMain}>
        <span className={css.rowTop}><b>{c.name}</b>{c.peerAgent ? <AiBadge employeeId={data.people.find((p) => p.id === c.peerId)?.employeeId} /> : null}{label && !c.withOrg ? <em data-kind={c.kind}>{label}</em> : null}<time dateTime={c.lastAt ?? undefined} data-unread={c.unread ? "" : undefined}>{listTime(c.lastAt)}</time></span>
        <span className={css.rowBottom}><span className={css.preview}>{c.reminders ? <span className={v5.reminderChip} data-reminder-chip=""><AlarmClock size={12} aria-hidden="true" />Reminder</span> : null}{typing ? <span className={v3.typingHead}>{typing}</span> : draft ? <><b className={v3.draft}>Draft:</b> {draft.slice(0, 80)}</> : <>{/* E2E-4P: a shared group's other organisation leads the second line, so its name keeps the first. */}{c.withOrg ? <span className={css.withOrg} title={`Shared with ${c.withOrg}`}>with {c.withOrg} · </span> : null}{preview(c, data.viewer)}</>}</span>
          {c.scheduled ? <Clock3 size={13} aria-label={`${c.scheduled} scheduled message${c.scheduled === 1 ? "" : "s"}`} className={v3.muted} /> : null}
          {isMuted ? <BellOff size={13} aria-label="Muted" className={v3.muted} /> : null}
          {c.pinnedAt ? <Pin size={13} aria-label="Pinned" className={css.pinned} /> : null}
          {c.mentions ? <b className={css.mention} aria-label={`${c.mentions} mention${c.mentions === 1 ? "" : "s"}`}>@</b> : null}
          {c.unread ? <b className={`${css.badge} ${isMuted ? v3.badgeMuted : ""}`} aria-label={`${c.unread} unread`}>{c.unread > 99 ? "99+" : c.unread}</b>
            : c.markedUnread ? <b className={`${css.badge} ${isMuted ? v3.badgeMuted : ""}`} data-marked="" aria-label="Marked unread" /> : null}</span>
      </span>
    </button>;
  };
  const sideHead = <header className={css.sideHead}>
            <button type="button" className={css.me} onClick={() => setStatus(true)} aria-label="Set your status" title={myStatus?.text ? `${myStatus.emoji ?? ""} ${myStatus.text}`.trim() : "Set your status"}>
              <Avatar name={me?.name ?? "You"} id={data.viewer} photoAt={me?.photoAt} size={wide && bar ? 30 : 36} status />
            </button>
            <h2>Chats</h2>
            {/* GROUPS-HUB: every group of the company, with filters, bulk actions, AI employees and the review queue. */}
            <Link className={css.iconBtn} href="/chats/groups" aria-label="All groups" title="All groups"><LayoutGrid size={19} aria-hidden="true" /></Link>
            <button type="button" className={css.iconBtn} onClick={() => setPanel("new")} aria-label="New chat" title="New chat"><SquarePen size={19} aria-hidden="true" /></button>
            <span className={css.menuWrap}>
              <button type="button" className={css.iconBtn} onClick={() => setMenu(!menu)} aria-label="More" aria-expanded={menu}><MoreVertical size={19} aria-hidden="true" /></button>
              {menu ? <span className={css.menu} role="menu" onClick={() => setMenu(false)}>
                <button type="button" role="menuitem" onClick={() => setPanel("group")}><Users size={16} aria-hidden="true" />New group</button>
                <button type="button" role="menuitem" onClick={() => setStatus(true)}><MessageCircle size={16} aria-hidden="true" />Set your status</button>
                <button type="button" role="menuitem" onClick={() => { setHits(null); setLater(false); setSaved(true); }} data-saved-open=""><Star size={16} aria-hidden="true" />Saved messages</button>
                <button type="button" role="menuitem" onClick={() => { setHits(null); setSaved(false); setLater(true); }} data-later-open=""><AlarmClock size={16} aria-hidden="true" />Reminders and scheduled</button>
                {moderated.length ? <button type="button" role="menuitem" onClick={() => setModeration(true)}><Shield size={16} aria-hidden="true" />Moderate other groups ({moderated.length})</button> : null}
                <Link role="menuitem" href="/chats/groups"><LayoutGrid size={16} aria-hidden="true" />All groups (hub)</Link>
                <Link role="menuitem" href="/groups"><Building2 size={16} aria-hidden="true" />Teams and Google groups</Link>
                {data.canImport ? <Link role="menuitem" href="/chats/import"><History size={16} aria-hidden="true" />Import WhatsApp history</Link> : null}
                {data.channels.some((c) => c.whatsapp) || data.canModerate ? <Link role="menuitem" href="/chats/whatsapp"><History size={16} aria-hidden="true" />WhatsApp chats</Link> : null}
              </span> : null}
            </span>
          </header>;
  return <IntentProvider data={data} role={role} modulesOff={modulesOff}><div ref={app} className={css.app} data-grow="" data-view={view} data-info={info || undefined} data-panel={side.open && wide ? "" : undefined} data-slim={slim || undefined} data-peek={slim && peek ? "" : undefined}>
    {bar ? createPortal(<div className={css.chatBar} data-chat-bar="">{wide ? <div className={css.chatBarList}>{sideHead}</div> : null}<div ref={setChatSlot} className={css.chatBarChat} /></div>, bar) : null}
    <aside className={css.side} aria-label="Chats" data-chat-list="">
      {panel === "new" ? <NewChat data={data} onClose={() => setPanel(null)} onPick={(p) => void direct(p)} onGroup={() => setPanel("group")} />
        : panel === "group" ? <NewGroup data={data} onClose={() => setPanel(null)} onCreated={async (id) => { await refreshList(); choose(id); }} />
        : <>
          {/* RELEASE-5: from 900 px the head lives in the top bar; the server cannot know that yet, so its copy here is hidden
              by width from the first paint (it was there until hydration, then the list jumped up 60 px). */}
          {wide && bar ? null : <div className={css.sideHeadInline}>{sideHead}</div>}
          {myStatus?.text || myStatus?.dnd ? <button type="button" className={css.myStatus} onClick={() => setStatus(true)}>{myStatus.dnd ? <b>Do not disturb</b> : null}{myStatus.text ? <span>{myStatus.emoji} {myStatus.text}</span> : null}<X size={14} aria-hidden="true" /></button> : null}
          <form className={css.search} role="search" onSubmit={(e) => { e.preventDefault(); void searchMessages(); }}>
            <Search size={16} aria-hidden="true" />
            <input value={query} onChange={(e) => { setQuery(e.target.value); if (e.target.value.trim().length < 3) setHits(null); }} placeholder="Search or start a new chat" aria-label="Search chats and people" enterKeyHint="search" />
            {query ? <button type="button" className={css.clear} onClick={() => { setQuery(""); setHits(null); }} aria-label="Clear search"><X size={15} aria-hidden="true" /></button> : null}
          </form>
          <div className={css.filters} role="tablist" aria-label="Show">
            {filter === "archived" ? <button type="button" role="tab" aria-selected="true" onClick={() => setFilter("all")}><ArrowLeft size={14} aria-hidden="true" style={{ verticalAlign: "-2px" }} /> Archived</button>
              : FILTERS.filter(([k]) => k !== "clients" || data.channels.some((c) => c.clientFacing || c.withOrg)).filter(([k]) => k !== "ai" || data.channels.some((c) => c.peerAgent)).map(([k, l]) =>
              <button key={k} type="button" role="tab" aria-selected={filter === k} data-filter={k} onClick={() => { setFilter(k); setSaved(false); setLater(false); }}>{k === "unread" && unread ? `${l} ${unread}` : k === "threads" && data.threadsUnread ? `${l} ${data.threadsUnread}` : l}</button>)}
          </div>
          {error ? <p className={css.sideError} role="alert">{error}<button type="button" onClick={() => void refreshList()}>Retry</button></p> : null}
          <nav ref={box} className={css.rows} aria-label="Conversations">
            {later ? <LaterList data={data} onBack={() => setLater(false)} />
              : saved ? <><button type="button" className={v3.archivedRow} onClick={() => setSaved(false)}><ArrowLeft size={16} aria-hidden="true" />Back to chats</button><Saved data={data} onOpen={(m) => { setSaved(false); go(`channel=${m.channelId}&message=${m.id}`); }} /></>
              : filter === "threads" && !query.trim() && !hits ? <ThreadsInbox data={data} stamp={data} onOpen={(t) => { setPanel(null); setInfo(false); go(`channel=${t.channelId}&thread=${t.rootId}`); }} />
              : hits ? <>
              <div className={v3.chips} role="group" aria-label="Filter the messages found" data-search-filters="">
                <label className={v3.chip}>From<SelectField value={from} onChange={(e) => refine({ from: e.target.value })} aria-label="From">
                  <option value="">anyone</option><option value={data.viewer}>me</option>{data.people.filter((p) => p.id !== data.viewer).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></label>
                {[["image", "Photos"], ["file", "Files"], ["link", "Links"], ["voice", "Voice notes"], ["task", "Tasks"]].map(([k, l]) => <button key={k} type="button" className={v3.chip} aria-pressed={has === k} onClick={() => refine({ has: has === k ? "" : k })}>{l}</button>)}
                {[["today", "Today"], ["week", "7 days"], ["month", "30 days"]].map(([k, l]) => <button key={k} type="button" className={v3.chip} aria-pressed={when === k} onClick={() => refine({ when: when === k ? "" : k })}>{l}</button>)}
              </div>
              {query.trim() && channels.length ? <section className={css.found} aria-label="Chats found"><h2>Chats</h2>{channels.slice(0, 5).map(row)}</section> : null}
              {people.length ? <section className={css.found} aria-label="People"><h2>Start a chat</h2>{people.map((p) =>
                <button key={p.id} type="button" className={css.row} onClick={() => void direct(p)}><Avatar ai={p.agent} name={p.name} id={p.id} photoAt={p.photoAt} size={48} status />
                  <span className={css.rowMain}><span className={css.rowTop}><b>{p.name}</b></span></span></button>)}</section> : null}
              {query.trim().length > 1 ? <button type="button" className={css.searchAll} onClick={() => void searchMessages()}><Search size={15} aria-hidden="true" />Search messages for “{query.trim()}”</button> : null}
              <SearchHits hits={hits} data={data} words={query} onOpen={(m) => { setHits(null); go(`channel=${m.channelId}&message=${m.id}`); }} /></> : <>
              {win.before ? <div style={{ height: win.before }} aria-hidden="true" /> : null}
              {channels.slice(win.start, win.end).map(row)}
              {win.after ? <div style={{ height: win.after }} aria-hidden="true" /> : null}
              {!channels.length && !people.length ? <p className={css.empty}>{query ? `No chats match “${query}”.` : filter === "unread" ? "You’re all caught up." : filter === "people" ? "No direct messages yet. Start one with the pencil above." : filter === "archived" ? "No archived chats." : filter === "clients" ? "No chats with clients yet." : filter === "ai" ? "No chats with AI employees yet." : filter === "pods" ? "You’re not in a pod or department group yet." : "No conversations yet. Start one with the pencil above, or make a group from ⋮."}</p> : null}
              {people.length ? <section className={css.found} aria-label="People"><h2>Start a chat</h2>{people.map((p) =>
                <button key={p.id} type="button" className={css.row} onClick={() => void direct(p)}><Avatar ai={p.agent} name={p.name} id={p.id} photoAt={p.photoAt} size={48} status />
                  <span className={css.rowMain}><span className={css.rowTop}><b>{p.name}</b>{p.agent ? <AiBadge employeeId={p.employeeId} /> : null}</span><span className={css.rowBottom}><span className={css.preview}>{p.agent ? "AI co-worker · answers in seconds" : [p.team, p.pod].filter(Boolean).join(" · ") || "Team member"}</span></span></span></button>)}</section> : null}
              {query.trim().length > 1 ? <button type="button" className={css.searchAll} onClick={() => void searchMessages()}><Search size={15} aria-hidden="true" />Search messages for “{query.trim()}”</button>
                : !query && filter === "all" ? <button type="button" className={css.searchAll} onClick={() => refine({ has: "image" })}><Search size={15} aria-hidden="true" />Find photos, files and links</button> : null}
              {!query && filter === "all" && archivedCount ? <button type="button" className={v3.archivedRow} onClick={() => setFilter("archived")} data-archived-row=""><Archive size={17} aria-hidden="true" />Archived<small>{archivedUnread ? `${archivedUnread} unread` : archivedCount}</small></button> : null}
              {!query && filter === "all" ? <SharedElsewhere /> : null}
              {!query && filter === "all" ? <Channels data={data} source={source} /> : null}
            </>}
          </nav>
          <OfflineBanner />
          <footer className={css.sideFoot} data-float-avoid=""><span className={css.liveDot} data-live={live ?? undefined} /><span role="status">{live === null ? "Connecting…" : live ? "Live" : "Reconnecting…"}</span><span className={css.lock}><Lock size={12} aria-hidden="true" />Only members read a conversation</span></footer>
        </>}
    </aside>
    <section className={css.pane} aria-label="Conversation" onMouseDown={peek ? () => setPeek(false) : undefined}>
      {source === "telegram" || source === "whatsapp" ? <ChannelSetup kind={source} connections={data.connections} onBack={() => go("", false)} />
        : channel ? <Conversation key={channel.id} channel={channel} data={data} focus={focus} thread={threadParam} boot={boot} bar={chatSlot} onInfo={() => setInfo(true)} onPin={() => void pin(channel)} onBack={() => slim ? setPeek((v) => !v) : go("", false)} onChanged={refreshList} />
        : selected ? <div className={css.welcome}><p>This conversation isn’t in your list. You may have left it, or it belongs to a group you aren’t in.</p><button type="button" className={css.primary} onClick={() => go("", false)}>Back to your chats</button></div>
        : <Start bar={wide ? chatSlot : null} data={data} role={role} modulesOff={modulesOff} onChoose={choose} onDirect={(p, draft) => void direct(p, draft)} onNew={() => setPanel("new")} onGroup={() => setPanel("group")} />}
    </section>
    {info && channel ? <InfoPanel channel={channel} data={data} onClose={() => setInfo(false)} onChanged={refreshList} onMessage={(p) => void direct(p)} onLeft={() => { setInfo(false); go("", false); void refreshList(); }} onPin={() => void pin(channel)} /> : null}
    {status ? <StatusDialog onClose={() => setStatus(false)} /> : null}
    {rowMenu ? <RowMenu at={rowMenu} onClose={closeRowMenu} onPin={(c) => void pin(c)} onChanged={refreshList} onError={setError} /> : null}
    {jump ? <JumpDialog data={data} onClose={() => setJump(false)} onPick={(id) => choose(id)} onPerson={(p) => void direct(p)} /> : null}
    {keys ? <ShortcutsDialog onClose={() => setKeys(false)} /> : null}
    {moderation ? <Moderation channels={moderated} onClose={() => setModeration(false)} onOpen={(id) => { setModeration(false); choose(id); }} /> : null}
    {boot ? null : <ContextPanel viewer={data.viewer} role={role} modulesOff={modulesOff} />}
  </div></IntentProvider>;
}

function Channels({ data, source }: { data: ChatData; source: string | null }) {
  const c = data.connections;
  const items: [string, ReactNode, string, string, string][] = [
    ["email", <Mail key="m" size={20} />, "Email", c?.email.connected ? "Your Gmail, read-only" : "Needs your own Workspace sign-in", "/chats?source=email"],
    ["telegram", <Send key="t" size={20} />, "Telegram", c?.telegram.connected ? "Connected" : "Not set up yet", "/chats?source=telegram"],
    ["whatsapp", <Smartphone key="w" size={20} />, "WhatsApp Business", c?.whatsapp.connected ? "Connected" : "Pending approval", "/chats?source=whatsapp"],
  ];
  return <section className={css.channels} aria-label="Other channels"><h2>Channels</h2>{items.map(([k, icon, name, state, href]) =>
    <Link key={k} href={href} className={css.row} data-channel={k} aria-current={source === k ? "true" : undefined} scroll={false}>
      <span className={css.channelIcon} data-channel={k} aria-hidden="true">{icon}</span>
      <span className={css.rowMain}><span className={css.rowTop}><b>{name}</b></span><span className={css.rowBottom}><span className={css.preview}>{state}</span></span></span>
      <ChevronRight size={16} aria-hidden="true" className={css.chev} />
    </Link>)}</section>;
}

const FILTERS: [string, string][] = [["all", "All"], ["unread", "Unread"], ["threads", "Threads"], ["pods", "Pods"], ["clients", "Clients"], ["groups", "Groups"], ["people", "People"], ["ai", "AI"]];
/** CHAT-V3: the words searched for, marked in a found message. */
function Marked({ text, words }: { text: string; words: string }) {
  const w = words.trim(); if (!w) return <>{text}</>;
  const parts = text.split(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return <>{parts.map((p, i) => i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>)}</>;
}
function SearchHits({ hits, data, onOpen, words = "" }: { hits: ChatMessage[]; data: ChatData; onOpen: (m: ChatMessage) => void; words?: string }) {
  return <section className={css.found} aria-label="Messages"><h2>{hits.length ? `${hits.length} message${hits.length === 1 ? "" : "s"}` : "No messages match"}</h2>
    {hits.map((m) => { const c = data.channels.find((x) => x.id === m.channelId); return <button key={m.id} type="button" className={css.row} onClick={() => onOpen(m)}>
      {c ? <GroupAvatar channel={c} size={40} /> : <Avatar name={m.name} size={40} />}
      <span className={css.rowMain}><span className={css.rowTop}><b>{c?.name ?? "Conversation"}</b><time>{listTime(m.createdAt)}</time></span><span className={`${css.rowBottom} ${v3.hit}`}><span className={css.preview}>{m.authorId === data.viewer ? "You" : m.name.split(" ")[0]}: <Marked text={m.body || m.attachments.map((a) => `📎 ${a.name}`).join(", ")} words={words} /></span></span></span>
    </button>; })}</section>;
}

function Moderation({ channels, onClose, onOpen }: { channels: Channel[]; onClose: () => void; onOpen: (id: string) => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className={css.dialog} role="dialog" aria-modal="true" aria-label="Moderate other groups">
    <header><h2>Moderate other groups</h2><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button></header>
    <p className={css.hint}>As an admin you can open pods, departments and Google groups you are not in, to remove a message. These stay out of your chat list. Direct messages are never open to moderation.</p>
    <div className={css.dialogList}>{channels.map((c) => <button key={c.id} type="button" className={css.row} onClick={() => onOpen(c.id)}><GroupAvatar channel={c} size={36} />
      <span className={css.rowMain}><span className={css.rowTop}><b>{c.name}</b><em data-kind={c.kind}>{kindLabel(c.kind)}</em></span><span className={css.rowBottom}><span className={css.preview}>{c.members} members</span></span></span></button>)}</div>
  </div></div>;
}

/** The first-ever visit only (nothing cached yet): the shape of the list, briefly; `stuck`, Pulse can't be reached. */
// E2E-4P (owner check): the same frame as the loaded app (chat mode, its header in the top bar from 900 px), so nothing
// moves when the list arrives; no placeholder avatar; once stuck, a calm line and no endless rows.
export function Skeleton({ stuck = false, retrying = false, onRetry }: { stuck?: boolean; retrying?: boolean; onRetry?: () => void }) {
  const wide = useSyncExternalStore(onWide, () => window.matchMedia(WIDE).matches, () => true);
  const bar = useSyncExternalStore(never, () => document.querySelector<HTMLElement>("[data-shell-toolbar]"), () => null);
  useEffect(() => {
    const root = document.documentElement; if (root.dataset.mode === "chat") return;
    root.dataset.mode = "chat"; root.dataset.chatView = "list";
    return () => { delete root.dataset.mode; delete root.dataset.chatView; };
  }, []);
  const head = <header className={css.sideHead}><h2>Chats</h2></header>;
  return <div className={css.app} data-grow="" data-view="list" aria-busy={!stuck}>
    {bar ? createPortal(<div className={css.chatBar} data-chat-bar="">{wide ? <div className={css.chatBarList}>{head}</div> : null}<div className={css.chatBarChat} /></div>, bar) : null}
    <aside className={css.side}>{wide && bar ? null : <div className={css.sideHeadInline}>{head}</div>}
      <div className={css.search}><Search size={16} aria-hidden="true" /><span className={css.skLine} style={{ width: "60%" }} /></div>
      {stuck ? <p className={css.sideQuiet} role="status">Reconnecting… your chats show here as soon as Pulse answers.<button type="button" onClick={onRetry} disabled={retrying}>{retrying ? "Trying…" : "Try now"}</button></p> : null}
      {stuck ? null : <div className={css.rows} role="status"><span className={css.srOnly}>{stuck ? "Chats are not loaded" : "Loading your chats"}</span>{Array.from({ length: 7 }, (_, i) => <div key={i} className={css.skRow}><span className={css.skAvatar} /><span><span className={css.skLine} style={{ width: `${45 + (i * 13) % 35}%` }} /><span className={css.skLine} style={{ width: `${60 + (i * 7) % 30}%` }} /></span></div>)}</div>}
    </aside>
    <section className={css.pane}><div className={css.welcome} /></section>
  </div>;
}
