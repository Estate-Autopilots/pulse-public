import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { ownCsp } from './app/api/proxy.mjs';
import { hostMode, inboundHeaders, requestHost } from './app/lib/host-mode.mjs';

// FLOW-C: a media review plays a cut where the team keeps it (a Drive file, a YouTube or Vimeo link) and video files
// by link or from the reviewer's own computer (blob:). Media never runs script; the players are sandboxed origins.
const PLAYERS = 'https://drive.google.com https://www.youtube-nocookie.com https://player.vimeo.com';

export async function proxy(request: NextRequest) {
  // UX-TENANT: a company's own address signs in with Pulse passwords, like public mode: no client-sent identity headers.
  const publicMode = (await hostMode(requestHost(request.headers))).signIn === 'password';
  const headers = inboundHeaders(request.headers, request.nextUrl.pathname, publicMode, request.method);
  const nonce = randomBytes(18).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  // R41: the approved Word editor's window may load, only while Word editing is configured (docs/ops/POLICY-WORD.md).
  let editor = '';
  try { if (process.env.PULSE_POLICY_EDITOR === 'onlyoffice') editor = new URL(process.env.PULSE_POLICY_EDITOR_URL ?? '').origin; } catch {}
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tiles.openfreemap.org https://elevation-tiles-prod.s3.amazonaws.com; font-src 'self'; connect-src 'self' https://tiles.openfreemap.org https://elevation-tiles-prod.s3.amazonaws.com${dev ? ' ws: wss:' : ''}; worker-src 'self' blob:; media-src 'self' blob: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; frame-src 'self' ${PLAYERS} https:${editor && editor !== 'null' ? ` ${editor}` : ''}`;
  headers.set('content-security-policy', csp);
  headers.set('x-nonce', nonce);
  const path = request.nextUrl.pathname;
  headers.set('x-pulse-path',path);
  headers.set('x-pulse-search',request.nextUrl.search);
  // PERF: a page's request id. Its server render's API calls carry it (lib/api.ts) and the browser reads it from
  // Server-Timing, so telemetry shows what a page's first byte waited on. API calls keep the browser's own id.
  const render = !path.startsWith('/api/') && !path.startsWith('/_next/') ? randomBytes(12).toString('base64url') : null;
  if (render) headers.set('x-pulse-request-id', render);
  // Backend v1 paths are exposed only through /api/v1; keep raw paths unavailable before page sign-in redirects.
  const blocked = /^\/v1(\/|$)/.test(path) || (!dev && (/\.map$/.test(path) || /^\/(debug|__debug|_debug|__nextjs)(\/|$)/.test(path)));
  const response = blocked ? new NextResponse(null, { status: 404 }) : NextResponse.next({ request: { headers } });
  // Stored files (task proof, chat files, documents) answer with their own policy: sandboxed, or none for a PDF.
  if (!(path.startsWith('/api/v0/') && ownCsp(path.slice(8).split('/').filter(Boolean)))) response.headers.set('content-security-policy', csp);
  response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  // CHAT-SHELL: Pulse's own pages open inside its chat's side panel (same origin only); any https page may be framed
  // there (the panel checks first whether the site allows it).
  response.headers.set('x-frame-options', 'SAMEORIGIN');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'no-referrer');
  // CHAT-VOICE: calls and voice messages use the microphone and camera, on Pulse itself only (never in frames).
  response.headers.set('permissions-policy', 'camera=(self), microphone=(self), geolocation=(self)');
  if (render) response.headers.set('server-timing', `pulse;desc="${render}"`);
  return response;
}
