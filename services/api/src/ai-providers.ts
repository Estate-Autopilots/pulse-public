// CONNECT-AI (owner, 23 Oct 2026): the AI an organisation connects, as Pulse calls it. Two kinds:
//  * subscriptions people already pay for, used through their official CLIs: Claude Code with a long-lived token from
//    `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN) and the Codex CLI with a ChatGPT sign-in (`codex login
//    --device-auth`, its auth.json in a private CODEX_HOME); each runs on the organisation's workspace;
//  * API keys of any provider, called over HTTPS: Anthropic's Messages API, Google's Gemini API, and every
//    OpenAI-compatible API (OpenAI, OpenRouter, Groq, Mistral, DeepSeek, or a custom address).
// Nothing here logs or returns a secret: errors are reduced to a status and the provider's own short sentence, with
// anything that looks like a key cut out.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the CLIs live on this server: the service's PATH plus the usual per-user install places (PULSE_AI_CLI_PATH first). */
export const cliPath = () => [process.env.PULSE_AI_CLI_PATH, join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin'), '/usr/local/bin', process.env.PATH]
  .filter(Boolean).join(':');

export type Style = 'openai' | 'anthropic' | 'gemini';
export type ApiProvider = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'groq' | 'mistral' | 'deepseek' | 'custom';
export const API_PROVIDERS: Record<ApiProvider, { name: string; base: string | null; style: Style; paid: boolean; keyHint: string; keysAt: string | null }> = {
  anthropic: { name: 'Anthropic (Claude API)', base: 'https://api.anthropic.com/v1', style: 'anthropic', paid: true, keyHint: 'sk-ant-api03-…', keysAt: 'https://console.anthropic.com/settings/keys' },
  openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', style: 'openai', paid: true, keyHint: 'sk-…', keysAt: 'https://platform.openai.com/api-keys' },
  gemini: { name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta', style: 'gemini', paid: true, keyHint: 'AIza…', keysAt: 'https://aistudio.google.com/apikey' },
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', style: 'openai', paid: true, keyHint: 'sk-or-…', keysAt: 'https://openrouter.ai/keys' },
  groq: { name: 'Groq', base: 'https://api.groq.com/openai/v1', style: 'openai', paid: true, keyHint: 'gsk_…', keysAt: 'https://console.groq.com/keys' },
  mistral: { name: 'Mistral', base: 'https://api.mistral.ai/v1', style: 'openai', paid: true, keyHint: 'Mistral API key', keysAt: 'https://console.mistral.ai/api-keys' },
  deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', style: 'openai', paid: true, keyHint: 'sk-…', keysAt: 'https://platform.deepseek.com/api_keys' },
  custom: { name: 'Custom (OpenAI-compatible)', base: null, style: 'openai', paid: false, keyHint: 'The key your server expects', keysAt: null },
};
export const isApiProvider = (p: unknown): p is ApiProvider => typeof p === 'string' && p in API_PROVIDERS;

/** Remove anything that looks like a secret from a provider's message before it is stored or shown. */
export const scrub = (s: string) => s.replace(/(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{8,}|Bearer\s+\S+|[A-Za-z0-9_-]{32,})/g, '••••').replace(/\s+/g, ' ').trim().slice(0, 240);

export class ProviderError extends Error {
  constructor(readonly kind: 'refused' | 'quota' | 'error', message: string, readonly until: Date | null = null) { super(message); }
}

const months: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** When a plan's "out of quota" message says it resets (the coworker runtime's rule, runtime.mjs quotaUntil). */
export function quotaUntil(text: string, now = new Date()): Date | null {
  const m = String(text).match(/(?:resets?|try again at|try again on|available again at)\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?,?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
  if (!m) return null;
  const mon = months[m[1].slice(0, 3).toLowerCase()]; if (mon === undefined) return null;
  let h = Number(m[4]) % 12; if (m[6] && /p/i.test(m[6])) h += 12; if (!m[6]) h = Number(m[4]);
  let year = m[3] ? Number(m[3]) : now.getUTCFullYear();
  let at = new Date(Date.UTC(year, mon, Number(m[2]), h, Number(m[5] ?? 0)));
  if (!m[3] && at.getTime() < now.getTime() - 86400000) at = new Date(Date.UTC(++year, mon, Number(m[2]), h, Number(m[5] ?? 0)));
  return Number.isNaN(at.getTime()) ? null : at;
}
export const QUOTA = /usage limit|weekly limit|rate limit|quota|limit reached|hit your (?:\w+ )?limit|out of (?:credits|usage)|5-hour limit|insufficient.?(?:balance|credit)/i;
const AUTH = /invalid.{0,20}(?:token|key|api|credential)|unauthori[sz]ed|authentication|expired|401|403|not logged in|please (?:run )?\/?login/i;

async function http(url: string, init: RequestInit, timeoutMs = 20000) {
  let r: Response;
  try { r = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new ProviderError('error', `Could not reach ${new URL(url).host}: ${scrub((e as Error).message)}`); }
  const text = await r.text();
  let body: unknown = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) {
    const said = scrub(String((body as { error?: { message?: string } | string })?.error && typeof (body as { error: unknown }).error === 'object'
      ? ((body as { error: { message?: string } }).error.message ?? '') : (body as { error?: string; message?: string })?.error ?? (body as { message?: string })?.message ?? text.slice(0, 200)));
    if (r.status === 401 || r.status === 403) throw new ProviderError('refused', `The provider refused the key (${r.status})${said ? `: ${said}` : ''}`);
    if (r.status === 429 || r.status === 402 || QUOTA.test(said)) throw new ProviderError('quota', `Out of quota or rate-limited (${r.status})${said ? `: ${said}` : ''}`, quotaUntil(said));
    throw new ProviderError('error', `The provider answered ${r.status}${said ? `: ${said}` : ''}`);
  }
  return body as Record<string, unknown>;
}

const headers = (style: Style, key: string): Record<string, string> => style === 'anthropic'
  ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  : style === 'gemini' ? { 'x-goog-api-key': key, 'content-type': 'application/json' }
  : { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

/** The models the key can use, as the provider lists them (at most 400). */
export async function listModels(style: Style, base: string, key: string): Promise<string[]> {
  const b = base.replace(/\/+$/, '');
  if (style === 'gemini') {
    const d = await http(`${b}/models?pageSize=200`, { headers: headers(style, key) }) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    return (d.models ?? []).filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map((m) => m.name.replace(/^models\//, '')).slice(0, 400);
  }
  const d = await http(`${b}/models${style === 'anthropic' ? '?limit=100' : ''}`, { headers: headers(style, key) }) as { data?: { id: string }[] };
  return (d.data ?? []).map((m) => String(m.id)).filter((m) => /^[A-Za-z0-9._:/@-]{1,120}$/.test(m)).slice(0, 400);
}

/** One short message to the model: the reply, and the provider's own token count (null when it reports none). */
export async function chat(style: Style, base: string, key: string, model: string, prompt: string, opts: { maxTokens?: number; effort?: string; provider?: string } = {}): Promise<{ text: string; tokens: number | null }> {
  const b = base.replace(/\/+$/, ''), max = opts.maxTokens ?? 2000;
  if (style === 'anthropic') {
    const d = await http(`${b}/messages`, { method: 'POST', headers: headers(style, key), body: JSON.stringify({ model, max_tokens: max, messages: [{ role: 'user', content: prompt }] }) }, 180000) as
      { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    return { text: (d.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''), tokens: d.usage ? (d.usage.input_tokens ?? 0) + (d.usage.output_tokens ?? 0) : null };
  }
  if (style === 'gemini') {
    const d = await http(`${b}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: headers(style, key), body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: max } }) }, 180000) as
      { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { totalTokenCount?: number } };
    return { text: (d.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''), tokens: d.usageMetadata?.totalTokenCount ?? null };
  }
  const d = await http(`${b}/chat/completions`, { method: 'POST', headers: headers(style, key), body: JSON.stringify({ model, max_tokens: max, messages: [{ role: 'user', content: prompt }] }) }, 180000) as
    { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } };
  return { text: String(d.choices?.[0]?.message?.content ?? ''), tokens: d.usage?.total_tokens ?? null };
}

/** A CLI run on this server or a workspace: stdin carries the secret (first line) and then the prompt; never argv. */
export function run(cmd: string, args: string[], input: string, timeoutMs: number, env: Record<string, string> = {}, cwd?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: cliPath(), ...env }, cwd });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new ProviderError('error', 'It took too long to answer')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > 2_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 200_000) err = err.slice(-100_000); });
    child.on('error', (e) => { clearTimeout(timer); reject(new ProviderError('error', `Could not start ${cmd}: ${e.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.on('error', () => { /* the program closed its input early */ });
    child.stdin.end(input);
  });
}

/** Read the outcome of a Claude Code or Codex test run: the answer, or why not (out of quota until, signed out, failed). */
export function cliOutcome(provider: 'claude' | 'codex', r: { code: number | null; out: string; err: string }): { text: string; tokens: number | null } {
  if (provider === 'claude') {
    let d: { result?: string; is_error?: boolean; api_error_status?: number; usage?: Record<string, number> } | null = null;
    try { d = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { d = null; }
    const said = String(d?.result ?? `${r.out} ${r.err}`);
    if ((d?.is_error || r.code !== 0) && (QUOTA.test(said) || d?.api_error_status === 429)) throw new ProviderError('quota', `Out of quota: ${scrub(said)}`, quotaUntil(said));
    if ((d?.is_error || r.code !== 0) && AUTH.test(said)) throw new ProviderError('refused', `The sign-in was refused: ${scrub(said)}`);
    if (!d || d.is_error) throw new ProviderError('error', `Claude Code failed: ${scrub(said) || 'no answer'}`);
    const u = d.usage ?? {};
    return { text: String(d.result ?? ''), tokens: ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((n, k) => n + (Number(u[k]) || 0), 0) || null };
  }
  let text = '', tokens: number | null = null, failed = '';
  for (const line of r.out.split('\n')) {
    let d: { type?: string; item?: { type?: string; text?: string }; usage?: Record<string, number>; message?: string; error?: { message?: string } };
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'item.completed' && d.item?.type === 'agent_message') text = String(d.item.text ?? '');
    if (d.type === 'turn.completed' && d.usage) tokens = ['input_tokens', 'output_tokens', 'reasoning_output_tokens'].reduce((n, k) => n + (Number(d.usage![k]) || 0), 0) || null;
    if (d.type === 'error' || d.type === 'turn.failed') failed = String(d.message ?? d.error?.message ?? '');
  }
  const said = `${failed} ${r.err}`;
  if (!text && QUOTA.test(said)) throw new ProviderError('quota', `Out of quota: ${scrub(failed || r.err)}`, quotaUntil(said));
  if (!text && AUTH.test(said)) throw new ProviderError('refused', `The sign-in was refused: ${scrub(failed || r.err)}`);
  if (!text) throw new ProviderError('error', `Codex failed: ${scrub(failed || r.err) || 'no answer'}`);
  return { text, tokens };
}

/** The shell script a workspace runs for one CLI call. Line 1 of stdin is the secret (base64; empty: the workspace's own
 *  sign-in), the rest is the prompt. Codex's refreshed sign-in comes back on stderr after a marker. */
export function cliScript(provider: 'claude' | 'codex', args: string[]): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const a = args.map(q).join(' ');
  if (provider === 'claude') return `set -u; IFS= read -r S; d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; cd "$d"; if [ -n "$S" ]; then export CLAUDE_CODE_OAUTH_TOKEN="$(printf %s "$S" | base64 -d)"; export CLAUDE_CONFIG_DIR="$d"; fi; unset S; claude ${a}`;
  return `set -u; IFS= read -r S; d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; cd "$d"; if [ -n "$S" ]; then mkdir -m 700 "$d/home"; printf %s "$S" | base64 -d > "$d/home/auth.json"; chmod 600 "$d/home/auth.json"; export CODEX_HOME="$d/home"; fi; unset S; codex ${a}; c=$?; if [ -f "$d/home/auth.json" ]; then printf '\\n@@PULSE_AUTH@@%s\\n' "$(base64 -w0 "$d/home/auth.json")" >&2; fi; exit $c`;
}
export const CLAUDE_ARGS = (model?: string | null, effort?: string | null) => ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--strict-mcp-config', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
export const CODEX_ARGS = (model?: string | null, effort?: string | null) => ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : [])];
export const refreshedAuth = (err: string) => { const m = err.match(/@@PULSE_AUTH@@([A-Za-z0-9+/=]+)/); return m ? Buffer.from(m[1], 'base64').toString('utf8') : null; };
