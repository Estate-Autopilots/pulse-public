// FIX-CHAT-AI (owner walkthrough, 10 Nov 2026: "one simple request used about 113k tokens; cut this 20-100x; measure
// before and after per task"): small, pure helpers the runner uses to spend fewer tokens and to say what each call cost.
// Pure, so they are tested on their own (thrift.test.mjs).
import { estimate } from "./budget.mjs";

/** One log line per model call: the prompt's size and its biggest parts (keys and token estimates; never the text). */
export function promptStats(parts, fit, rt) {
  const sizes = (parts ?? []).filter((p) => p?.text).map((p) => [p.key, estimate(p.text)]).sort((a, b) => b[1] - a[1]);
  return `~${fit?.tokens ?? sizes.reduce((n, [, t]) => n + t, 0)} tokens (${rt?.provider ?? "?"}/${rt?.model ?? "default"}; biggest: ${sizes.slice(0, 5).map(([k, t]) => `${k} ${t}`).join(", ")})${fit?.trimmed?.length ? ` trimmed ${fit.trimmed.join(",")}` : ""}`;
}

const SIMPLE = /^(?:hi|hello|hey|hii+|ok(?:ay)?|thanks?|thank you|thx|great|good|nice|cool|sure|yes|no|done|got it|noted|👍|🙏|good (?:morning|night|evening|afternoon))\b[\s!.?🙂😊👍🙏]*$/i;
const SCREEN = /^(?:please\s+)?(?:open|show|close|hide|fold|unfold|go to|take me to|point (?:at|to)|scroll)\b/i;
/** A chat ask simple enough for the smallest model: a greeting or thanks, or a short screen action ("open Finance",
 *  "close the sidebar"). Questions about data, money, people or work are not simple (they need the usual model). */
export function simpleAsk(text, { kind = "chat.direct" } = {}) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 80 || /client\.silent|call\.|consult/.test(kind)) return false;
  if (SIMPLE.test(t)) return true;
  return SCREEN.test(t) && !/\b(quot\w*|invoice\w*|price|payment|delete|remove|send|approve|create|make|add)\b/i.test(t);
}

// The web's own map of Pulse's places (a pure module; Ctrl+K and the task companion read the same list).
import { matchDestinations } from "../../apps/web/app/destinations/registry.mjs";
// DOCS-EDITOR-8: the Learn walkthroughs (a pure module too), for "how do I …".
import { matchTutorial } from "../../apps/web/app/lib/learn.mjs";

/** Whether a request is about what is on their screen (then the runtime reads the screen first, ~1,000 tokens). */
export function aboutScreen(text) {
  const t = String(text ?? "");
  return t.length <= 600 && /\b(this|that|these|the)\s+(line|row|item|field|button|form|page|screen|quote|quotation|invoice|tab)\b|\b(click|press|tap|fill|type|tick|untick|select|remove|delete|change|edit|set|update)\b.{0,60}\b(line|row|item|field|button|form|box|column|amount|price|qty|quantity|name|phone|email|date)\b|\bon (my|the) screen\b/i.test(t);
}

const HOW = /^(?:please\s+|so\s+|ok\s+|hey\s+)?(?:how\s+(?:do|can|should|would)\s+(?:i|we|one)|how\s+(?:to|is)|show\s+me\s+how\s+(?:to|do\s+i|i)|teach\s+me\s+(?:how\s+)?to|where\s+do\s+i)\s+(.{2,60})$/i;
/** A plain screen request done without a model: "open finance", "take me to my tasks", "close the sidebar". Returns the
 *  screen tool and its arguments with the words for the reply, or null (anything else goes to the model). */
export function screenDirect(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  if (!t || t.length > 60) return null;
  // DOCS-EDITOR-8 (owner, 17 Nov 2026: "if someone asks 'how do I add a bank statement / a task', the agent should show
  // it on the screen"): a "how do I …" that a walkthrough answers is played on their screen, step by step (no model call).
  // One no walkthrough answers goes to the model (it explains in words), never to "open a page".
  const how = t.match(HOW);
  if (how) {
    const tut = matchTutorial(how[1]);
    if (!tut) return null;
    return { tool: "screen_show_me_how", args: { question: t, tutorial: tut.id }, words: `show you “${tut.title}” step by step`, done: `showing you “${tut.title}” on your screen`,
      say: `Sure, I’ll show you on the page: “${tut.title}”, ${tut.steps.length} short steps. Press Next as you go, or Do it for me and I’ll do it.` };
  }
  const side = t.match(/^(?:please\s+)?(open|show|close|hide|fold)\s+(?:the\s+|my\s+)?(?:left\s+)?(?:sidebar|side bar|menu)$/i);
  if (side) { const open = /^(open|show)$/i.test(side[1]); return { tool: "screen_sidebar", args: { open }, words: `${open ? "open" : "close"} the sidebar`, done: `${open ? "opened" : "closed"} the sidebar` }; }
  const m = t.match(/^(?:please\s+|can you\s+|pls\s+)?(?:open|show(?: me)?|go to|take me to|bring up)\s+(?:the\s+|my\s+)?(.{2,40}?)(?:\s+(?:page|screen|tab))?$/i);
  if (!m || /\b(quot\w*|invoice|client|task|project|doc|file|person|chat) (?:for|of|from|named|called|with)\b|\d{2,}/i.test(m[1])) return null;
  const hits = matchDestinations(m[1], 3).filter((h) => h.score >= 3 && h.dest?.href && /^\/(?!\/)/.test(h.dest.href));
  if (!hits.length) return null;
  const best = hits.find((h) => h.dest.kind === "page" && h.score >= hits[0].score - 0.2) ?? hits[0];
  return { tool: "screen_open_page", args: { path: best.dest.href }, words: `open ${best.dest.label}`, done: `opened ${best.dest.label} on your screen` };
}

// TOKENS-TELEMETRY (owner, 17 Nov 2026: "we spend a lot of tokens on very small tasks"): production's daily looks were 46%
// of all AI tokens, ~27k tokens each, and 104 of 105 had nothing new on the task. Pulse now skips most of them
// (2270 agent_tasks_daily); a quiet look that still runs (the first reminders) is a reminder, not new work, so it
// leaves out what only new work needs: everyone it could give a sub-task to, its conversations, other groups' chat,
// the company snapshot, and all but the newest lines of the thread.
/** Whether this task look is a daily look with nothing new since the last one (no fresh comment, answer or sub-task). */
export function quietLook(ctx) {
  if (!ctx?.task || ctx.cause !== "daily") return false;
  return !(ctx.thread ?? []).some((c) => c.new && !c.mine);
}
/** The tokens a model call usually costs for work Pulse now does by a rule (measured; the dashboard's "saved"). */
export const SAVED_EST = { "chat.screen_direct": 13300, "chat.memory_intent": 13300, "chat.fold_newer": 13300 };
/** The model tier by kind of work: a quiet daily look is a reminder, so it runs on the fast tier, never the strong one
 *  (production: 104 quiet looks ran on Opus "thinking" at ~27k tokens each). Other work keeps its tier. */
export function tierFor(ctx, tier) {
  return tier === "strong" && quietLook(ctx) ? "fast" : tier;
}
