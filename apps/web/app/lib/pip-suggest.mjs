// TASK-MERGE (Pip, owner 7 Nov 2026): "Fix the side panel. It detects keywords in titles and auto-opens irrelevant
// suggestions on the right on its own." Pip now suggests only from real structure: a task given to the reader, a
// Pulse link or a file in a message, a place the task's creator picked or wrote out in full ("Pulse → HR → Policies"),
// the task's type and its project's type. Words in a title or a message never count. Every suggestion has a kind and
// a subject; a person's "Not useful" is kept per person (server side, pulse.pip_feedback) and the same suggestion is
// never shown again, and a kind people keep dismissing scores down for them. Pip opens something by itself only when
// auto-open is switched on (off by default until measured precision is very high) and the score is near certain.
// Pure: no React, no fetch.

/** The kinds of structure a suggestion may stand on. Anything else (words) is refused. */
export const STRUCTURE = new Set(["task", "link", "file", "picked", "written-place", "task-type", "project-type"]);
/** Shown as a one-tap chip at or above this score. */
export const SUGGEST_MIN = 0.85;
/** Opened by itself (when auto-open is on) only at or above this score. */
export const AUTO_MIN = 0.97;

/** The key a dismissal is remembered under: per suggestion kind and subject. */
export const suggestionKey = (kind, subject) => `${String(kind)}:${String(subject)}`;

/** How much this person wants this kind of suggestion, 0–1, from what they did with it before: accepted ones keep it at
 *  1, each dismissal lowers it (four dismissals with no accept halve it). No history: 1. */
export function relevance(stat) {
  const a = Math.max(0, Number(stat?.accepted) || 0), d = Math.max(0, Number(stat?.dismissed) || 0);
  return Math.round(Math.min(1, (a + 4) / (a + d + 4)) * 1000) / 1000;
}

/**
 * Whether one suggestion may be shown, and its score.
 * s: { kind, subject, basis, confidence }. opts: { dismissed: Set<string> of suggestionKey, kinds: { [kind]: { accepted, dismissed } } }.
 * Returns { ok, score, why }: why names the first rule that refused it.
 */
export function qualifies(s, opts = {}) {
  if (!s || !s.kind || s.subject == null || s.subject === "") return { ok: false, score: 0, why: "no subject" };
  if (!STRUCTURE.has(s.basis)) return { ok: false, score: 0, why: "not structure" };
  const conf = Number(s.confidence);
  if (!Number.isFinite(conf)) return { ok: false, score: 0, why: "no confidence" };
  if (opts.dismissed?.has?.(suggestionKey(s.kind, s.subject))) return { ok: false, score: 0, why: "dismissed" };
  const score = Math.round(conf * relevance(opts.kinds?.[s.kind]) * 1000) / 1000;
  if (score < SUGGEST_MIN) return { ok: false, score, why: "not sure enough" };
  return { ok: true, score, why: "" };
}

/** What to do with a set of suggestions: the one to open by itself (only with `autoOpen` on and a near-certain
 *  score), and up to `max` chips to offer. Best first; one per subject. */
export function pickSuggestions(list, opts = {}) {
  const seen = new Set(); const ok = [];
  for (const s of list ?? []) {
    const q = qualifies(s, opts); if (!q.ok) continue;
    const k = suggestionKey(s.kind, s.subject); if (seen.has(k)) continue; seen.add(k);
    ok.push({ ...s, score: q.score });
  }
  ok.sort((a, b) => b.score - a.score);
  const auto = opts.autoOpen && ok[0] && ok[0].score >= AUTO_MIN && ok[0].autoOk ? ok[0] : null;
  return { auto, chips: ok.filter((s) => s !== auto).slice(0, opts.max ?? 2) };
}

const UUIDISH = /^[0-9a-z][0-9a-z-]{2,63}$/i;
/** Pulse pages a message can link to that are worth opening beside the chat. */
const PULSE_PATH = /^\/(tasks|docs|projects|clients|people|processes|steps|goals|hr|finance|me)(\/|\?|$)/;
const URLS = /https?:\/\/[^\s<>"“”]+/g;

/**
 * Suggestions for one chat message, from its structure only: a task attached to it (given to the reader), a link to a
 * page in Pulse, a document file. `directed`: a direct chat, a mention of the reader or a task attached; `direct`: a
 * direct chat. A group message to everyone is never sure enough. The message's words and the attached task's title are
 * never read. m: { body, attachments: [{ id?, name, url?, mime?, task? }] }, ctx: { origin, directed, direct }.
 */
export function chatSuggestions(m, ctx = {}) {
  const out = []; const directed = !!ctx.directed;
  for (const a of m?.attachments ?? []) {
    // A task handed to the reader in their own direct chat is the one case sure enough to open by itself (when on).
    if (a?.task && UUIDISH.test(String(a.task))) out.push({ kind: "chat-task", subject: String(a.task), basis: "task", href: `/tasks/${a.task}`, label: "the task",
      confidence: ctx.direct ? 0.97 : directed ? 0.92 : 0.6, autoOk: !!ctx.direct, reason: "a task was given to you here" });
    else if (a?.id && /^(application\/pdf|text\/plain|text\/markdown)$/.test(String(a.mime ?? ""))) out.push({ kind: "chat-file", subject: String(a.id), basis: "file", href: `file:${a.id}`,
      label: String(a.name || "the file").slice(0, 60), confidence: directed ? 0.86 : 0.5, autoOk: false, reason: "a document was sent to you" });
  }
  const origin = String(ctx.origin ?? "");
  for (const raw of String(m?.body ?? "").match(URLS) ?? []) {
    const url = raw.replace(/[).,;:!?]+$/, "");
    let path = null;
    try { const u = new URL(url); if (origin && u.origin === origin) path = `${u.pathname}${u.search}`; } catch { /* not a link */ }
    if (!path || !PULSE_PATH.test(path)) continue;
    out.push({ kind: "chat-link", subject: path.slice(0, 200), basis: "link", href: path, label: "the linked page", confidence: directed ? 0.9 : 0.6, autoOk: false, reason: "links to a page in Pulse" });
  }
  return out;
}

/** The task page's "Done when" proposal as a suggestion: it stands on the place the creator picked (sure) or wrote out
 *  in full (nearly sure); a place guessed from words is not structure. */
export function doneWhenSuggestion(taskId, target, signals) {
  if (!target || !signals?.length) return null;
  const basis = target.source === "creator" ? "picked" : target.source === "notes" || target.source === "title" ? "written-place" : null;
  if (!basis) return null;
  return { kind: "done-when", subject: String(taskId), basis, confidence: basis === "picked" ? 0.95 : 0.9, autoOk: false };
}
