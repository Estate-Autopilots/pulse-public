// MEETING-CAPTURE (9 Nov 2026; MEETING-DEEP C #20/#21, PW-07; migration 1946): a transcript brought into Meetings, read on
// this server (nothing goes to an outside AI service, and the words never leave the server). Pure; unit-tested.
//   parseTranscript  Wispr Flow / plain text, "Name: words" lines, Loom ("0:05 words"), Otter ("Name  0:05" then the
//                    words), WebVTT (.vtt, <v Name> voices) and SubRip (.srt): one line per thing said, the speaker and the
//                    time kept when the file has them.
//   nameFor          a name from the content and the day ("Launch plan, 9 Nov 2026").
//   summaryOf        a short summary: who spoke, what it was mostly about, what was decided, how long it ran.
//   readable         the lines as the meeting's text ("[0:05] Asha: …"), which parseTranscript reads back the same.
//   draftProblems    "Narrate a problem": the bug report(s) or task a narration describes, with the page it names.

export type Format = "plain" | "speakers" | "loom" | "otter" | "vtt" | "srt";
export type Line = { speaker: string | null; at: number | null; text: string };
export type Parsed = { format: Format; lines: Line[]; speakers: string[]; heldOn: string | null; heading: string | null };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_LINES = 20000;
const MAX_LINE = 1200;

/** Seconds from "1:02:03", "02:03", "00:00:05.120" or "00:00:05,120"; null when it is not a time. */
export function secondsOf(s: string): number | null {
  const m = /^\s*\[?\(?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d{1,3})?\)?\]?\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1] ?? 0), mi = Number(m[2]), se = Number(m[3]);
  return mi > 59 && m[1] ? null : se > 59 ? null : h * 3600 + mi * 60 + se;
}
/** "0:05", "12:30", "1:02:03". */
export function clock(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
}

const clean = (s: string) => s.replace(/[​-‍⁠﻿]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim();
const LABELS = new Set(["action", "action item", "action items", "to do", "todo", "task", "tasks", "next step", "next steps", "note", "notes", "agenda", "decision", "decisions",
  "summary", "update", "updates", "re", "fyi", "ps", "q", "a", "question", "answer", "issue", "problem", "bug", "page", "date", "time", "subject", "title", "location",
  "attendees", "participants", "minutes", "meeting", "transcript", "topic", "follow up", "follow-up", "owner", "due", "status", "http", "https", "warning", "error", "example", "tip"]);
// "Asha:", "Asha Rao:", "Dr. Meera K:", "Speaker 1:", "[0:05] Asha:" (Pulse's own readable form).
const SPEAKER = /^(?:\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]\s*)?([\p{Lu}][\p{L}\p{M}.'’-]*(?:\s+(?:[\p{L}\p{M}][\p{L}\p{M}.'’-]*|\d{1,2})){0,3})\s*:\s+(\S.*)$/u;
const STAMPED = /^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:[.,]\d{1,3})?\]?\s*[-–—]?\s+(\S.*)$/;
const OTTER_HEAD = /^([\p{L}\p{M}][\p{L}\p{M}.'’-]*(?:\s+(?:[\p{L}\p{M}][\p{L}\p{M}.'’-]*|\d{1,2})){0,3})\s+((?:\d{1,2}:)?\d{1,2}:\d{2})\s*$/u;
const CUE_TIME = /^((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function speakerLine(l: string): { at: number | null; speaker: string; text: string } | null {
  const m = SPEAKER.exec(l);
  if (!m) return null;
  const name = m[2].trim();
  if (name.length > 40 || LABELS.has(name.toLowerCase()) || /^\d/.test(name)) return null;
  return { at: m[1] ? secondsOf(m[1]) : null, speaker: name, text: m[3].trim() };
}

/** A long paragraph (Wispr Flow dictation, a pasted note) as sentences, so each line can be found and linked. */
function sentences(p: string): string[] {
  if (p.length <= 280) return [p];
  const out: string[] = [];
  let cur = "";
  for (const s of p.split(/(?<=[.!?।])\s+(?=["“'‘(]?[\p{Lu}\p{N}\p{Lo}])/u)) {
    if (cur && (cur.length + s.length > 280)) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out.flatMap((s) => s.length <= MAX_LINE ? [s] : s.match(new RegExp(`.{1,${MAX_LINE}}(?:\\s|$)`, "gs"))!.map((x) => x.trim()).filter(Boolean));
}

function dateIn(s: string): string | null {
  const iso = /\b(20\d{2})[-_. /](\d{1,2})[-_. /](\d{1,2})\b/.exec(s);
  const ok = (y: number, mo: number, d: number) => { const t = new Date(Date.UTC(y, mo, d)); return t.getUTCMonth() === mo && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null; };
  if (iso) { const r = ok(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])); if (r) return r; }
  const lower = s.toLowerCase();
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join("|")})[a-z]*\\.?,?\\s+(20\\d{2})\\b`).exec(lower);
  if (dmy) { const r = ok(Number(dmy[3]), MONTHS.indexOf(dmy[2]), Number(dmy[1])); if (r) return r; }
  const mdy = new RegExp(`\\b(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`).exec(lower);
  if (mdy) { const r = ok(Number(mdy[3]), MONTHS.indexOf(mdy[1]), Number(mdy[2])); if (r) return r; }
  return null;
}

function cueText(raw: string): { speaker: string | null; text: string } {
  let speaker: string | null = null;
  const voice = /<v(?:\.[\w.-]+)?\s+([^>]{1,60})>/.exec(raw);
  if (voice) speaker = clean(voice[1]);
  let text = clean(raw.replace(/<\/?[^>]{0,80}>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " "));
  if (!speaker) {
    const br = /^\[([^\]]{1,40})\]\s*:?\s+(\S.*)$/.exec(text) ?? /^>>\s*([^:]{1,40}):\s+(\S.*)$/.exec(text);
    if (br && !secondsOf(br[1])) { speaker = br[1].trim(); text = br[2]; }
    else { const s = speakerLine(text); if (s) { speaker = s.speaker; text = s.text; } }
  }
  return { speaker, text: text.replace(/^[-–—]\s+/, "") };
}

/** Cues (VTT, SRT) as lines: a speaker's run of short caption pieces joins into sentences; a rolling repeat is dropped. */
function fromCues(blocks: string[]): Line[] {
  const out: Line[] = [];
  for (const b of blocks) {
    const rows = b.split("\n").map((r) => r.trimEnd());
    const ti = rows.findIndex((r) => CUE_TIME.test(r.trim()));
    if (ti < 0) continue;
    const at = secondsOf(CUE_TIME.exec(rows[ti].trim())![1]);
    const { speaker, text } = cueText(rows.slice(ti + 1).join(" "));
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text.endsWith(text)) continue;
    if (prev && text.startsWith(prev.text) && (prev.speaker === speaker || !speaker)) { prev.text = text; continue; }
    if (prev && (speaker ?? prev.speaker) === prev.speaker && !/[.!?…]["”’)]?$/.test(prev.text) && prev.text.length + text.length < 300) { prev.text = `${prev.text} ${text}`; continue; }
    out.push({ speaker, at, text });
  }
  return out;
}

/** The transcript's lines, speakers and format (and the day it names, if it names one). */
export function parseTranscript(raw: string, fileName?: string | null): Parsed {
  const text = String(raw ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const ext = (/\.([a-z0-9]{2,4})$/i.exec(String(fileName ?? ""))?.[1] ?? "").toLowerCase();
  const rows = text.split("\n").map(clean);
  const nonEmpty = rows.filter(Boolean);
  let format: Format = "plain", lines: Line[] = [], heading: string | null = null;

  if (/^WEBVTT\b/.test(text.trimStart()) || ext === "vtt") {
    format = "vtt";
    const blocks = text.split(/\n[ \t]*\n/).filter((b) => !/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(b.trim()));
    lines = fromCues(blocks);
  } else if (ext === "srt" || /^\s*\d+\s*\n\s*\d{1,2}:\d{2}:\d{2},\d{1,3}\s*-->/m.test(text)) {
    format = "srt";
    lines = fromCues(text.split(/\n[ \t]*\n/));
  } else {
    const otterHeads = nonEmpty.filter((r) => { const m = OTTER_HEAD.exec(r); return !!m && !LABELS.has(m[1].toLowerCase()) && m[1].length <= 40; }).length;
    const stamped = nonEmpty.filter((r) => STAMPED.test(r) || secondsOf(r) !== null).length;
    const spoken = nonEmpty.filter((r) => speakerLine(r)).length;
    if (otterHeads >= 2 && otterHeads >= nonEmpty.length * 0.2) {
      format = "otter";
      let who: string | null = null, at: number | null = null, started = false;
      for (const r of rows) {
        if (!r) continue;
        const h = OTTER_HEAD.exec(r);
        if (h && !LABELS.has(h[1].toLowerCase()) && h[1].length <= 40) { who = h[1].trim(); at = secondsOf(h[2]); started = true; continue; }
        if (!started) { heading ??= r.length <= 90 ? r : null; continue; }
        if (/^transcribed by\b/i.test(r) || /otter\.ai\s*$/i.test(r)) continue;
        for (const s of sentences(r)) { lines.push({ speaker: who, at, text: s }); at = null; }
      }
    } else if (spoken >= 2 && spoken >= nonEmpty.length * 0.3) {
      format = "speakers";
      let pendingAt: number | null = null;
      for (const r of rows) {
        if (!r) continue;
        const t = secondsOf(r);
        if (t !== null) { pendingAt = t; continue; }
        const s = speakerLine(r);
        if (s) { lines.push({ speaker: s.speaker, at: s.at ?? pendingAt, text: s.text }); pendingAt = null; continue; }
        const st = STAMPED.exec(r);
        if (st) { const inner = speakerLine(st[2]); lines.push({ speaker: inner?.speaker ?? null, at: secondsOf(st[1]), text: inner?.text ?? st[2] }); pendingAt = null; continue; }
        const prev = lines[lines.length - 1];
        if (!prev) { heading ??= r.length <= 90 ? r : null; continue; }
        // A labelled note ("Action: …", "Decision: …") is a line of its own, said by nobody in particular.
        const label = /^([\p{L} -]{1,16})\s*:\s+\S/u.exec(r);
        if (label && LABELS.has(label[1].trim().toLowerCase())) { lines.push({ speaker: null, at: null, text: r }); continue; }
        // A line with no name continues what the last speaker said (a wrapped line).
        if (prev.text.length + r.length < MAX_LINE) prev.text = `${prev.text} ${r}`; else lines.push({ speaker: prev.speaker, at: null, text: r });
      }
    } else if (stamped >= 2 && stamped >= nonEmpty.length * 0.4) {
      format = "loom";
      let pendingAt: number | null = null;
      for (const r of rows) {
        if (!r) continue;
        const t = secondsOf(r);
        if (t !== null) { pendingAt = t; continue; }
        const st = STAMPED.exec(r);
        if (st) { const inner = speakerLine(st[2]); lines.push({ speaker: inner?.speaker ?? null, at: secondsOf(st[1]), text: inner?.text ?? st[2] }); pendingAt = null; continue; }
        if (!lines.length && pendingAt === null) { heading ??= r.length <= 90 ? r : null; continue; }
        if (pendingAt !== null) { lines.push({ speaker: null, at: pendingAt, text: r }); pendingAt = null; continue; }
        const prev = lines[lines.length - 1];
        if (prev.text.length + r.length < MAX_LINE) prev.text = `${prev.text} ${r}`; else lines.push({ speaker: null, at: null, text: r });
      }
    } else {
      format = "plain";
      // Wispr Flow, a .txt or typed notes: each paragraph or line, long ones as sentences.
      for (const r of rows) if (r) for (const s of sentences(r)) lines.push({ speaker: null, at: null, text: s });
      if (lines.length > 2 && lines[0].text.length <= 70 && !/[.!?,;:]$/.test(lines[0].text) && lines[0].text.split(/\s+/).length <= 9) heading = lines[0].text;
    }
  }
  lines = lines.map((l) => ({ ...l, text: l.text.slice(0, 4000) })).filter((l) => l.text).slice(0, MAX_LINES);
  const seen = new Map<string, string>();
  for (const l of lines) if (l.speaker && !seen.has(l.speaker.toLowerCase())) seen.set(l.speaker.toLowerCase(), l.speaker);
  const heldOn = dateIn(nonEmpty.slice(0, 6).join(" ")) ?? dateIn(String(fileName ?? ""));
  const head = heading && secondsOf(heading) === null ? (dateIn(heading) ? cleanHeading(heading) : heading.slice(0, 90)) : null;
  return { format, lines, speakers: [...seen.values()].slice(0, 40), heldOn, heading: head };
}
/** A heading without its day and time ("Weekly sync, Tue Nov 7, 2026 10:00 AM" → "Weekly sync"). */
const cleanHeading = (h: string) => { const t = h.replace(/\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*/gi, "").replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+20\d{2}\b|\b[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2}\b|\b20\d{2}-\d{2}-\d{2}\b/g, "")
  .replace(/\s*(?:\d{1,2}:\d{2}\s*(?:am|pm)?|•|\|)\s*.*$/i, "").replace(/[\s,–—-]+$/, "").trim(); return t.length >= 3 ? t : null; };

/** The lines as one text, the way Pulse shows and keeps it ("[0:05] Asha: words"); parseTranscript reads it back. */
export function readable(lines: Line[]): string {
  return lines.map((l) => `${l.at !== null ? `[${clock(l.at)}] ` : ""}${l.speaker ? `${l.speaker}: ` : ""}${l.text}`).join("\n");
}

const STOP = new Set(("a about above after again against all also am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further get got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself just let's like me more most mustn't my myself no nor not now of off on once only or other ought our ours ourselves out over own really right same say said shall shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've thing things think this those through to too under until up us very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's will with won't would wouldn't yes yeah yep okay ok you you'd you'll you're you've your yours yourself yourselves um uh hmm hey hi hello thanks thank going gonna want wanna need know mean actually basically maybe kind sort lot today tomorrow week also just still even every much many make made sure good great fine well back look one two three first next last time way something anything everything nothing someone everyone people guys alright".split(/\s+/)));

/** The words a transcript talks about most (not speakers' names), most frequent first. */
export function topics(lines: Line[], speakers: string[] = [], n = 3): string[] {
  const names = new Set(speakers.flatMap((s) => s.toLowerCase().split(/\s+/)));
  const count = new Map<string, number>(), first = new Map<string, string>(), lower = new Set<string>();
  for (const l of lines) for (const raw of l.text.replace(/[’]/g, "'").match(/[\p{L}][\p{L}\p{M}'-]{3,}/gu) ?? []) {
    const w = raw.replace(/'s$/i, "").replace(/^-+|-+$/g, ""), k = w.toLowerCase();
    if (k.length < 4 || STOP.has(k) || names.has(k)) continue;
    count.set(k, (count.get(k) ?? 0) + 1);
    if (!first.has(k)) first.set(k, w);
    if (w === k) lower.add(k);
  }
  // A word never written in lower case is a name and keeps its capital ("Bluefin"); any other is said in lower case.
  return [...count.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => lower.has(k) ? k : first.get(k) ?? k);
}
const andList = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const firstName = (s: string) => s.split(/\s+/)[0];
/** Speakers by first name when no two share one, else by full name ("Asha and Ravi", never "Fake, Fake and Fake"). */
const shortNames = (speakers: string[]) => { const firsts = speakers.map(firstName); const unique = new Set(firsts.map((f) => f.toLowerCase())).size === firsts.length;
  return (s: string) => unique ? firstName(s) : s; };
// "This is the Bluefin launch review", "Welcome to the weekly sync", "Today we'll talk about the Q3 budget".
const INTRO = /\b(?:this is (?:the|our|a)|welcome to (?:the|our)|(?:this|the|today'?s) (?:meeting|call|session) is (?:about|on)|today we(?:'ll| will| are going to)? (?:talk about|discuss|look at|review|go over)|let'?s (?:talk about|discuss|go over|review)|we(?:'re| are) here to (?:talk about|discuss|review))\s+(?:the\s+)?([^.,!?;:]{3,60})/i;
/** What the meeting says it is, in its first lines. */
function introTopic(lines: Line[]): string | null {
  for (const l of lines.slice(0, 5)) { const m = INTRO.exec(l.text); if (m && m[1].trim().split(/\s+/).length <= 8) return m[1].trim(); }
  return null;
}
/** "9 Nov 2026" for 2026-11-09. */
export function dayName(iso: string): string { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTH_NAMES[m - 1]} ${y}`; }

/** A name from the content and the day: the file's own heading, a meaningful file name, its main words, or who spoke. */
export function nameFor(p: Parsed, o: { fileName?: string | null; day: string }): string {
  const day = dayName(p.heldOn ?? o.day);
  const base = String(o.fileName ?? "").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[_]+/g, " ").replace(/\b20\d{2}[-_. ]?\d{1,2}[-_. ]?\d{1,2}\b/g, "").replace(/\s+/g, " ").replace(/^[\s,–—-]+|[\s,–—-]+$/g, "").trim();
  const fileOk = base.length >= 4 && !/^(transcript|transcription|captions?|subtitles?|untitled|recording|audio|video|meeting|new|document|notes?|loom|otter|wispr)(\s*(\(\d+\)|\d+))?$/i.test(base) && /\p{L}{3}/u.test(base) && !/^[\p{L}\d]{20,}$/u.test(base);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  let topic = p.heading && p.heading.length >= 3 ? p.heading : fileOk ? base : cap(introTopic(p.lines) ?? "");
  if (!topic) {
    const words = topics(p.lines, p.speakers, 2), short = shortNames(p.speakers);
    topic = words.length ? cap(andList(words)) : p.speakers.length >= 2 ? `Meeting with ${andList(p.speakers.slice(0, 3).map(short))}` : "Meeting notes";
  }
  topic = topic.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120).replace(/[\s,.;:–—-]+$/, "");
  return `${topic}, ${day}`.slice(0, 160);
}

const DECIDED = /\b(?:we\s+(?:have\s+)?(?:agreed|decided)|(?:it\s+was|is)\s+(?:agreed|decided)|decided\s+to|agreed\s+(?:to|on|that)|decision\s*:|let'?s\s+go\s+with|we(?:'ll|\s+will)\s+go\s+with|final(?:ised|ized)?\s*:|approved)\b/i;
/** A short summary (at most about 600 characters): who spoke, what it was mostly about, what was decided, how long. */
export function summaryOf(p: Parsed): string {
  const out: string[] = [], short = shortNames(p.speakers);
  if (p.speakers.length) out.push(p.speakers.length === 1 ? `${p.speakers[0]} spoke.` : `${p.speakers.length} people spoke: ${andList(p.speakers.slice(0, 5).map(short))}${p.speakers.length > 5 ? " and others" : ""}.`);
  const words = topics(p.lines, p.speakers, 3);
  if (words.length) out.push(`It was mostly about ${andList(words)}.`);
  const decided = p.lines.filter((l) => DECIDED.test(l.text)).slice(0, 3).map((l) => { const t = l.text.length > 150 ? `${l.text.slice(0, 147).replace(/\s+\S*$/, "")}…` : l.text; return `${t.replace(/[.!?]*$/, "")}.`; });
  if (decided.length) out.push(`${decided.length === 1 ? "Decision" : "Decisions"}: ${decided.join(" ")}`);
  const times = p.lines.map((l) => l.at).filter((x): x is number => x !== null);
  if (times.length > 1) { const mins = Math.round((Math.max(...times) - Math.min(...times)) / 60); if (mins >= 1) out.push(`It runs about ${mins} ${mins === 1 ? "minute" : "minutes"}.`); }
  if (!out.length) out.push(`${p.lines.length} ${p.lines.length === 1 ? "line" : "lines"} of notes.`);
  const s = out.join(" ");
  return s.length > 600 ? `${s.slice(0, 597).replace(/\s+\S*$/, "")}…` : s;
}

// ---------------------------------------------------------------------------------------------------------------------
// Narrate a problem: "this doesn't scroll on the tasks page" → a bug report (or a task), with the page named.

export type PageName = { route: string; label: string; words: string[] };
/** The pages people name when they describe a problem (the plain words they use for them). */
export const PAGES: PageName[] = [
  { route: "/tasks", label: "Tasks", words: ["tasks page", "task page", "tasks", "task list", "work page", "my work", "work tab", "to do list", "todo list"] },
  { route: "/tasks/projects", label: "Projects", words: ["projects page", "projects", "project page", "project list"] },
  { route: "/my-day", label: "My day", words: ["my day", "today page", "day plan"] },
  { route: "/dashboard", label: "Home", words: ["home page", "home screen", "dashboard", "homepage"] },
  { route: "/chats", label: "Chats", words: ["chats", "chat page", "chat", "messages", "inbox", "whatsapp page"] },
  { route: "/calls", label: "Calls", words: ["calls page", "calls", "call screen", "calling"] },
  { route: "/meetings", label: "Meetings", words: ["meetings", "meeting page", "transcripts"] },
  { route: "/docs", label: "Docs", words: ["docs", "documents page", "doc editor", "docs page"] },
  { route: "/processes", label: "Processes", words: ["processes", "process page", "sops", "sop page", "workflows"] },
  { route: "/clients", label: "Clients", words: ["clients", "client page", "client list", "customers"] },
  { route: "/contacts", label: "Contacts", words: ["contacts", "contact page", "address book"] },
  { route: "/acquisition", label: "Leads", words: ["leads", "lead page", "lead list", "acquisition", "pipeline"] },
  { route: "/erp", label: "Billing", words: ["billing", "invoices", "invoice page", "bills", "erp"] },
  { route: "/erp/documents", label: "Quotes", words: ["quotes", "quotation", "quotations", "quote page", "estimates"] },
  { route: "/erp/catalog", label: "Catalogue", words: ["catalogue", "catalog", "products page", "price list"] },
  { route: "/finance", label: "Finance", words: ["finance", "accounts page", "expenses", "bank page"] },
  { route: "/contracts", label: "Agreements", words: ["agreements", "contracts", "contract page"] },
  { route: "/people", label: "Team", words: ["team page", "people page", "team list", "org chart", "people list"] },
  { route: "/me", label: "My desk", words: ["my desk", "check in", "check-in", "attendance", "leave page", "my profile", "profile page", "profile"] },
  { route: "/hr", label: "HR desk", words: ["hr desk", "hr page", "payroll", "salary page"] },
  { route: "/goals", label: "Goals", words: ["goals", "okrs", "goal page"] },
  { route: "/pr", label: "PR Studio", words: ["pr studio", "posts page", "content calendar"] },
  { route: "/settings", label: "Settings", words: ["settings", "settings page", "preferences"] },
  { route: "/notifications", label: "Notifications", words: ["notifications", "alerts page", "bell"] },
  { route: "/search", label: "Search", words: ["search page", "search bar", "search box", "search"] },
  { route: "/login", label: "Sign-in", words: ["login page", "log in page", "sign in page", "sign-in page", "login screen", "login", "sign in"] },
  { route: "/people/ai", label: "AI employees", words: ["ai employees", "ai employee", "pip", "assistant"] },
  { route: "/bug-reports", label: "Bug reports", words: ["bug reports", "bug page"] },
];

export type ProblemDraft = { kind: "bug" | "task"; title: string; quote: string; route: string | null; lineNo: number };

const BUG = /\b(?:doesn'?t|does\s+not|don'?t|do\s+not|didn'?t|can'?t|cannot|can\s+not|won'?t|isn'?t|is\s+not|not\s+(?:working|loading|showing|saving|opening|scrolling|visible|there|right|correct)|broken|breaks?|error|errors|crash(?:es|ed)?|stuck|freez(?:es|ing)|frozen|hangs?|slow|lag(?:s|gy)?|scroll(?:s|ing)?|blank|empty|missing|disappear(?:s|ed)?|wrong|fails?|failed|failing|overlap(?:s|ping)?|cut\s+off|clipped|hidden|off\s+(?:the\s+)?screen|404|500|spinner|loading\s+forever|nothing\s+happens|glitch|bug|weird|messed\s+up|too\s+small|unreadable|overflow(?:s|ing)?)\b/i;
const ASK = /\b(?:add|please|can\s+we|could\s+we|should|would\s+be\s+(?:nice|good|great)|need(?:s)?\s+(?:a|an|to)|want(?:s)?\s+(?:a|an|to)|wish|let\s+me|allow|make\s+it|change\s+it|move\s+it)\b/i;
const FILLER = /^(?:(?:so|okay|ok|um+|uh+|hmm+|hey|hi|right|well|basically|like|and|also|yeah|alright|look|listen|actually)[,\s]+)+/i;

function pageIn(s: string): PageName | null {
  const low = ` ${s.toLowerCase().replace(/[’]/g, "'")} `;
  let best: { p: PageName; len: number } | null = null;
  for (const p of PAGES) for (const w of p.words) {
    if (new RegExp(`[^\\p{L}]${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\p{L}]`, "u").test(low) && (!best || w.length > best.len)) best = { p, len: w.length };
  }
  return best?.p ?? null;
}
/** The page a route is (for a narration started on that page). */
export function pageFor(route: string | null | undefined): PageName | null {
  if (!route || !/^\/[A-Za-z0-9/_.~%-]{0,200}$/.test(route)) return null;
  return [...PAGES].sort((a, b) => b.route.length - a.route.length).find((p) => route === p.route || route.startsWith(`${p.route}/`)) ?? null;
}

function shortTitle(s: string, page: PageName | null): string {
  let t = s.replace(FILLER, "").trim();
  if (page) for (const w of [...page.words].sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(`\\s*\\b(?:on|in|at|from|of)\\s+(?:the\\s+|my\\s+|this\\s+)?${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+(?:page|screen|tab))?\\b`, "i"), "");
  t = t.replace(/\s+/g, " ").replace(/[\s,;:.!?]+$/, "").trim();
  if (!t) t = s.trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length > 90) t = `${t.slice(0, 89).replace(/\s+\S*$/, "")}…`;
  return page ? `${page.label}: ${t}` : t;
}

/** The problems a narration describes: one draft per sentence that says something is wrong (a bug report) or asks for
 *  something (a task), at most 5; the sentences around one go with it. The page is the one it names, else the narration's
 *  page, else the page it was started on. */
export function draftProblems(text: string, o: { from?: string | null } = {}): ProblemDraft[] {
  const parsed = parseTranscript(text);
  const all = parsed.lines.flatMap((l, i) => l.text.split(/(?<=[.!?])\s+(?=\S)/).map((s) => ({ s: s.trim(), n: i + 1 }))).filter((x) => x.s);
  const whole = pageIn(all.map((x) => x.s).join(" ")) ?? pageFor(o.from);
  const drafts: (ProblemDraft & { page: PageName | null })[] = [];
  for (const { s, n } of all) {
    const bug = BUG.test(s), ask = !bug && ASK.test(s);
    const last = drafts[drafts.length - 1];
    if ((bug || ask) && drafts.length < 5 && s.split(/\s+/).length >= 3) {
      const page = pageIn(s) ?? whole;
      // The same page and kind again is the same problem told in more words.
      if (last && last.page === page && last.kind === (bug ? "bug" : "task") && last.quote.length + s.length < 600) { last.quote = `${last.quote} ${s}`; continue; }
      drafts.push({ kind: bug ? "bug" : "task", title: shortTitle(s, page), quote: s, route: page?.route ?? null, lineNo: n, page });
    } else if (last && last.quote.length + s.length < 600) last.quote = `${last.quote} ${s}`;
  }
  if (!drafts.length && all.length) {
    const s = all.map((x) => x.s).join(" ");
    const page = whole;
    drafts.push({ kind: "bug", title: shortTitle(all[0].s, page), quote: s.slice(0, 600), route: page?.route ?? null, lineNo: 1, page });
  }
  return drafts.map(({ page: _page, ...d }) => ({ ...d, quote: d.quote.slice(0, 600) }));
}

/** A narrated problem's name: "Problem on Tasks, 9 Nov 2026". */
export function problemName(drafts: ProblemDraft[], day: string): string {
  const page = pageFor(drafts[0]?.route ?? null);
  return `${drafts.length > 1 ? `${drafts.length} problems` : "A problem"}${page ? ` on ${page.label}` : ""}, ${dayName(day)}`;
}
