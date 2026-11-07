// Gateway client for the native companions: token-only calls to /api/native/v0 with single-flight refresh,
// browser pairing ("Sign in with your Pulse account") and clear errors for offline and for the outer Access gate.
import { actionRequest } from './view.js';

export const DEFAULT_BASE = 'https://pulse.estateautopilots.com/api/native/v0';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Pulse is unreachable because the site's outer sign-in gate (Cloudflare Access) answered instead of Pulse. */
export class GateError extends Error {
  constructor() { super('Pulse’s front door is not open for apps yet. Your admin needs to allow app access; until then use Pulse in the browser.'); this.gate = true; }
}
export class OfflineError extends Error {
  constructor() { super('You’re offline. Pulse will catch up when you’re back online.'); this.offline = true; }
}
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** The web page where the person approves a pairing code, on the same Pulse site as the gateway. */
export function verifyUrl(base, code, expectedPerson) {
  const u = new URL(base);
  return `${u.origin}/connect?code=${encodeURIComponent(code)}${expectedPerson?`&expected=${encodeURIComponent(expectedPerson)}`:''}`;
}

export function checkBase(base) {
  const u = new URL(base);
  const local = u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
  if ((u.protocol !== 'https:' && !local) || u.username || u.password || u.search || u.hash) throw new Error('Use the secure Pulse address (https://…)');
  return base.replace(/\/+$/, '');
}

/**
 * store: { get(): Promise<tokens|null>, set(tokens): Promise<void>, clear(): Promise<void> }
 * tokens: { accessToken, refreshToken, deviceId, person? }
 * credentials: 'include' lets the Chrome extension pass the browser's Access cookie along; native apps omit it.
 */
export function createClient({ base = DEFAULT_BASE, fetchImpl = globalThis.fetch, store, client = 'companion/0.3.3', credentials = 'omit', timeoutMs = 20000 }) {
  base = checkBase(base);
  let refreshing = null;

  async function send(path, body, token) {
    let r;
    try {
      r = await fetchImpl(`${base}/${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual', credentials, cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-pulse-client': client, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new OfflineError(); }
    if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) throw new GateError();
    if (!(r.headers.get('content-type') ?? '').includes('json')) throw r.status >= 500 ? new ApiError(r.status, 'Pulse is not answering right now') : new GateError();
    let data;
    try { data = await r.json(); } catch { throw new ApiError(r.status, 'Pulse sent an unreadable answer'); }
    return { r, data };
  }

  const changedSession = current => {
    const e = new ApiError(current ? 409 : 401, 'Your Pulse sign-in changed. Try again.');
    if (!current) e.signedOut = true;
    return e;
  };

  async function refresh(old) {
    const current = await store.get();
    if (!current || current.deviceId !== old.deviceId) {
      throw changedSession(current);
    }
    // Another request may already have rotated while this request's 401 was in flight.
    if (current.refreshToken !== old.refreshToken) return current;
    const { r, data } = await send('native/refresh', { refreshToken: old.refreshToken });
    const latest = await store.get();
    if (!latest || latest.deviceId !== old.deviceId || latest.refreshToken !== old.refreshToken) {
      throw changedSession(latest);
    }
    if (!r.ok || !TOKEN.test(data.accessToken ?? '') || !TOKEN.test(data.refreshToken ?? '')) { await store.clear(); const e = new ApiError(401, 'This device was signed out of Pulse. Sign in again.'); e.signedOut = true; throw e; }
    const next = { ...old, accessToken: data.accessToken, refreshToken: data.refreshToken };
    await store.set(next);
    return next;
  }

  async function call(path, body, { auth = true } = {}) {
    let tokens = auth ? await store.get() : null;
    if (auth && !tokens?.accessToken && !tokens?.refreshToken) { const e = new ApiError(401, 'Sign in to Pulse first'); e.signedOut = true; throw e; }
    // A stored device without a live access credential (e.g. after a browser restart) rotates first.
    if (auth && !tokens.accessToken) { refreshing ??= refresh(tokens).finally(() => { refreshing = null; }); tokens = await refreshing; }
    let { r, data } = await send(path, body, tokens?.accessToken);
    if (auth && r.status === 401 && tokens.refreshToken) {
      refreshing ??= refresh(tokens).finally(() => { refreshing = null; });
      tokens = await refreshing;
      ({ r, data } = await send(path, body, tokens.accessToken));
    }
    if(auth){const latest=await store.get();if(!latest||latest.deviceId!==tokens.deviceId)throw changedSession(latest);}
    if (!r.ok) {
      const e = new ApiError(r.status, data?.error ?? `Pulse answered ${r.status}`);
      if (r.status === 401) { await store.clear(); e.signedOut = true; }
      if (r.status === 429) e.retryAfter = Number(r.headers.get('retry-after') ?? 30);
      throw e;
    }
    return data;
  }

  return {
    base,
    call,
    companion: () => call('companion'),
    act: (action, extra = {}) => { const { path, body } = actionRequest(action, extra); return call(path, body); },
    /** Step 1 of browser sign-in: a short code the person approves on the Pulse site. */
    pairStart: (platform, name) => call('native/pair/start', { platform, name }, { auth: false }),
    /** Step 2: ask until the person approves; on approval the tokens are stored and returned once. */
    async pairPoll(pairId, pollSecret) {
      const data = await call('native/pair/poll', { pairId, pollSecret }, { auth: false });
      if (data.status === 'approved') await store.set({ accessToken: data.accessToken, refreshToken: data.refreshToken, deviceId: data.deviceId, person: data.person ?? null });
      return { status: data.status, person: data.person ?? null, deviceId: data.deviceId ?? null };
    },
    /** Sign out: revoke this device's tokens on the server (best effort) and forget them here. */
    async signOut() {
      const tokens = await store.get();
      try { if (tokens?.deviceId) await call(`devices/${tokens.deviceId}/revoke`, {}); } catch { /* local sign-out still happens */ }
      await store.clear();
    },
  };
}
