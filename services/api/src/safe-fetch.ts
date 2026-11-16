// CONNECTORS-CONTRACTS: outbound HTTPS to an address a company admin typed (a remote MCP server, its OAuth endpoints),
// guarded the same way webhooks are (safe-outbound.ts): https on 443 only, no user name or fragment, every address the
// name resolves to must be public (publicAddress), the connection is pinned to the address checked (no second lookup),
// no redirects are followed, the answer is capped in size and time. A refusal names its kind, never the address's insides.
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { OutboundError, publicAddress } from './safe-outbound.js';

export { OutboundError };
export type SafeAnswer = { status: number; headers: Record<string, string>; body: string };
export type Resolve = (host: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>;
export type Send = typeof request;

/** Whether a URL may be called at all, before any lookup: https, port 443, no credentials or fragment. */
export function outboundUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new OutboundError('destination'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash) throw new OutboundError('destination');
  return url;
}

/** The addresses a host may be reached at: all public, or a refusal. */
export async function publicAddresses(host: string, resolve: Resolve = lookup as unknown as Resolve) {
  const bare = host.replace(/^\[|\]$/g, '');
  const addresses = isIP(bare) ? [{ address: bare, family: isIP(bare) }] : await resolve(bare, { all: true, verbatim: true }).catch(() => { throw new OutboundError('dns'); });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) throw new OutboundError('destination');
  return addresses;
}

export async function safeFetch(raw: string, init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number } = {},
  resolve: Resolve = lookup as unknown as Resolve, send: Send = request): Promise<SafeAnswer> {
  const url = outboundUrl(raw);
  const timeoutMs = Math.max(1, Math.min(init.timeoutMs ?? 15000, 30000)), maxBytes = Math.max(1024, Math.min(init.maxBytes ?? 2_000_000, 8_000_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const addresses = await Promise.race([publicAddresses(url.hostname, resolve),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new OutboundError('timeout')), { once: true }))]);
    const pinned = addresses[0];
    const body = init.body ?? '';
    return await new Promise<SafeAnswer>((accept, reject) => {
      const req = send(url, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), agent: false, rejectUnauthorized: true, family: pinned.family,
        signal: controller.signal, maxHeaderSize: 16384,
        headers: { ...(init.headers ?? {}), ...(init.body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }) },
        lookup: (_hostname, _options, done) => done(null, pinned.address, pinned.family) }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) { res.destroy(); reject(new OutboundError('redirect')); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) { res.destroy(); reject(new OutboundError('response_size')); } else chunks.push(chunk); });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
          accept({ status, headers, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', () => reject(new OutboundError('network')));
      });
      req.on('error', () => reject(new OutboundError(controller.signal.aborted ? 'timeout' : 'network')));
      req.end(init.body === undefined ? undefined : body);
    });
  } catch (error) { throw error instanceof OutboundError ? error : new OutboundError('network'); }
  finally { clearTimeout(timer); }
}

/** A refusal as a sentence an admin can act on. */
export const OUTBOUND_WORDS: Record<OutboundError['kind'], string> = {
  destination: 'Vitals OS only connects to public https addresses (port 443); this one is not allowed.',
  dns: 'That address does not resolve. Check it and try again.',
  timeout: 'The app did not answer in time. Try again in a minute.',
  redirect: 'The app answered with a redirect; give its final address instead.',
  response_size: 'The app answered with too much data.',
  network: 'The app could not be reached. Check the address and try again.',
};
