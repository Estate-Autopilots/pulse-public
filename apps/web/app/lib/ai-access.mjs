// AI-ACCESS (owner, 23 Nov 2026): the words of Settings → AI access, in one place so the page and its test read the same.
// Five parts of what a connected AI app (Claude, ChatGPT, the pulse command) may do, each On its own / Ask first / Never:
// the same three choices as an AI employee's "on its own / ask first" (risk policy), plus Never. The API classifies every
// tool into these parts (services/api/src/v1-ai-access.ts toolGroup); the database keeps the rules (migration 2536).

/** @typedef {"read" | "work" | "messages" | "money" | "delete"} Group */
/** @typedef {"on" | "ask" | "off"} Rule */

/** @type {readonly Group[]} */
export const GROUP_ORDER = Object.freeze(["read", "work", "messages", "money", "delete"]);

/** What each part covers, in plain words (6th-grade level). `verb` finishes "… wants to". */
export const GROUP_TEXT = Object.freeze({
  read: { label: "Read", hint: "Tasks, docs, chats, people", verb: "read your work" },
  work: { label: "Make and change", hint: "Tasks, leads, quotes, docs", verb: "make or change work" },
  messages: { label: "Send messages", hint: "Chats, emails, sending quotes", verb: "send a message" },
  money: { label: "Money", hint: "Bills, payments, stock", verb: "do something with money" },
  delete: { label: "Delete", hint: "Delete, archive, cancel", verb: "delete or archive something" },
});

/** The three choices, as the drop-downs say them. */
export const RULE_TEXT = Object.freeze({ on: "On its own", ask: "Ask first", off: "Never" });

/** Which app a connection's name is, for its small mark. */
export function appKind(name) {
  const n = String(name ?? "");
  if (/claude/i.test(n)) return "claude";
  if (/chatgpt|openai/i.test(n)) return "chatgpt";
  if (/pulse (cli|command)|command line|\bcli\b|terminal/i.test(n)) return "cli";
  return "other";
}

const ROLE = Object.freeze({ admin: "an admin", hr: "in HR", leadership: "in leadership", manager: "a manager", finance: "in finance", sales: "in sales", sales_head: "a sales head" });
/** A role key as a sentence part: "Everyone who is " + roleName(key). */
export function roleName(key) {
  return ROLE[key] ?? String(key ?? "").replaceAll("_", " ");
}

const VERBS = [[/^(list|get|search|find|read|fetch|my|who|attendance)/, "Looked at"], [/^create|^add|^draft|^make|^record/, "Made"],
  [/^(update|revise|set|change|correct|move|assign|place|link|bulk)/, "Changed"], [/^(send|email|post)/, "Sent"], [/^complete/, "Finished"],
  [/^(delete|archive|discard|remove|revoke|cancel)/, "Deleted"], [/^undo/, "Took back"], [/^approve/, "Approved"], [/^issue/, "Issued"]];
const SPECIAL = Object.freeze({ useOrganisation: "Switched company", listMyOrganisations: "Looked at your companies", whoAmI: "Checked who you are", mcpTransport: "Connected" });
/** One AI action in plain words: "createTask" → "Made a task", "listTasks" → "Looked at tasks". */
export function actionWords(operationId) {
  const id = String(operationId ?? "");
  if (SPECIAL[id]) return SPECIAL[id];
  const words = id.replace(/([A-Z])/g, " $1").toLowerCase().trim().split(/\s+/);
  const verb = VERBS.find(([re]) => re.test(id));
  const rest = words.slice(1).join(" ");
  if (!verb) return rest ? `${words[0][0].toUpperCase()}${words[0].slice(1)} ${rest}` : id;
  const single = rest && !rest.endsWith("s") && verb[1] !== "Looked at" ? `a ${rest}` : rest;
  return `${verb[1]} ${single || "something"}`.trim();
}
/** What happened to it. */
export function outcomeWords(status, rule) {
  if (status < 400) return rule === "approved" ? "done after a yes" : "done";
  if (rule === "ask") return "waiting for a yes";
  if (rule === "off") return "stopped by your rules";
  return "stopped";
}
/** The log, with the same action and outcome in a row shown once with how many times. */
export function groupLog(recent) {
  const out = [];
  for (const a of recent ?? []) {
    const what = actionWords(a.operation), how = outcomeWords(a.status, a.rule), last = out.at(-1);
    if (last && last.what === what && last.how === how) last.times++;
    else out.push({ what, how, at: a.at, ok: a.status < 400, times: 1 });
  }
  return out;
}
/** A request's summary ("Create a task: title: Call the plumber; dueOn: …") as a title and its details. */
export function askParts(summary) {
  const s = String(summary ?? ""), i = s.indexOf(": ");
  return i > 0 ? { title: s.slice(0, i), details: s.slice(i + 2) } : { title: s, details: "" };
}
