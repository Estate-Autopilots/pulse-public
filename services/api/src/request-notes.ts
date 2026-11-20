// AI-FIX (19 Nov 2026, BUG-CENSUS BC-007): a short, argument-free note on why a request was refused, carried on the
// request so the server's own telemetry row (telemetry.ts, kind api.server) says it. POST /api/v1/mcp answered 400 to
// 528 calls in 14 days and nothing anywhere said why: the MCP SDK's refusal goes to an onerror nobody listens to.
// Only short strings: never arguments, bodies or credentials.
const NOTE = Symbol.for('pulse.requestNote');
type Notes = Record<string, string>;

export function noteRequest(request: object, note: Notes): void {
  const r = request as Record<symbol, Notes | undefined>;
  const clean = Object.fromEntries(Object.entries(note).map(([k, v]) => [k.slice(0, 20), String(v).slice(0, 160)]));
  r[NOTE] = { ...(r[NOTE] ?? {}), ...clean };
}
export function requestNote(request: object): Notes | undefined {
  return (request as Record<symbol, Notes | undefined>)[NOTE];
}
/** The caller's product ("claude-code/2.1.3", "Claude-User", "node"), never the rest of its User-Agent. */
export function clientProduct(userAgent: unknown): string {
  const m = /^[A-Za-z][\w.+-]{0,39}(?:\/[\w.+-]{1,20})?/.exec(typeof userAgent === 'string' ? userAgent.trim() : '');
  return m ? m[0] : '-';
}
