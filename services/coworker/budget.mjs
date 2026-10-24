// FEATURES-1024 (owner, 24 Oct 2026: "some runs burn 500k to several million tokens"): every AI employee run keeps to
// a budget. Each kind of work has its own input and output budget (chat replies small and fast, work larger and strong;
// the organisation can change them, agent_org_ai.budgets); the prompt is fitted to it (oldest chat first, then notes,
// then the people list are trimmed; only notes that matter to this message are given); at 80% of the day (the AI
// employee's or the organisation's) it wraps up briefly, at 100% it stops and asks its manager. A Codex run that loops
// (the same command again and again, too many commands) or talks past its output budget is stopped (watchCodex).
// Pure, so it is tested on its own (budget.test.mjs).

export const DEFAULT_BUDGETS = { chat: { in: 30000, out: 4000, tier: "fast" }, task: { in: 300000, out: 40000, tier: "strong" } };
/** Tokens a CLI adds on its own before our prompt (its system prompt), measured roughly on this server. */
export const OVERHEAD = { claude: 12000, codex: 12000, api: 0, stub: 0 };
const num = (x, lo, hi, d) => { const n = Number(x); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : d; };

/** The organisation's budgets over the defaults, each number kept in a sane range. */
export function budgetsFor(org = {}) {
  const out = {};
  for (const k of Object.keys(DEFAULT_BUDGETS)) {
    const d = DEFAULT_BUDGETS[k], o = org?.[k] ?? {};
    out[k] = { in: num(o.in, 2000, 2000000, d.in), out: num(o.out, 500, 200000, d.out), tier: o.tier === "fast" || o.tier === "strong" ? o.tier : d.tier };
  }
  return out;
}
export const estimate = (text) => Math.ceil(String(text ?? "").length / 4);

/** Fits the prompt's parts into `limit` tokens. Parts: [{key, text, drop: order (lower goes first; absent: never)}];
 *  a droppable part is cut to its newest half, then removed. Returns {prompt, tokens, trimmed: [keys], over}. */
export function fitPrompt(parts, limit) {
  const p = parts.filter((x) => x.text).map((x) => ({ ...x }));
  const total = () => estimate(p.map((x) => x.text).join("\n\n"));
  const trimmed = [];
  for (const x of p.filter((y) => y.drop !== undefined).sort((a, b) => a.drop - b.drop)) {
    while (total() > limit && x.text.length > 400) { x.text = `…${x.text.slice(Math.floor(x.text.length / 2))}`; if (!trimmed.includes(x.key)) trimmed.push(x.key); }
    if (total() > limit) { x.text = ""; if (!trimmed.includes(x.key)) trimmed.push(x.key); }
  }
  const prompt = p.map((x) => x.text).filter(Boolean).join("\n\n");
  return { prompt, tokens: estimate(prompt), trimmed, over: estimate(prompt) > limit };
}

const WORDS = (s) => new Set(String(s ?? "").toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
/** Only the notes that matter to this message (shared words), newest first among equals, at most `max`. */
export function relevantMemory(memory = [], query = "", max = 8) {
  const q = WORDS(query);
  return memory.map((m, i) => ({ m, i, s: [...WORDS(m)].filter((w) => q.has(w)).length })).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, max).map((x) => x.m);
}

/** Where the day stands: ok, soft (80%: wrap up and summarise) or hard (100%: stop and ask), and whose limit. */
export function dayLevel({ usedToday = 0, dailyBudget = null, orgUsedToday = 0, orgDaily = null } = {}) {
  const share = (u, b) => (b ? u / b : 0);
  const a = share(usedToday, dailyBudget), o = share(orgUsedToday, orgDaily);
  const top = Math.max(a, o), who = o > a ? "organisation" : "own";
  return { level: top >= 1 ? "hard" : top >= 0.8 ? "soft" : "ok", who, share: Math.round(top * 100) };
}

/** A line reader for `codex exec --json`: returns why to stop the run, or null. Too many commands, the same command
 *  three times, or more text than the output budget allows (in characters, ~4 per token, with room). */
export function watchCodex({ maxCommands = 12, outTokens = 4000 } = {}) {
  const seen = new Map(); let commands = 0, chars = 0;
  return (line) => {
    let d; try { d = JSON.parse(line); } catch { return null; }
    const item = d.item ?? {};
    if (d.type === "item.started" || d.type === "item.completed") {
      if (item.type === "command_execution" && d.type === "item.started") {
        commands += 1; const c = String(item.command ?? "").trim(); const n = (seen.get(c) ?? 0) + 1; seen.set(c, n);
        if (n >= 3) return `runaway: it ran the same command ${n} times`;
        if (commands > maxCommands) return `runaway: more than ${maxCommands} commands in one run`;
      }
      if (d.type === "item.completed" && (item.type === "agent_message" || item.type === "reasoning")) chars += String(item.text ?? "").length;
      if (chars > outTokens * 4 * 3) return "runaway: it kept writing past its output budget";
    }
    return null;
  };
}
