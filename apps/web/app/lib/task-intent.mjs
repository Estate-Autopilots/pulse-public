// CHAT-WORK (J2): a chat line that gives someone work — "@rila draft positioning for Skyline by Thu" — read as a task
// offer: who (an @mention of someone in the chat), what (the rest), when (a due phrase) and which project (a live
// project whose name the line names). Pure and conservative: no mention, or a line that reads like a question or a
// greeting, offers nothing; the person still decides with one press.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_WORD = "(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)";
const MONTH_WORD = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DUE = new RegExp(`\\s*\\b(?:(?:by|on|before|due|for)\\s+)?(today|tonight|eod|end of (?:the )?day|tomorrow|tmrw|tmr|(?:this |next )?${DAY_WORD}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_WORD}|${MONTH_WORD}\\s+\\d{1,2}(?:st|nd|rd|th)?)\\b\\.?`, "i");
/** UX-SIMPLE: the due phrase ("by Thu", "tomorrow", "3 Nov"), for the chat commands' readers. */
export const DUE_PHRASE = DUE;
const NOT_WORK = /^(hi|hello|hey|thanks|thank you|ok|okay|good (morning|night|evening)|congrats|welcome)\b/i;

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The calendar day a due phrase means, from `today` (YYYY-MM-DD in the company's zone); null when it is not one. */
export function dueDay(phrase, today) {
  const p = phrase.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^(today|tonight|eod|end of (the )?day)$/.test(p)) return today;
  if (/^(tomorrow|tmrw|tmr)$/.test(p)) return addDays(today, 1);
  const wd = p.match(/^(this |next )?([a-z]+)$/);
  if (wd) {
    const i = DAYS.indexOf(wd[2].slice(0, 3)); if (i < 0) return null;
    const now = new Date(`${today}T00:00:00Z`).getUTCDay();
    let n = (i - now + 7) % 7; if (wd[1] === "next " && n === 0) n = 7;
    return addDays(today, n);
  }
  const md = p.match(/^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?$/);
  const dm = p.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)$/) ?? (md ? [md[0], md[2], md[1]] : null);
  if (dm) {
    const d = Number(dm[1]), m = MONTHS.indexOf(String(dm[2]).slice(0, 3)); if (m < 0 || d < 1 || d > 31) return null;
    let y = Number(today.slice(0, 4)); let iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (iso < today) { y += 1; iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
    return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
  }
  return null;
}

/** The task a line offers, or null: { assignee (a member), title, dueOn, project }. `members` are the chat's members
 *  ({ id, username, name }); `projects` are live projects ({ id, name }); `today` is the company's day. */
export function taskIntent(text, { members, viewer, projects = [], today }) {
  const line = String(text ?? "").trim();
  if (!line || line.startsWith("/") || line.includes("\n") || line.length > 300) return null;
  const at = [...line.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9._-]*)/gi)].map((m) => m[1].replace(/[.-]+$/, "").toLowerCase());
  const who = at.map((u) => members.find((p) => p.username?.toLowerCase() === u && p.id !== viewer)).find(Boolean);
  if (!who) return null;
  let rest = line.replace(new RegExp(`(^|\\s)@${who.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[,:]?`, "i"), " ").replace(/\s+/g, " ").trim();
  rest = rest.replace(/^(please|pls|plz|can you|could you|kindly|can|could)\s+/i, "");
  if (!rest || NOT_WORK.test(rest) || /\?\s*$/.test(rest) && !DUE.test(rest)) return null;
  let dueOn = null;
  const d = rest.match(DUE);
  if (d) { dueOn = dueDay(d[1], today); if (dueOn) rest = (rest.slice(0, d.index) + rest.slice(d.index + d[0].length)).replace(/\s+/g, " ").trim(); }
  rest = rest.replace(/[\s,.;:!-]+$/, "").replace(/\b(please|pls)$/i, "").trim();
  if (rest.split(/\s+/).length < 2) return null;
  const words = new Set(line.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const project = projects.map((p) => ({ p, key: (String(p.name).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 4 && !["project", "client", "internal", "work", "synthetic"].includes(w)) }))
    .filter((x) => x.key.length && words.has(x.key[0])).sort((a, b) => b.key.filter((w) => words.has(w)).length - a.key.filter((w) => words.has(w)).length)[0]?.p ?? null;
  return { assignee: who, title: rest.charAt(0).toUpperCase() + rest.slice(1), dueOn, project };
}
