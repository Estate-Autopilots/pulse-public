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

/** Whether a request is about what is on their screen (then the runtime reads the screen first, ~1,000 tokens). */
export function aboutScreen(text) {
  const t = String(text ?? "");
  return t.length <= 600 && /\b(this|that|these|the)\s+(line|row|item|field|button|form|page|screen|quote|quotation|invoice|tab)\b|\b(click|press|tap|fill|type|tick|untick|select|remove|delete|change|edit|set|update)\b.{0,60}\b(line|row|item|field|button|form|box|column|amount|price|qty|quantity|name|phone|email|date)\b|\bon (my|the) screen\b/i.test(t);
}

/** A plain screen request done without a model: "open finance", "take me to my tasks", "close the sidebar". Returns the
 *  screen tool and its arguments with the words for the reply, or null (anything else goes to the model). */
export function screenDirect(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  if (!t || t.length > 60) return null;
  const side = t.match(/^(?:please\s+)?(open|show|close|hide|fold)\s+(?:the\s+|my\s+)?(?:left\s+)?(?:sidebar|side bar|menu)$/i);
  if (side) { const open = /^(open|show)$/i.test(side[1]); return { tool: "screen_sidebar", args: { open }, words: `${open ? "open" : "close"} the sidebar`, done: `${open ? "opened" : "closed"} the sidebar` }; }
  const m = t.match(/^(?:please\s+|can you\s+|pls\s+)?(?:open|show(?: me)?|go to|take me to|bring up)\s+(?:the\s+|my\s+)?(.{2,40}?)(?:\s+(?:page|screen|tab))?$/i);
  if (!m || /\b(quot\w*|invoice|client|task|project|doc|file|person|chat) (?:for|of|from|named|called|with)\b|\d{2,}/i.test(m[1])) return null;
  const hits = matchDestinations(m[1], 3).filter((h) => h.score >= 3 && h.dest?.href && /^\/(?!\/)/.test(h.dest.href));
  if (!hits.length) return null;
  const best = hits.find((h) => h.dest.kind === "page" && h.score >= hits[0].score - 0.2) ?? hits[0];
  return { tool: "screen_open_page", args: { path: best.dest.href }, words: `open ${best.dest.label}`, done: `opened ${best.dest.label} on your screen` };
}
