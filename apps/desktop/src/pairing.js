// Browser pairing in the quick panel and the Pulse window: "Join <company>'s Pulse?" before the code is requested,
// then the poll at the server's interval until the person, and the company's admin if it asks for that, approve.
import { addressHost, failure } from './address.js';

export const ADMIN_WAIT = 'Approved by you. Waiting for your admin to approve this computer.';
export const ADMIN_DENIED = 'Your admin did not approve this computer. Nothing was signed in.';
const EXPIRED = 'The code expired. Start again when you’re ready.';

/** "Northwind Studio’s Pulse", or "Pulse at pulse.example.com" for an older Pulse that does not name its company. */
export function place(session) {
  return session?.company ? `${session.company}’s Pulse` : `Pulse at ${addressHost(session?.base)}`;
}

/** The company name for a saved address, asked once per address and window; null when the server does not say. */
const asked = new Set();
export async function learnCompany(invoke, session) {
  if (!session?.base || session.company || asked.has(session.base)) return null;
  asked.add(session.base);
  try { const next = await invoke('companion_about'); return next?.base === session.base ? next.company ?? null : null; } catch { return null; }
}

/**
 * Polls a pairing ({ code, interval, expiresIn } from companion_pair_start, or a session's awaitingAdmin
 * { code, interval, until } after a restart). update(model) shows the next sign-in step; done(session) runs once
 * this computer is signed in. Returns stop().
 */
export function follow(invoke, pairing, update, done) {
  let admin = !!pairing.until, deadline = pairing.until ?? Date.now() + (pairing.expiresIn ?? 600) * 1000;
  const end = (model) => { clearInterval(timer); update(model); };
  const timer = setInterval(async () => {
    if (Date.now() > deadline) return end({ phase: 'error', message: admin ? 'Your admin did not decide within a day. Start again when you’re ready.' : EXPIRED });
    try {
      const r = await invoke('companion_pair_poll');
      if (r.status === 'approved') { clearInterval(timer); done(r.session); }
      else if (r.status === 'awaiting_admin') { if (!admin) { admin = true; deadline = r.until ?? deadline; update({ phase: 'awaiting', code: pairing.code, message: ADMIN_WAIT }); } }
      else if (r.status !== 'pending') end({ phase: 'error', message: r.status === 'denied' ? (admin ? ADMIN_DENIED : 'Not approved. Nothing was signed in.') : EXPIRED });
    } catch (e) {
      const f = failure(e), retryable = f.offline || (Number.isFinite(Number(f.status)) && Number(f.status) >= 500);
      if (!retryable) end({ phase: f.gate ? 'gate' : 'error', message: f.message });
    }
  }, Math.max(2, pairing.interval ?? 3) * 1000);
  return () => clearInterval(timer);
}
