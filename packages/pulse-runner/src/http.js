export class PulseError extends Error {
  constructor(message, { status = 0, code = 'network_error' } = {}) {
    super(message);
    this.name = 'PulseError';
    this.status = status;
    this.code = code;
  }

  get revoked() {
    return this.status === 401 && this.code === 'runner_revoked';
  }

  /** True when Pulse has said it no longer wants this job. */
  get jobGone() {
    return this.status === 404 || this.status === 409;
  }

  get retryable() {
    return this.status === 0 || this.status === 401 || this.status === 429 || this.status >= 500;
  }
}

/** Only HTTPS may carry the credential. Plain HTTP is allowed to loopback, for tests. */
export function assertSafeApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid API URL: ${value}`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The Pulse API URL must use https.');
  }
  return url.origin;
}

const PREFIX = '/runner/v1';

export class PulseClient {
  constructor({ apiUrl, credential = null, onRevoked = () => {} }) {
    this.origin = assertSafeApiUrl(apiUrl);
    this.credential = credential;
    this.onRevoked = onRevoked;
    this.stopper = new AbortController();
  }

  /** Aborts in-flight requests, including a held long poll. */
  abort() {
    this.stopper.abort();
  }

  async request(method, route, { json, body, headers = {}, timeoutMs = 30_000 } = {}) {
    const finalHeaders = { ...headers };
    if (this.credential) finalHeaders.Authorization = `Bearer ${this.credential}`;
    if (json !== undefined) finalHeaders['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(`${this.origin}${PREFIX}${route}`, {
        method,
        headers: finalHeaders,
        body: json !== undefined ? JSON.stringify(json) : body,
        redirect: 'error',
        signal: AbortSignal.any([this.stopper.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (err) {
      // The cause's message can name the URL but never holds headers, so it is safe to keep.
      throw new PulseError(`${method} ${route} failed: ${err.cause?.code ?? err.name}`);
    }
    const text = await response.text().catch(() => '');
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const code = typeof parsed?.error?.code === 'string' ? parsed.error.code : `http_${response.status}`;
      const detail = typeof parsed?.error?.message === 'string' ? `: ${parsed.error.message.slice(0, 300)}` : '';
      const error = new PulseError(`${method} ${route} returned ${response.status} ${code}${detail}`, { status: response.status, code });
      if (error.revoked) this.onRevoked(error);
      throw error;
    }
    return parsed;
  }

  pair(code, runner) {
    return this.request('POST', '/pair', { json: { code, runner } });
  }
  deregister() {
    return this.request('POST', '/deregister', { json: {} });
  }
  heartbeat(body) {
    return this.request('POST', '/heartbeat', { json: body });
  }
  capabilities(body) {
    return this.request('POST', '/capabilities', { json: body });
  }
  poll(body) {
    return this.request('POST', '/poll', { json: body, timeoutMs: (body.waitSec + 15) * 1000 });
  }
  ack(id) {
    return this.request('POST', `/jobs/${encodeURIComponent(id)}/ack`, { json: {} });
  }
  events(id, events) {
    return this.request('POST', `/jobs/${encodeURIComponent(id)}/events`, { json: { events } });
  }
  result(id, result) {
    return this.request('POST', `/jobs/${encodeURIComponent(id)}/result`, { json: result });
  }
  /** PROTOCOL.md §10: how a login Pulse asked for is going (never a token; only the link and code for a person). */
  login(id, body) {
    return this.request('POST', `/logins/${encodeURIComponent(id)}`, { json: body });
  }
  upload(id, relPath, bytes, sha256) {
    return this.request('PUT', `/jobs/${encodeURIComponent(id)}/outputs?path=${encodeURIComponent(relPath)}`, {
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': sha256 },
      timeoutMs: 10 * 60_000,
    });
  }
}
