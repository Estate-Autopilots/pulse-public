// AGENT-MEMORY (8 Nov 2026, bugs seen in the 7 Nov demo): "Can you remember that?" made a task, and "I have noted that every
// quotation …" was never kept. These typed rules read a message before any model call: a request to remember or note
// something, a standing instruction (always / never / every quotation should … / from now on), or "undo". Pure, so it is
// tested on its own (intent.test.mjs); Pulse decides who may set a rule and keeps both (migration 1840).

const CLEAN = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
/** Polite openings that do not change what is asked. */
const LEAD = /^(?:(?:hey|hi|hello|ok|okay|so|and|also|btw|please|pls|kindly|great|thanks|thank you)\b[\s,!.:-]*)+/i;
const ASK = /^(?:(?:can|could|would|will) you(?: please| kindly)?|please|pls|kindly)\s+/i;
/** "that", "this", "it", nothing: the note is what they said just before. */
const ONLY_REF = /^(?:that|this|it|these|those|the above|all (?:of )?that|what i (?:just )?said|this one|that one|for me|for later)?(?:\s+(?:for me|for later|please|pls))*[\s.!?]*$/i;
/** A standing instruction: it changes how the AI employee works from now on. */
const STANDING = [
  /^(?:always|never|from now on|going forward|henceforth|in future|in the future|any ?time|whenever|every time|each time|don'?t ever|do not ever|make sure (?:you )?always)\b/i,
  /\b(?:every|each|all|any)\s+(?:quotations?|quotes?|estimates?|invoices?|bills?|tasks?|clients?|messages?|replies|proposals?|orders?)\b.*\b(?:should|must|shall|has to|have to|needs? to|will)\b/i,
  /\b(?:should|must)\s+always\b/i,
];
const NOTE_LEAD = /^(?:remember|note|keep in mind|bear in mind|make a note|take a note|save (?:a|this as a) note|jot (?:this |that |it )?down|write (?:this |that |it )?down|add (?:this |that |it )?to your notes|put (?:this |that |it )?in your notes)\b(?:\s+(?:that|this|it|down|of this|of that))?\s*[:,-]?\s*/i;
const NOTED = /^(?:i(?:'ve| have)? (?:just )?noted|noted|i want you to (?:know|remember)|fyi|for your information|for your notes|note for you)\b(?:\s+(?:that|this))?\s*[:,-]?\s*/i;
const RULE_LEAD = /^(?:from now on|going forward|henceforth|in future|in the future)\b[\s,:-]*/i;
const UNDO = /^(?:undo|undo (?:that|it|this|the last note|that note|that rule)|forget (?:that|it|this|what i just said)|don'?t remember (?:that|it|this)|do not remember (?:that|it|this)|remove (?:that|this|it|the last) (?:note|rule)|delete (?:that|this|the last) (?:note|rule)|scratch that)[\s.!]*$/i;
// AGENT-MEMORY (2090): people see and forget what it remembers about them, in chat too.
const RECALL = /^(?:what|wht)\s+(?:do|did|have)\s+you\s+(?:remember|know|kept|keep|noted|note|learn(?:ed|t)?|save[d]?)\s+(?:about|on|of)\s+me\b[\s?.!]*$|^(?:show|tell|list)(?: me)?\s+(?:what you (?:remember|know) about me|my notes|your notes (?:about|on) me)[\s?.!]*$/i;
const FORGET_ME = /^(?:forget|delete|erase|clear|remove|wipe)\s+(?:everything|all|all of it|all your notes|whatever you (?:know|remember))?\s*(?:you (?:know|remember|have|kept) )?(?:about|on|of)\s+me\b[\s.!]*$|^(?:forget me|clear my (?:memory|notes)|delete my (?:memory|notes))[\s.!]*$/i;

/** Whether this text is a standing instruction (a behaviour rule) rather than a fact. */
export function isStanding(text) { const t = CLEAN(text); return STANDING.some((r) => r.test(t)); }

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const tidy = (s) => CLEAN(s).replace(/^[:,-]\s*/, "").replace(/\s*\?+$/, "").replace(/\s+please[.!]*$/i, "").trim();

/** What a message asks of its memory, or null (then the model answers as usual):
 *  {kind: "undo"} | {kind: "note" | "rule", body, ref} — ref: the note is the earlier message ("remember that"). "Remember
 *  to send it tomorrow" is a to-do (null: a task may be right), not a note. */
export function memoryIntent(text) {
  let t = CLEAN(text).replace(/^(?:@[\w.-]+[,:]?\s*)+/, "");
  if (!t || t.length > 1500) return null;
  t = t.replace(LEAD, "").trim();
  if (UNDO.test(t)) return { kind: "undo" };
  const plain = t.replace(ASK, "").trim();
  if (RECALL.test(plain)) return { kind: "recall" };
  if (FORGET_ME.test(plain)) return { kind: "forget_all" };
  const asked = t.replace(ASK, "").trim();
  // From now on …: the rest is the rule.
  if (RULE_LEAD.test(asked)) { const body = tidy(asked.replace(RULE_LEAD, "")); return body.length >= 3 ? { kind: "rule", body: cap(body), ref: false } : null; }
  let rest = null;
  if (NOTE_LEAD.test(asked)) {
    // "remember to …" / "note to call …": a to-do, not a note.
    if (/^(?:remember|note)\s+to\s+(?!self\b)/i.test(asked)) return null;
    rest = asked.replace(NOTE_LEAD, "");
  } else if (NOTED.test(asked)) rest = asked.replace(NOTED, "");
  if (rest !== null) {
    const body = tidy(rest);
    if (ONLY_REF.test(body)) return { kind: "note", body: "", ref: true };
    // "Can you remember what I said yesterday?" asks it to recall, not to keep something.
    if (/\?\s*$/.test(asked) && /^(?:what|when|who|whom|where|how|if|whether|which|why)\b/i.test(body)) return null;
    if (body.length < 3) return null;
    return { kind: isStanding(body) ? "rule" : "note", body: cap(body), ref: false };
  }
  // A bare standing instruction ("Every quotation should mention …", "Always copy Kazuk on quotes") is a rule; a
  // question is not ("Should every quotation …?").
  if (isStanding(asked) && !/\?\s*$/.test(asked) && !/^(?:should|do|does|can|could|would|will|is|are|why|what|how|when)\b/i.test(asked)) return { kind: "rule", body: cap(tidy(asked)), ref: false };
  return null;
}

/** For "remember that": the latest earlier message by the same person that is not itself a memory request; else none.
 *  recent: the conversation, oldest first ({author, body, mine}). */
export function earlierNote(recent, author, current) {
  const list = Array.isArray(recent) ? recent : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.mine || m.byAgent || CLEAN(m.body) === CLEAN(current)) continue;
    if (author && m.author && m.author !== author) continue;
    const it = memoryIntent(m.body);
    if (it && (it.kind === "undo" || it.ref)) continue;
    const body = CLEAN(m.body);
    if (body.length >= 3) return body.slice(0, 1000);
  }
  return "";
}

/** Whom a note is about: a colleague it names (@username, a full name, or a first name only one colleague has), else the
 *  person who wrote it when they speak of themselves ("I", "me", "my"): {username, name} | {self: true, name} | null.
 *  people: its colleagues [{name, username}]. */
export function aboutOf(body, people = [], asker = null) {
  const t = String(body ?? "");
  const low = t.toLowerCase();
  const list = (Array.isArray(people) ? people : []).filter((p) => p && p.username && p.name);
  const at = low.match(/@([a-z0-9._-]+)/)?.[1];
  const who = (p) => ({ username: String(p.username), name: p.name });
  if (at) { const p = list.find((x) => String(x.username ?? "").toLowerCase() === at); if (p) return who(p); }
  const full = list.find((p) => p.name.length > 3 && new RegExp(`\\b${esc(p.name.toLowerCase())}\\b`).test(low));
  if (full) return who(full);
  const one = list.map((p) => ({ p, f: p.name.split(/\s+/)[0].toLowerCase() })).filter((x) => x.f.length > 2 && new RegExp(`\\b${esc(x.f)}(?:'s)?\\b`).test(low));
  if (one.length === 1) return who(one[0].p);
  if (asker && /\b(?:i|me|my|mine|myself|i'm|i've|i'd|i'll)\b/i.test(t)) return { self: true, name: asker.name ?? "you" };
  return null;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The topic of a note about no one in particular (shown on the Knowledge tab and in the confirmation). */
export function topicOf(body) {
  const t = String(body ?? "").toLowerCase();
  const topics = [[/\b(quotations?|quotes?|estimates?)\b/, "quotations"], [/\b(invoices?|bills?|payments?)\b/, "invoices and payments"],
    [/\b(clients?|customers?)\b/, "clients"], [/\b(tasks?|deadlines?)\b/, "tasks"], [/\b(prices?|pricing|rates?|discounts?)\b/, "pricing"],
    [/\b(projects?|sites?)\b/, "projects"], [/\b(leaves?|holidays?|attendance)\b/, "leave and attendance"]];
  return topics.find(([r]) => r.test(t))?.[1] ?? "general";
}

/** AGENT-MEMORY (2090): the answer to "what do you remember about me?", from what Pulse returned (never the model's words).
 *  r: {direct, items: [{body, private, by, where}], count}. In a group it lists nothing (private notes stay private). */
export function recallText(r, link) {
  const where = link ? ` You can see, correct or forget each one here: ${link}` : "";
  if (!r?.direct) return r?.count ? `I keep ${r.count} note${r.count === 1 ? "" : "s"} about you. Ask me in our direct chat and I'll list them, or open my Knowledge tab.${where}` : `I don't keep any notes about you yet.${where}`;
  const items = (Array.isArray(r.items) ? r.items : []).slice(0, 12);
  if (!items.length) return `I don't keep any notes about you yet. When you tell me how you like to work, I'll remember it for our chats.${where}`;
  const line = (x) => `- ${String(x.body).slice(0, 160)}${x.by ? ` (written by ${x.by})` : x.where ? ` (from ${x.where})` : ""}`;
  const more = (r.count ?? items.length) > items.length ? `\n…and ${r.count - items.length} more.` : "";
  return `Here's what I remember about you (only you see the private ones):\n${items.map(line).join("\n")}${more}\nSay "forget everything about me" and I'll let it all go.${where}`;
}
/** The answer to "forget everything about me". r: {forgotten, kept}. */
export function forgotText(r) {
  const n = Number(r?.forgotten ?? 0), kept = Number(r?.kept ?? 0);
  const k = kept ? ` ${kept} note${kept === 1 ? "" : "s"} your manager wrote stay${kept === 1 ? "s" : ""}; ask them to change ${kept === 1 ? "it" : "them"}.` : "";
  return n ? `Done. I've forgotten ${n} thing${n === 1 ? "" : "s"} I remembered about you.${k}` : `I had nothing of my own to forget about you.${k}`;
}

/** The confirmation it posts, from what Pulse kept (never the model's words). */
export function rememberedText(saved, body, link) {
  const short = body.length > 160 ? `${body.slice(0, 157)}…` : body;
  const where = link ? ` You can see or change it here: ${link}` : "";
  if (saved?.kind === "rule") {
    const scope = { quotation: " for quotations", invoice: " for invoices", task: " for tasks", chat: " for messages" }[saved.scope] ?? "";
    return `Saved as a standing rule${scope}: "${short}". I'll follow it from now on${saved.include ? `, and every quotation I draft will include "${saved.include}"` : ""}. Reply "undo" to remove it.${where}`;
  }
  const about = saved?.about?.name ?? (saved?.topic && saved.topic !== "general" ? saved.topic : "this");
  const down = saved?.downgraded ? ` Only ${saved.canSetRules ?? "my owner"} or an admin can make it a rule for everyone, so I'll keep it in mind when I work with you.` : "";
  return `Saved to my notes about ${about}: "${short}".${down} Reply "undo" to remove it.${where}`;
}
