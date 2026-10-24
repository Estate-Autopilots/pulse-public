// CHAT-WORK: the composer's slash commands, one registry. A lane adds its own with registerChatCommand (a name, the
// line shown in the composer's list and what it does); the composer lists those that match what is typed after "/"
// and runs the one sent. Built in: /task (make a task from the chat), /tasks, /projects and /steps (what this group's
// people are working on, shown to the asker only, with Share in chat).
import { FolderKanban, ListChecks, ListTodo, Workflow, type LucideIcon } from "lucide-react";
import type { Channel } from "./types";

export type WorkKind = "tasks" | "projects" | "steps";
export type ChatCommandContext = {
  channel: Channel;
  /** What follows the command ("/task Book the drone" gives "Book the drone"). */
  args: string;
  makeTask: (title: string) => void;
  showWork: (kind: WorkKind) => void;
};
export type ChatCommand = { name: string; hint: string; detail?: string; icon: LucideIcon; run: (ctx: ChatCommandContext) => void;
  /** Picking it from the list leaves "/name " to type after (otherwise picking runs it). */
  takesText?: boolean;
  /** Offered only where this says so (for example, not in a direct message). */
  when?: (channel: Channel) => boolean };

const registry = new Map<string, ChatCommand>();
export function registerChatCommand(command: ChatCommand) { registry.set(command.name.toLowerCase(), command); }
/** Commands whose name starts with what is typed after "/", in the order they were added. */
export function chatCommands(typed: string, channel: Channel): ChatCommand[] {
  const q = typed.split(/\s/)[0].toLowerCase();
  return [...registry.values()].filter((c) => c.name.startsWith(q) && (!c.when || c.when(channel)));
}
/** The command a sent line names ("/tasks", "/task Book the drone"), or null when it is an ordinary message. */
export function findChatCommand(text: string, channel: Channel): { command: ChatCommand; args: string } | null {
  const m = text.trim().match(/^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i);
  const command = m ? registry.get(m[1].toLowerCase()) : undefined;
  return command && (!command.when || command.when(channel)) ? { command, args: (m?.[2] ?? "").trim() } : null;
}

registerChatCommand({ name: "task", hint: "Make a task from this chat", detail: "Type what needs doing, then Enter", icon: ListChecks, takesText: true, run: (x) => x.makeTask(x.args) });
registerChatCommand({ name: "tasks", hint: "Open tasks of this group’s people", detail: "Only you see the list; share it if you like", icon: ListTodo, run: (x) => x.showWork("tasks") });
registerChatCommand({ name: "projects", hint: "Projects this group works on", detail: "Only you see the list; share it if you like", icon: FolderKanban, run: (x) => x.showWork("projects") });
registerChatCommand({ name: "steps", hint: "Flow steps this group has open", detail: "Live runs only", icon: Workflow, run: (x) => x.showWork("steps") });
