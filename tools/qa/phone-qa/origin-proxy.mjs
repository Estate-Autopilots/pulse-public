// PHONE-QA: a loopback-only reverse proxy for phone QA against staging through an ssh tunnel. A phone browser on
// http://localhost:<port> (adb reverse) sends Origin http://localhost:<port>, which the API proxy's same-origin guard
// rightly refuses on staging ("Invalid origin"): staging's origin is its public address. This proxy presents the
// staging public address as Host and Origin (exactly what the browser would send on that address), and maps
// redirects back to the loopback address. It listens on 127.0.0.1 only and adds no identity header: sign-in is
// still Pulse's own (no Access header, no session invented). Nothing about the server changes.
//
//   ssh -N -L 4102:127.0.0.1:4102 ea &
//   node tools/qa/phone-qa/origin-proxy.mjs --listen 4612 --target http://127.0.0.1:4102 --public https://pulse-staging.estateautopilots.com
//   adb -s <serial> reverse tcp:4612 tcp:4612      (phone: http://localhost:4612)
import { createServer, request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IDENTITY = /^(cf-access-|cf-connecting-ip$|x-pulse-session$|x-pulse-client-session$|x-pulse-agent-key$|x-forwarded-)/i;

/** Request headers as the public address would carry them; identity headers a browser never sends are dropped. */
export function forwardHeaders(headers, publicUrl) {
  const pub = new URL(publicUrl), out = {};
  for (const [k, v] of Object.entries(headers)) if (!IDENTITY.test(k)) out[k] = v;
  out.host = pub.host;
  if (out.origin) out.origin = pub.origin;
  if (out.referer) { try { const r = new URL(out.referer); out.referer = pub.origin + r.pathname + r.search; } catch { delete out.referer; } }
  return out;
}

/** Response headers for the loopback address: absolute redirects to the public address come back here. */
export function backHeaders(headers, publicUrl, local) {
  const pub = new URL(publicUrl), out = { ...headers };
  if (typeof out.location === 'string' && out.location.startsWith(pub.origin)) out.location = local + out.location.slice(pub.origin.length);
  return out;
}

export function startProxy({ listen, target, publicUrl }) {
  const t = new URL(target), local = `http://localhost:${listen}`;
  if (!['127.0.0.1', 'localhost'].includes(t.hostname)) throw Error('target must be a loopback address (an ssh tunnel)');
  const server = createServer((req, res) => {
    const up = httpRequest({ host: t.hostname, port: t.port, method: req.method, path: req.url, headers: forwardHeaders(req.headers, publicUrl) }, (r) => {
      res.writeHead(r.statusCode ?? 502, backHeaders(r.headers, publicUrl, local));
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('tunnel unavailable\n'); });
    req.pipe(up);
  });
  server.listen(Number(listen), '127.0.0.1');
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const opts = { listen: arg('listen') ?? '4612', target: arg('target') ?? 'http://127.0.0.1:4102', publicUrl: arg('public') ?? 'https://pulse-staging.estateautopilots.com' };
  startProxy(opts);
  console.log(`origin-proxy: http://localhost:${opts.listen} -> ${opts.target} as ${opts.publicUrl}`);
}
