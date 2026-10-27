import { hostHeader } from './host-mode.mjs';

/** Dedicated service/public surface: never forwards a browser session or staff identity. */
export async function catalogProxy(request, context) {
  const { path } = await context.params;
  const items = path.length === 1 && path[0] === 'items';
  const offer = path.length === 2 && path[0] === 'offers' && /^[A-Za-z0-9_-]{43}$/.test(path[1]);
  const error = (message, status) => Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } });
  if (!items && !offer) return error('Not found', 404);
  if (request.method !== 'GET') return error('GET required', 405);
  if (new URL(request.url).search) return error('Query parameters are not supported', 400);
  const authorization = request.headers.get('authorization');
  if (offer && authorization) return error('Public links use their own token', 403);
  try {
    const upstream = await fetch(`${process.env.PULSE_API_URL ?? 'http://127.0.0.1:8081'}/api/v1/catalog/${path.join('/')}`, {
      method: 'GET', headers: { ...hostHeader(request.headers), ...(items && authorization ? { authorization } : {}) },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
    for (const key of ['content-type','content-security-policy','retry-after']) if (upstream.headers.has(key)) headers.set(key, upstream.headers.get(key));
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch { return error('Catalogue unavailable', 503); }
}
