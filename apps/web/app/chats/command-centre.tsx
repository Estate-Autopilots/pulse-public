"use client";
// UX-SIMPLE (owner, 28 Oct 2026): "Everything happens in chat." The commands a conversation's box runs inline: each
// reads its words without a server (lib/chat-commands.mjs), shows a card with what will happen, and changes nothing
// until Confirm. Every write goes to an endpoint the rest of Pulse already uses, so the API's own permissions decide
// (a person who may not give work, file leave for someone or decide an approval gets the API's refusal on the card).
// Commands that need a form Pulse already has (a quotation, a bill's photo) open that form beside the chat.
import { AlarmClock, ArrowRightLeft, Bug, CalendarClock, CalendarOff, CheckCheck, CheckCircle2, FileText, FolderKanban, FolderOpen, Gauge, ListChecks, NotebookText, ReceiptIndianRupee,
  Search, ThumbsDown, UserPlus, Video, Wallet, XCircle, type LucideIcon } from "lucide-react";
import { registerChatCommand, type ChatCommandContext, type CommandCard } from "./commands";
import { cachedThread } from "./store";
import { get, send } from "./net";
import { openInPanel } from "./workspace/tabs";
import { showCommandCard } from "./command-card";
import { startCall } from "../calls/call-host";
import { amountOf, chatDigest, leaveRange, localDay, remindAt, whoWhen } from "../lib/chat-commands.mjs";
import { FALLBACK_ZONE } from "../lib/zone.mjs";
import type { ChatMessage, Member } from "./types";

type TaskHit = { id: string; title: string; statusLabel: string; assigneeName: string | null };
type HealthRow = { id: string; title: string; client: string | null; health: string; why: string; open: number; late: number; next: { title: string; who: string | null; due: string | null } | null };
type SearchGroup = { key: string; label: string; items: { id: string; title: string; sub?: string | null; href: string; kind: string }[] };
type LeaveType = { key: string; name: string; active?: boolean };

const today = (x: ChatCommandContext) => x.today ?? localDay(new Date());
// A calendar day is the same everywhere (read at UTC midnight); a moment is shown in the company's zone.
const dayWords = (iso: string | null) => iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }) : "No due day";
const timeWords = (d: Date, zone: string) => d.toLocaleString("en-IN", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const first = (name: string | null | undefined) => String(name ?? "").split(" ")[0];
const HEALTH: Record<string, string> = { blocked: "Blocked", waiting: "Waiting on the client", at_risk: "At risk", watch: "Watch", on_track: "On track" };
const show = (x: ChatCommandContext, card: CommandCard) => x.preview?.(card);
const needWords = (x: ChatCommandContext, title: string, example: string, icon: CommandCard["icon"]) => show(x, { title, icon, note: `Type it like this: ${example}` });

/** The open task the words name (the best match the chat's # search finds), or a card saying none did. */
async function findTask(x: ChatCommandContext, words: string, title: string, icon: CommandCard["icon"]): Promise<TaskHit | null> {
  const q = words.replace(/^#/, "").trim();
  if (!q) { needWords(x, title, `/${title.toLowerCase().split(" ")[0]} part of the task's name`, icon); return null; }
  try {
    const d = await get<{ tasks: TaskHit[] }>(`chats/tasks?q=${encodeURIComponent(q)}`);
    if (!d.tasks.length) { show(x, { title, icon, note: `No open task matches “${q.slice(0, 60)}”. Try other words from its name.` }); return null; }
    return d.tasks[0];
  } catch (e) { show(x, { title, icon, error: (e as Error).message }); return null; }
}
/** Splits "/assign the deck @rila" into the task words and the person. */
function personIn(x: ChatCommandContext, args: string): { words: string; person: Member | null } {
  const r = whoWhen(args, { members: x.members ?? [], today: today(x), viewer: x.viewer });
  const words = args.replace(/(?:^|\s)@[\w.-]+/g, " ").replace(/\s+/g, " ").trim();
  return { words, person: r.person as Member | null };
}

// ── Work ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function taskCmd(x: ChatCommandContext) {
  const r = whoWhen(x.args, { members: x.members ?? [], today: today(x), viewer: x.viewer });
  if (!r.text) { x.makeTask(""); return; }
  const who = r.person && !r.self ? r.person : null;
  // KAZUK (Kazuk's screen 3): in a project's chat the task lands in that project, on the plan step its words suggest.
  const home = await get<{ project: { id: string; title: string } | null; step: { id: string; title: string } | null }>(`projects/for-chat/${x.channel.id}?text=${encodeURIComponent(r.text)}`).catch(() => null);
  const project = home?.project ?? null, step = project ? home?.step ?? null : null;
  show(x, { title: "New task", icon: ListChecks, lines: [{ label: "What", value: r.text }, { label: "Who", value: who ? who.name : "You" }, { label: "Due", value: dayWords(r.dueOn) },
    ...(project ? [{ label: "Project", value: project.title }] : []), ...(step ? [{ label: "Step", value: `${step.id} ${step.title} (suggested)` }] : [])],
    note: "Add a person with @name and a day like “fri” or “3 Nov”.",
    more: { label: "More details", run: () => x.makeTask(r.text) },
    confirm: { label: who ? `Give it to ${first(who.name)}` : "Make the task", run: async () => {
      const t = await send<{ id: string; title?: string }>("work/tasks", { title: r.text, ...(who ? { assigneeId: who.id } : {}), ...(r.dueOn ? { dueOn: r.dueOn } : {}), ...(project ? { projectId: project.id } : {}) });
      if (t?.id && project && step) await send(`projects/${project.id}/step`, { taskId: t.id, step: step.id }).catch(() => null);
      if (t?.id) x.attach?.("", [{ task: t.id, name: r.text.slice(0, 300) }]);
      return who ? `Task given to ${first(who.name)}` : "Task made";
    } } });
}
async function doneCmd(x: ChatCommandContext) {
  const t = await findTask(x, x.args, "Mark done", CheckCheck); if (!t) return;
  show(x, { title: "Mark done", icon: CheckCheck, lines: [{ label: "Task", value: t.title }, { label: "Now", value: t.statusLabel }, ...(t.assigneeName ? [{ label: "Who", value: t.assigneeName }] : [])],
    confirm: { label: "Mark it done", run: async () => { await send(`tasks/${t.id}/move`, { status: "done" }); return "Marked done"; } },
    open: { label: "Open the task", href: `/tasks/${t.id}`, title: t.title } });
}
async function assignCmd(x: ChatCommandContext, handoff = false) {
  const title = handoff ? "Hand over" : "Give a task";
  const icon = handoff ? ArrowRightLeft : UserPlus;
  const { words, person } = personIn(x, x.args);
  if (!person) { needWords(x, title, `/${handoff ? "handoff" : "assign"} part of the task's name @name${handoff ? " and a note" : ""}`, icon); return; }
  const [taskWords, note] = handoff ? words.split(/\s+(?:—|--|:)\s+/, 2) : [words, ""];
  const t = await findTask(x, taskWords, title, icon); if (!t) return;
  show(x, { title, icon, lines: [{ label: "Task", value: t.title }, { label: "From", value: t.assigneeName ?? "Nobody yet" }, { label: "To", value: person.name }, ...(note ? [{ label: "Note", value: note }] : [])],
    note: handoff ? "They are told, with your note. If they must accept first, Pulse asks them." : undefined,
    confirm: { label: `Give it to ${first(person.name)}`, run: async () => {
      await send(`work/tasks/${t.id}/assign`, { personId: person.id, ...(note || handoff ? { note: note || "Handed over in chat" } : {}) });
      return `Sent to ${first(person.name)}`;
    } } });
}
async function dueCmd(x: ChatCommandContext) {
  const r = whoWhen(x.args, { members: [], today: today(x) });
  if (!r.dueOn) { needWords(x, "Change the due day", "/due part of the task's name fri", CalendarClock); return; }
  const t = await findTask(x, r.text, "Change the due day", CalendarClock); if (!t) return;
  show(x, { title: "Change the due day", icon: CalendarClock, lines: [{ label: "Task", value: t.title }, { label: "New due day", value: dayWords(r.dueOn) }],
    confirm: { label: "Change it", run: async () => { await send(`tasks/${t.id}`, { dueOn: r.dueOn }); return `Due ${dayWords(r.dueOn)}`; } } });
}
function remindCmd(x: ChatCommandContext) {
  const r = remindAt(x.args);
  if (!r || !r.text) { needWords(x, "Remind me", "/remind tomorrow 10am send the GST file · /remind in 2h call Neha", AlarmClock); return; }
  const zone = x.zone ?? FALLBACK_ZONE;
  show(x, { title: "Remind me", icon: AlarmClock, lines: [{ label: "What", value: r.text }, { label: "When", value: timeWords(r.at, zone) }],
    note: "It becomes a task for you, due at that time, so it sits in your list and your day.",
    confirm: { label: "Set it", run: async () => { await send("work/tasks", { title: r.text.charAt(0).toUpperCase() + r.text.slice(1), dueAt: r.at.toISOString() }); return `Reminder set for ${timeWords(r.at, zone)}`; } } });
}
async function statusCmd(x: ChatCommandContext) {
  try {
    const h = await get<{ rows: { id: string; title: string; status: string; dueOn: string | null }[]; today: string }>("tasks/home");
    const open = h.rows.filter((t) => ["open", "in_progress", "blocked"].includes(t.status));
    const late = open.filter((t) => t.dueOn && t.dueOn < h.today).length, due = open.filter((t) => t.dueOn === h.today).length, blocked = open.filter((t) => t.status === "blocked").length;
    const next = [...open].sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999")).slice(0, 4);
    const line = `My day: ${open.length} open · ${due} due today · ${late} late${blocked ? ` · ${blocked} blocked` : ""}`;
    show(x, { title: "My day", icon: Gauge, lines: [{ label: "Open", value: String(open.length) }, { label: "Due today", value: String(due) }, { label: "Late", value: String(late) }, ...(blocked ? [{ label: "Blocked", value: String(blocked) }] : [])],
      items: next.map((t) => ({ title: t.title, sub: dayWords(t.dueOn), href: `/tasks/${t.id}` })), share: line, open: { label: "Open my work", href: "/tasks", title: "My work" } });
  } catch (e) { show(x, { title: "My day", icon: Gauge, error: (e as Error).message }); }
}

// ── Projects, money and time off ───────────────────────────────────────────────────────────────────────────────────
async function projectCmd(x: ChatCommandContext) {
  const words = x.args.trim();
  if (/^(new|create|from)\b/i.test(words) || /\bquote\b/i.test(words)) {
    show(x, { title: "Start a project from a quote", icon: FolderKanban, note: "Open the signed quotation and press Start the project: every sold line becomes a task.",
      open: { label: "Open quotations", href: "/erp/documents", title: "Quotations" } });
    return;
  }
  const q = words.replace(/^(open|status|show)\s+/i, "").toLowerCase();
  try {
    const d = await get<{ rows: HealthRow[] }>("projects/health?scope=all");
    const rows = q ? d.rows.filter((r) => `${r.title} ${r.client ?? ""}`.toLowerCase().includes(q)) : d.rows;
    if (!rows.length) { show(x, { title: "Projects", icon: FolderKanban, note: q ? `No project you can see matches “${q.slice(0, 60)}”.` : "No active projects you can see." }); return; }
    if (rows.length > 1 && !q) {
      show(x, { title: "Projects that need you first", icon: FolderKanban, items: rows.slice(0, 6).map((r) => ({ title: r.title, sub: `${HEALTH[r.health] ?? r.health} · ${r.why}`, href: `/tasks/projects/${r.id}` })),
        open: { label: "All projects", href: "/projects", title: "Projects" } });
      return;
    }
    const p = rows[0];
    show(x, { title: p.title, icon: FolderKanban, lines: [{ label: "Health", value: `${HEALTH[p.health] ?? p.health}` }, { label: "Why", value: p.why }, { label: "Open tasks", value: `${p.open}${p.late ? ` · ${p.late} late` : ""}` },
      ...(p.next ? [{ label: "Next step", value: `${p.next.title}${p.next.who ? ` · ${p.next.who}` : ""}` }] : [])],
      share: `${p.title}: ${HEALTH[p.health] ?? p.health} (${p.why}). ${p.open} open${p.late ? `, ${p.late} late` : ""}.`,
      open: { label: "Open the project", href: `/tasks/projects/${p.id}`, title: p.title } });
  } catch (e) { show(x, { title: "Projects", icon: FolderKanban, error: (e as Error).message }); }
}
function billingCmd(x: ChatCommandContext, type: "quotation" | "invoice") {
  const label = type === "quotation" ? "New quotation" : "New invoice";
  show(x, { title: label, icon: type === "quotation" ? FileText : ReceiptIndianRupee, lines: x.args.trim() ? [{ label: "For", value: x.args.trim() }] : undefined,
    note: "Billing's builder opens beside the chat; it keeps the numbering and the client's details.", open: { label: `Open ${label.toLowerCase()}`, href: `/erp/new?type=${type}`, title: label } });
}
async function leaveCmd(x: ChatCommandContext) {
  const r = leaveRange(x.args, today(x));
  if (!r) { needWords(x, "Ask for leave", "/leave sick tomorrow · /leave 3 nov to 5 nov family function · /leave half day fri", CalendarOff); return; }
  let types: LeaveType[] = [];
  try { types = ((await get<{ types?: LeaveType[] }>("hr/self")).types ?? []).filter((t) => t.active !== false); } catch { /* the API answers on Confirm */ }
  const kind = types.find((t) => r.kind && (t.key.toLowerCase().includes(r.kind) || t.name.toLowerCase().includes(r.kind))) ?? types[0];
  if (!kind) { show(x, { title: "Ask for leave", icon: CalendarOff, note: "Leave isn’t set up for you yet. Ask HR.", open: { label: "Open leave", href: "/leave", title: "Leave" } }); return; }
  show(x, { title: "Ask for leave", icon: CalendarOff, lines: [{ label: "Type", value: kind.name }, { label: "From", value: dayWords(r.from) }, ...(r.to !== r.from ? [{ label: "To", value: dayWords(r.to) }] : []),
    ...(r.half ? [{ label: "Half", value: r.half === "first" ? "First half" : "Second half" }] : []), ...(r.reason ? [{ label: "Reason", value: r.reason }] : [])],
    note: types.length > 1 ? `Other types: ${types.filter((t) => t !== kind).map((t) => t.name).slice(0, 4).join(", ")} (name one in the command).` : undefined,
    confirm: { label: "Send to my approver", run: async () => {
      await send("leave", { fromDate: r.from, toDate: r.to, kind: kind.key, ...(r.half ? { halfDay: r.half } : {}), ...(r.reason ? { reason: r.reason } : {}) });
      return "Leave asked for. Your approver is told.";
    } } });
}
function expenseCmd(x: ChatCommandContext) {
  const r = amountOf(x.args);
  if (!r) { needWords(x, "Claim an expense", "/expense ₹450 cab to the site", Wallet); return; }
  show(x, { title: "Claim an expense", icon: Wallet, lines: [{ label: "Amount", value: `₹${r.amount.toLocaleString("en-IN")}` }, ...(r.what ? [{ label: "For", value: r.what }] : [])],
    note: "A claim needs the bill’s photo, so the claim form opens beside the chat to add it.", open: { label: "Add the bill", href: "/me/pay", title: "My claims" } });
}
async function decideCmd(x: ChatCommandContext, approve: boolean) {
  const title = approve ? "Approve" : "Ask for changes";
  const icon = approve ? CheckCircle2 : ThumbsDown;
  const waiting = (cachedThread(x.channel.id)?.messages ?? []).filter((m: ChatMessage) => m.approval?.state === "waiting" && m.authorId !== x.viewer).slice(-1)[0];
  if (!waiting) {
    show(x, { title, icon, note: "Nothing in this chat waits for an approval. Leave, claims and other requests wait in Approvals.", open: { label: "Open Approvals", href: "/me/approvals", title: "Approvals" } });
    return;
  }
  const note = x.args.trim();
  show(x, { title, icon, lines: [{ label: "From", value: waiting.name }, { label: "Message", value: waiting.body.slice(0, 140) || (waiting.attachments[0]?.name ?? "Attachment") }, ...(note ? [{ label: "Note", value: note }] : [])],
    confirm: { label: approve ? "Approve" : "Ask for changes", danger: !approve, run: async () => {
      await send(`chats/messages/${waiting.id}/approval`, { action: approve ? "approved" : "changes", ...(note ? { note } : {}) });
      return approve ? "Approved" : "Changes asked for";
    } } });
}

// ── Find, catch up, Drive, report ────────────────────────────────────────────────────────────────────────────────────
async function findCmd(x: ChatCommandContext) {
  const q = x.args.trim();
  if (q.length < 2) { needWords(x, "Find", "/find brochure · /find Rila · /find GST", Search); return; }
  try {
    const d = await get<{ groups: SearchGroup[] }>(`search?q=${encodeURIComponent(q)}`);
    const items = d.groups.flatMap((g) => g.items.slice(0, 3).map((i) => ({ title: i.title, sub: [g.label, i.sub].filter(Boolean).join(" · "), href: i.href }))).slice(0, 8);
    show(x, { title: `Find “${q.slice(0, 40)}”`, icon: Search, items, note: items.length ? "Only what you may open is listed." : "Nothing you can open matches. Try fewer words." });
  } catch (e) { show(x, { title: "Find", icon: Search, error: (e as Error).message }); }
}
async function summaryCmd(x: ChatCommandContext) {
  const w = x.args.trim().toLowerCase();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (/yesterday/.test(w)) start.setDate(start.getDate() - 1);
  else if (/week/.test(w)) start.setDate(start.getDate() - 6);
  else if (!/today/.test(w)) start.setDate(start.getDate() - 1); // by default, since yesterday morning
  try {
    const d = await get<{ messages: ChatMessage[] }>(`chats/${x.channel.id}/messages`);
    const s = chatDigest(d.messages, { viewer: x.viewer ?? "", since: start.toISOString() });
    if (!s.count) { show(x, { title: "Catch up", icon: NotebookText, note: "Nothing new here in that time." }); return; }
    const who = s.people.map((p) => `${first(p.name)} ${p.n}`).join(", ");
    // An AI employee in this conversation writes the summary when asked (the same @mention /ask sends; it answers here).
    const ai = (x.members ?? []).find((p) => p.agent && p.username);
    const span = /yesterday/.test(w) ? "yesterday" : /week/.test(w) ? "the last 7 days" : /today/.test(w) ? "today" : "since yesterday";
    show(x, { title: `Catch up · ${s.count} message${s.count === 1 ? "" : "s"}`, icon: NotebookText,
      ...(ai && x.send ? { more: { label: `Ask ${first(ai.name)} to write it`, run: () => x.send!(`@${ai.username} please summarise this chat for ${span}: what was decided, open questions, and who is doing what by when.`) } } : {}),
      lines: [{ label: "Who spoke", value: who }, ...(s.tasks ? [{ label: "Tasks shared", value: String(s.tasks) }] : []), ...(s.files ? [{ label: "Files", value: String(s.files) }] : [])],
      items: [...s.questions.map((q) => ({ title: q.body, sub: `Still open · ${first(q.name)}` })), ...s.latest.map((m) => ({ title: m.body, sub: `Latest · ${first(m.name)}` }))],
      note: ai ? `Counted here on your screen. ${first(ai.name)} can write it up in the chat.` : "Counted here on your screen; nothing is sent anywhere. Add an AI employee to this chat to have it written up." });
  } catch (e) { show(x, { title: "Catch up", icon: NotebookText, error: (e as Error).message }); }
}
async function driveCmd(x: ChatCommandContext) {
  const q = x.args.trim().toLowerCase();
  let rows: HealthRow[] = [];
  try { rows = (await get<{ rows: HealthRow[] }>("projects/health?scope=all")).rows; } catch { /* shown below */ }
  const p = q ? rows.find((r) => `${r.title} ${r.client ?? ""}`.toLowerCase().includes(q)) : null;
  show(x, { title: p ? `Drive · ${p.title}` : "Drive", icon: FolderOpen,
    note: "Uploading from Pulse to a project’s Drive folder isn’t switched on yet. Open the project’s files beside the chat and drop them into its folder there.",
    open: p ? { label: "Open the project’s files", href: `/tasks/projects/${p.id}`, title: p.title } : { label: "Open Drive deliveries", href: "/delivery", title: "Deliveries" } });
}
function reportCmd(x: ChatCommandContext) {
  const words = x.args.trim();
  if (words.length < 4) { needWords(x, "Report a problem", "/report the invoice page keeps loading", Bug); return; }
  show(x, { title: "Report a problem", icon: Bug, lines: [{ label: "What", value: words }, { label: "Page", value: "Chats" }], note: "The Pulse team sees it with this page’s address, no screenshot.",
    confirm: { label: "Send the report", run: async () => {
      const r = await send<{ number?: number }>("bug-reports", { words, route: window.location.pathname, platform: "web", commandId: crypto.randomUUID() });
      return r?.number ? `Reported as #${r.number}` : "Reported";
    } } });
}
function meetCmd(x: ChatCommandContext) {
  show(x, { title: x.channel.kind === "direct" ? `Video call with ${x.channel.name}` : `Video call in ${x.channel.name}`, icon: Video, note: "Everyone in this chat is rung.",
    confirm: { label: "Start the call", run: async () => { startCall(x.channel.id, true); return "Calling…"; } } });
}

/** A message's "Add to a project": pick one of the projects you can see; the message becomes a task there, with where it
 *  came from in its notes. The pick is the confirm (nothing is made before it). */
export async function addToProject(m: { text: string; from: string; where: string }) {
  const title = m.text.split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 120) || "From chat";
  let rows: HealthRow[] = [];
  try { rows = (await get<{ rows: HealthRow[] }>("projects/health?scope=all")).rows; } catch (e) { showCommandCard({ title: "Add to a project", icon: FolderKanban, error: (e as Error).message }); return; }
  showCommandCard({ title: "Add to a project", icon: FolderKanban, lines: [{ label: "Task", value: title }, { label: "From", value: `${m.from} in ${m.where}` }],
    note: rows.length ? "Pick the project: the message becomes a task there, with where it came from." : "No active project you can see. Open Projects to start one.",
    items: rows.slice(0, 8).map((p) => ({ title: p.title, sub: `${HEALTH[p.health] ?? p.health} · ${p.open} open`, run: async () => {
      await send("work/tasks", { title, projectId: p.id, notes: `From ${m.from} in ${m.where}: “${m.text.slice(0, 600)}”` });
      return `Added to ${p.title}`;
    } })),
    open: rows.length ? undefined : { label: "Open Projects", href: "/projects", title: "Projects" } });
}

const C = (name: string, hint: string, detail: string, icon: LucideIcon, run: (x: ChatCommandContext) => void | Promise<void>, takesText = true) =>
  registerChatCommand({ name, hint, detail, icon, takesText, run: (x) => { void run(x); } });
C("done", "Mark a task done", "/done brochure draft", CheckCheck, doneCmd);
C("assign", "Give a task to someone", "/assign brochure draft @rila", UserPlus, (x) => assignCmd(x));
C("due", "Change a task’s due day", "/due brochure draft fri", CalendarClock, dueCmd);
C("handoff", "Hand a task over, with a note", "/handoff brochure — @rila: files are in Drive", ArrowRightLeft, (x) => assignCmd(x, true));
C("remind", "Remind me later", "/remind tomorrow 10am send the GST file", AlarmClock, remindCmd);
C("status", "My day: open, due and late", "Share it in the chat if you like", Gauge, statusCmd, false);
C("project", "A project’s health and next step", "/project Greenleaf · /project from quote", FolderKanban, projectCmd);
C("quote", "Make a quotation", "/quote Greenleaf Realty", FileText, (x) => billingCmd(x, "quotation"));
C("invoice", "Make an invoice", "/invoice Greenleaf Realty", ReceiptIndianRupee, (x) => billingCmd(x, "invoice"));
C("leave", "Ask for leave", "/leave sick tomorrow · /leave 3 nov to 5 nov", CalendarOff, leaveCmd);
C("expense", "Claim an expense", "/expense ₹450 cab to the site", Wallet, expenseCmd);
C("approve", "Approve what waits in this chat", "/approve looks good", CheckCircle2, (x) => decideCmd(x, true));
C("reject", "Ask for changes on what waits here", "/reject the logo is too small", XCircle, (x) => decideCmd(x, false));
C("find", "Find tasks, people, files and chats", "/find brochure", Search, findCmd);
C("summary", "Catch up on this chat", "/summary · /summary today · /summary week", NotebookText, summaryCmd);
C("drive", "A project’s Drive files", "/drive Greenleaf", FolderOpen, driveCmd);
C("report", "Report a problem with Pulse", "/report the page keeps loading", Bug, reportCmd);
C("meet", "Start a video call here", "Everyone in this chat is rung", Video, meetCmd, false);
// /task keeps its name and place (CHAT-WORK); it now shows the card first when it can read who or when.
registerChatCommand({ name: "task", hint: "Make a task (add @name and a day)", detail: "/task Send the deck @rila fri", icon: ListChecks, takesText: true, run: taskCmd });

/** The command groups the list and the palette show, the work first. */
export const COMMAND_GROUPS: [string, RegExp][] = [
  ["Work", /^(task|tasks|done|assign|due|handoff|remind|status|steps)$/],
  ["Projects and money", /^(project|projects|quote|invoice|expense|drive)$/],
  ["Time off and approvals", /^(leave|approve|reject)$/],
  ["Find and ask", /^(find|summary|ask|poll)$/],
  ["Calls", /^(call|video|meet)$/],
  ["Open beside the chat", /^(open|profile|report)$/],
];
