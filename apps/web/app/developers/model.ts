export type Operation = { path: string; method: string; summary?: string; security?: Record<string, string[]>[]; parameters?: { name: string; in: string; required?: boolean }[]; requestBody?: unknown; responses?: unknown; legacy?: string };
export type Reference = { openapi: string; info?: { version?: string }; paths: Record<string, Record<string, unknown>> };
const areas = 'tasks|projects|people|chats|docs|billing|workflows|companies|search|events';
const safePath = (path: string) => new RegExp(`^/api/v1/(${areas}|service|catalog)(/|$)`).test(path)
  && path.split('/').slice(1).every(p => /^[A-Za-z0-9_{}-]+$/.test(p) && !['operator', 'auth'].includes(p))
  && (!/^\/api\/v1\/(service|catalog)(\/|$)/.test(path) || Object.hasOwn(legacy, path));
// Existing service contract only; activated by its presence in the live aggregate, never advertised speculatively.
const legacy: Record<string, [string, string]> = {
  '/api/v1/catalog/items': ['get', 'catalog.read (also accepts legacy pcat_ keys)'],
  '/api/v1/service/clients': ['get', 'clients.read'], '/api/v1/service/leads': ['get', 'leads.read'],
  '/api/v1/service/people': ['get', 'people.read'], '/api/v1/service/tasks/mine': ['get', 'tasks.read; also requires Pulse-Person-Token (use your server client)'],
  '/api/v1/service/quotes': ['post', 'quotes.draft.create'],
  '/api/v1/service/quotes/{id}/ready-notice': ['post', 'notify.quote_ready'],
  '/api/v1/service/chats/{chatId}/messages': ['post', 'chats.post'],
};
export function operations(doc: Reference): Operation[] {
  if (doc.openapi !== '3.1.0' || !doc.paths || typeof doc.paths !== 'object') throw Error('OpenAPI 3.1 reference unavailable');
  return Object.entries(doc.paths).filter(([path]) => safePath(path)).flatMap(([path, item]) => {
    if (typeof item.$ref === 'string' && legacy[path]) {
      const [method, scope] = legacy[path];
      return [{ path, method, summary: `Legacy service scope: ${scope}`, legacy: item.$ref }];
    }
    return Object.entries(item).filter(([method]) => ['get', 'post', 'patch', 'delete'].includes(method))
      .map(([method, value]) => ({ ...(value as Operation), path, method }));
  });
}
export const referenceRequest: RequestInit = { credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' };
export function prepareRequest(op: Operation, key: string, params: string, query: string, body: string, idempotency: string, confirmed: boolean) {
  if (!safePath(op.path) || !['get', 'post', 'patch', 'delete'].includes(op.method)) throw Error('Choose a documented v1 operation');
  if (legacy[op.path] && op.method !== legacy[op.path][0]) throw Error('Choose a documented service method');
  if (op.path === '/api/v1/service/tasks/mine') throw Error('This legacy operation requires a separate person token; use your server client');
  if (!/^(?:psvc_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}|pak_[0-9a-f]{8}_[0-9a-f]{64}|pcat_[A-Za-z0-9_-]+)$/.test(key)) throw Error('Paste a valid API key; this key is missing or malformed');
  if ([params, query, body, idempotency].some(value => value.includes(key))) throw Error('Keep the API key only in the key field');
  const values = JSON.parse(params || '{}'), search = JSON.parse(query || '{}');
  if ([values, search, ...(body ? [JSON.parse(body)] : [])].some(value => JSON.stringify(value).includes(key))) throw Error('Keep the API key only in the key field');
  if (!values || !search || Array.isArray(values) || Array.isArray(search) || typeof values !== 'object' || typeof search !== 'object') throw Error('Parameters and query must be JSON objects');
  const path = op.path.replace(/\{(\w+)\}/g, (_, name) => {
    if (typeof values[name] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(values[name])) throw Error(`Provide a plain path parameter: ${name}`);
    return values[name];
  });
  if (Object.keys(values).some(name => !op.path.includes(`{${name}}`))) throw Error('Unknown path parameter');
  const url = new URL(path, 'https://reference.invalid');
  const allowed = op.legacy ? (op.method !== 'get' || op.path.endsWith('/catalog/items') ? [] : ['limit', 'cursor', ...(/\/(clients|leads)$/.test(path) ? ['phone'] : [])]) : (op.parameters ?? []).filter(p => p.in === 'query').map(p => p.name);
  for (const [name, value] of Object.entries(search)) {
    if (!allowed.includes(name) || typeof value !== 'string') throw Error('Use only documented query parameters with string values');
    url.searchParams.set(name, value);
  }
  const write = op.method !== 'get';
  if (write && (!confirmed || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotency))) throw Error('Confirm this write and provide an idempotency key (8–128 plain characters)');
  if (body) JSON.parse(body);
  return { url: url.pathname + url.search, init: { ...referenceRequest, method: op.method.toUpperCase(),
    headers: { Authorization: `Bearer ${key}`, ...(write ? { 'Idempotency-Key': idempotency } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(write && body ? { body } : {}) } };
}
export async function sendRequest(request: ReturnType<typeof prepareRequest>, signal: AbortSignal, fetchImpl = fetch) {
  const response = await fetchImpl(request.url, { ...request.init, signal });
  const headers = ['x-request-id', 'retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset'].map(name => `${name}: ${response.headers.get(name) ?? 'not supplied'}`).join('\n');
  const reader = response.body?.getReader(), decoder = new TextDecoder(); let body = '';
  if (reader) while (true) { const part = await reader.read(); if (part.done) break; body += decoder.decode(part.value, { stream: true }); if (body.length > 65536) { await reader.cancel(); body = body.slice(0, 65536) + '\n[Response truncated]'; break; } }
  return { status: response.status, text: `HTTP ${response.status}\n${headers}\n\n${body}` };
}
