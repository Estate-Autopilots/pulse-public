// CHAT-SHELL (22 Oct 2026): which Pulse place a message or an assigned task is about, rules first. "Update your
// profile in My profile" is the reader's own profile; "add tasks to the Riverside project" is that project; "apply for
// leave" is My desk → Leave. Each guess carries a confidence: at AUTO_OPEN or more the chat opens the place in its side
// panel by itself, from SUGGEST a one-tap chip offers it, below that nothing shows. A coach names the exact control
// for Pip to point at once the place is open. Pure (no React, no fetch): a model can be added later as one more
// resolver beside these rules (chats/workspace/intent.ts), never instead of them.
import { DESTINATIONS, canSee, goHref, matchDestinations, norm } from "../destinations/registry.mjs";

export const AUTO_OPEN = 0.85;
export const SUGGEST = 0.55;

/** Words that ask someone to do something somewhere. */
const DO = /\b(update|add|fill(?: in| out)?|complete|upload|submit|apply|open|go to|check|review|set up|setup|create|approve|mark|finish|edit|change|attach|put|enter|record|log)\b/i;
/** Words that name a place in Pulse. */
const PLACE = /\b(page|tab|section|screen|in pulse|on pulse)\b/i;
/** Registry phrases too ordinary in chat to mean the place on their own ("me", "home", "thanks", "history"). */
const GENERIC = new Set(["me", "home", "start", "overview", "chat", "chats", "messages", "groups", "group", "whatsapp", "desk", "today", "thanks", "kudos", "claim", "people",
  "staff", "colleagues", "accounts", "cash", "money", "books", "setup", "preferences", "alerts", "bell", "history", "results", "points", "columns", "brief", "close",
  "team", "work", "tasks", "to do", "todo", "this week", "my day", "my week", "streak", "holiday", "sunday", "extra day", "day off", "arrival", "approve", "leads", "ads", "sites", "locations",
  "packages", "bank", "reminders", "documents", "notices", "statements", "ca", "pan", "aadhaar", "matches", "blockers map", "dependencies", "kanban", "board", "boards", "process", "points this week"]);
/** Places the side panel never opens on its own (the chat itself). */
const NEVER = new Set(["chats"]);

const clamp = (n) => Math.round(Math.min(0.99, Math.max(0, n)) * 100) / 100;
const words = (s) => norm(s).split(" ").filter(Boolean);
const has = (text, phrase) => ` ${norm(text)} `.includes(` ${norm(phrase)} `);

/**
 * The places a text is about, most likely first, one per address.
 * ctx: viewer (the reader's person id), projects [{ id, name }] (work projects), people [{ id, name }], role (the
 * shell's role label) and modulesOff (to leave out what this person cannot see), directed (a task assigned to the
 * reader, or a direct message: a little more likely meant for them).
 * Each: { id, label, href, confidence, reason, source: rule | project | person | place, coach?: { selector?, button?, text } }.
 */
export function detectIntent(text, ctx = {}) {
  const t = String(text ?? "").slice(0, 2000);
  if (!t.trim() || /^\s*\/\w+/.test(t) && !/^\s*\/open\b/i.test(t)) return [];
  const out = [];
  // "open my steps" / "/open finance": the person asks for the place itself.
  const asked = /^\s*\/?(open|show( me)?|go to)\b/i.test(t);
  const act = DO.test(t), place = PLACE.test(t), lift = (ctx.directed ? 0.05 : 0) + (asked ? 0.15 : 0);

  // My profile: "update your profile", "my profile", "your profile photo". Said by someone else, "your" is the reader.
  const own = /\b(my|your|ur|own)\s+(profile|bio|about)\b/i.test(t);
  const loose = /\bprofile\s+(photo|picture|pic|details|info|page)\b/i.test(t) || /\b(update|complete|fill)\b[^.!?]{0,30}\bprofile\b/i.test(t);
  if (own || loose) {
    const named = /\b(in|on|at)\s+(my|your)\s+profile\b/i.test(t);
    out.push({ id: "me.profile", label: "My profile", href: ctx.viewer ? `/people/${encodeURIComponent(ctx.viewer)}?tab=info` : "/me/profile", source: "rule",
      confidence: clamp((own ? 0.72 : 0.6) + (act ? 0.13 : 0) + (named ? 0.08 : 0) + lift), reason: own ? "says “your profile”" : "asks to update a profile",
      coach: { selector: "#info-about", text: "Edit what colleagues see about you here" } });
  }

  // Someone's profile: "Ravi's profile".
  for (const p of ctx.people ?? []) {
    const first = String(p.name ?? "").split(" ")[0]; if (!first || first.length < 3 || p.id === ctx.viewer) continue;
    for (const n of new Set([p.name, first])) {
      if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['’]s\\s+profile\\b`, "i").test(t)) {
        out.push({ id: `person:${p.id}`, label: `${p.name}’s profile`, href: `/people/${encodeURIComponent(p.id)}`, source: "person", confidence: clamp(0.78 + lift), reason: `names ${n}’s profile` });
        break;
      }
    }
  }

  // A work project by its name: "add tasks to the Riverside Villas project".
  const projectWord = /\bprojects?\b/i.test(t);
  for (const p of ctx.projects ?? []) {
    const name = String(p.name ?? "").trim(); const w = words(name);
    if (!name || name.length < 3 || !w.length) continue;
    // A one-word name such as "Website" is too ordinary on its own: the text must also say "project".
    if (w.length === 1 && (!projectWord || GENERIC.has(w[0]) || name.length < 4)) continue;
    if (!has(t, name)) continue;
    const addTasks = /\b(add|create|put|make)\b[^.!?]{0,40}\btasks?\b/i.test(t);
    out.push({ id: `project:${p.id}`, label: name, href: `/tasks/projects/${encodeURIComponent(p.id)}`, source: "project",
      confidence: clamp(0.6 + (projectWord ? 0.15 : 0) + (act ? 0.12 : 0) + Math.min(0.06, (w.length - 1) * 0.03) + lift), reason: `names the project “${name}”`,
      coach: addTasks ? { button: "Add task", text: "Add the tasks to this project here" } : undefined });
  }

  // Places in Pulse by the words people use for them (the destinations registry).
  for (const { dest, score, matched } of matchDestinations(t, 6)) {
    if (NEVER.has(dest.id) || (dest.parent && NEVER.has(dest.parent))) continue;
    if (ctx.role !== undefined && !canSee(dest, { role: ctx.role, modulesOff: ctx.modulesOff })) continue;
    const m = norm(matched); const n = words(matched).length;
    if (score < 3 || GENERIC.has(m)) continue;
    // One word said whole ("Finance") counts only with a word that asks for something or names a place.
    if (n === 1 && !act && !place) continue;
    const named = new RegExp(`\\b(in|on|under|from)\\s+(the\\s+)?${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(norm(t));
    const href = dest.kind === "section" || dest.kind === "control" ? goHref(dest) : dest.href;
    out.push({ id: dest.id, label: dest.path.join(" → "), href, source: "place", confidence: clamp(0.45 + Math.min(0.2, (score - 3) * 0.1) + (act ? 0.2 : 0) + (place ? 0.05 : 0) + (named ? 0.1 : 0) + lift),
      reason: `mentions “${matched}”`, coach: dest.coach ? { text: dest.coach } : undefined });
  }

  const seen = new Set();
  return out.sort((a, b) => b.confidence - a.confidence).filter((i) => { const k = i.href.replace(/[?&]go=[^&]*/, ""); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** What the chat does with the guesses: open the best one by itself when it is clearly meant, else offer up to two. */
export function decide(intents) {
  const list = intents ?? [];
  const auto = list[0] && list[0].confidence >= AUTO_OPEN ? list[0] : null;
  return { auto, chips: list.filter((i) => i !== auto && i.confidence >= SUGGEST).slice(0, 2) };
}

/** Every place a person could ask for by name (for "/open" suggestions). */
export function openablePlaces(role, modulesOff) {
  return DESTINATIONS.filter((d) => (d.kind === "page" || d.kind === "tab") && !NEVER.has(d.id) && (role === undefined || canSee(d, { role, modulesOff })))
    .map((d) => ({ id: d.id, label: d.path.join(" → "), href: d.href, words: [d.label, ...(d.synonyms ?? [])].join(" ") }));
}
