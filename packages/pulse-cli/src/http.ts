// One HTTP call to Pulse: no redirects (a bearer token never follows one), a 30 s timeout, at most 4 MiB back, and
// Pulse's refusals (application/problem+json, OAuth errors) turned into one plain sentence and an exit code.
import { readFileSync } from 'node:fs';
import { CliError, EXIT, redact } from './errors.js';

export const VERSION: string = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
})();
const USER_AGENT = `pulse-cli/${VERSION} node/${process.versions.node}`;
const LIMIT = 4 * 1024 * 1024;

export type Reply = { status: number; headers: Headers; body: unknown; text: string };
export type CallOptions = { method?: string; headers?: Record<string, string>; json?: unknown; form?: Record<string, string>; timeoutMs?: number };

export async function call(url: string | URL, options: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT, ...options.headers };
  let body: string | undefined;
  if (options.json !== undefined) { body = JSON.stringify(options.json); headers['content-type'] = 'application/json'; }
  else if (options.form) { body = new URLSearchParams(options.form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
  let response: Response;
  try {
    response = await fetch(url, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers, body, redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const why = err.name === 'TimeoutError' ? 'it did not answer within 30 seconds' : err.cause?.code ?? err.message;
    throw new CliError(`Could not reach ${new URL(url).origin}: ${why}`, EXIT.failed, 'Check the address (--host or PULSE_HOST) and your connection.');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new CliError(`${new URL(url).origin} answered with a redirect to ${response.headers.get('location') ?? 'somewhere else'}; pulse does not follow redirects`,
      EXIT.failed, 'Use the Pulse address itself with --host (https://…, no path).');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > LIMIT) throw new CliError('Pulse sent more than 4 MiB; narrow the request', EXIT.failed);
      chunks.push(Buffer.from(chunk));
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown = undefined;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = undefined; } }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

/** Pulse's refusal as an error: the problem's detail (or OAuth error), the request id, and what to do next. */
export function refusal(reply: Reply, context = ''): CliError {
  const b = (reply.body && typeof reply.body === 'object' ? reply.body : {}) as Record<string, unknown>;
  const said = [b.detail, b.error_description, b.error, b.message, b.title].find(v => typeof v === 'string' && v) as string | undefined;
  const id = (typeof b.requestId === 'string' && b.requestId) || reply.headers.get('x-request-id');
  const detail = redact(said ?? (reply.text && !reply.text.trimStart().startsWith('<') ? reply.text.slice(0, 300) : `HTTP ${reply.status}`));
  const tail = id ? ` (request ${id})` : '';
  const prefix = context ? `${context}: ` : '';
  const s = reply.status;
  if (s === 401) return new CliError(`${prefix}Pulse did not accept your sign-in: ${detail}${tail}`, EXIT.auth, 'Run `pulse login` (or check PULSE_TOKEN).');
  if (s === 403) return new CliError(`${prefix}Pulse refused: ${detail}${tail}`, EXIT.forbidden, 'Your role or the sign-in\'s permissions do not allow this.');
  if (s === 429) {
    const wait = reply.headers.get('retry-after');
    return new CliError(`${prefix}Too many requests: ${detail}${tail}`, EXIT.rateLimited, wait ? `Try again in ${wait} seconds.` : 'Wait a minute and try again.');
  }
  if (s >= 500) return new CliError(`${prefix}Pulse failed (HTTP ${s}): ${detail}${tail}`, EXIT.failed, 'Try again; if it keeps failing, report it with the request id.');
  return new CliError(`${prefix}${detail} (HTTP ${s})${tail}`, EXIT.usage);
}
