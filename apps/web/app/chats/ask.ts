"use client";
// CHAT-V4 (24 Oct 2026): /ask asks an AI employee from any conversation. "/ask Mira what is due this week": when Mira is
// in this conversation the question is sent here as an @mention (she answers in the conversation, as when named);
// otherwise her direct chat opens with the question written, ready to send (nothing is sent anywhere unseen).
import { Sparkles } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { registerChatCommand, type ChatCommandContext } from "./commands";
import { cachedList } from "./store";
import type { Member } from "./types";

/** The AI employee "/ask" names by its first word (a first name or a username, "@" allowed), and the question after it. */
export function askTarget(args: string, people: Member[]): { ai: Member; question: string } | null {
  const [word = "", ...rest] = args.trim().split(/\s+/);
  const w = word.replace(/^@/, "").replace(/[,:]+$/, "").toLowerCase();
  if (!w) return null;
  const ais = people.filter((p) => p.agent);
  const ai = ais.find((p) => p.username?.toLowerCase() === w) ?? ais.find((p) => p.name.toLowerCase() === w) ?? ais.find((p) => p.name.toLowerCase().split(/\s+/)[0] === w);
  return ai ? { ai, question: rest.join(" ").trim() } : null;
}
export const DIRECT_EVENT = "pulse:chat-direct";

function ask(x: ChatCommandContext) {
  const people = cachedList()?.people ?? [];
  const found = askTarget(x.args, [...(x.members ?? []), ...people]);
  const names = people.filter((p) => p.agent).map((p) => p.name.split(" ")[0]).slice(0, 4);
  if (!found) { notify({ id: "chat-ask", tone: "info", title: "Who should answer?", message: names.length ? `Type /ask and a name: ${names.join(", ")}.` : "No AI employees here yet.", timeout: 4000 }); return; }
  const { ai, question } = found;
  const here = x.members?.some((m) => m.id === ai.id);
  if (here && question && ai.username && x.send) { x.send(`@${ai.username} ${question}`); return; }
  window.dispatchEvent(new CustomEvent(DIRECT_EVENT, { detail: { personId: ai.id, draft: question } }));
  if (question) notify({ id: "chat-ask", tone: "info", title: `${ai.name.split(" ")[0]} isn’t in this conversation`, message: "Your question is written in your chat with them. Press Enter to send it.", timeout: 4000 });
}

registerChatCommand({ name: "ask", hint: "Ask an AI employee", detail: "/ask Mira what is due this week", icon: Sparkles, takesText: true, run: ask });
