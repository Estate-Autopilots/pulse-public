"use client";
// CHAT-SHELL (22 Oct 2026): Pulse notices what a message or an assigned task is about. The rules (lib/chat-intent.mjs)
// name the place and how sure they are; here the chat acts on it: clearly meant (a direct message, a task given to
// you, or a group message that mentions you) and opened while the conversation is on screen, the place opens beside
// the chat by itself, once, with Pip pointing at the control; otherwise a one-tap chip under the message offers it.
// A model can be plugged in later with registerIntentModel(); the rules always run first and win when they are sure.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { decide, detectIntent, type Intent, type IntentContext } from "../../lib/chat-intent.mjs";
import { openInPanel } from "./tabs";
import type { Channel, ChatData, ChatMessage } from "../types";
import css from "./workspace.module.css";

type Model = (text: string, ctx: IntentContext) => Promise<Intent[]>;
let model: Model | null = null;
/** The seam for a model: it is asked only when the rules are not sure, and its guesses never open anything by themselves. */
export function registerIntentModel(fn: Model | null) { model = fn; }
/** Each decision the chat takes is logged for tuning (never read back to act). */
export function logDecision(d: { source: "typed" | "message" | "voice" | "task" | "home"; text: string; channelId?: string; messageId?: string; action: "auto" | "chip" | "none" | "taken"; intent?: Intent | null }) {
  void fetch("/api/v0/chats/intent/decision", { method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
    body: JSON.stringify({ text: d.text, source: d.source, channelId: d.channelId, messageId: d.messageId, decided: { action: d.action, href: d.intent?.href, confidence: d.intent?.confidence, by: d.intent?.source === "model" ? "model" : "rules" } }) }).catch(() => {});
}
// CHAT-SHELL v2: the model on this server (the AI employees' runtime, else its stub), asked only when the rules are unsure.
registerIntentModel(async (text) => {
  const r = await fetch("/api/v0/chats/intent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!r.ok) return [];
  const d = await r.json() as { answers?: { target: { href: string; label: string }; confidence: number; why: string }[]; model?: string };
  return (d.answers ?? []).map((a) => ({ id: `model:${a.target.href}`, label: a.target.label, href: a.target.href, confidence: a.confidence, reason: a.why, source: "model" as const }));
});
export async function resolveIntent(text: string, ctx: IntentContext): Promise<Intent[]> {
  const rules = detectIntent(text, ctx);
  if (!model || decide(rules).auto) return rules;
  try { const extra = (await model(text, ctx)).map((i) => ({ ...i, source: "model" as const, confidence: Math.min(i.confidence, 0.8) })); return [...rules, ...extra].sort((a, b) => b.confidence - a.confidence); }
  catch { return rules; }
}

// The work projects named in messages are read once per visit (one small list), then kept.
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

/** What a message asks of the reader, in words the rules read: its text and the tasks attached to it. */
const textOf = (m: ChatMessage) => [m.body, ...m.attachments.filter((a) => a.task).map((a) => a.name)].filter(Boolean).join("\n");
const directedAt = (m: ChatMessage, channel: Channel, viewer: string, username: string | null) =>
  channel.kind === "direct" || m.attachments.some((a) => a.task) || (!!username && m.mentions?.some((u) => u.toLowerCase() === username.toLowerCase())) || m.mentions?.includes(viewer);

const cache = new Map<string, Intent[]>();
function intentsFor(m: ChatMessage, ctx: IntentContext, directed: boolean) {
  const k = `${m.id}|${m.editedAt ?? ""}|${directed ? 1 : 0}|${ctx.projects?.length ?? 0}`;
  let hit = cache.get(k);
  if (!hit) { hit = m.removed || m.kind === "event" ? [] : detectIntent(textOf(m), { ...ctx, directed }); cache.set(k, hit); if (cache.size > 600) cache.delete(cache.keys().next().value!); }
  return hit;
}

const OPENED = "pulse.intent.opened";
const opened = () => { try { return new Set<string>(JSON.parse(window.sessionStorage.getItem(OPENED) ?? "[]")); } catch { return new Set<string>(); } };
const remember = (id: string) => { try { const s = opened(); s.add(id); window.sessionStorage.setItem(OPENED, JSON.stringify([...s].slice(-200))); } catch { /* storage unavailable */ } };
const phone = () => window.matchMedia("(max-width: 899.98px)").matches;

/** Opens the place a new message clearly means, once per message: the newest one from someone else that arrived
 *  unread or while the conversation is open. On a phone it never covers the chat by itself: the chip offers it. */
export function useAutoOpen(messages: readonly ChatMessage[], channel: Channel, viewer: string, username: string | null, unreadAtOpen: number) {
  const ctx = useContext(Ctx);
  const since = useRef<string | null>(null);
  useEffect(() => {
    if (!ctx || !messages.length || channel.moderationOnly) return;
    if (since.current === null) {
      // Messages that were unread when the chat opened count as new; older ones were already seen.
      const theirs = messages.filter((m) => m.authorId !== viewer && m.kind !== "event");
      since.current = unreadAtOpen > 0 ? theirs[Math.max(0, theirs.length - unreadAtOpen)]?.createdAt ?? "" : messages[messages.length - 1].createdAt;
      if (!unreadAtOpen) return;
    }
    const fresh = [...messages].reverse().find((m) => m.authorId !== viewer && !m.pending && m.kind !== "event" && m.createdAt >= since.current!);
    if (!fresh || phone()) return;
    since.current = messages[messages.length - 1].createdAt;
    const seen = opened(); if (seen.has(fresh.id)) return;
    const { auto } = decide(intentsFor(fresh, ctx, directedAt(fresh, channel, viewer, username)));
    if (!auto) return;
    remember(fresh.id);
    logDecision({ source: fresh.attachments.some((a) => a.task) ? "task" : "message", text: textOf(fresh), channelId: channel.id, messageId: fresh.id, action: "auto", intent: auto });
    openInPanel({ href: auto.href, title: auto.label.split(" → ").pop(), coach: auto.coach ?? null, reason: auto.reason, auto: true });
  }, [ctx, messages, channel, viewer, username, unreadAtOpen]);
}

/** The model's guesses for a message the rules said nothing about, asked once per message. */
const asked = new Map<string, Intent[] | null>();
// CHAT-V3 (speed): the model is asked only about a message meant for me (a direct chat, a mention, a task) that is at
// most 10 minutes old. It was asked about every message on screen without a rule match: opening a busy group sent ~40
// requests of ~1.5 s each (telemetry: 231 POST /chats/intent in one evening).
function useModelGuess(key: string, text: string, skip: boolean, at = "") {
  const [, bump] = useState(0);
  useEffect(() => {
    if (skip || asked.has(key) || text.trim().length < 8 || !(Date.now() - Date.parse(at) < 10 * 60000)) return;
    asked.set(key, null);
    void resolveIntent(text, {}).then((list) => { asked.set(key, list.filter((i) => i.source === "model")); bump((n) => n + 1); }).catch(() => asked.set(key, []));
  }, [key, text, skip, at]);
  return asked.get(key) ?? [];
}

/** The one-tap chips under a message: "Open My profile". The one already opened by itself shows as opened. A voice
 *  note's transcript (`said`) is read like a typed message. */
export function IntentChips({ m, channel, viewer, username, said }: { m: ChatMessage; channel: Channel; viewer: string; username: string | null; said?: string | null }) {
  const ctx = useContext(Ctx);
  const theirs = !!ctx && m.authorId !== viewer && !m.pending;
  const msg = said ? { ...m, body: [m.body, said].filter(Boolean).join("\n"), editedAt: `${m.editedAt ?? ""}+said` } : m;
  const list = theirs ? intentsFor(msg, ctx!, directedAt(m, channel, viewer, username)) : [];
  const ruled = decide(list);
  const guess = useModelGuess(`${m.id}|${said ? 1 : 0}`, textOf(msg), !theirs || !!ruled.auto || ruled.chips.length > 0 || m.removed || m.kind === "event" || !directedAt(m, channel, viewer, username), m.createdAt);
  const all = [ruled.auto, ...ruled.chips, ...decide(guess).chips].filter((i): i is Intent => !!i).slice(0, 2);
  const logged = useRef(false);
  useEffect(() => { if (all.length && !logged.current && !ruled.auto) { logged.current = true; logDecision({ source: said ? "voice" : "message", text: textOf(msg), channelId: channel.id, messageId: m.id, action: "chip", intent: all[0] }); } });
  if (!all.length) return null;
  return <div className={css.chips}>{all.map((i) => <button key={i.id} type="button" className={css.chip} title={`Pip: this message ${i.reason}`}
    onClick={() => { remember(m.id); logDecision({ source: said ? "voice" : "message", text: textOf(msg), channelId: channel.id, messageId: m.id, action: "taken", intent: i }); openInPanel({ href: i.href, title: i.label.split(" → ").pop(), coach: i.coach ?? null, reason: i.reason }); }}>
    <Sparkles size={12} aria-hidden="true" /><span>Open {i.label.split(" → ").pop()}</span></button>)}</div>;
}

/** What the person just typed and sent: clearly a place ("open my steps", "I'll update the Riverside project now")
 *  opens beside the chat; otherwise nothing (their own words never get a chip). */
export function useTypedIntent(channelId: string) {
  const ctx = useContext(Ctx);
  return (text: string) => {
    if (!ctx || phone()) return;
    const { auto } = decide(detectIntent(text, ctx));
    logDecision({ source: "typed", text, channelId, action: auto ? "auto" : "none", intent: auto });
    if (auto) openInPanel({ href: auto.href, title: auto.label.split(" → ").pop(), coach: auto.coach ?? null, reason: auto.reason, auto: true });
  };
}
