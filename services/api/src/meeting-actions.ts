// KAZUK-REST slice 4 (D3, "tasks from recordings"): the action items in a meeting's transcript or notes, read without any
// AI service (nothing leaves the server): lines marked "Action:" / "To do:", sentences where someone will, needs to or must
// do something, and lines that start with a thing to do ("Send the …", "Please share …"). Who does it is the colleague
// named in the line ("I will" is the person who recorded it); a day in it ("by Friday", "tomorrow", "12 Nov", "next
// week") is its due date. Each one is only a draft until a person confirms it on the meeting's page. Pure; unit-tested.

export type Person = { id: string; name: string };
export type ActionDraft = { title: string; quote: string; assigneeId: string | null; dueOn: string | null };

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const VERBS = "send|share|call|prepare|book|schedule|fix|update|finish|review|create|draft|email|mail|confirm|check|arrange|deliver|collect|upload|post|write|get|follow up|set up|organise|organize|ask|tell|pay|order|plan|finalise|finalize|submit|visit|meet";
const EXPLICIT = /^\s*(?:action(?:\s+item)?|to\s*-?\s*do|todo|task|next\s+step)\s*[:\-–—]\s*/i;
const MODAL = /\b(?:will|'ll|’ll|shall|needs?\s+to|has\s+to|have\s+to|must|is\s+going\s+to|are\s+going\s+to|going\s+to|should|to\s+follow\s+up)\s+\w+/i;
const SUBJECT = /^\s*(?:i|we|you|let'?s|let\s+us)\b/i;
const IMPERATIVE = new RegExp(`^\\s*(?:please\\s+)?(?:${VERBS})\\b`, "i");

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day0 = (today: string) => new Date(`${today}T00:00:00Z`);
const plus = (today: string, n: number) => { const d = day0(today); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The due day a line names, relative to `today` (YYYY-MM-DD), or null. */
export function dueFrom(line: string, today: string): string | null {
  const s = line.toLowerCase();
  if (/\btoday\b|\bby (?:the )?end of (?:the )?day\b|\beod\b/.test(s)) return today;
  if (/\btomorrow\b/.test(s)) return plus(today, 1);
  const inDays = /\bin (\d{1,2}) days?\b/.exec(s); if (inDays) return plus(today, Number(inDays[1]));
  if (/\bnext week\b/.test(s)) { const w = day0(today).getUTCDay(); return plus(today, ((8 - w) % 7) || 7); }
  if (/\b(?:by |before )?(?:the )?end of (?:the |this )?week\b/.test(s)) { const w = day0(today).getUTCDay(); return plus(today, (5 - w + 7) % 7); }
  if (/\b(?:by |before )?(?:the )?end of (?:the |this )?month\b/.test(s)) { const d = day0(today); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); }
  const named = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join("|")})[a-z]*\\b|\\b(${MONTHS.join("|")})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(s);
  if (named) {
    const dd = Number(named[1] ?? named[4]), mm = MONTHS.indexOf(named[2] ?? named[3]), t = day0(today);
    if (dd >= 1 && dd <= 31) {
      let d = new Date(Date.UTC(t.getUTCFullYear(), mm, dd));
      if (d.getUTCMonth() === mm) { if (iso(d) < today) d = new Date(Date.UTC(t.getUTCFullYear() + 1, mm, dd)); return iso(d); }
    }
  }
  const wd = new RegExp(`\\b(?:by |on |before |this |next |coming )?(${DAYS.join("|")})\\b`).exec(s);
  if (wd) { const want = DAYS.indexOf(wd[1]), w = day0(today).getUTCDay(); return plus(today, ((want - w + 7) % 7) || 7); }
  return null;
}

/** The colleague a line names (whole first name or full name, the longest match first). */
export function whoFrom(line: string, people: Person[], me: string | null): string | null {
  const s = ` ${line.toLowerCase()} `;
  const named = people.flatMap((p) => { const full = p.name.trim().toLowerCase(), first = full.split(/\s+/)[0];
    return [{ id: p.id, key: full }, ...(first && first.length >= 3 && first !== full ? [{ id: p.id, key: first }] : [])]; })
    .sort((a, b) => b.key.length - a.key.length)
    .find((x) => new RegExp(`[^\\p{L}]${esc(x.key)}[^\\p{L}]`, "u").test(s));
  if (named) {
    // A first name two colleagues share names nobody.
    const first = named.key.split(/\s+/)[0];
    if (named.key === first && people.filter((p) => p.name.trim().toLowerCase().split(/\s+/)[0] === first).length > 1) return null;
    return named.id;
  }
  if (/^\s*(?:i\b|i'll\b|i’ll\b)/i.test(line)) return me;
  return null;
}

/** A line as a task title: the marker, the speaker's name and "will", and the trailing day go; the first letter is a capital. */
export function titleFrom(line: string, people: Person[]): string {
  let t = line.replace(EXPLICIT, "").replace(/^\s*[-*•·]\s*|^\s*\d{1,2}[.)]\s*/, "").trim();
  const names = people.flatMap((p) => [p.name.trim(), p.name.trim().split(/\s+/)[0]]).filter((n) => n.length >= 3).sort((a, b) => b.length - a.length).map(esc);
  const lead = names.length ? new RegExp(`^(?:${names.join("|")})\\s*[,:]\\s*`, "i") : null;
  if (lead) t = t.replace(lead, "");
  const who = `(?:i|we|you${names.length ? `|${names.join("|")}` : ""})`;
  t = t.replace(new RegExp(`^${who}\\s+(?:will|'ll|’ll|shall|needs?\\s+to|has\\s+to|have\\s+to|must|is\\s+going\\s+to|are\\s+going\\s+to|should)\\s+`, "i"), "")
    .replace(new RegExp(`^${who}(?:'ll|’ll)\\s+`, "i"), "").replace(/^(?:let'?s|let us|please)\s+/i, "");
  t = t.replace(/\s+(?:by|before|on|this|next|in)\s+(?:the\s+)?(?:end of (?:the |this )?(?:day|week|month)|today|tomorrow|next week|\d{1,2} days?|\w+day|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}|[a-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?)\s*[.!?]*$/i, "")
    .replace(/\s+(?:today|tomorrow|eod)\s*[.!?]*$/i, "").replace(/[\s.!?;,]+$/, "").trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

/** Is this line something someone has to do? */
export function isAction(line: string, people: Person[]): boolean {
  const s = line.replace(/^\s*[-*•·]\s*|^\s*\d{1,2}[.)]\s*/, "").trim();
  if (s.split(/\s+/).length < 3 || s.endsWith("?")) return false;
  if (EXPLICIT.test(s)) return true;
  if (IMPERATIVE.test(s)) return true;
  if (MODAL.test(s) && (SUBJECT.test(s) || whoFrom(s, people, null) !== null)) return true;
  return false;
}

/** The action items in a transcript or notes: at most `max`, each once, in the order they were said. */
export function extractActions(text: string, o: { today: string; people: Person[]; me: string | null; max?: number }): ActionDraft[] {
  const lines = String(text ?? "").replace(/\r/g, "").split(/\n+/).flatMap((l) => /^\s*([-*•·]|\d{1,2}[.)])\s/.test(l) || EXPLICIT.test(l) ? [l] : l.split(/(?<=[.!?])\s+(?=[A-Z0-9“"'])/))
    .map((l) => l.trim()).filter(Boolean);
  const out: ActionDraft[] = [], seen = new Set<string>();
  for (const l of lines) {
    if (out.length >= (o.max ?? 20)) break;
    if (l.length > 600 || !isAction(l, o.people)) continue;
    const title = titleFrom(l, o.people);
    const key = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (title.length < 3 || seen.has(key)) continue;
    seen.add(key);
    out.push({ title, quote: l.slice(0, 600), assigneeId: whoFrom(l, o.people, o.me), dueOn: dueFrom(l, o.today) });
  }
  return out;
}

/** The consent words a recording starts with (kept on the meeting). */
export const CONSENT_TEXT = "Everyone present was told this meeting is recorded in Pulse, transcribed on the company's own server and used to draft tasks, and agreed.";
