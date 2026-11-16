import { hostHeader } from './host-mode.mjs';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MAX_BODY = 64 * 1024;

/** Exact contract operations only. This boundary never reads or forwards browser identity. */
export async function serviceProxy(request, context) {
  const { path } = await context.params;
  const pagination = path.length === 1 && ['clients','leads','people'].includes(path[0]);
  const mine = path.length === 2 && path[0] === 'tasks' && path[1] === 'mine';
  const requests = path.length === 1 && path[0] === 'update-requests';
  const progress = path.length === 3 && path[0] === 'update-requests' && UUID.test(path[1]) && path[2] === 'progress';
  const update = path.length === 1 && path[0] === 'updates';
  const quote = path.length === 1 && path[0] === 'quotes';
  const chat = path.length === 3 && path[0] === 'chats' && UUID.test(path[1]) && path[2] === 'messages';
  const notice = path.length === 3 && path[0] === 'quotes' && UUID.test(path[1]) && path[2] === 'ready-notice';
  const headers = { 'cache-control':'no-store', 'referrer-policy':'no-referrer' };
  const error = (message, status) => Response.json({ error: message }, { status, headers });
  // Signed out (no psvc_ credential) answers 401 before any shape, method, query or body refusal, as the API does
  // (EST-1521). EST-1715: the release smoke's literal :chatId got 403 here; EST-1912: its anonymous `{}` POST to
  // ready-notice got the no-body 400. A psvc_ key keeps its 403 scope and 400/413 shape refusals below.
  if (!/^Bearer\s+psvc_/i.test(request.headers.get('authorization') ?? '')) return error('Invalid service credential',401);
  if (!pagination && !mine && !quote && !notice && !chat && !update && !requests && !progress) return error('Service key scope excludes this endpoint',403);
  if (requests ? !['GET','POST'].includes(request.method) : request.method !== (pagination || mine ? 'GET' : 'POST')) return error('Service key scope excludes this endpoint',403);
  const { search, searchParams: query } = new URL(request.url);
  const queryKeys = requests && request.method === 'GET' ? ['status','onBehalfOf','cursor','limit'] : pagination ? ['cursor','limit',...(path[0] === 'people' ? [] : ['phone'])] : [];
  if ([...query.keys()].some(k => !queryKeys.includes(k))) return error('Unknown query parameter',400);
  if (query.has('phone') && (query.getAll('phone').length !== 1 || [...query.keys()].some(k => k !== 'phone'))) return error('Phone must be the only query parameter',400);
  try {
    let body;
    if (request.body) {
      const reader = request.body.getReader(), chunks = [];
      let size = 0;
      while (true) {
        const { done,value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > (chat ? 3 * 1024 * 1024 : MAX_BODY)) { await reader.cancel(); return error('Request body too large',413); }
        chunks.push(value);
      }
      if (notice && size) return error('No request body allowed',400);
      body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk,offset); offset += chunk.byteLength; }
    }
    const forwarded = new Headers(hostHeader(request.headers));
    // The signed-in WAS person's Google ID token crosses only to tasks/mine (EST-1392 §6), never logged.
    for (const key of ['authorization','content-type','idempotency-key',...(mine ? ['pulse-person-token'] : [])]) if (request.headers.has(key)) forwarded.set(key,request.headers.get(key));
    // Preserve literal '+' and '%2B' for the API's raw phone parser.
    const upstream = await fetch(`${process.env.PULSE_API_URL ?? 'http://127.0.0.1:8081'}/api/v1/service/${path.join('/')}${search}`, {
      method: request.method, headers: forwarded, body, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    const responseHeaders = new Headers(headers);
    for (const key of ['content-type','retry-after']) if (upstream.headers.has(key)) responseHeaders.set(key,upstream.headers.get(key));
    return new Response(upstream.body,{ status: upstream.status, headers: responseHeaders });
  } catch { return error('Service unavailable',503); }
}
