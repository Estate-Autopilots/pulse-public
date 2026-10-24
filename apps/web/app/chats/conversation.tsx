"use client";
// One conversation, WhatsApp style: mine on the right, theirs on the left, a chip over each day, ticks on what I sent,
// a reply quotes the message it answers, reactions under the bubble, actions on hover (desktop) or a long press
// (phone). Messages draw from the cache at once and sync behind; a send shows immediately and settles when stored.
import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject, type TouchEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Archive, ArrowDown, ArrowLeft, Bell, BellOff, Check, CheckCheck, CheckCircle2, ChevronDown, CircleAlert, Clock3, Copy, File as FileIcon, Forward, History, Image as ImageIcon, Images, Info, Link2, ListChecks, MessageSquareText, Paperclip, Pencil, Phone, Pin, PinOff, Reply, Search, SendHorizontal, Smile, Star, StarOff, Trash2, Video, X } from "lucide-react";
import { openCreate } from "../create";
import { Avatar } from "../ui";
import { AiBadge } from "../kit/ai-badge";
import { PresenceLine } from "../presence";
import { clock, dayChip, fullTime, kindLabel, linkDomain, sameDay, segments, ticks } from "../lib/chat-format.mjs";
import { cachedList, cachedThread, saveList, storeVersion, subscribe, updateThread, saveThread } from "./store";
import { GroupAvatar, go, syncThread } from "./parts";
import { get, readBase64, send } from "./net";
import { TaskCard, useTaskCards } from "./task-card";
import { chatCommands, findChatCommand, type ChatCommand, type WorkKind } from "./commands";
import { WorkList, type WorkData, type WorkResult } from "./work-list";
import { taskIntent, type TaskIntent } from "../lib/task-intent.mjs";
import { zoneDay } from "../lib/zone.mjs";
import { useOrgZone } from "../org-code";
import { dueLabel } from "./task-card";
import wk from "./work.module.css";
import { ImportedHistory } from "./history";
import { VoiceNote, VoiceRecorder, isVoice, useVoiceState } from "./voice";
import { CallLine, callOf } from "../calls/call-line";
import { startCall } from "../calls/call-host";
import type { Attachment, Channel, ChatData, ChatMessage, Member } from "./types";
import { PanelToggle, droppedRef } from "./workspace/panel";
import { IntentChips, useAutoOpen, useTypedIntent } from "./workspace/intent";
import "./workspace/commands";
import { openInPanel } from "./workspace/tabs";
import ws from "./workspace/workspace.module.css";
import { draftStore } from "./drafts";
import css from "./chats.module.css";
import own from "./history.module.css";
// CHAT-V3: typing, the outbox, threads, the picture viewer, approvals, seen by, pinned messages, forwarding, the gallery.
import { iAmTyping, stoppedTyping, typingLine, useTypers } from "./live";
import { deliver as deliverOut, startOutbox } from "./outbox";
import { ApprovalCard, ForwardDialog, Gallery, MessageInfo, PinnedBar, SeenBy, TypingBubble, mutedNow, useNotice } from "./v3";
import { Lightbox, ThreadPane } from "./thread";
import v3 from "./v3.module.css";

const never = () => () => {};
/** FEATURES-1024: chat files that open beside the chat (the API serves them inline); anything else downloads. */
const PANEL_DOCS = /^(application\/pdf|text\/plain)$/;
const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const MORE_REACTIONS = ["🎉", "✅", "👀", "🔥", "🙂"];
const EMOJI = ["😀", "😂", "🙂", "😊", "😍", "🤩", "😎", "🤔", "😅", "😮", "😢", "😡", "🙏", "👍", "👎", "👏", "🙌", "💪", "🤝", "👀", "🎉", "🔥", "✅", "❌", "⭐", "❤️", "💯", "📌", "📅", "⏰", "🎬", "📷", "🎥", "🏠", "🏢", "🚗", "☕", "🍕", "🎂", "🌴"];
const RUN_MS = 5 * 60000;
// CHAT-SHELL v2: drafts survive leaving the page and reloading (drafts.ts).
const drafts = draftStore;
/** CHAT-SHELL v2: the command menu in groups, the work first. */
const GROUPS: [string, RegExp][] = [["Work", /^(task|tasks|projects|steps)$/], ["Open beside the chat", /^(open|profile)$/], ["Call", /^(call|video)$/]];
const cmdGroup = (name: string) => GROUPS.find(([, re]) => re.test(name))?.[0] ?? "More";
const byGroup = <T extends { name: string }>(list: T[]) => [...list].sort((a, b) => { const g = (n: string) => { const i = GROUPS.findIndex(([, re]) => re.test(n)); return i < 0 ? 9 : i; }; return g(a.name) - g(b.name); });
/** CHAT-SHELL: what the message box of a conversation starts with (the chat home's "@ravi can you…"). */
export function setDraft(channelId: string, text: string) { drafts.set(channelId, text); }
/** The message box's way in for files and links dropped anywhere on the conversation. */
type ComposerApi = { files: (list: File[]) => void; link: (ref: { name: string; url: string }) => void };
const first = (name: string) => name.replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const isImage = (a: Attachment) => !!a.id && /^image\/(png|jpe?g|gif|webp)$/.test(a.mime ?? "");
const coarse = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

/** `bar`: LAYOUT-SWEEP chat mode puts this header into Pulse's top bar (the conversation's identity, search in it, its
 *  details); without one it heads the pane as before. */
type Props = { channel: Channel; data: ChatData; focus: string | null; boot: boolean; onInfo: () => void; onPin: () => void; onBack: () => void; onChanged: () => Promise<void> | void; bar?: HTMLElement | null;
  /** CHAT-V3: a thread to open (a notification about a reply links to it). */ thread?: string | null };
export function Conversation({ channel, data, focus, boot, onInfo, onPin, onBack, onChanged, bar, thread: threadParam = null }: Props) {
  useSyncExternalStore(subscribe, storeVersion, () => 0);
  // The cache is this browser's: read it only after hydration, so the first client render matches the server's.
  const ready = useSyncExternalStore(never, () => true, () => false);
  const thread = ready ? cachedThread(channel.id) : null;
  const messages = useMemo(() => thread?.messages ?? [], [thread]);
  const members = thread?.members?.length ? thread.members : data.people.filter((p) => p.id === data.viewer || p.id === channel.peerId);
  const [loading, setLoading] = useState(!thread), [error, setError] = useState(""), [shown, setShown] = useState(40);
  const [reply, setReply] = useState<ChatMessage | null>(null), [editing, setEditing] = useState<ChatMessage | null>(null), [sheet, setSheet] = useState<ChatMessage | null>(null);
  const [confirm, setConfirm] = useState<ChatMessage | null>(null), [flash, setFlash] = useState<string | null>(null), [below, setBelow] = useState(false), [menu, setMenu] = useState(false), [history, setHistory] = useState(false);
  const list = useRef<HTMLDivElement>(null), nearBottom = useRef(true), posted = useRef(""), olderBusy = useRef(false);
  // Search inside this conversation: the chat search, kept to this channel.
  const [searching, setSearching] = useState(false), [find, setFind] = useState(""), [searchHits, setSearchHits] = useState<ChatMessage[] | null>(null);
  async function findHere() { if (!find.trim()) return; try { setSearchHits((await get<{ messages: ChatMessage[] }>(`chats/search?q=${encodeURIComponent(find.trim())}`)).messages); } catch (e) { setError((e as Error).message); } }
  const [unreadAtOpen] = useState(channel.unread);
  const me = data.people.find((p) => p.id === data.viewer);
  const policy = data.policy ?? { editMinutes: 15, removeHours: 48 };
  const viewer = data.viewer, group = channel.kind !== "direct";
  // CHAT-V3 (speed): the same list until a name changes (members arrive as a new array on every sync).
  const userKey = members.map((m) => m.username ?? "").join(",");
  const usernames = useMemo(() => userKey.split(","), [userKey]);
  const taskIds = useMemo(() => [...new Set(messages.flatMap((m) => m.attachments.filter((a) => a.task).map((a) => a.task!)))], [messages]);
  // CHAT-V3: task cards follow the conversation's live changes (a status changed elsewhere shows on the next sync).
  const cards = useTaskCards(taskIds, thread?.at ?? 0);
  const voice = useVoiceState(channel.id, messages, thread?.at ?? 0);
  // CHAT-V3: a thread beside the conversation, the picture viewer, forwarding, message info, the gallery, a notice line.
  const [threadOf, setThreadOf] = useState<string | null>(threadParam), [lightbox, setLightbox] = useState<{ m: string; f?: string } | null>(null);
  useEffect(() => { if (threadParam) queueMicrotask(() => setThreadOf(threadParam)); }, [threadParam]);
  const [forward, setForward] = useState<ChatMessage | null>(null), [infoOf, setInfoOf] = useState<ChatMessage | null>(null), [gallery, setGallery] = useState(false);
  const [notice, notify] = useNotice();
  const typers = useTypers(channel.id);
  useEffect(() => { startOutbox(); }, []);
  // Someone whose message just arrived has stopped typing it.
  const lastAuthor = messages.at(-1)?.authorId;
  useEffect(() => { if (lastAuthor && lastAuthor !== data.viewer) stoppedTyping(channel.id, lastAuthor); }, [lastAuthor, channel.id, data.viewer]);
  // CHAT-WORK: /tasks, /projects and /steps answer the asker alone, under the latest message, until closed.
  const [work, setWork] = useState<WorkResult[]>([]);
  useEffect(() => { queueMicrotask(() => setWork([])); }, [channel.id]);
  useEffect(() => { const el = list.current; if (el && work.length) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })); }, [work]);
  function showWork(kind: WorkKind) {
    const key = crypto.randomUUID(); nearBottom.current = true;
    setWork((w) => [...w.filter((x) => x.kind !== kind), { key, kind }]);
    get<WorkData>(`chats/${channel.id}/work?kind=${kind}`).then((data) => setWork((w) => w.map((x) => x.key === key ? { ...x, data } : x)))
      .catch((e) => setWork((w) => w.map((x) => x.key === key ? { ...x, error: (e as Error).message } : x)));
  }
  // CHAT-SHELL: a message that clearly means a place in Pulse opens it beside the chat (once); files and links dropped
  // anywhere on the conversation (from the desktop, the side panel or Drive) go into the message box.
  useAutoOpen(messages, channel, viewer, me?.username ?? null, unreadAtOpen);
  // CHAT-SHELL v2: what the person sends is read too ("open my steps" opens it beside the chat).
  const typed = useTypedIntent(channel.id);
  const composer = useRef<ComposerApi | null>(null);
  const [dropping, setDropping] = useState(false), dragDepth = useRef(0);
  const carries = (dt: DataTransfer) => dt.types.includes("Files") || dt.types.includes("text/uri-list") || dt.types.includes("application/x-pulse-ref");

  // E2E-4P (owner check, 23 Oct): the thread hung on a centred spinner while the server was loaded. Cached messages show
  // at once; the fresh page is fetched with a 15 s limit and retried quietly (2, 4, 8, 15 s...); after 4 s with nothing
  // to show the spinner becomes a calm "Still opening..." line with Try now, and a cached thread only says "Reconnecting...".
  const [slow, setSlow] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (boot) return;
    let live = true, tries = 0, timer = 0, done = false;
    const slowTimer = window.setTimeout(() => { if (live && !done) setSlow(true); }, 4000);
    const run = () => syncThread(channel.id).then(() => { done = true; if (live) { setError(""); setLoading(false); setSlow(false); } })
      .catch(() => { if (!live) return; tries++; setSlow(true); timer = window.setTimeout(run, Math.min(15000, 1000 * 2 ** tries)); });
    void run();
    return () => { live = false; window.clearTimeout(timer); window.clearTimeout(slowTimer); };
  }, [boot, channel.id, attempt]);

  // Read: everything on screen up to the newest stored message, once per new arrival, only while the tab is visible.
  useEffect(() => {
    if (boot || !messages.length || channel.moderationOnly) return;
    const last = [...messages].reverse().find((m) => !m.pending && !m.failed);
    if (!last || last.createdAt <= posted.current || document.visibilityState !== "visible") return;
    posted.current = last.createdAt;
    if (last.authorId === viewer && !channel.unread) return;
    void send(`chats/${channel.id}/read`, { through: last.createdAt }).then(() => {
      const l = cachedList(); if (l) saveList({ ...l, channels: l.channels.map((c) => c.id === channel.id ? { ...c, unread: 0, mentions: 0 } : c) });
    }).catch(() => { posted.current = ""; });
  }, [boot, messages, channel.id, channel.unread, channel.moderationOnly, viewer]);

  // Stay at the bottom while reading the latest; open at the message a link points to.
  // CHAT-V3: opening a chat with several unread messages starts at the first of them (the unread line), not the bottom;
  // while reading above, new messages from others are counted on the way-down button.
  const jumped = useRef(false), seenCount = useRef(messages.length), [fresh, setFresh] = useState(0);
  useEffect(() => {
    const added = messages.slice(seenCount.current).filter((m) => m.authorId !== viewer && !m.pending).length; seenCount.current = messages.length;
    if (added && !nearBottom.current && jumped.current) queueMicrotask(() => setFresh((f) => f + added));
  }, [messages, viewer]);
  useEffect(() => {
    const el = list.current; if (!el) return;
    if (!jumped.current && !focus && unreadAtOpen >= 4 && messages.length) {
      const line = el.querySelector<HTMLElement>("[data-unread-line]");
      if (line) { jumped.current = true; line.scrollIntoView({ block: "start" }); el.scrollTop -= 8; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; queueMicrotask(() => setBelow(!nearBottom.current)); return; }
    }
    if (messages.length) jumped.current = true;
    if (focus && messages.some((m) => m.id === focus)) {
      const target = el.querySelector(`#m-${CSS.escape(focus)}`);
      if (target) { target.scrollIntoView({ block: "center" }); queueMicrotask(() => setFlash(focus)); return; }
    }
    // Bubbles off screen are laid out lazily (content-visibility), so settle at the bottom once more after layout.
    if (nearBottom.current) { el.scrollTop = el.scrollHeight; requestAnimationFrame(() => { if (nearBottom.current) el.scrollTop = el.scrollHeight; }); }
  }, [messages, focus, unreadAtOpen]);
  // QA-E2E: a new bubble is laid out lazily (its 52 px content-visibility placeholder grows once it is on screen) after
  // the list has pinned to the bottom, so on a phone the newest message stayed half under the composer. Keep the list
  // pinned while the newest message settles (also when its image loads).
  useEffect(() => {
    const el = list.current, last = el?.lastElementChild;
    if (!el || !last || typeof ResizeObserver === "undefined") return;
    const settle = new ResizeObserver(() => { if (nearBottom.current) el.scrollTop = el.scrollHeight; });
    settle.observe(last);
    return () => settle.disconnect();
  }, [messages]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 2200); return () => clearTimeout(t); }, [flash]);
  // RELEASE-5: a conversation opens already settled. Its bubbles are laid out lazily and the list pins to the bottom over
  // the next frames, which moved what was on screen (0.12 of a phone's screen in UX-5A's layout-shift gate); the list
  // stays invisible for those frames (its spinner shows before), then appears in place.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (settled || !messages.length) return;
    const t = setTimeout(() => setSettled(true), 160);
    return () => clearTimeout(t);
  }, [settled, messages.length]);

  const start = Math.max(0, messages.length - shown);
  const visible = messages.slice(start);
  async function older() {
    const el = list.current; if (!el || olderBusy.current) return;
    if (start > 0) { const h = el.scrollHeight; setShown((s) => s + 60); requestAnimationFrame(() => { el.scrollTop += el.scrollHeight - h; }); return; }
    const oldest = messages.find((m) => !m.pending); if (!thread?.hasMore || !oldest) return;
    olderBusy.current = true; const h = el.scrollHeight;
    try {
      const d = await get<{ messages: ChatMessage[]; hasMore: boolean }>(`chats/${channel.id}/messages?before=${encodeURIComponent(oldest.createdAt)}`);
      const t = cachedThread(channel.id); if (t) saveThread(channel.id, { ...t, messages: [...d.messages.filter((m) => !t.messages.some((x) => x.id === m.id)), ...t.messages], hasMore: d.hasMore });
      setShown((s) => s + d.messages.length); requestAnimationFrame(() => { el.scrollTop += el.scrollHeight - h; });
    } catch (e) { setError((e as Error).message); } finally { olderBusy.current = false; }
  }
  function onScroll() {
    const el = list.current; if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setBelow(!nearBottom.current); if (nearBottom.current && fresh) setFresh(0);
    if (el.scrollTop < 200) void older();
  }
  const toBottom = () => { const el = list.current; if (el) { el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); nearBottom.current = true; setFresh(0); } };

  // CHAT-V3 (offline): delivered by the outbox; without a connection it waits and goes by itself when it is back.
  const deliver = useCallback(async (m: ChatMessage): Promise<string | null> => { const id = await deliverOut(channel.id, m); if (id) void onChanged(); return id; }, [channel.id, onChanged]);
  function sendMessage(text: string, attachments: Attachment[], quote: ChatMessage | null) {
    if (text.trim()) typed(text);
    const clientId = crypto.randomUUID();
    const temp: ChatMessage = { id: `local-${clientId}`, clientId, channelId: channel.id, authorId: viewer, name: me?.name ?? "You", username: me?.username ?? null, photoAt: me?.photoAt, body: text.trim(), parentId: null,
      quoteId: quote?.id ?? null, quote: quote ? { id: quote.id, authorId: quote.authorId, name: quote.name, body: quote.body.slice(0, 240), removed: false, attachments: quote.attachments.length } : null, kind: "text",
      createdAt: new Date().toISOString(), editedAt: null, removed: false, replies: 0, attachments, mentions: [], reactions: [], pending: true };
    nearBottom.current = true; updateThread(channel.id, (ms) => [...ms, temp]); iAmTyping(channel.id, false);
    return deliver(temp);
  }
  // J2: "@rila draft positioning for Skyline by Thu" sent as a task: the message goes at once, then its task (Rila,
  // due Thursday, the project named) with its card under it; Rila takes it, declines or asks on the card.
  async function sendAsTask(text: string, offer: TaskIntent<Member>, quote: ChatMessage | null) {
    const mid = await sendMessage(text, [], quote);
    if (!mid) return;
    try {
      await send("work/tasks", { title: offer.title, assigneeId: offer.assignee.id, dueOn: offer.dueOn, projectId: offer.project?.id ?? null, chatChannelId: channel.id, chatMessageId: mid, chatFollow: true });
      void syncThread(channel.id);
    } catch (e) { setError(`The message went, but its task did not: ${(e as Error).message}`); }
  }
  function retry(m: ChatMessage) { updateThread(channel.id, (ms) => ms.map((x) => x.clientId === m.clientId ? { ...x, failed: undefined, pending: true } : x)); void deliver({ ...m, failed: undefined, pending: true }); }
  function discard(m: ChatMessage) { updateThread(channel.id, (ms) => ms.filter((x) => x.clientId !== m.clientId)); }
  async function react(m: ChatMessage, emoji: string) {
    updateThread(channel.id, (ms) => ms.map((x) => { if (x.id !== m.id) return x; const r = x.reactions.find((y) => y.emoji === emoji);
      const reactions = r ? (r.mine ? x.reactions.map((y) => y.emoji === emoji ? { ...y, count: y.count - 1, mine: false } : y).filter((y) => y.count > 0) : x.reactions.map((y) => y.emoji === emoji ? { ...y, count: y.count + 1, mine: true } : y)) : [...x.reactions, { emoji, count: 1, mine: true }];
      return { ...x, reactions }; }));
    try { await send(`chats/messages/${m.id}/react`, { emoji }); } catch (e) { setError((e as Error).message); void syncThread(channel.id); }
  }
  async function saveEdit(m: ChatMessage, body: string) {
    updateThread(channel.id, (ms) => ms.map((x) => x.id === m.id ? { ...x, body: body.trim(), editedAt: new Date().toISOString() } : x)); setEditing(null);
    try { await send(`chats/messages/${m.id}/edit`, { body }); } catch (e) { setError((e as Error).message); void syncThread(channel.id); }
  }
  async function remove(m: ChatMessage) {
    setConfirm(null);
    updateThread(channel.id, (ms) => ms.map((x) => x.id === m.id ? { ...x, removed: true, body: "", attachments: [] } : x));
    try { await send(`chats/messages/${m.id}/remove`, { reason: "Deleted in Chats" }); void onChanged(); } catch (e) { setError((e as Error).message); void syncThread(channel.id); }
  }
  function makeTask(m: ChatMessage | null, title = "") {
    const who = m && m.authorId !== viewer ? m.authorId : channel.peerId ?? undefined;
    const text = m ? m.body || m.attachments.map((a) => a.name).join(", ") : "";
    openCreate({ kind: "task", title: (title || text.split("\n")[0]).slice(0, 120), assigneeId: who, chat: { channelId: channel.id, messageId: m?.id },
      source: m ? { label: `From ${m.authorId === viewer ? "you" : first(m.name)} in ${channel.kind === "direct" ? "your chat" : channel.name}`, quote: text.slice(0, 300) } : { label: channel.kind === "direct" ? `In your chat with ${first(channel.name)}` : `In ${channel.name}` } });
  }
  const canEdit = (m: ChatMessage) => m.authorId === viewer && m.kind !== "event" && !m.removed && !m.pending && Date.now() - Date.parse(m.createdAt) < policy.editMinutes * 60000;
  const canRemove = (m: ChatMessage) => !m.removed && !m.pending && m.kind !== "event" && (m.authorId === viewer && Date.now() - Date.parse(m.createdAt) < policy.removeHours * 3600000 || data.canModerate && channel.kind !== "direct");
  const member = !channel.moderationOnly;
  async function pinMessage(m: ChatMessage, on: boolean) { try { await send(`chats/messages/${m.id}/pin`, { on }); await syncThread(channel.id); notify(on ? "Pinned for everyone in this chat" : "Unpinned"); } catch (e) { setError((e as Error).message); } }
  async function star(m: ChatMessage) {
    const on = !m.starred; updateThread(channel.id, (ms) => ms.map((x) => x.id === m.id ? { ...x, starred: on } : x));
    try { await send(`chats/messages/${m.id}/star`, { on }); notify(on ? "Saved. Find it under Saved messages" : "Removed from saved"); } catch (e) { setError((e as Error).message); void syncThread(channel.id); }
  }
  async function askApproval(m: ChatMessage) { try { await send(`chats/messages/${m.id}/approval`, { action: "ask" }); await syncThread(channel.id); } catch (e) { setError((e as Error).message); } }
  const copyLink = (m: ChatMessage) => { void navigator.clipboard?.writeText(`${window.location.origin}/chats?channel=${channel.id}&message=${m.id}`).then(() => notify("Link copied"), () => notify("Could not copy the link")); };
  const actions = (m: ChatMessage): Action[] => [
    { key: "reply", label: "Reply", icon: <Reply size={16} />, run: () => setReply(m) },
    ...(member && !m.parentId ? [{ key: "thread", label: m.replies ? "Open the thread" : "Reply in a thread", icon: <MessageSquareText size={16} />, run: () => setThreadOf(m.id) }] : []),
    { key: "task", label: "Make a task", icon: <ListChecks size={16} />, run: () => makeTask(m) },
    ...(member && m.attachments.some((a) => a.id || a.url) && !m.approval ? [{ key: "approval", label: "Ask for approval", icon: <CheckCircle2 size={16} />, run: () => void askApproval(m) }] : []),
    { key: "forward", label: "Forward", icon: <Forward size={16} />, run: () => setForward(m) },
    ...(member ? [{ key: "pin", label: m.pinnedAt ? "Unpin" : "Pin for everyone", icon: m.pinnedAt ? <PinOff size={16} /> : <Pin size={16} />, run: () => void pinMessage(m, !m.pinnedAt) }] : []),
    { key: "star", label: m.starred ? "Remove from saved" : "Save for later", icon: m.starred ? <StarOff size={16} /> : <Star size={16} />, run: () => void star(m) },
    ...(m.body ? [{ key: "copy", label: "Copy text", icon: <Copy size={16} />, run: () => void navigator.clipboard?.writeText(m.body) }] : []),
    { key: "link", label: "Copy link", icon: <Link2 size={16} />, run: () => copyLink(m) },
    ...(m.authorId === viewer && (thread?.readers?.length ?? 0) > 0 ? [{ key: "info", label: "Message info", icon: <Info size={16} />, run: () => setInfoOf(m) }] : []),
    ...(canEdit(m) ? [{ key: "edit", label: "Edit", icon: <Pencil size={16} />, run: () => { setReply(null); setEditing(m); } }] : []),
    ...(canRemove(m) ? [{ key: "delete", label: m.authorId === viewer ? "Delete for everyone" : "Remove (moderation)", icon: <Trash2 size={16} />, run: () => setConfirm(m), danger: true }] : []),
  ];

  // CHAT-V3 (speed): bubbles are drawn again only when their own message changes; what they do goes through one handle
  // that always reaches the newest state.
  const [api] = useState<BubbleApi>(() => ({ actions, react, sheet: setSheet, retry, discard, reply: setReply, thread: setThreadOf, image: (m: ChatMessage, f: string) => setLightbox({ m: m.id, f }), voice, error: setError,
    quote: (id: string) => { const el = document.querySelector(`[role="log"] #m-${CSS.escape(id)}`); if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); setFlash(id); } else go(`channel=${channel.id}&message=${id}`); } }));
  useEffect(() => { Object.assign(api, { actions, react, retry, discard, voice }); });
  // "Seen by" goes under my latest message among the last few.
  const lastMine = useMemo(() => { for (let i = messages.length - 1; i >= Math.max(0, messages.length - 6); i--) { const m = messages[i]; if (m.authorId === viewer && m.kind !== "event" && !m.pending && !m.failed && !m.removed) return m.id; } return null; }, [messages, viewer]);
  const typing = typingLine(typers, channel.kind === "direct");
  // CHAT-V3: an AI employee answering shows like someone typing (from its question's live state).
  const thinking = useMemo(() => [...new Set(messages.slice(-20).filter((m) => m.agentAsk && ["queued", "leased", "dispatching"].includes(m.agentAsk.state) && m.agentAsk.reason !== "paused" && m.agentAsk.runtimeState !== "out_of_quota").map((m) => m.agentAsk!.agent.split(" ")[0]))], [messages]);
  const muted = mutedNow(channel.mutedUntil);
  async function mute(until: string | null) { try { await send(`chats/${channel.id}/mute`, { until }); await onChanged(); notify(until ? "Muted: no bell or push, except mentions and replies to you" : "Unmuted"); } catch (e) { setError((e as Error).message); } }
  async function archive() { try { await send(`chats/${channel.id}/archive`, { on: !channel.archivedAt }); await onChanged(); if (!channel.archivedAt) onBack(); } catch (e) { setError((e as Error).message); } }

  // The unread line sits above the first message that arrived while away.
  const unreadFrom = useMemo(() => {
    let n = unreadAtOpen; if (!n) return null;
    for (let i = messages.length - 1; i >= 0; i--) { const m = messages[i]; if (m.authorId !== viewer && m.kind !== "event" && --n === 0) return m.id; }
    return null;
  }, [messages, viewer, unreadAtOpen]);
  const label = kindLabel(channel.kind);
  const hits = searchHits?.filter((m) => m.channelId === channel.id) ?? null;
  const head = <header className={css.head} data-searching={searching ? "" : undefined}>
      <button type="button" className={`${css.iconBtn} ${css.back}`} onClick={onBack} aria-label="Back to chats"><ArrowLeft size={20} aria-hidden="true" /></button>
      <button type="button" className={css.who} onClick={onInfo} aria-label={`${channel.name}: details and members`}>
        <GroupAvatar channel={channel} size={bar ? 32 : 40} />
        <span><b>{channel.name}{channel.peerAgent ? <AiBadge employeeId={members.find((p) => p.id === channel.peerId)?.employeeId} /> : null}{muted ? <BellOff size={13} aria-label="Muted" className={v3.muted} style={{ marginLeft: 6, verticalAlign: "-1px" }} /> : null}</b>{typing ? <small className={v3.typingHead} role="status">{typing}</small> : channel.kind === "direct" && channel.peerFormer ? <small>Former member · no longer with the company</small> : channel.kind === "direct" && channel.peerAgent ? <small>AI co-worker · answers in seconds; real work becomes a task</small> : channel.kind === "direct" && channel.peerId ? <PresenceLine id={channel.peerId} className={css.headLine} /> : <small>{[label, `${channel.members} member${channel.members === 1 ? "" : "s"}`, channel.moderationOnly ? "moderator view" : ""].filter(Boolean).join(" · ")}</small>}</span>
      </button>
      {/* CHAT-VOICE: call from the chat (a person, or a group of up to 8). */}
      {!channel.moderationOnly && !channel.peerFormer && !channel.peerAgent && channel.members <= 8 && (channel.kind !== "direct" || channel.peerId) ? <>
        <button type="button" className={css.iconBtn} data-chat-call="voice" onClick={() => startCall(channel.id, false)} aria-label={channel.kind === "direct" ? `Call ${first(channel.name)}` : "Start a group call"} title="Voice call"><Phone size={18} aria-hidden="true" /></button>
        <button type="button" className={css.iconBtn} data-chat-call="video" onClick={() => startCall(channel.id, true)} aria-label={channel.kind === "direct" ? `Video call ${first(channel.name)}` : "Start a group video call"} title="Video call"><Video size={19} aria-hidden="true" /></button>
      </> : null}
      <button type="button" className={css.iconBtn} data-chat-search="" onClick={() => setSearching(!searching)} aria-label={searching ? "Close search" : "Search this chat"} aria-expanded={searching} title="Search this chat"><Search size={18} aria-hidden="true" /></button>
      <PanelToggle className={`${css.iconBtn} ${css.panelToggle}`} />
      <span className={css.menuWrap}>
        <button type="button" className={css.iconBtn} onClick={() => setMenu(!menu)} aria-label="Conversation options" aria-expanded={menu}><ChevronDown size={19} aria-hidden="true" /></button>
        {menu ? <span className={css.menu} role="menu" onClick={() => setMenu(false)}>
          {/* POLISH-1: on a narrow phone, search moves into this menu so the name keeps its room. */}
          <button type="button" role="menuitem" data-chat-search-item="" onClick={() => setSearching(true)}><Search size={16} aria-hidden="true" />Search this chat</button>
          <button type="button" role="menuitem" onClick={onInfo}><Info size={16} aria-hidden="true" />{channel.kind === "direct" ? "Contact info" : "Group info"}</button>
          {!channel.moderationOnly ? <button type="button" role="menuitem" onClick={onPin}>{channel.pinnedAt ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}{channel.pinnedAt ? "Unpin chat" : "Pin chat"}</button> : null}
          {!channel.moderationOnly ? <button type="button" role="menuitem" onClick={() => makeTask(null)}><ListChecks size={16} aria-hidden="true" />Make a task here</button> : null}
          <button type="button" role="menuitem" onClick={() => setGallery(true)}><Images size={16} aria-hidden="true" />Media, files and links</button>
          {!channel.moderationOnly ? (muted ? <button type="button" role="menuitem" onClick={() => void mute(null)}><Bell size={16} aria-hidden="true" />Unmute</button> : <>
            <button type="button" role="menuitem" onClick={() => void mute(new Date(Date.now() + 8 * 3600000).toISOString())}><BellOff size={16} aria-hidden="true" />Mute for 8 hours</button>
            <button type="button" role="menuitem" onClick={() => void mute(new Date(Date.now() + 7 * 86400000).toISOString())}><BellOff size={16} aria-hidden="true" />Mute for a week</button>
            <button type="button" role="menuitem" onClick={() => void mute("always")}><BellOff size={16} aria-hidden="true" />Mute always</button></>) : null}
          {!channel.moderationOnly ? <button type="button" role="menuitem" onClick={() => void archive()}><Archive size={16} aria-hidden="true" />{channel.archivedAt ? "Unarchive chat" : "Archive chat"}</button> : null}
          {channel.imported ? <button type="button" role="menuitem" onClick={() => setHistory(true)}><History size={16} aria-hidden="true" />Imported WhatsApp history</button> : null}
        </span> : null}
      </span>
      {searching ? <form className={css.inChat} role="search" onSubmit={(e) => { e.preventDefault(); void findHere(); }}>
        <input autoFocus value={find} onChange={(e) => { setFind(e.target.value); setSearchHits(null); }} placeholder={`Search ${channel.kind === "direct" ? `your chat with ${first(channel.name)}` : channel.name}`} aria-label="Search this chat" enterKeyHint="search" />
        <button type="button" className={css.iconBtn} onClick={() => { setSearching(false); setFind(""); setSearchHits(null); }} aria-label="Close search"><X size={16} aria-hidden="true" /></button>
        {hits ? <div className={css.inChatHits} role="listbox" aria-label="Messages found">{hits.length ? hits.map((m) => <button key={m.id} type="button" role="option" aria-selected="false" onClick={() => { setSearching(false); setSearchHits(null); go(`channel=${channel.id}&message=${m.id}`); }}>
          <b>{m.authorId === viewer ? "You" : m.name}</b><span>{m.body.slice(0, 140)}</span><time dateTime={m.createdAt}>{dayChip(m.createdAt)}</time></button>) : <p>No message here matches “{find.trim()}”.</p>}</div> : null}
      </form> : null}
    </header>;
  const canWrite = !channel.moderationOnly && !(channel.kind === "direct" && channel.peerFormer);
  return <div className={`${css.chat} ${threadOf || gallery ? v3.withPane : ""}`}
    onDragEnter={(e) => { if (!canWrite || !carries(e.dataTransfer)) return; e.preventDefault(); dragDepth.current++; setDropping(true); }}
    onDragOver={(e) => { if (canWrite && carries(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
    onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDropping(false); } }}
    onDrop={(e) => {
      dragDepth.current = 0; setDropping(false); if (!canWrite) return;
      const files = [...e.dataTransfer.files]; const ref = files.length ? null : droppedRef(e.dataTransfer);
      if (!files.length && !ref) return;
      e.preventDefault(); if (files.length) composer.current?.files(files); else if (ref) composer.current?.link(ref);
    }}>
    {dropping ? <div className={ws.drop} aria-hidden="true"><span><Paperclip size={26} />Drop to attach<small>Files up to 5 MB, or a link from the side panel or Drive</small></span></div> : null}
    {/* The header's name sits inside the details button; screen readers (and a full-screen chat on a phone) still get a heading. */}
    <h2 className={css.srOnly}>{channel.kind === "direct" ? `Chat with ${channel.name}` : channel.name}</h2>
    {bar ? createPortal(head, bar) : head}
    {thread?.pinned?.length ? <PinnedBar pinned={thread.pinned} viewer={viewer} onJump={(m) => api.quote(m.id)} onUnpin={(m) => void pinMessage(m, false)} /> : null}
    {error ? <p className={css.chatError} role="alert">{error}<button type="button" onClick={() => { setError(""); void syncThread(channel.id).catch((e) => setError((e as Error).message)); }}>Retry</button></p> : null}
    <div ref={list} className={css.messages} role="log" aria-label="Messages" aria-busy={loading || undefined} onScroll={onScroll} data-settling={settled || !messages.length ? undefined : ""}>
      {/* R47: history imported from a WhatsApp export opens apart from the conversation, read-only. */}
      {channel.imported && !(start > 0 || thread?.hasMore) ? <button type="button" className={own.banner} disabled={!ready} onClick={() => setHistory(true)}><History size={14} aria-hidden="true" />{channel.imported} earlier message{channel.imported === 1 ? "" : "s"} imported from WhatsApp</button> : null}
      {start > 0 || thread?.hasMore ? <button type="button" className={css.older} onClick={() => void older()}>Earlier messages</button> : null}
      {messages.length && slow && loading ? <p className={css.reconnecting} role="status">Reconnecting…</p> : null}
      {!messages.length ? <div className={css.chatEmpty} data-chat-empty="">{loading && slow ? <p className={css.stillOpening} role="status">Still opening this conversation…<button type="button" onClick={() => { setSlow(false); setAttempt((a) => a + 1); }}>Try now</button></p> : loading ? <span className={css.spinner} aria-label="Opening the conversation" /> : <><GroupAvatar channel={channel} size={64} /><h3>{channel.kind === "direct" ? `Say hello to ${first(channel.name)}` : `Welcome to ${channel.name}`}</h3><p>{channel.description || (channel.kind === "direct" ? "Only the two of you can read this chat." : `${label}. Only members can read it.`)}</p></>}</div> : null}
      {visible.map((m, i) => {
        const prev = i ? visible[i - 1] : start > 0 ? messages[start - 1] : null;
        const chip = !prev || !sameDay(prev.createdAt, m.createdAt) ? dayChip(m.createdAt) : null;
        const run = !chip && prev && prev.authorId === m.authorId && prev.kind !== "event" && m.kind !== "event" && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < RUN_MS;
        return <div key={m.clientId ?? m.id} className={css.slot}>
          {chip ? <div className={css.day}><span>{chip}</span></div> : null}
          {m.id === unreadFrom ? <div className={css.unreadLine} data-unread-line=""><span>{unreadAtOpen} unread message{unreadAtOpen === 1 ? "" : "s"}</span></div> : null}
          {m.kind === "event" ? <EventLine m={m} viewer={viewer} cards={cards} channel={channel} onJump={api.quote} />
            : <Bubble m={m} mine={m.authorId === viewer} group={group} run={!!run} usernames={usernames} viewer={viewer} myName={me?.username ?? null} tick={ticks(m, thread?.receipts ?? null, viewer)} cards={cards}
              note={voice.notes[m.id]} transcripts={voice.transcripts} channel={channel} flash={flash === m.id} api={api} />}
          {m.id === lastMine && group && thread?.readers?.length ? <SeenBy m={m} readers={thread.readers} members={members} onInfo={() => setInfoOf(m)} /> : null}
        </div>;
      })}
      <TypingBubble typers={typers} members={members} direct={channel.kind === "direct"} />
      {thinking.length ? <div className={v3.typing} role="status" data-ai-thinking=""><span aria-hidden="true"><i /><i /><i /></span><span>{thinking.join(" and ")} {thinking.length === 1 ? "is" : "are"} working on an answer</span></div> : null}
      {work.map((r) => <WorkList key={r.key} result={r} channelId={channel.id} onClose={() => setWork((w) => w.filter((x) => x.key !== r.key))}
        onShare={(text, attachments) => { void sendMessage(text, attachments, null); setWork((w) => w.filter((x) => x.key !== r.key)); }} />)}
    </div>
    {below ? <button type="button" className={css.toBottom} onClick={toBottom} aria-label={fresh ? `${fresh} new message${fresh === 1 ? "" : "s"}: scroll to the latest` : "Scroll to the latest message"}><ArrowDown size={18} aria-hidden="true" />{fresh ? <span className={v3.newCount}>{fresh > 99 ? "99+" : fresh}</span> : null}</button> : null}
    {notice}
    {channel.moderationOnly ? <p className={css.readonly}>You’re viewing this group as a moderator. Only its members write here.</p>
      : channel.kind === "direct" && channel.peerFormer ? <p className={css.readonly}>{channel.name} is no longer with the company. This chat stays for its history.</p>
      : <Composer key={`${channel.id}:${editing?.id ?? ""}`} channel={channel} members={members} viewer={viewer} reply={reply} editing={editing} onCancel={() => { setReply(null); setEditing(null); }}
        onSend={(text, attachments) => { void sendMessage(text, attachments, reply); setReply(null); }} onSendTask={(text, offer) => { void sendAsTask(text, offer, reply); setReply(null); }} onSaveEdit={(text) => editing && void saveEdit(editing, text)} onTask={(title) => makeTask(null, title)} onWork={showWork} apiRef={composer} />}
    {history ? <ImportedHistory channel={channel} viewer={viewer} onClose={() => setHistory(false)} /> : null}
    {threadOf ? <ThreadPane key={threadOf} channel={channel} rootId={threadOf} viewer={viewer} me={me} usernames={usernames} onClose={() => setThreadOf(null)} onImage={(m, f) => setLightbox({ m, f })} /> : null}
    {gallery ? <aside className={v3.pane} aria-label="Media, files and links"><header className={v3.paneHead}><h3>Media, files and links<small>{channel.name}</small></h3><button type="button" className={css.iconBtn} onClick={() => setGallery(false)} aria-label="Close"><X size={18} aria-hidden="true" /></button></header>
      <div className={v3.paneBody}><Gallery channel={channel} onOpenImage={(m, f) => setLightbox({ m, f })} onJump={(id) => { setGallery(false); api.quote(id); }} /></div></aside> : null}
    {lightbox ? <Lightbox key={`${lightbox.m}:${lightbox.f ?? ""}`} channel={channel} messageId={lightbox.m} fileId={lightbox.f} viewer={viewer} me={me} usernames={usernames} onClose={() => setLightbox(null)}
      onGo={(m, f) => setLightbox({ m, f })} onPanel={(f, name) => { setLightbox(null); openInPanel({ href: `file:${f}`, title: name }); }} /> : null}
    {forward ? <ForwardDialog m={forward} data={data} onClose={() => setForward(null)} onDone={(n) => { setForward(null); notify(`Forwarded to ${n} chat${n === 1 ? "" : "s"}`); void onChanged(); }} /> : null}
    {infoOf ? <MessageInfo m={infoOf} readers={thread?.readers ?? []} members={members} onClose={() => setInfoOf(null)} /> : null}
    {sheet ? <Sheet m={sheet} actions={actions(sheet)} onReact={(e) => { void react(sheet, e); setSheet(null); }} onClose={() => setSheet(null)} /> : null}
    {confirm ? <Confirm title={confirm.authorId === viewer ? "Delete this message for everyone?" : "Remove this message?"} text={confirm.authorId === viewer ? "Everyone in the chat will see “This message was deleted”." : "Members will see “This message was deleted”. The removal stays in the audit trail."}
      action={confirm.authorId === viewer ? "Delete" : "Remove"} onCancel={() => setConfirm(null)} onConfirm={() => void remove(confirm)} /> : null}
  </div>;
}

function EventLine({ m, viewer, cards, channel, onJump }: { m: ChatMessage; viewer: string; cards: ReturnType<typeof useTaskCards>; channel: Channel; onJump: (id: string) => void }) {
  const task = m.attachments.find((a) => a.task), call = callOf(m.attachments);
  // CHAT-V3: "pinned a message", "asked for approval", "approved": a tap shows the message it is about.
  const about = m.attachments.find((a) => a.pinned || a.approval);
  if (about) return <div className={css.event} id={`m-${m.id}`}><button type="button" className={v3.eventBtn} onClick={() => onJump((about.pinned ?? about.approval)!)} data-event-about="" title="Show the message"><b>{m.authorId === viewer ? "You" : m.name}</b> {m.body} · {clock(m.createdAt)}</button></div>;
  // J6: a Flow step's line links to the step.
  const step = !task ? m.attachments.find((a) => a.url?.startsWith("/runs/")) : undefined;
  if (call) return <div className={css.event} id={`m-${m.id}`}><CallLine a={call} mine={m.authorId === viewer} author={first(m.name)} channelId={channel.id} at={m.createdAt} /></div>;
  return <div className={css.event} id={`m-${m.id}`}><span><b>{m.authorId === viewer ? "You" : m.name}</b> {m.body} · {clock(m.createdAt)}</span>
    {task ? <TaskCard task={cards.get(task.task!)} fallback={task.name} channelId={channel.id} compact /> : null}
    {step?.url ? <Link href={step.url} className={wk.stepLink} data-step-link=""><ListChecks size={13} aria-hidden="true" />{step.name}</Link> : null}</div>;
}

type Action = { key: string; label: string; icon: ReactNode; run: () => void; danger?: boolean };
/** CHAT-V3: what a bubble can do, one stable handle (see `live` in Conversation). */
type BubbleApi = { actions: (m: ChatMessage) => Action[]; react: (m: ChatMessage, emoji: string) => void; sheet: (m: ChatMessage) => void; retry: (m: ChatMessage) => void; discard: (m: ChatMessage) => void;
  reply: (m: ChatMessage) => void; thread: (id: string) => void; image: (m: ChatMessage, fileId: string) => void; quote: (id: string) => void; error: (e: string) => void; voice: ReturnType<typeof useVoiceState> };
type BubbleProps = { m: ChatMessage; mine: boolean; group: boolean; run: boolean; usernames: (string | null)[]; viewer: string; myName: string | null; tick: string | null; cards: ReturnType<typeof useTaskCards>;
  note: ReturnType<typeof useVoiceState>["notes"][string] | undefined; transcripts: boolean; channel: Channel; flash: boolean; api: BubbleApi };
const SWIPE = 56;
// CHAT-V3 (speed): a bubble is drawn again only when what it shows changed (its message, ticks, cards, voice state).
const Bubble = memo(function Bubble({ m, mine, group, run, usernames, viewer, myName, tick, cards, note, transcripts, channel, flash, api }: BubbleProps) {
  const [tools, setTools] = useState<null | "react" | "menu">(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  // CHAT-V3 (phone): swipe a message to the right to reply to it, as in WhatsApp.
  const swipe = useRef<{ x: number; y: number; on: boolean; dx: number } | null>(null), [dx, setDx] = useState(0);
  const images = m.attachments.filter(isImage), notes = m.attachments.filter(isVoice), others = m.attachments.filter((a) => !isImage(a) && !isVoice(a));
  const touchStart = (e: TouchEvent) => { const t = e.touches[0]; swipe.current = { x: t.clientX, y: t.clientY, on: false, dx: 0 }; press.current = setTimeout(() => { press.current = null; swipe.current = null; navigator.vibrate?.(12); api.sheet(m); }, 450); };
  const cancelPress = () => { if (press.current) { clearTimeout(press.current); press.current = null; } };
  const touchMove = (e: TouchEvent) => {
    const s = swipe.current, t = e.touches[0]; if (!s) { cancelPress(); return; }
    const x = t.clientX - s.x, y = t.clientY - s.y;
    if (Math.abs(x) > 6 || Math.abs(y) > 6) cancelPress();
    if (!s.on && Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) { swipe.current = null; setDx(0); return; }
    if (x > 10) { s.on = true; s.dx = Math.min(80, x * 0.8); setDx(s.dx); }
  };
  const touchEnd = () => { cancelPress(); if (swipe.current?.on && swipe.current.dx >= SWIPE) { navigator.vibrate?.(10); api.reply(m); } swipe.current = null; setDx(0); };
  const actions = tools === "menu" ? api.actions(m) : [];
  const open = (a: Attachment) => (e: ReactMouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); api.image(m, a.id!); };
  return <article id={`m-${m.id}`} className={css.msg} data-mine={mine || undefined} data-run={run || undefined} data-flash={flash || undefined} data-pending={m.pending || undefined} data-queued={m.queued || undefined}
    style={dx ? { transform: `translateX(${dx}px)` } : undefined}
    onTouchStart={m.removed || m.pending ? undefined : touchStart} onTouchEnd={touchEnd} onTouchMove={touchMove} onTouchCancel={touchEnd} onContextMenu={(e) => { if (coarse() && !m.removed) { e.preventDefault(); api.sheet(m); } }}
    onMouseLeave={() => setTools(null)}>
    {dx ? <span className={v3.swipeReply} style={{ opacity: Math.min(1, dx / SWIPE) }} aria-hidden="true"><Reply size={15} /></span> : null}
    {(group || m.byAgent) && !mine ? (run ? <span className={css.avatarGap} /> : <Avatar ai={m.byAgent} name={m.name} id={m.authorId} photoAt={m.photoAt} size={30} />) : null}
    <div className={css.bubbleCol}>
      <div className={css.bubble} data-agent={m.agentRun || m.agentAsk || m.handoff ? "" : undefined} data-media={images.length && !m.body ? "" : undefined} data-edited={m.editedAt && !m.removed ? "" : undefined}>
        {(group || m.byAgent) && !mine && !run ? <b className={css.author} style={{ "--hue": hue(m.authorId) } as CSSProperties}>{m.byAgent ? <Link href={`/people/ai/${encodeURIComponent(m.authorId)}`}>{m.name}</Link> : m.name}{m.byAgent ? <AiBadge employeeId={m.employeeId} /> : null}{m.former ? <small className={css.former}> · former member</small> : null}</b> : null}
        {m.forwarded && !m.removed ? <span className={v3.flags}><Forward size={12} aria-hidden="true" />Forwarded</span> : null}
        {m.removed ? <p className={css.removed}><CircleAlert size={14} aria-hidden="true" />This message was deleted</p> : <>
          {m.quote ? <button type="button" className={css.quote} onClick={() => api.quote(m.quote!.id)} style={{ "--hue": hue(m.quote.authorId) } as CSSProperties}>
            <b>{m.quote.authorId === viewer ? "You" : m.quote.name}</b><span>{m.quote.removed ? "This message was deleted" : m.quote.body || (m.quote.attachments ? "📎 Attachment" : "")}</span></button> : null}
          {images.length ? <div className={css.images} data-n={Math.min(images.length, 4)}>{images.map((a) => <a key={a.id} className={v3.imgWrap} href={`/api/v0/chats/files/${a.id}?inline=1`} target="_blank" rel="noreferrer" onClick={open(a)} aria-label={`Open ${a.name}${a.version ? `, version ${a.version}` : ""}`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- member-only file served by the API */}
            <img src={`/api/v0/chats/files/${a.id}?inline=1`} alt={a.name} loading="lazy" />{a.version ? <span className={v3.version}>v{a.version}</span> : null}</a>)}</div> : null}
          {m.pending ? notes.map((a) => <VoiceNote key={a.id} messageId={m.id} a={a} mine={mine} transcripts={false} onPlayed={() => {}} onTranscribe={() => {}} />)
            : notes.map((a) => <VoiceNote key={a.id} messageId={m.id} a={a} mine={mine} state={note} transcripts={transcripts} onPlayed={() => api.voice.played(m.id)} onTranscribe={() => api.voice.transcribe(m.id)} />)}
          {others.map((a, i) => a.task ? <TaskCard key={a.task} task={cards.get(a.task)} fallback={a.name} channelId={channel.id} />
            : a.id ? <a key={a.id} className={css.file} href={`/api/v0/chats/files/${a.id}`} target="_blank" rel="noreferrer"
                onClick={(e) => { if (!a.id || !PANEL_DOCS.test(a.mime ?? "") || e.metaKey || e.ctrlKey || e.shiftKey) return; if (openInPanel({ href: `file:${a.id}`, title: a.name })) e.preventDefault(); }}>
                <FileIcon size={18} aria-hidden="true" /><span>{a.name}{a.version ? ` · v${a.version}` : ""}<small>{PANEL_DOCS.test(a.mime ?? "") ? "Open" : "Download"}</small></span></a>
            : <a key={a.url ?? i} className={css.file} href={a.url} target="_blank" rel="noreferrer" onClick={(e) => { if (!a.url || e.metaKey || e.ctrlKey || e.shiftKey) return; if (openInPanel({ href: a.url, title: a.name })) e.preventDefault(); }}><Link2 size={18} aria-hidden="true" /><span>{a.name}<small>{a.url ? linkDomain(a.url) : ""}</small></span></a>)}
          {!m.removed && !m.pending && !m.failed && (images.length > 0 || others.some((a) => !a.task)) ? <button type="button" className={wk.fileTask} data-file-task="" onClick={() => api.actions(m).find((a) => a.key === "task")?.run()}><ListChecks size={13} aria-hidden="true" />Make it a task</button> : null}
          {m.body ? <p className={css.text}>{segments(m.body, usernames).map((s, i) => s.type === "link" ? <span key={i}><a href={s.value} target="_blank" rel="noreferrer" title={s.value}>{s.label}</a>{s.rest}</span> : s.type === "mention" ? <mark key={i}>{s.value}</mark> : <span key={i}>{s.value}</span>)}<span className={css.spacer} aria-hidden="true" /></p> : null}
        </>}
        {m.removed ? null : <AgentParts m={m} channel={channel} />}
        {m.approval && !m.removed ? <ApprovalCard m={m} viewer={viewer} channelId={channel.id} onError={api.error} /> : null}
        <span className={css.meta}>{m.pinnedAt ? <Pin size={11} aria-label="Pinned" /> : null}{m.starred ? <Star size={11} aria-label="Saved" /> : null}{m.editedAt && !m.removed ? <em>edited</em> : null}<time dateTime={m.createdAt} title={fullTime(m.createdAt)}>{clock(m.createdAt)}</time>
          {tick ? <i className={css.tick} data-tick={tick} aria-label={m.queued ? "Waiting for the connection" : tick === "read" ? "Read" : tick === "delivered" ? "Delivered" : tick === "sent" ? "Sent" : tick === "pending" ? "Sending" : "Not sent"}>
            {tick === "pending" ? <Clock3 size={13} /> : tick === "failed" ? <CircleAlert size={13} /> : tick === "sent" ? <Check size={14} /> : <CheckCheck size={15} />}</i> : null}</span>
      </div>
      {m.queued && !m.failed ? <p className={css.failed} role="status" data-outbox="">Waiting for the connection · it sends by itself</p> : null}
      {m.failed ? <p className={css.failed} role="alert">Not sent: {m.failed} <button type="button" onClick={() => api.retry(m)}>Try again</button><button type="button" onClick={() => api.discard(m)}>Delete</button></p> : null}
      {m.replies > 0 && !m.removed ? <button type="button" className={v3.threadChip} onClick={() => api.thread(m.id)} data-thread-chip=""><MessageSquareText size={14} aria-hidden="true" />{m.replies} repl{m.replies === 1 ? "y" : "ies"}{m.lastReplyAt ? <small>· {dayChip(m.lastReplyAt) === "Today" ? clock(m.lastReplyAt) : dayChip(m.lastReplyAt)}</small> : null}</button> : null}
      {mine || m.removed ? null : <IntentChips m={m} channel={channel} viewer={viewer} username={myName} said={note?.transcript ?? null} />}
      {m.reactions.length ? <div className={css.reactions}>{m.reactions.map((r) => <button key={r.emoji} type="button" aria-pressed={r.mine} onClick={() => api.react(m, r.emoji)} aria-label={`${r.emoji} ${r.count}${r.mine ? ", including you" : ""}`}>{r.emoji}{r.count > 1 ? <span>{r.count}</span> : null}</button>)}</div> : null}
    </div>
    {!m.removed && !m.pending && !m.failed ? <div className={css.tools} data-open={tools ? "" : undefined}>
      <button type="button" aria-label="React" aria-expanded={tools === "react"} onClick={() => setTools(tools === "react" ? null : "react")}><Smile size={16} aria-hidden="true" /></button>
      <button type="button" aria-label="Reply" onClick={() => api.reply(m)}><Reply size={16} aria-hidden="true" /></button>
      {!channel.moderationOnly ? <button type="button" aria-label={m.replies ? "Open the thread" : "Reply in a thread"} title={m.replies ? "Open the thread" : "Reply in a thread"} onClick={() => api.thread(m.id)}><MessageSquareText size={16} aria-hidden="true" /></button> : null}
      <button type="button" aria-label="More actions" aria-expanded={tools === "menu"} onClick={() => setTools(tools === "menu" ? null : "menu")}><ChevronDown size={16} aria-hidden="true" /></button>
      {tools === "react" ? <span className={css.reactPick} role="group" aria-label="Choose a reaction">{[...QUICK, ...MORE_REACTIONS].map((e) => <button key={e} type="button" aria-label={`React ${e}`} onClick={() => { setTools(null); api.react(m, e); }}>{e}</button>)}</span> : null}
      {tools === "menu" ? <span className={css.menu} role="menu">{actions.map((a) => <button key={a.key} type="button" role="menuitem" data-danger={a.danger || undefined} onClick={() => { setTools(null); a.run(); }}>{a.icon}{a.label}</button>)}</span> : null}
    </div> : null}
  </article>;
}, (a, b) => a.m === b.m && a.mine === b.mine && a.group === b.group && a.run === b.run && a.usernames === b.usernames && a.tick === b.tick && a.cards === b.cards && a.note === b.note
  && a.transcripts === b.transcripts && a.channel.id === b.channel.id && a.channel.moderationOnly === b.channel.moderationOnly && a.flash === b.flash && a.myName === b.myName && a.viewer === b.viewer && a.api === b.api);

/** EST-1035: why a question went unanswered or a hand-off was not filed, from the fixed codes Pulse records. */
const AGENT_REASON: Record<string, string> = {
  message_gone: "the message is gone", not_leader: "the person who asked is no longer a leader here", agent_left: "it is no longer in this conversation",
  asker_left: "the person who asked left this conversation", budget_spent: "today's token budget is spent", not_chats: "it answers in Chats only",
  expired: "the question waited more than a day", gave_up: "it could not start after five tries", stuck: "it got stuck", model_error: "something went wrong while answering",
  no_answer: "it had no answer",
};
const HANDOFF_REASON: Record<string, string> = {
  agent_left: "the co-worker left this conversation", decider_not_leader: "the leader who handed it over is no longer a leader",
  decider_left: "the leader who handed it over left this conversation",
};

/** EST-1035: what an AI co-worker's answer cost (as the model reported it, or unknown), where a leader's question to
 *  it stands, and a hand-off it proposed, which a leader hands over or declines (only then is it filed as work). */
/** AI-EMPLOYEES v2: what an AI employee would post, asked of its approver: Send it / Edit / Don't (or a reply such as
 *  "fine, send it"); once decided, who decided and how. On the posted message: who approved it. */
function ProposalCard({ m, channel }: { m: ChatMessage; channel: Channel }) {
  const p = m.proposal!;
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [editing, setEditing] = useState(false), [text, setText] = useState(p.body);
  const decide = async (action: "send" | "dismiss", body?: string) => {
    setBusy(true); setError("");
    try { await send(`chats/proposals/${p.id}/decide`, { action, body }); setEditing(false); await syncThread(channel.id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const decided = p.decidedBy ? `${p.decidedBy}${p.via === "reply" ? " (by reply)" : ""}${p.decidedAt ? ` · ${new Date(p.decidedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}` : ""}` : "";
  // EA-AI: a proposed task is created (as the person who says Create it), not posted; its card follows in the chat.
  const task = p.kind === "task", where = p.channelName ? ` in ${p.channelName}` : "";
  if (p.on === "sent") return <small className={css.aiStatus} data-state="approved" data-proposal-sent={p.id}><Check size={12} aria-hidden="true" />{task ? "Task created, approved by " : "Approved by "}{decided}{p.sentBody && p.sentBody !== p.body ? ", edited" : ""}</small>;
  return <div className={css.aiProposal} data-state={p.state} data-proposal={p.id} data-kind={p.kind ?? "reply"}>
    <b>{p.state === "pending" ? (task ? "Proposed task" : `Proposed reply${where}`) : p.state === "sent" ? (task ? "Task created" : `Sent${where}`) : task ? "Not created" : "Not sent"}</b>
    {editing ? <textarea aria-label={task ? "Edit the task (first line is its title)" : "Edit the reply"} value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={4000} autoFocus />
      : <blockquote>{p.state === "sent" && p.sentBody ? p.sentBody : p.body}</blockquote>}
    {p.why && p.state === "pending" ? <small>Why: {p.why}</small> : null}
    {p.state === "pending" ? (p.mine ? <span className={css.aiActions}>
      {editing ? <><button type="button" className={css.primary} disabled={busy || !text.trim()} onClick={() => void decide("send", text.trim())}>{task ? "Create edited" : "Send edited"}</button>
        <button type="button" className={css.secondary} disabled={busy} onClick={() => { setEditing(false); setText(p.body); }}>Cancel</button></>
        : <><button type="button" className={css.primary} disabled={busy} onClick={() => void decide("send")}>{task ? "Create it" : "Send it"}</button>
        <button type="button" className={css.secondary} disabled={busy} onClick={() => setEditing(true)}>Edit</button>
        <button type="button" className={css.secondary} disabled={busy} onClick={() => void decide("dismiss")}>Don&apos;t</button></>}
    </span> : <small>Waiting for {p.approver ?? "its approver"}</small>)
      : <small>{p.state === "sent" ? (task && p.taskId ? <>Approved by {decided}. <a href={`/tasks/${p.taskId}`}>Open the task</a></>
        : <>Approved by {decided}. <a href={`/chats?channel=${p.channelId}${p.postedMessageId ? `&message=${p.postedMessageId}` : ""}`}>See it in {p.channelName ?? "the group"}</a></>) : p.state === "dismissed" ? `${task ? "Not created" : "Not sent"}: ${decided}` : "Expired"}</small>}
    {error ? <small role="alert">{error}</small> : null}
  </div>;
}

function AgentParts({ m, channel }: { m: ChatMessage; channel: Channel }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = m.agentRun, ask = m.agentAsk, h = m.handoff, update = m.handoffUpdate;
  if (m.proposal) return <ProposalCard m={m} channel={channel} />;
  if (!run && !ask && !h && !update) return null;
  const lead = !!cachedList()?.canLead, board = cachedList()?.boardUrl;
  const decide = async (accept: boolean) => {
    setBusy(true); setError("");
    try { await send(`chats/handoffs/${h!.id}/decide`, { accept }); await syncThread(channel.id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const meter = run ? [run.lane, run.model, run.tokens === null ? "tokens unknown" : `${run.tokens.toLocaleString("en-IN")} tokens`,
    run.seconds === null ? null : `${Number(run.seconds)} s`, run.state === "uncertain" ? "stuck" : run.state === "error" ? "error" : run.state === "dispatching" ? "answering" : null].filter(Boolean).join(" · ") : "";
  const who = ask?.agent ?? "The co-worker";
  return <>
    {update ? <div className={css.aiUpdate}><AiBadge employeeId={m.employeeId} /><span>{m.name}&apos;s update</span>
      <b>{({ started: "Started", progress: "Progress", in_review: "For your review", blocked: "Blocked", cancelled: "Cancelled" })[update.state]}</b>
      {board ? <a href={`${board}/${encodeURIComponent(update.boardRef.split("-")[0])}/issues/${encodeURIComponent(update.boardRef)}`} target="_blank" rel="noreferrer">{update.boardRef}</a> : <span>{update.boardRef}</span>}<span className={css.spacer} aria-hidden="true" /></div> : null}
    {meter ? <small className={css.aiMeter} title="What this answer cost, as the model reported it">{meter}</small> : null}
    {ask && ["queued", "leased", "dispatching"].includes(ask.state) ? <small className={css.aiStatus} data-state="thinking">{ask.reason === "paused" ? `${who} is paused until an admin switches it back on` : ask.reason === "out_of_quota" || ask.runtimeState === "out_of_quota" ? `${who} is out of quota${ask.runtimeUntil ? ` until ${new Date(ask.runtimeUntil).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : ""}; it answers then` : `${who} is thinking…`}</small>
      : ask?.state === "failed" ? <small className={css.aiStatus} data-state="failed">{who} couldn&apos;t answer{ask.reason && AGENT_REASON[ask.reason] ? `: ${AGENT_REASON[ask.reason]}` : ""}</small>
      : ask?.state === "uncertain" ? <small className={css.aiStatus} data-state="failed">{who} got stuck and didn&apos;t answer</small> : null}
    {h ? <div className={css.aiHandoff} data-state={h.state}><b>Hand-off: {h.title}</b>{h.details ? <span>{h.details}</span> : null}
      {h.state === "proposed" ? (lead ? <span className={css.aiActions}><button type="button" className={css.primary} disabled={busy} onClick={() => void decide(true)}>Hand it over</button>
        <button type="button" className={css.secondary} disabled={busy} onClick={() => void decide(false)}>Not now</button></span> : <small>A leader can hand it over</small>)
        : <small>{h.state === "declined" ? "Not taken on" : h.state === "filed" ? `Handed over as ${h.boardRef}. The result comes back here for review.`
          : h.state === "uncertain" ? "Not confirmed as filed. Check the board before handing it over again."
          : h.state === "closed" ? `Not filed: ${HANDOFF_REASON[h.reason ?? ""] ?? "it can no longer be handed over"}` : "Handed over · being filed"}</small>}
      {error ? <small role="alert">{error}</small> : null}</div> : null}
  </>;
}

function Sheet({ m, actions, onReact, onClose }: { m: ChatMessage; actions: Action[]; onReact: (e: string) => void; onClose: () => void }) {
  return <div className={css.sheetBackdrop} onClick={onClose}><div className={css.sheet} role="dialog" aria-modal="true" aria-label="Message actions" onClick={(e) => e.stopPropagation()}>
    <div className={css.sheetReact} role="group" aria-label="React">{[...QUICK, ...MORE_REACTIONS.slice(0, 2)].map((e) => <button key={e} type="button" aria-label={`React ${e}`} aria-pressed={m.reactions.some((r) => r.emoji === e && r.mine)} onClick={() => onReact(e)}>{e}</button>)}</div>
    {actions.map((a) => <button key={a.key} type="button" className={css.sheetItem} data-danger={a.danger || undefined} onClick={() => { onClose(); a.run(); }}>{a.icon}{a.label}</button>)}
    <button type="button" className={css.sheetItem} onClick={onClose}><X size={16} aria-hidden="true" />Cancel</button>
  </div></div>;
}

export function Confirm({ title, text, action, onCancel, onConfirm }: { title: string; text: string; action: string; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => { const k = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onCancel(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onCancel]);
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}><div className={css.dialog} role="alertdialog" aria-modal="true" aria-label={title}>
    <h2>{title}</h2><p className={css.hint}>{text}</p>
    <footer><button type="button" className={css.secondary} onClick={onCancel} autoFocus>Cancel</button><button type="button" className={css.danger} onClick={onConfirm}>{action}</button></footer>
  </div></div>;
}

type Suggest = { kind: "mention"; items: Member[] } | { kind: "task"; items: { id: string; title: string; statusLabel: string; assigneeName: string | null }[] } | { kind: "command"; items: ChatCommand[] } | null;
let projectCache: { id: string; name: string }[] | null = null, projectLoad: Promise<void> | null = null;
function Composer({ channel, members, viewer, reply, editing, onCancel, onSend, onSendTask, onSaveEdit, onTask, onWork, apiRef }: { channel: Channel; members: Member[]; viewer: string; reply: ChatMessage | null; editing: ChatMessage | null;
  onCancel: () => void; onSend: (text: string, attachments: Attachment[]) => void; onSendTask: (text: string, offer: TaskIntent<Member>) => void; onSaveEdit: (text: string) => void; onTask: (title: string) => void; onWork: (kind: WorkKind) => void; apiRef?: RefObject<ComposerApi | null> }) {
  const [text, setText] = useState(() => editing ? editing.body : drafts.get(channel.id) ?? ""), [files, setFiles] = useState<(Attachment & { preview?: string; uploading?: boolean; link?: boolean })[]>([]);
  const [emoji, setEmoji] = useState(false), [error, setError] = useState(""), [suggest, setSuggest] = useState<Suggest>(null), [active, setActive] = useState(0);
  // QA-1024: Pip steps aside while the @ / slash / task list is open (it sat over the list's options at 768 and 1440 px).
  const suggesting = !!suggest;
  useEffect(() => { window.dispatchEvent(new Event("pulse:float-changed")); }, [suggesting]);
  const input = useRef<HTMLTextAreaElement>(null), picker = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) drafts.set(channel.id, text); }, [channel.id, text, editing]);
  useEffect(() => { if (reply || editing) input.current?.focus(); }, [reply, editing]);
  useEffect(() => { const el = input.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 148)}px`; }, [text]);
  // POLISH-2 (QA-E2E P1-11): a finished @name that is nobody in this conversation is not told anything; say so here.
  const outside = useMemo(() => {
    const known = new Set(members.map((p) => p.username?.toLowerCase()).filter(Boolean));
    // The name still being typed (the people list is open for it) is not finished yet.
    const typing = suggest?.kind === "mention" ? text.match(/@([\w.-]*)$/)?.[1] : undefined;
    return [...new Set([...text.matchAll(/(?:^|\s)@([\w.-]+)(?=[\s,!?:;]|$)/g)].map((m) => m[1].replace(/[.-]+$/, ""))
      .filter((u) => u && u !== typing && !known.has(u.toLowerCase())))].slice(0, 3);
  }, [text, members, suggest]);
  // What the caret is typing: @someone, #a task, or /task.
  const token = useMemo(() => { const m = text.match(/(^|\s)([@#])([^\s@#]*)$/); return m ? { sign: m[2], q: m[3] } : text.startsWith("/") && !text.includes("\n") ? { sign: "/", q: text.slice(1) } : null; }, [text]);
  useEffect(() => {
    if (!token) { queueMicrotask(() => setSuggest(null)); return; }
    if (token.sign === "@") { const q = token.q.toLowerCase(); const items = members.filter((p) => p.id !== viewer && p.username && `${p.name} ${p.username}`.toLowerCase().includes(q)).slice(0, 6); queueMicrotask(() => { setSuggest(items.length ? { kind: "mention", items } : null); setActive(0); }); return; }
    if (token.sign === "/") { const items = token.q.includes(" ") ? [] : byGroup(chatCommands(token.q, channel)); queueMicrotask(() => { setSuggest(items.length ? { kind: "command", items } : null); setActive(0); }); return; }
    const t = setTimeout(() => { void get<{ tasks: { id: string; title: string; statusLabel: string; assigneeName: string | null }[] }>(`chats/tasks?q=${encodeURIComponent(token.q)}`).then((d) => { setSuggest(d.tasks.length ? { kind: "task", items: d.tasks } : null); setActive(0); }).catch(() => setSuggest(null)); }, 180);
    return () => clearTimeout(t);
  }, [token, members, viewer, channel]);
  const ready = !files.some((f) => f.uploading) && (!!text.trim() || files.length > 0);
  // J2: a line that gives someone in this chat work is offered as a task (who, what, when, which project).
  const zone = useOrgZone();
  const [projects, setProjects] = useState(projectCache), [notTask, setNotTask] = useState("");
  const offer = useMemo(() => editing || files.length ? null : taskIntent(text, { members, viewer, projects: projects ?? [], today: zoneDay(zone) }), [text, members, viewer, projects, zone, editing, files.length]);
  useEffect(() => {
    if (!offer || projects) return;
    projectLoad ??= get<{ projects: { id: string; name: string }[] }>("work/options").then((d) => { projectCache = d.projects.map((p) => ({ id: p.id, name: p.name })); }).catch(() => { projectCache = []; });
    void projectLoad.then(() => setProjects(projectCache));
  }, [offer, projects]);
  const offered = offer && notTask !== text ? offer : null;
  function sendTask() { if (!offered || !ready) return; onSendTask(text, offered); setText(""); setSuggest(null); input.current?.focus(); }
  function submit() {
    if (editing) { if (text.trim()) onSaveEdit(text); setText(""); return; }
    if (!ready) return;
    // CHAT-VOICE: /call and /video start a call here.
    const call = text.match(/^\/(call|video)\s*$/i);
    if (call) { startCall(channel.id, call[1].toLowerCase() === "video"); setText(""); return; }
    const found = findChatCommand(text, channel);
    if (found) { found.command.run({ channel, args: found.args, makeTask: onTask, showWork: onWork }); setText(""); setSuggest(null); return; }
    onSend(text, files.map((f) => f.task ? { task: f.task, name: f.name } : f.link ? { name: f.name, url: f.url } : { id: f.id, name: f.name, mime: f.mime })); setText(""); files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)); setFiles([]); setEmoji(false);
    input.current?.focus();
  }
  function pick(i: number) {
    if (!suggest) return;
    if (suggest.kind === "mention") { const p = suggest.items[i]; setText((t) => t.replace(/@[^\s@#]*$/, `@${p.username} `)); }
    else if (suggest.kind === "task") { const t = suggest.items[i]; setText((x) => x.replace(/#[^\s@#]*$/, `#${t.title} `)); if (!files.some((f) => f.task === t.id) && files.length < 5) setFiles((f) => [...f, { task: t.id, name: t.title.slice(0, 300) }]); }
    else { const c = suggest.items[i]; if (c.takesText) setText(`/${c.name} `); else { c.run({ channel, args: "", makeTask: onTask, showWork: onWork }); setText(""); } }
    setSuggest(null); input.current?.focus();
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggest && ["ArrowDown", "ArrowUp", "Tab"].includes(e.key)) { e.preventDefault(); const n = suggest.items.length; setActive((a) => (a + (e.key === "ArrowUp" ? n - 1 : 1)) % n); return; }
    if (e.key === "Escape") { if (suggest) setSuggest(null); else if (reply || editing) { onCancel(); if (editing) setText(""); } return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && offered) { e.preventDefault(); sendTask(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) {
      e.preventDefault();
      // A command typed in full ("/tasks") runs; a part of one ("/ta") picks the highlighted one.
      if (suggest && !(suggest.kind === "command" && findChatCommand(text, channel))) { pick(active); return; }
      submit();
    }
  }
  async function upload(list: File[]) {
    setError("");
    for (const f of list.slice(0, 5 - files.length)) {
      if (f.size > 5 * 1024 * 1024) { setError(`${f.name} is over 5 MB. Share a Drive link instead.`); continue; }
      const key = crypto.randomUUID(), preview = f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined;
      setFiles((x) => [...x, { name: f.name, mime: f.type, preview, uploading: true, url: key }]);
      try {
        const a = await send<Attachment>(`chats/${channel.id}/files`, { name: f.name, mime: f.type || "application/octet-stream", bytes: await readBase64(f) });
        setFiles((x) => x.map((y) => y.url === key ? { id: a.id, name: a.name, mime: a.mime, preview } : y));
      } catch (e) { setFiles((x) => x.filter((y) => y.url !== key)); setError((e as Error).message); }
    }
  }
  // Dropped on the conversation: files upload as if picked, links attach as links (up to five things in all).
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { files: (list) => void upload(list), link: (ref) => setFiles((x) => x.length >= 5 || x.some((f) => f.link && f.url === ref.url) ? x : [...x, { name: ref.name, url: ref.url, link: true }]) };
    return () => { apiRef.current = null; };
  });
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) { const list = [...e.clipboardData.files]; if (list.length) { e.preventDefault(); void upload(list); } }
  function insert(s: string) { const el = input.current; const at = el?.selectionStart ?? text.length; setText((t) => t.slice(0, at) + s + t.slice(at)); requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + s.length, at + s.length); }); }
  // FLOAT-2: floating things (Pip) keep off the composer, so Send can always be tapped on a phone. READY (owner, 23 Oct):
  // on a computer too: Pip beside the mic and Send crowded them, so it rests above the composer at every width.
  return <div className={css.composer} data-chat-composer="" data-float-avoid="">
    {reply || editing ? <div className={css.replying}><span style={{ "--hue": hue((editing ?? reply)!.authorId) } as CSSProperties}><b>{editing ? "Editing" : `Replying to ${(reply!.authorId === viewer ? "yourself" : reply!.name)}`}</b><small>{(editing ?? reply)!.body || "📎 Attachment"}</small></span>
      <button type="button" className={css.iconBtn} onClick={() => { onCancel(); if (editing) setText(""); }} aria-label={editing ? "Stop editing" : "Cancel reply"}><X size={16} aria-hidden="true" /></button></div> : null}
    {files.length ? <div className={css.pending}>{files.map((f, i) => <span key={f.id ?? f.task ?? f.url ?? i} data-uploading={f.uploading || undefined}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the file being sent */}
      {f.preview ? <img src={f.preview} alt="" /> : f.task ? <ListChecks size={16} aria-hidden="true" /> : f.link ? <Link2 size={16} aria-hidden="true" /> : f.mime?.startsWith("image/") ? <ImageIcon size={16} aria-hidden="true" /> : <FileIcon size={16} aria-hidden="true" />}
      <em>{f.task ? `Task: ${f.name}` : f.name}</em><button type="button" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}><X size={13} aria-hidden="true" /></button></span>)}</div> : null}
    {suggest ? <div className={css.suggest} data-float-avoid="" role="listbox" aria-label={suggest.kind === "mention" ? "People" : suggest.kind === "task" ? "Tasks" : "Commands"}>
      {suggest.kind === "command" ? <>{suggest.items.map((c, i) => <div key={c.name} role="presentation">
        {i === 0 || cmdGroup(suggest.items[i - 1].name) !== cmdGroup(c.name) ? <p className={css.cmdGroup}>{cmdGroup(c.name)}</p> : null}
        <button type="button" role="option" aria-selected={i === active} data-command={c.name} className={css.cmdRow} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
          <span className={css.cmdIcon} aria-hidden="true"><c.icon size={16} /></span><span><b>/{c.name}</b><small>{c.hint}{c.detail ? ` · ${c.detail}` : ""}</small></span>{i === active ? <kbd aria-hidden="true">{c.takesText ? "Tab" : "↵"}</kbd> : null}</button></div>)}
        <p className={css.cmdFoot} aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>↵</kbd> run</span><span><kbd>Esc</kbd> close</span></p></>
        : suggest.kind === "mention" ? suggest.items.map((p, i) => <button key={p.id} type="button" role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(i); }}><Avatar ai={p.agent} name={p.name} id={p.id} photoAt={p.photoAt} size={26} status /><span><b>{p.name}{p.agent ? <AiBadge employeeId={p.employeeId} /> : null}</b><small>@{p.username}{p.team ? ` · ${p.team}` : ""}</small></span></button>)
        : suggest.items.map((t, i) => <button key={t.id} type="button" role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(i); }}><ListChecks size={16} aria-hidden="true" /><span><b>{t.title}</b><small>{t.statusLabel}{t.assigneeName ? ` · ${t.assigneeName}` : ""}</small></span></button>)}
    </div> : null}
    {offered && !suggest ? <div className={wk.offer} data-task-offer="" role="group" aria-label="Send as a task">
      <ListChecks size={15} aria-hidden="true" />
      <span>Task for <b>{offered.assignee.name.split(" ")[0]}</b>: {offered.title}{offered.dueOn ? <em> · {dueLabel(offered.dueOn, zone)}</em> : null}{offered.project ? <em> · {offered.project.name}</em> : null}</span>
      <button type="button" data-primary="" onClick={sendTask} disabled={!ready} title="Ctrl+Enter">Send as task</button>
      <button type="button" className={wk.offerClose} onClick={() => setNotTask(text)} aria-label="Not a task, send it as a message"><X size={14} aria-hidden="true" /></button>
    </div> : null}
    {emoji ? <div className={css.emojiGrid} role="group" aria-label="Emoji">{EMOJI.map((e) => <button key={e} type="button" onClick={() => insert(e)} aria-label={e}>{e}</button>)}</div> : null}
    <div className={css.bar} data-float-avoid="">
      <button type="button" className={css.iconBtn} onClick={() => setEmoji(!emoji)} aria-label="Emoji" aria-expanded={emoji}><Smile size={21} aria-hidden="true" /></button>
      <button type="button" className={css.iconBtn} onClick={() => picker.current?.click()} aria-label="Attach a file" title="Photos and files up to 5 MB" disabled={files.length >= 5 || !!editing}><Paperclip size={20} aria-hidden="true" /></button>
      <input ref={picker} type="file" multiple hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
      <textarea ref={input} rows={1} value={text} onChange={(e) => { setText(e.target.value); const t = e.target.value.trim(); if (!editing) iAmTyping(channel.id, !!t && !t.startsWith("/")); }} onKeyDown={onKey} onPaste={onPaste} maxLength={12000} enterKeyHint="send"
        placeholder={editing ? "Edit your message" : "Message"} aria-label={editing ? "Edit your message" : `Message ${channel.name}`} />
      {/* CHAT-VOICE: with nothing typed or attached, Send is the mic (hold to record, tap for hands free). */}
      {!editing && !text.trim() && !files.length ? <VoiceRecorder channelId={channel.id} onSend={(a) => { setError(""); onSend("", [a]); }} onError={setError} />
        : <button type="button" className={css.send} onClick={submit} disabled={editing ? !text.trim() : !ready} aria-label={editing ? "Save the edit" : "Send"}>{editing ? <Check size={20} aria-hidden="true" /> : <SendHorizontal size={20} aria-hidden="true" />}</button>}
    </div>
    {error ? <p className={css.composeError} role="alert">{error}</p> : null}
    {outside.length ? <p className={css.mentionOut}>{outside.map((u) => `@${u}`).join(", ")} {outside.length === 1 ? "isn’t" : "aren’t"} in this conversation: they won’t be told or see it.</p> : null}
    {/* CHAT-SHELL: the hints are quick actions: each puts its sign in the box (or opens the side panel). */}
    <div className={css.composeHint}>
      <button type="button" onClick={() => insert(text && !/\s$/.test(text) ? " @" : "@")}><kbd>@</kbd> mention</button>
      <button type="button" onClick={() => insert(text && !/\s$/.test(text) ? " #" : "#")}><kbd>#</kbd> a task</button>
      <button type="button" onClick={() => { if (!text.startsWith("/")) { setText("/"); input.current?.focus(); } }}><kbd>/</kbd> commands</button>
      {/* E2E-4P (owner check): three quick actions and one keyboard hint; the row was cramped with five. */}
      <span title="Drop files or links into the box to attach them"><kbd>Shift</kbd><kbd>Enter</kbd> new line</span>
    </div>
  </div>;
}
