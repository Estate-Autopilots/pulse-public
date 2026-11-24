// One enrollment at a time: foreground/online retries share the native single-use pairing request.
// REPLAY-FIXES #5 (REPLAY-INSIGHTS: Adunor's Android tablet asked 12 times in 7 minutes, each refused with 404, on every
// return to the app; the server-side cause, FIX-LIVE-2's shared address, reaches production with the next release). A
// refusal (the server answers 4xx: no such request in this company, not allowed) is the same answer next time, so the
// automatic tries (opening the app, coming back online) wait ENROLL_PAUSE_MS and the person sees one plain message;
// Settings → Devices → Retry app registration still tries at once (force). A network failure or a busy server (5xx,
// 408, 429) is retried as before.
export const ENROLL_PAUSE_MS = 30 * 60_000;
const PAUSE_KEY = 'pulse.shell.enroll.refused';
const refusedAt = () => { try { return Number(globalThis.sessionStorage?.getItem(PAUSE_KEY) ?? 0) || 0; } catch { return 0; } };
const setRefused = (t) => { try { if (t) globalThis.sessionStorage?.setItem(PAUSE_KEY, String(t)); else globalThis.sessionStorage?.removeItem(PAUSE_KEY); } catch { /* storage off */ } };
/** Whether automatic tries wait: a refusal less than ENROLL_PAUSE_MS ago. */
export function enrollPaused(now = Date.now(), at = refusedAt()) { return at > 0 && now - at >= 0 && now - at < ENROLL_PAUSE_MS; }
/** A refusal, not a passing network problem. */
export const refusal = (status) => Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
export const REFUSED_WORDS = 'This phone could not be registered yet, so Pulse stopped trying. Open Settings → Devices and tap Retry app registration.';

let tail = Promise.resolve();
export function enrollShell(person, native, request, current = () => true, { force = false, now = Date.now } = {}) {
  if (!force && enrollPaused(now())) return Promise.resolve();
  const task = tail.catch(() => {}).then(async () => {
    if (!current()) return;
    const info = await native.info();
    if (!current() || (info.enrolled && info.personId === person)) return;
    if (info.enrolled) await native.signOut();
    if (!current()) return;
    const { code, replaces } = await native.startEnrollment();
    if (!current()) return;
    const r = await request('/api/v0/native/shell/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, replaces, expectedPersonId: person }) });
    if (!r.ok) {
      if (refusal(r.status)) { setRefused(now()); throw Object.assign(Error(REFUSED_WORDS), { refused: true }); }
      throw Error('Phone registration is waiting. Retry from Devices when connected.');
    }
    setRefused(0);
    if (!current()) return;
    await native.finishEnrollment();
    if (current()) void native.checkInbox().catch(() => {});
  });
  tail = task; return task;
}
