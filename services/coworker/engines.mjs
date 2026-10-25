// FEATURES-1024 (owner, 24 Oct 2026: "AI employees behave stupidly when their preferred subscription is out of quota"):
// the engine router. An AI employee's run goes to the first engine of its chain that is healthy and has quota:
//   its own chain (profile), else its organisation's default, else: its preferred engine, this server's Claude, this
//   server's Codex, every AI connection of the organisation (Settings → AI), a key this runtime holds (from Infisical:
//   ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY), then a local model (Ollama) when one answers.
// Health comes from the plans' known reset times (quota.json), each connection's reported state, and what this runtime
// saw lately (a 429 or an error marks an engine down for a while). Chat replies run "fast" (a cheaper model, low
// effort); work runs "strong". Pure where it can be, so it is tested on its own (engines.test.mjs).

export const ENGINE = /^(server:(claude|codex)|connection:[0-9a-f-]{36}|env:(anthropic|openai|openrouter)|local:ollama|stub)$/;
const ENV_KEYS = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const ENV_API = {
  anthropic: { style: "anthropic", baseUrl: "https://api.anthropic.com/v1", models: { fast: "claude-haiku-4-5", strong: "claude-sonnet-4-5" } },
  openai: { style: "openai", baseUrl: "https://api.openai.com/v1", models: { fast: "gpt-5-mini", strong: "gpt-5" } },
  openrouter: { style: "openai", baseUrl: "https://openrouter.ai/api/v1", models: { fast: "openrouter/auto", strong: "openrouter/auto" } },
};
const CLAUDE_MODEL = /^(claude-|opus|sonnet|haiku)/i, CODEX_MODEL = /^(gpt-|o\d|codex)/i;
const LABEL = { "server:claude": "Claude subscription", "server:codex": "Codex subscription", "env:anthropic": "Anthropic API key", "env:openai": "OpenAI API key",
  "env:openrouter": "OpenRouter key", "local:ollama": "local model", stub: "test runtime" };

/** The engines this run may use, in order, each {id, kind, provider, label, connection?}. `cfg` is GET /api/v0/agent/engines. */
export function engineChain(me, cfg = {}, { env = {}, local = false } = {}) {
  if (me.provider === "stub") return [describe("stub", cfg, env)];
  const own = (cfg.agent ?? []).filter((x) => ENGINE.test(x)), org = (cfg.org ?? []).filter((x) => ENGINE.test(x));
  let ids = own.length ? own : org;
  if (!ids.length) {
    const conns = (cfg.connections ?? []).filter((c) => c.state !== "expired");
    ids = [me.aiConnectionId ? `connection:${me.aiConnectionId}` : me.provider === "codex" ? "server:codex" : "server:claude", "server:claude", "server:codex",
      ...conns.map((c) => `connection:${c.id}`), ...Object.keys(ENV_KEYS).map((k) => `env:${k}`), "local:ollama"];
  }
  return [...new Set(ids)].map((id) => describe(id, cfg, env)).filter((e) => e && (e.kind !== "env" || e.secret) && (e.kind !== "local" || local));
}
function describe(id, cfg, env) {
  const [kind, rest] = id.split(":");
  if (id === "stub") return { id, kind: "stub", provider: "stub", label: LABEL.stub };
  if (kind === "server") return { id, kind, provider: rest, label: LABEL[id] };
  if (kind === "env") return { id, kind, provider: rest, label: LABEL[id], secret: env[ENV_KEYS[rest]] || null };
  if (kind === "local") return { id, kind, provider: "local", label: LABEL[id] };
  const c = (cfg.connections ?? []).find((x) => x.id === rest);
  return c ? { id, kind: "connection", provider: c.provider, label: `${c.name} (${c.kind === "api" ? "API key" : "subscription"})`, connection: c } : null;
}

/** What this runtime knows about each engine's health: down until when, and why. Server plans also read quota.json. */
export class Health {
  constructor(now = () => Date.now()) { this.now = now; this.down = new Map(); }
  mark(id, until, why) { this.down.set(id, { until: until ? new Date(until).getTime() : this.now() + 10 * 60000, why: String(why ?? "").slice(0, 160) }); }
  clear(id) { this.down.delete(id); }
  /** {until, why} when the engine is out, else null. `quota` maps provider → Date for this server's plans. */
  state(e, quota = {}) {
    const t = this.now();
    if (e.kind === "server" && quota[e.provider] && quota[e.provider].getTime() > t) return { until: quota[e.provider].getTime(), why: "out of quota" };
    if (e.kind === "connection") {
      const c = e.connection;
      if (c.state === "expired") return { until: null, why: "its sign-in or key was refused" };
      if (c.state === "out_of_quota" && c.until && Date.parse(c.until) > t) return { until: Date.parse(c.until), why: "out of quota" };
      if (c.cap && c.used >= c.cap) return { until: null, why: "its monthly limit is used up" };
    }
    const d = this.down.get(e.id);
    if (d && d.until > t) return d;
    if (d) this.down.delete(e.id);
    return null;
  }
}

/** The usable engines (in order) and the ones that are out, with when they come back. */
export function pickEngines(chain, health, quota = {}) {
  const usable = [], down = [];
  for (const e of chain) { const s = health.state(e, quota); if (s) down.push({ engine: e, until: s.until, why: s.why }); else usable.push(e); }
  return { usable, down };
}

/** "Claude subscription: out of quota until 24 Oct, 4:30 pm IST; Codex subscription: …" for the person waiting. */
export function downNotice(down, fmt = (ms) => new Date(ms).toISOString()) {
  if (!down.length) return "No AI engine is set up for me yet.";
  return down.map((d) => `${d.engine.label}: ${d.why}${d.until ? ` until ${fmt(d.until)}` : ""}`).join("; ");
}
/** When the first engine is back (ms), or null when none says. */
export const firstBack = (down) => down.map((d) => d.until).filter(Boolean).sort((a, b) => a - b)[0] ?? null;

/** The call for one engine at a tier: provider, model, effort and (for a key or local model) the connection to use. */
export function tierRuntime(e, me, tier, env = {}) {
  const strong = tier === "strong";
  const effort = strong ? me.effort || "medium" : "low";
  if (e.kind === "stub") return { provider: "stub", model: "stub", effort };
  if (e.kind === "server" && e.provider === "claude") {
    // Only a Claude model name goes to Claude Code (a profile once held "gpt-6-luna" and the run was labelled with it).
    const mine = me.provider === "claude" && CLAUDE_MODEL.test(me.model ?? "") ? me.model : null;
    return { provider: "claude", model: strong ? mine ?? "opus" : env.PULSE_AI_CLAUDE_FAST || "sonnet", effort };
  }
  if (e.kind === "server") return { provider: "codex", model: me.provider === "codex" && CODEX_MODEL.test(me.model ?? "") ? me.model : undefined, effort };
  if (e.kind === "connection") return { provider: e.connection.kind === "api" ? "api" : e.provider, model: e.connection.model ?? undefined, effort, connectionId: e.connection.id };
  if (e.kind === "env") {
    const p = ENV_API[e.provider];
    return { provider: "api", model: env[`PULSE_AI_${e.provider.toUpperCase()}_${tier.toUpperCase()}`] || p.models[tier] || p.models.strong, effort,
      connection: { kind: "api", style: p.style, baseUrl: p.baseUrl, secret: e.secret, provider: e.provider } };
  }
  return { provider: "api", model: env.PULSE_AI_LOCAL_MODEL || "llama3.1", effort,
    connection: { kind: "api", style: "openai", baseUrl: env.PULSE_AI_LOCAL_URL || "http://127.0.0.1:11434/v1", secret: "local", provider: "custom" } };
}

/** The name recorded on the run and shown in Pulse: the engine and the model it ran. */
export const engineName = (e, rt) => `${e.id}${rt?.model ? `/${rt.model}` : ""}`.slice(0, 80);
