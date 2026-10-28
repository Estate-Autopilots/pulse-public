// AI-EMPLOYEES v2: the words for an AI employee's settings, shared by the profile (server) and its AI section (client).
export type Autonomy = "own" | "approve" | "off";
/** Runtimes. Claude Code and Codex run as CLIs on this server (their plans); the API runtimes need a key on this server,
 *  and none is set, so they show "not connected" (the setting is kept). */
export const PROVIDER: Record<string, string> = { claude: "Claude Code (this server)", codex: "Codex (this server)", anthropic_api: "Claude API", openai_api: "OpenAI API", stub: "Test runtime" };
/** Thinking, as people say it; the runtime's reasoning effort underneath. */
export const THINKING: Record<string, string> = { low: "Fast", medium: "Balanced", high: "Deep", xhigh: "Deepest" };
export const KINDS: { key: "direct" | "mention" | "group"; label: string; hint: string }[] = [
  { key: "direct", label: "Direct messages to it", hint: "Someone writes to it one to one" },
  { key: "mention", label: "When @mentioned or replied to", hint: "In a group, someone names it or answers its message" },
  { key: "group", label: "Anything else said in its groups", hint: "A client or colleague writes in a group it is in" }];
export const AUTONOMY: Record<Autonomy, string> = { own: "Replies on its own", approve: "Asks first", off: "Stays out" };
/** AI-AUTONOMY (1230): when it asks a person first; everything else it does on its own. */
export type RiskPolicy = { internal: "send" | "ask"; clients: "send" | "ask"; money: "send" | "ask"; delete: "ask"; legalHr: "send" | "ask"; costLimit: number; clientsAllowed?: boolean };
export const RISK_DEFAULT: RiskPolicy = { internal: "send", clients: "ask", money: "ask", delete: "ask", legalHr: "ask", costLimit: 25000, clientsAllowed: false };
export const RISKS: { key: "internal" | "clients" | "money" | "delete" | "legalHr"; label: string; short: string; hint: string }[] = [
  { key: "internal", label: "Colleagues", short: "colleagues", hint: "Answers and updates to people on the staff, in chats and direct messages" },
  { key: "clients", label: "Messages to clients", short: "clients", hint: "Anything it writes where a client can read it" },
  { key: "money", label: "Money", short: "money", hint: "Prices, discounts, refunds, payments and invoices it would commit to" },
  { key: "delete", label: "Deleting data", short: "deleting data", hint: "Pulse never lets an AI employee delete; a person does it" },
  { key: "legalHr", label: "Legal and HR", short: "legal or HR", hint: "Contracts, hiring, pay, warnings and other people decisions" }];

/** UI-UPGRADE (24 Oct 2026): a model as people say it ("Claude Opus 5.5", "GPT-6 Luna"), never its raw id. */
const MODEL_NAME: Record<string, string> = { stub: "Test runtime" };
const WORD: Record<string, string> = { gpt: "GPT", ai: "AI", api: "API", mini: "mini" };
export function modelName(id: string | null | undefined): string {
  const raw = (id ?? "").trim();
  if (!raw) return "Its runtime’s default";
  if (MODEL_NAME[raw]) return MODEL_NAME[raw];
  // "claude-opus-5-5" → Claude Opus 5.5; "gpt-6-luna" → GPT-6 Luna (a version joins its maker with a hyphen, as people write it).
  const parts = raw.split(/[-_\s]+/).filter(Boolean), out: string[] = [];
  for (const p of parts) {
    const last = out.length - 1;
    if (/^\d+$/.test(p) && last >= 0 && /\d$/.test(out[last])) out[last] += `.${p}`;
    else if (/^\d/.test(p) && last >= 0 && out[last] === "GPT") out[last] += `-${p}`;
    else out.push(WORD[p.toLowerCase()] ?? (/^\d/.test(p) ? p : p[0].toUpperCase() + p.slice(1)));
  }
  return out.join(" ");
}
/** Which maker a model belongs to, to tell when a run used another one than its settings (a stand-in). */
export function modelFamily(id: string | null | undefined): "claude" | "openai" | "other" {
  const m = (id ?? "").toLowerCase();
  return m.startsWith("claude") ? "claude" : /^(gpt|o\d|codex)/.test(m) ? "openai" : "other";
}
export const FAMILY_NAME = { claude: "Claude", openai: "ChatGPT", other: "its AI" } as const;
/** The short names of the three kinds of message, for compact rows. */
export const KIND_SHORT: Record<"direct" | "mention" | "group", string> = { direct: "Direct messages", mention: "@mentions and replies", group: "Other group messages" };
/** A tool's name, for read-only lists (the profile's Overview). */
export const TOOL_LABEL: Record<string, string> = { chats: "Chats", tasks: "Tasks", memory: "Memory", board: "Board", projects: "Projects", drive: "Drive", web: "Web", server: "Server access", mcp: "MCP servers" };
