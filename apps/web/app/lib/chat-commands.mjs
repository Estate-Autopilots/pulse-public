// UX-SIMPLE (28 Oct 2026): the words after a chat command, read without a server. Pure, so each is unit-tested:
// who and when ("/task Send the deck @rila fri"), a leave's days ("/leave sick tomorrow", "/leave 3 nov to 5 nov"),
// a reminder's moment ("/remind in 2h call Neha", "/remind tomorrow 10am the GST file"), an amount ("/expense ₹450 cab"),
// a line that asks for work without naming anyone ("please send the brochure by Friday"), and a chat's catch-up.
import { DUE_PHRASE, dueDay } from "./task-intent.mjs";

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const tidy = (s) => squash(s).replace(/^[\s,.;:!-]+|[\s,;:!-]+$/g, "");
const pad = (n) => String(n).padStart(2, "0");
/** The local calendar day of a Date, YYYY-MM-DD. */
export const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "/task Send the deck @rila by fri" → { text: "Send the deck", person, dueOn }. `members` are { id, username, name }. */
export function whoWhen(args, { members = [], today, viewer = "" }) {
  let rest = squash(args);
  let person = null;
  const at = rest.match(/(?:^|\s)@([a-z0-9][a-z0-9._-]*)/i);
  if (at) {
    const u = at[1].replace(/[.-]+$/, "").toLowerCase();
    person = members.find((p) => p.username?.toLowerCase() === u) ?? members.find((p) => p.name?.toLowerCase().split(/\s+/)[0] === u) ?? null;
    if (person) rest = squash(rest.slice(0, at.index) + " " + rest.slice(at.index + at[0].length));
  }
  let dueOn = null;
  const d = rest.match(DUE_PHRASE);
  if (d && today) { dueOn = dueDay(d[1], today); if (dueOn) rest = squash(rest.slice(0, d.index) + " " + rest.slice(d.index + d[0].length)); }
  const text = tidy(rest.replace(/^(please|pls|plz|kindly)\s+/i, ""));
  return { text: text ? text.charAt(0).toUpperCase() + text.slice(1) : "", person, self: !person || person.id === viewer, dueOn };
}

const KINDS = /\b(sick|casual|earned|privilege|paid|unpaid|comp(?:ensatory)?(?:\s+off)?|maternity|paternity|bereavement|optional)\b/i;
/** "/leave sick tomorrow", "/leave 3 nov to 5 nov family function", "/leave half day fri" → the days and the reason. */
export function leaveRange(args, today) {
  let rest = squash(args);
  let half = null;
  const h = rest.match(/\b(first half|second half|half[- ]day)\b/i);
  if (h) { half = /second/i.test(h[1]) ? "second" : "first"; rest = squash(rest.replace(h[0], " ")); }
  let kind = null;
  const k = rest.match(KINDS);
  if (k) { kind = k[1].toLowerCase(); rest = squash(rest.replace(k[0], " ").replace(/\bleave\b/i, " ")); }
  const re = new RegExp(DUE_PHRASE.source, "gi");
  const days = [];
  let m; let cut = rest;
  while ((m = re.exec(rest)) && days.length < 2) { const d = dueDay(m[1], today); if (d) { days.push(d); cut = cut.replace(m[0], " "); } }
  if (!days.length) return null;
  const from = days[0], to = days[1] && days[1] >= from ? days[1] : from;
  const reason = tidy(cut.replace(/(^|\s)(to|till|until|through|-|–)(\s|$)/gi, " "));
  return { from, to: half ? from : to, half, kind, reason };
}

/** "/remind in 2h call Neha", "/remind tomorrow 10am send the GST file", "/remind fri the review" → { at, text }. */
export function remindAt(args, now = new Date()) {
  let s = squash(args);
  const rel = s.match(/^in\s+(\d{1,3})\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\b\s*/i);
  if (rel) {
    const n = Number(rel[1]), u = rel[2][0].toLowerCase();
    if (!n) return null;
    return { at: new Date(now.getTime() + n * (u === "m" ? 60000 : u === "h" ? 3600000 : 86400000)), text: tidy(s.slice(rel[0].length).replace(/^to\s+/i, "")) };
  }
  const today = localDay(now);
  let day = null;
  const dm = s.match(/^(today|tonight|tomorrow|tmrw|tmr|(?:next |this )?(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*)\b\s*/i);
  if (dm) { day = dueDay(dm[1].toLowerCase() === "tonight" ? "today" : dm[1], today); if (day) s = s.slice(dm[0].length); }
  let hour = null, minute = 0;
  const tm = s.match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b\s*/i);
  if (tm && (tm[3] || tm[2] || /^at\s/i.test(tm[0]))) {
    hour = Number(tm[1]); minute = Number(tm[2] ?? 0);
    if (tm[3]) hour = (hour % 12) + (tm[3].toLowerCase() === "pm" ? 12 : 0);
    if (hour > 23 || minute > 59) return null;
    s = s.slice(tm[0].length);
  }
  if (!day && hour === null) return null;
  if (hour === null) { hour = /tonight/i.test(dm?.[1] ?? "") ? 19 : 10; }
  const [y, mo, d] = (day ?? today).split("-").map(Number);
  let at = new Date(y, mo - 1, d, hour, minute, 0, 0);
  if (!day && at <= now) at = new Date(y, mo - 1, d + 1, hour, minute, 0, 0);
  if (at <= now) return null;
  return { at, text: tidy(s.replace(/^to\s+/i, "")) };
}

/** "/expense ₹450 cab to the site" → { amount: 450, what: "Cab to the site" }; "1.2k" is 1200. */
export function amountOf(args) {
  const s = squash(args);
  const m = s.match(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k)?\b/i);
  if (!m) return null;
  const amount = Math.round(Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1) * 100) / 100;
  if (!(amount > 0)) return null;
  const what = tidy(s.slice(0, m.index) + " " + s.slice(m.index + m[0].length)).replace(/^(for|on)\s+/i, "");
  return { amount, what: what ? what.charAt(0).toUpperCase() + what.slice(1) : "" };
}

const ASKS = /^(please|pls|plz|kindly|can you|could you|can someone|could someone|need to|we need to|i need to|we have to|remember to|don't forget to|dont forget to|todo:?|to do:?|action:?)\s+/i;
const NOT_WORK = /^(hi|hello|hey|thanks|thank you|ok|okay|good (morning|night|evening)|congrats|welcome|lol|haha)\b/i;
/** A line that asks for work without naming anyone ("please send the brochure by Friday"): offered as a task. */
export function requestIntent(text, today) {
  const line = squash(text);
  if (!line || line.startsWith("/") || String(text).includes("\n") || line.length < 8 || line.length > 220 || NOT_WORK.test(line)) return null;
  if (/(?:^|\s)@[a-z0-9]/i.test(line)) return null; // a named person is the J2 offer's job
  const asks = ASKS.test(line);
  const due = line.match(DUE_PHRASE);
  const byDay = due && /^(by|before|due)\b/i.test(due[0].trim());
  if (!asks && !byDay) return null;
  if (/\?\s*$/.test(line) && !/^(can|could) (you|someone)\b/i.test(line)) return null;
  let rest = line.replace(ASKS, "");
  let dueOn = null;
  const d = rest.match(DUE_PHRASE);
  if (d && today) { dueOn = dueDay(d[1], today); if (dueOn) rest = squash(rest.slice(0, d.index) + " " + rest.slice(d.index + d[0].length)); }
  rest = tidy(rest.replace(/\?+$/, "").replace(/\b(please|pls)$/i, ""));
  if (rest.split(/\s+/).length < 2) return null;
  return { title: rest.charAt(0).toUpperCase() + rest.slice(1), dueOn };
}

/** A conversation's catch-up from its messages (newest last is not required): how many since `since`, who spoke most,
 *  the questions still hanging (a line ending in "?" with nothing after it from someone else), tasks and files shared. */
export function chatDigest(messages, { viewer, since }) {
  const list = (messages ?? []).filter((m) => !m.removed && m.kind !== "event" && (!since || m.createdAt >= since)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const by = new Map();
  for (const m of list) by.set(m.authorId, { name: m.name, n: (by.get(m.authorId)?.n ?? 0) + 1 });
  const people = [...by.values()].sort((a, b) => b.n - a.n).slice(0, 4);
  const questions = list.filter((m, i) => /\?\s*$/.test(m.body ?? "") && m.authorId !== viewer && !list.slice(i + 1).some((x) => x.authorId !== m.authorId))
    .slice(-3).map((m) => ({ name: m.name, body: squash(m.body).slice(0, 140) }));
  const tasks = list.reduce((n, m) => n + (m.attachments ?? []).filter((a) => a.task).length, 0);
  const files = list.reduce((n, m) => n + (m.attachments ?? []).filter((a) => !a.task).length, 0);
  const latest = list.slice(-3).map((m) => ({ name: m.name, body: squash(m.body).slice(0, 140) || "📎 Attachment" }));
  return { count: list.length, people, questions, tasks, files, latest, from: list[0]?.createdAt ?? null };
}
