// Manual web attendance recovery. Reuse the companion retry contract; cache no day, credentials or office data.
import { enqueue, queuedRequest, actionRequest, QUEUE_MAX_AGE_MS, QUEUE_LIMIT } from '@pulse/companion';
export const ATTENDANCE_KEY = 'pulse.attendance.recovery.v1';
const states = ['queued', 'accepted', 'rejected', 'needs-correction'];
const TRIGGERS = ['manual', 'suggested', 'notification', 'reminder', 'widget'];
/** EST-1195: a request Pulse has not answered in this long is given up (the tap stays saved and retries with its id). */
export const REQUEST_TIMEOUT_MS = 10000;
const NAME = { 'check-in': 'check-in', 'check-out': 'check-out', 'break-start': 'break', 'break-end': 'end of your break' };
const signedOut = e => e?.status === 401;
/** Said when a saved tap could not be sent yet. */
const waiting = e => signedOut(e) ? 'Your sign-in has expired. Your tap is saved on this device and sends once you sign in again.'
  : 'Couldn’t reach Pulse. Your tap is saved on this device and sends when you’re back online, or tap Retry.';

export class AttendanceRecovery {
  constructor({ owner, storage, request, clock = Date.now, lock = async fn => fn(), changed = () => {}, timeoutMs = REQUEST_TIMEOUT_MS }) {
    Object.assign(this, { owner, storage, request, clock, lock, changed, timeoutMs });
    this.active = true; this.tail = Promise.resolve(); this.note = ''; this.busy = false;
    /** A tap Pulse could not take at all (no confirmed clock): nothing was saved; `again()` tries it as a new tap. */
    this.unsaved = null;
    const saved = this.read();
    this.records = saved?.owner === owner ? saved.records : [];
    this.offset = saved?.owner === owner ? saved.offset : null;
    this.save(); // Changing accounts discards the former account's local actions, never loads its day.
  }
  read() {
    const raw = this.storage.getItem(ATTENDANCE_KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (!(value.offset === null || Number.isFinite(value.offset)) || typeof value.owner !== 'string' || !Array.isArray(value.records) || value.records.length > QUEUE_LIMIT ||
          value.records.some(r => !/^[A-Za-z0-9-]{8,64}$/.test(r.id) || !['check-in','check-out','break-start','break-end'].includes(r.action) || !Number.isFinite(r.at) || !states.includes(r.state))) throw Error();
      return value;
    } catch { throw Error('Saved attendance could not be read. Review My desk before retrying.'); }
  }
  current() { return this.active && this.read()?.owner === this.owner; }
  save() { this.storage.setItem(ATTENDANCE_KEY, JSON.stringify({ owner: this.owner, records: this.records, offset: this.offset })); }
  dispose() { this.active = false; }
  run(fn) {
    let result;
    const task = this.tail.catch(() => {}).then(() => this.lock(async () => {
      if (!this.current()) return;
      const saved = this.read(); this.records = saved.records; this.offset = saved.offset;
      this.busy = true; this.changed();
      // A background retry with nothing saved stays quiet; the next tap asks Pulse itself and says what happened.
      try { result = await fn(); } catch (e) { if (this.current()) this.note = this.records.some(r => r.state === 'queued') ? waiting(e) : ''; }
      finally { this.busy = false; if (this.current()) this.changed(); }
    })).then(() => result);
    this.tail = task; return task;
  }
  /** One request, given up after `timeoutMs` (the signal stops the fetch too), so a stalled network never holds a tap. */
  async call(path, body) {
    const abort = new AbortController(); let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(Object.assign(Error('Pulse did not answer in time'), { timeout: true })); }, this.timeoutMs); });
    try { return await Promise.race([this.request(path, body, abort.signal), late]); } finally { clearTimeout(timer); }
  }
  async syncClock() {
    const p = await this.call('companion');
    if (!this.current()) return false;
    if (p.person?.id !== this.owner) { this.note = 'Your sign-in changed. Reload My desk before taking an action.'; return false; }
    const at = Date.parse(p.now);
    if (!Number.isFinite(at)) throw Error('Missing server time');
    this.offset = at - this.clock(); this.save(); return true;
  }
  async flush() {
    for (const item of this.records) {
      if (item.state !== 'queued' || !this.current()) continue;
      if (this.clock() + this.offset - item.at > QUEUE_MAX_AGE_MS) {
        item.state = 'needs-correction'; this.save(); continue;
      }
      const { action, extra } = queuedRequest(item);
      // A tap answering Pulse's own question ("You're at the office. Check in?") says so; anything else is manual.
      const { path, body } = actionRequest(action, { ...extra, expectedPersonId: this.owner, via: 'web', trigger: TRIGGERS.includes(extra.trigger) ? extra.trigger : 'manual' });
      try {
        const receipt = await this.call(path, body);
        if (!this.current()) return;
        if (typeof receipt.id !== 'string') throw Error('Missing receipt');
        item.state = 'accepted'; item.receiptId = receipt.id; this.save();
      } catch (e) {
        if (!this.current()) return;
        if (!e.status || e.status === 401 || e.status === 429 || e.status >= 500) { item.tries++; this.save(); throw e; }
        item.state = e.status === 409 ? 'needs-correction' : 'rejected'; this.save();
      }
    }
    this.note = '';
  }
  retry() { return this.run(async () => { if (await this.syncClock()) await this.flush(); }); }
  /** EST-1195: the tap Pulse could not take, tried again as a new tap now (its time is Pulse's clock at this tap). */
  again() { const u = this.unsaved; return u ? this.act(u.action, u.mode, u.trigger, u.extra) : this.retry(); }
  /**
   * `extra.leave: 'cancel'` (UX-5A): the person chose to cancel today's approved leave with this check-in.
   * Resolves to the saved tap's state ('accepted', 'queued', …), 'unsaved' when nothing could be saved, or undefined.
   */
  act(action, mode, trigger, extra = {}) {
    return this.run(async () => {
      this.unsaved = null;
      if (this.offset === null) {
        // EST-1195: no confirmed clock yet (offline or signed out since the page opened). Ask Pulse now, with this tap.
        // A tap is never saved on the phone's own clock, so when Pulse can't answer nothing is saved: say so plainly.
        try { if (!(await this.syncClock())) return; }
        catch (e) {
          if (!this.current()) return;
          this.unsaved = { action, mode, trigger, extra, signedOut: signedOut(e) };
          this.note = signedOut(e) ? `Your sign-in has expired, so this ${NAME[action]} was not saved. Sign in again, then try again.`
            : `Couldn’t reach Pulse, so this ${NAME[action]} was not saved. Check your connection and try again.`;
          return 'unsaved';
        }
      }
      // A queued action has no confirmed day transition yet. Do not invent the next attendance state.
      if (this.records.some(r => r.state === 'queued')) return;
      const before = this.records;
      if (this.records.length >= QUEUE_LIMIT) { this.note = 'Review and clear confirmed receipts before saving more actions.'; return; }
      const queued = enqueue(this.records, action, this.clock() + this.offset, { ...(action === 'check-in' ? { mode } : {}), ...(TRIGGERS.includes(trigger) ? { trigger } : {}),
        ...(action === 'check-in' && extra?.leave === 'cancel' ? { leave: 'cancel' } : {}) });
      if (queued.length === this.records.length) return;
      this.records = queued.map(r => r.state ? r : ({ ...r, state: 'queued' }));
      try { this.save(); } catch { this.records = before; this.note = 'Could not save this action on this device. Check storage, then retry.'; return; }
      const tap = this.records.at(-1);
      this.changed(); await this.flush();
      return tap.state;
    });
  }
  clearReviewed() { return this.run(async () => { this.records = this.records.filter(r => r.state === 'queued'); this.save(); }); }
}
