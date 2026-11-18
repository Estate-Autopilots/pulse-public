"use client";
// CHAT-SHELL (22 Oct 2026), TASK-MERGE Pip (owner, 7 Nov 2026: "It detects keywords in titles and auto-opens
// irrelevant suggestions on the right on its own"). Pip no longer reads the words of a message or the title of a task
// attached to it. Under a message it offers a place beside the chat only from the message's structure (a task given to
// you, a link to a page in Pulse, a document sent to you; lib/pip-suggest.mjs), only when sure, and every offer has
// "Not useful", remembered for this person on the server. It opens something by itself only when auto-open is switched
// on (off by default, PIP_AUTO_OPEN) and the suggestion is near certain. What a person types to open a place ("/open
// payroll", the chat home's box) still reads their words: that is the person asking (lib/chat-intent.mjs).
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Sparkles, X } from "lucide-react";
import type { IntentContext } from "../../lib/chat-intent.mjs";
import { chatSuggestions, pickSuggestions } from "../../lib/pip-suggest.mjs";
import { PIP_AUTO_OPEN, pipFeedback, usePipFeedback } from "../../lib/pip-feedback";
import { openInPanel } from "./tabs";
import type { Channel, ChatData, ChatMessage } from "../types";
import css from "./workspace.module.css";

/** Each decision the chat takes is logged for tuning (never read back to act). Only the text's length is kept. */
export function logDecision(d: { source: "typed" | "message" | "voice" | "task" | "home"; text: string; channelId?: string; messageId?: string; action: "auto" | "chip" | "none" | "taken"; href?: string; confidence?: number }) {
  void fetch("/api/v0/chats/intent/decision", { method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
    body: JSON.stringify({ text: d.text, source: d.source, channelId: d.channelId, messageId: d.messageId, decided: { action: d.action, href: d.href, confidence: d.confidence, by: "structure" } }) }).catch(() => {});
}

// The work projects (for "/open <project>", which the person types) are read once per visit (one small list), then kept.
let projects: { id: string; name: string }[] | null = null; let reading: Promise<void> | null = null;
function useProjects() {
  const [, bump] = useState(0);
  useEffect(() => {
    if (projects || reading) return;
    reading = fetch("/api/v0/work/projects").then((r) => r.ok ? r.json() : { rows: [] }).then((d: { rows?: { id: string; name: string }[] }) => { projects = (d.rows ?? []).map((r) => ({ id: r.id, name: r.name })); })
      .catch(() => { projects = []; }).finally(() => { reading = null; bump((n) => n + 1); });
  }, []);
  return projects;
}

/** The work projects read so far (for "/open <project>" outside a component). */
export const knownProjects = () => projects ?? [];

const Ctx = createContext<IntentContext | null>(null);
/** What the rules know here (who reads, the people, the projects, the role): for the chat home's box. */
export const useIntentContext = () => useContext(Ctx);
export function IntentProvider({ data, role, modulesOff, children }: { data: ChatData; role?: string; modulesOff?: readonly string[]; children: ReactNode }) {
  const list = useProjects();
  const value = useMemo<IntentContext>(() => ({ viewer: data.viewer, people: data.people.map((p) => ({ id: p.id, name: p.name })), projects: list ?? [], role, modulesOff }), [data.viewer, data.people, list, role, modulesOff]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const directedAt = (m: ChatMessage, channel: Channel, viewer: string, username: string | null) =>
  channel.kind === "direct" || m.attachments.some((a) => a.task) || (!!username && m.mentions?.some((u) => u.toLowerCase() === username.toLowerCase())) || m.mentions?.includes(viewer);
const suggestionsFor = (m: ChatMessage, channel: Channel, viewer: string, username: string | null) => m.removed || m.kind === "event" ? []
  : chatSuggestions(m, { origin: typeof window === "undefined" ? "" : window.location.origin, directed: !!directedAt(m, channel, viewer, username), direct: channel.kind === "direct" });

const OPENED = "pulse.intent.opened";
const opened = () => { try { return new Set<string>(JSON.parse(window.sessionStorage.getItem(OPENED) ?? "[]")); } catch { return new Set<string>(); } };
const remember = (id: string) => { try { const s = opened(); s.add(id); window.sessionStorage.setItem(OPENED, JSON.stringify([...s].slice(-200))); } catch { /* storage unavailable */ } };
const phone = () => window.matchMedia("(max-width: 899.98px)").matches;

/** Only with auto-open switched on: opens the one near-certain suggestion of a new message, once per message (the
 *  newest one from someone else that arrived unread or while the conversation is open). Never on a phone. */
export function useAutoOpen(messages: readonly ChatMessage[], channel: Channel, viewer: string, username: string | null, unreadAtOpen: number) {
  const fb = usePipFeedback();
  const since = useRef<string | null>(null);
  useEffect(() => {
    if (!PIP_AUTO_OPEN || !fb.loaded || !messages.length || channel.moderationOnly) return;
    if (since.current === null) {
      const theirs = messages.filter((m) => m.authorId !== viewer && m.kind !== "event");
      since.current = unreadAtOpen > 0 ? theirs[Math.max(0, theirs.length - unreadAtOpen)]?.createdAt ?? "" : messages[messages.length - 1].createdAt;
      if (!unreadAtOpen) return;
    }
    const fresh = [...messages].reverse().find((m) => m.authorId !== viewer && !m.pending && m.kind !== "event" && m.createdAt >= since.current!);
    if (!fresh || phone()) return;
    since.current = messages[messages.length - 1].createdAt;
    if (opened().has(fresh.id)) return;
    const { auto } = pickSuggestions(suggestionsFor(fresh, channel, viewer, username), { dismissed: fb.dismissed, kinds: fb.kinds, autoOpen: true });
    if (!auto) return;
    remember(fresh.id);
    logDecision({ source: "task", text: "", channelId: channel.id, messageId: fresh.id, action: "auto", href: auto.href, confidence: auto.score });
    openInPanel({ href: auto.href, title: auto.label, reason: auto.reason, auto: true });
  }, [fb, messages, channel, viewer, username, unreadAtOpen]);
}

/** Under a message: at most two one-tap offers, from its structure only, each with "Not useful". */
export function IntentChips({ m, channel, viewer, username }: { m: ChatMessage; channel: Channel; viewer: string; username: string | null; said?: string | null }) {
  const fb = usePipFeedback();
  const theirs = m.authorId !== viewer && !m.pending;
  const { chips } = theirs && fb.loaded ? pickSuggestions(suggestionsFor(m, channel, viewer, username), { dismissed: fb.dismissed, kinds: fb.kinds }) : { chips: [] };
  const logged = useRef(false);
  useEffect(() => { if (chips.length && !logged.current) { logged.current = true; logDecision({ source: "message", text: "", channelId: channel.id, messageId: m.id, action: "chip", href: chips[0].href, confidence: chips[0].score }); } });
  if (!chips.length) return null;
  return <div className={css.chips} data-pip-chips="">{chips.map((s) => <span key={`${s.kind}:${s.subject}`} className={css.chipPair}>
    <button type="button" className={css.chip} title={`Pip: ${s.reason}`}
      onClick={() => { remember(m.id); pipFeedback(s.kind, s.subject, "accept"); logDecision({ source: "message", text: "", channelId: channel.id, messageId: m.id, action: "taken", href: s.href, confidence: s.score }); openInPanel({ href: s.href, title: s.label, reason: s.reason }); }}>
      <Sparkles size={12} aria-hidden="true" /><span>Open {s.label} beside the chat</span></button>
    <button type="button" className={css.chipX} aria-label={`Not useful: hide “Open ${s.label}”`} title="Not useful (Pip will not offer this again)" onClick={() => pipFeedback(s.kind, s.subject, "dismiss")}><X size={12} aria-hidden="true" /></button>
  </span>)}</div>;
}
