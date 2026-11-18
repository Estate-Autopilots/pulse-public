// TOKENS-2 (orchestrator under the owner's delegation, 17 Nov 2026: "classify each request (small answer / lookup / tool
// action / heavy analysis) and pick the cheapest model that passes; escalate on low confidence or failure; per-company
// override"). Production before (TOKENS-TELEMETRY's audit, 253 runs): every task ran on the strong tier (Opus, or the
// profile's model) whatever it was, and a chat ran on the fast tier unless it was a greeting.
//
// The router reads the request (a chat message, or a task's own words) and gives it one class:
//   small  - a greeting, a thank-you, a screen action, a reminder on a quiet task, a few words with no question  -> small tier
//   lookup - a question about what is in Pulse ("who is on leave today?", "status of the Jote quote?")           -> fast tier
//   action - something to do with Pulse's tools (create, assign, send, remind, a quotation from words)            -> fast tier
//   heavy  - real analysis or long work (analyse, compare, reconcile, a plan or a contract, a statement, files,
//            a long ask)                                                                                        -> strong tier
// A cheaper tier is told it may hand the work up (`{"action":"escalate"}`), and a failed or empty answer there is tried
// once more a tier up (the runner). A company can turn the router off (the old tiers) or set another tier per class;
// a class that needed a stronger tier in 30%+ of its recent runs here starts a tier up (what Pulse learned). An approved
// pattern (the same steps that worked 5+ times, approved by an admin) puts its steps in the prompt and runs on the
// cheaper of its own tier and the class's. Pure, so it is tested on its own (router.test.mjs).

export const CLASSES = ["small", "lookup", "action", "heavy"];
export const DEFAULT_TIERS = { small: "small", lookup: "fast", action: "fast", heavy: "strong" };
const RANK = { small: 0, fast: 1, strong: 2 };
export const UP = { small: "fast", fast: "strong" };
const cheaper = (a, b) => (RANK[a] <= RANK[b] ? a : b);

const HEAVY = /\b(analy[sz]\w*|compar\w*|reconcil\w*|audit\w*|forecast\w*|strateg\w*|evaluat\w*|assess\w*|investigat\w*|research\w*|root cause|deep dive|break ?down|explain (why|in detail)|why (did|is|are|has|have)|pros and cons|projection\w*|trend\w*|month[- ]end|year[- ]end|p ?& ?l|profit and loss|balance sheet|cash ?flow|gstr\w*|gst (return|working|filing)|tds|statements?|ledger\w*|(draft|write|prepare|create|make) (?:[a-z'-]+ ){0,3}(contract|agreement|policy|proposal|plan|report|strategy|sop|business case|presentation|deck)s?|summari[sz]e (all|every|the whole|this month|last month))\b/i;
const HEAVY_DEVANAGARI = /(विश्लेषण|तुलना|रिपोर्ट|योजना|हिसाब मिलान|अहवाल|नियोजन)/;
const ACTION = /\b(create|add|make|assign|reassign|move|mark|update|change|set|send|resend|remind|schedule|reschedule|book|approve|reject|close|reopen|cancel|delete|remove|rename|draft|prepare|quote|record|log|upload|share|invite|follow ?up|ping|notify|pay|transfer|issue|convert|copy|duplicate|post|reply|forward|start|stop|pause|resume|fix|plan)\b/i;
const ACTION_DEVANAGARI = /(बनाओ|बनाइए|भेजो|भेजिए|जोड़ो|करो|कीजिए|बदलो|हटाओ|पाठवा|करा|बनवा|जोडा|बदला)/;
const LOOKUP = /\?|\b(what|who|whom|whose|when|where|which|how (many|much|long|far)|list|show|find|search|status|is there|are there|did|does|do we|have we|has|any|tell me|check|kitne|kitna|kya|kab|kaun|kahan|kidhar)\b/i;
const LOOKUP_DEVANAGARI = /(किती|काय|कधी|कोण|कुठे|क्या|कब|कौन|कहाँ|कितने|कितना)/;
const QUOTE = /(quot|estimate|कोटेशन|क्वोटेशन|दरपत्रक|अंदाजपत्रक|एस्टिमेट|kotation)/i;
const MONEY = /(invoice|payment|bill|gst|बिल|पेमेंट)/i;
const TASK_CAUSES = new Set(["assigned", "daily", "comment", "returned", "subtask", "direct", "continue", "mention"]);

/** The kind of work, named as Pulse names it (2270's ai_task_type), so patterns and decisions match the database. */
export function taskTypeOf(ctx) {
  if (ctx?.task) return `task.${TASK_CAUSES.has(ctx.cause) ? ctx.cause : "look"}`;
  const t = String(ctx?.message?.body ?? "");
  if (!ctx?.message) return "chat.other";
  if (QUOTE.test(t)) return "chat.quote";
  if (MONEY.test(t)) return "chat.money";
  return t.trim().length <= 40 ? "chat.short" : "chat.ask";
}

/** What the request says, in its own words: a chat message, or a task's title, notes and newest lines (the new ones). */
function wordsOf(ctx) {
  if (!ctx?.task) return String(ctx?.message?.body ?? "");
  const t = ctx.task, thread = ctx.thread ?? [];
  const fresh = thread.filter((c) => c?.new && !c?.mine).map((c) => c.body);
  // Something new on a task it already worked: the new lines are the request; otherwise the task itself.
  if (fresh.length && ctx.cause !== "assigned") return fresh.join("\n");
  return [t.title, t.notes, ...thread.slice(-2).map((c) => c?.body)].filter(Boolean).join("\n");
}

const filesOf = (ctx) => (ctx?.message?.files?.length ?? 0) + (ctx?.message?.attachments?.length ?? 0);

/** One class for the request, with why in a few words (recorded on the run). `simple` is thrift's simpleAsk verdict and
 *  `quiet` its quietLook verdict (passed in so this module stays pure). */
export function classify(ctx, { simple = false, quiet = false } = {}) {
  const text = wordsOf(ctx).replace(/\s+/g, " ").trim(), n = text.length;
  if (ctx?.task) {
    if (quiet) return { cls: "small", why: "a reminder on a quiet task" };
    if (HEAVY.test(text) || HEAVY_DEVANAGARI.test(text)) return { cls: "heavy", why: "the task asks for analysis or a long piece of work" };
    if (n > 900 || (ctx.task.subtasks?.length ?? 0) > 6) return { cls: "heavy", why: "a long or many-step task" };
    if (ctx.cause !== "assigned" && n <= 160 && (LOOKUP.test(text) || LOOKUP_DEVANAGARI.test(text)) && !ACTION.test(text)) return { cls: "lookup", why: "a question on the task" };
    return { cls: "action", why: "work to do with Pulse's tools" };
  }
  if (simple) return { cls: "small", why: "a greeting, a thank-you or a screen action" };
  if (filesOf(ctx)) return { cls: "heavy", why: "files to read" };
  if (HEAVY.test(text) || HEAVY_DEVANAGARI.test(text)) return { cls: "heavy", why: "asks for analysis or a long piece of work" };
  if (n > 700) return { cls: "heavy", why: "a long ask" };
  if (QUOTE.test(text)) return { cls: "action", why: "a quotation (its tools do the work)" };
  if (ACTION.test(text) || ACTION_DEVANAGARI.test(text)) return { cls: "action", why: "asks to do something" };
  if (LOOKUP.test(text) || LOOKUP_DEVANAGARI.test(text)) return { cls: "lookup", why: "a question about what is in Pulse" };
  if (n <= 40) return { cls: "small", why: "a few words, no question" };
  return { cls: "lookup", why: "a question in words" };
}

/** The approved pattern for this kind of work, if any (the one used most; patterns come with the engines). */
export function patternFor(ctx, patterns = []) {
  const tt = taskTypeOf(ctx);
  return (patterns ?? []).find((p) => p?.taskType === tt && (p.tools?.length || p.shape)) ?? null;
}

/** The route for one request: {cls, tier, why, mode, pattern, taskType}. `legacy` is the tier the runtime used before the
 *  router (and still uses when the company turned it off); `soft` is "near the end of today's budget" (never above fast);
 *  `cap` is a tier the company's own budget for this kind of work sets as its highest. */
export function routeFor(ctx, cfg = {}, { legacy = "strong", soft = false, cap = null, simple = false, quiet = false } = {}) {
  const r = cfg?.router ?? {}, taskType = taskTypeOf(ctx);
  if (r.mode === "off") return { cls: null, tier: soft ? cheaper(legacy, "fast") : legacy, why: "the router is off for this company", mode: "off", pattern: null, taskType };
  const c = classify(ctx, { simple, quiet });
  let tier = r.tiers?.[c.cls] in RANK ? r.tiers[c.cls] : DEFAULT_TIERS[c.cls], why = c.why;
  if (r.tiers?.[c.cls] in RANK) why += " (the company's setting)";
  else if ((r.learned?.[c.cls] ?? 0) >= 30 && UP[tier]) { tier = UP[tier]; why += " (often needed more here)"; }
  const pattern = patternFor(ctx, cfg?.patterns);
  if (pattern && pattern.tier in RANK) { const t = cheaper(tier, pattern.tier); if (t !== tier) { tier = t; why += " (an approved way of doing it)"; } }
  if (cap in RANK) tier = cheaper(tier, cap);
  if (soft) tier = cheaper(tier, "fast");
  return { cls: c.cls, tier, why: why.slice(0, 120), mode: "auto", pattern, taskType };
}

/** The line a cheaper tier gets: it may hand the work up instead of guessing. */
export const ESCALATE_NOTE = 'If this needs more than you can do well here (careful analysis, many steps, or you are not sure you can get it right), answer only {"action":"escalate","why":"<a few words>"} and a stronger model will take it. Otherwise answer as usual.';
/** Whether an answer hands the work up. */
export const wantsMore = (text) => /"action"\s*:\s*"escalate"/.test(String(text ?? "").slice(0, 600));

/** The prompt part for an approved pattern: the steps that worked before, as the known way. */
export function playbookPart(p) {
  if (!p) return null;
  const steps = (p.tools ?? []).length ? `the tools ${p.tools.join(" → ")}` : "no tools";
  return { key: "playbook", text: `How this kind of work is done here (an admin approved it after it worked the same way many times): ${steps}${p.shape ? `, ending with ${shapeWords(p.shape)}` : ""}. Do it the same way unless this request is different.` };
}
const shapeWords = (s) => String(s).replace(/^task:/, "a ").replace(/^chat:/, "a ").replace(/\+/g, " and ").replace(/status=/g, "status ").replace(/:/g, " ");

/** The answer's shape (recorded on the run, so the same kind of answer is seen as a pattern): what it did, not what it said. */
export function shapeOf(work, a) {
  if (work) {
    const did = [a?.comment && "comment", a?.status && `status=${String(a.status).replace(/[^a-z_]/gi, "").toLowerCase()}`, a?.files?.length && "files",
      a?.subtasks?.length && "subtasks", a?.followups?.length && "followups", a?.plan?.length && "plan"].filter(Boolean);
    return did.length ? `task:${did.join("+")}`.slice(0, 80) : null;
  }
  const act = String(a?.action ?? "reply").replace(/[^a-z_]/gi, "").toLowerCase() || "reply";
  const len = String(a?.message ?? a?.said ?? "").length;
  return `chat:${act}:${len < 200 ? "short" : len < 1000 ? "medium" : "long"}`;
}
