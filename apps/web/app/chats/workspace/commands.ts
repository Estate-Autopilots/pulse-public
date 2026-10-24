"use client";
// CHAT-SHELL (22 Oct 2026): the side panel's slash commands. A conversation's message box uses CHAT-WORK's one registry
// (chats/commands.ts: /task, /tasks, /projects, /steps; CHAT-VOICE's /call and /video); this adds /open and /profile
// to it. The chat home's box has no conversation, so it offers its own short list (homeCommands) that opens places
// beside the chat instead.
import { FolderKanban, ListChecks, ListTodo, SquareArrowOutUpRight, User, type LucideIcon } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { openCreate } from "../../create";
import { detectIntent } from "../../lib/chat-intent.mjs";
import { panelTarget } from "../../lib/panel-target.mjs";
import { registerChatCommand } from "../commands";
import { knownProjects } from "./intent";
import { openInPanel, showLauncher } from "./tabs";

/** "/open finance", "/open https://docs.google.com/…": a link as it is, else the place the words name. */
export function openPlace(words: string, viewer: string) {
  const w = words.trim();
  if (!w) { showLauncher(); return true; }
  if (panelTarget(w, window.location.origin)) return openInPanel(w);
  const best = detectIntent(`open ${w}`, { viewer, projects: knownProjects() })[0];
  if (best) return openInPanel({ href: best.href, title: best.label.split(" → ").pop(), coach: best.coach ?? null });
  notify({ id: "chat-open", tone: "info", title: `Nothing in Pulse is called “${w.slice(0, 40)}”`, message: "Try a page name such as My steps or Finance, or paste a link.", timeout: 3500 });
  showLauncher();
  return false;
}
const viewerId = () => document.body.dataset.viewer ?? "";

registerChatCommand({ name: "open", hint: "Open a page, a Doc or a link beside the chat", detail: "/open finance · /open a Drive link", icon: SquareArrowOutUpRight, takesText: true, run: (x) => { openPlace(x.args, viewerId()); } });
registerChatCommand({ name: "profile", hint: "Your profile, beside the chat", icon: User, run: () => { openInPanel({ href: "/me/profile", title: "My profile" }); } });

export type HomeCommand = { name: string; hint: string; icon: LucideIcon; takesArgs?: boolean; run: (args: string, viewer: string) => void };
const HOME: HomeCommand[] = [
  { name: "open", hint: "Open a page, a Doc or a link beside the chat", icon: SquareArrowOutUpRight, takesArgs: true, run: (a, v) => { openPlace(a, v); } },
  { name: "task", hint: "Make a task", icon: ListChecks, takesArgs: true, run: (a) => openCreate({ kind: "task", title: a.slice(0, 120) }) },
  { name: "tasks", hint: "Your tasks, beside the chat", icon: ListTodo, run: () => { openInPanel({ href: "/tasks?scope=me", title: "My tasks" }); } },
  { name: "projects", hint: "Work projects, beside the chat", icon: FolderKanban, run: () => { openInPanel({ href: "/tasks?view=projects", title: "Projects" }); } },
  { name: "profile", hint: "Your profile, beside the chat", icon: User, run: () => { openInPanel({ href: "/me/profile", title: "My profile" }); } },
];
/** The chat home's commands that start with `typed`. */
export const homeCommands = (typed: string) => HOME.filter((c) => c.name.startsWith(typed.toLowerCase()));
/** "/name words" on the chat home: runs it; false when it is not one. */
export function runHomeCommand(text: string, viewer: string) {
  const m = text.trim().match(/^\/([a-z]+)\b\s*([\s\S]*)$/i); const c = m ? HOME.find((x) => x.name === m[1].toLowerCase()) : undefined;
  if (!c) return false; c.run(m![2].trim(), viewer); return true;
}
