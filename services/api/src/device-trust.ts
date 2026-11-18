// SWITCH-SMOOTH (owner, 16 Nov 2026): "Once you are in the Pulse account, switching between companies should be
// easy ... Asking again and again is a hazard." A browser that proved the person (their own password, a code to their own
// e-mail, Google / Microsoft / Apple with their own address, "Confirm it's you") is trusted for that account for 180 days
// (migration 2165, pulse_priv.account_device). The browser is the web proxy's own httpOnly pulse_device_key cookie: the
// proxy sends its hash as x-pulse-device-id, and x-pulse-device-known: 1 only when that cookie was really there (a key it
// made up for this one request never counts). Nothing here crosses a company by itself: the database lifts a session of
// the same account to personal, and the owner's rule (acct_may_cross) decides the rest as before.
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Open } from './routes.js';

const DEVICE_ID = /^[0-9a-f]{64}$/;
const SESSION = /^[A-Za-z0-9_-]{40,64}$/;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** The hash Pulse keeps for this browser, or null. `fresh`: a sign-in answer, which the proxy turns into the device
 *  cookie itself (so a key it just made is this browser's from now on). */
export function deviceOf(headers: FastifyRequest['headers'], fresh = false): string | null {
  const id = headers['x-pulse-device-id'];
  if (typeof id !== 'string' || !DEVICE_ID.test(id)) return null;
  if (!fresh && headers['x-pulse-device-known'] !== '1') return null;
  return hash('pulse-device:' + id);
}

/** The browser's own sign-in token (never a tab's derived child: the front door reads it before swapping). */
export const browserToken = (headers: FastifyRequest['headers']) => {
  const t = headers['x-pulse-session'];
  return typeof t === 'string' && SESSION.test(t) ? t : null;
};

// One check per sign-in and browser every few minutes per process: a lift is a single write, a trusted personal
// session needs nothing more, and a company sign-in on a browser that never proved the person stays as it is.
const checked = new Map<string, number>();
const CHECK_MS = 5 * 60 * 1000;

/** The front door: lifts the browser's sign-in when this browser proved the same person before (pulse.acct_device_seen).
 *  Never fails a request: any error leaves the session exactly as it was. */
// A page's first burst of requests waits for the one lookup in flight (one connection, and none of them runs ahead of
// the lift: a tab's company would otherwise be refused for a moment).
const inflight = new Map<string, Promise<string | null>>();
export async function deviceSeen(db: Pick<Pool, 'query'>, sessionHash: string, device: string): Promise<string | null> {
  const key = sessionHash + ':' + device, now = Date.now();
  const waiting = inflight.get(key);
  if (waiting) return waiting;
  if ((checked.get(key) ?? 0) > now) return null;
  if (checked.size > 50000) checked.clear();
  const run = (async () => {
    try {
      const r = (await db.query<{ s: string }>('select pulse.acct_device_seen($1,$2) s', [sessionHash, device]))?.rows?.[0]?.s ?? null;
      checked.set(key, Date.now() + CHECK_MS);
      return r;
    } catch { checked.set(key, Date.now() + 60000); return null; } finally { inflight.delete(key); }
  })();
  inflight.set(key, run);
  return run;
}

/** Forget what the front door remembered for this browser (after "Forget this device"). */
export const deviceForget = () => checked.clear();

/** Right after a proof on this browser: trusted for 180 days from now (only when the session is personal). */
export async function trustDevice(open: Open, req: FastifyRequest, token: string | null | undefined,
  proof: 'password' | 'code' | 'google' | 'microsoft' | 'apple' | 'passkey', sessionHash: (t: string) => string, fresh = false): Promise<boolean> {
  const device = deviceOf(req.headers, fresh);
  if (!device || !token) return false;
  try {
    return await open(async (c) => (await c.query('select pulse.acct_device_trust($1,$2,$3) t', [sessionHash(token), device, proof])).rows[0]?.t === true);
  } catch { return false; }
}
