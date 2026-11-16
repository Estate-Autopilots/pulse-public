// Desktop attendance recovery. No credentials, inbox, office networks or request details are cached.
import { enqueue, outcomeOf, prune, queuedRequest, settle } from './queue.js';
import { applyLocal, clockOffset } from './view.js';

const fields = ['now', 'today', 'pending', 'state', 'utcOffsetMinutes', 'shift', 'shiftStartsAt', 'shiftEndsAt', 'nextShift', 'entry'];
const snapshot = (payload) => Object.fromEntries(fields.map((key) => [key, payload[key]]));

export class DesktopSession {
  constructor({ read, write, client, clock = Date.now }) {
    Object.assign(this, { read, write, client, clock });
    this.generation = 0; this.tail = Promise.resolve(); this.owner = null;
    this.payload = null; this.queue = []; this.confirmedAt = null; this.error = null; this.fresh = false; this.offset = 0; this.notice = null;
  }
  use(session) {
    const owner = session?.signedIn && session.deviceId ? `${session.base}|${session.deviceId}` : null;
    if (owner === this.owner) return;
    this.generation++; this.owner = owner; this.payload = null; this.queue = []; this.confirmedAt = null; this.error = null; this.fresh = false; this.offset = 0; this.notice = null;
    const saved = this.read();
    if (owner && saved?.owner === owner) {
      this.queue = Array.isArray(saved.queue) ? saved.queue : [];
      this.confirmedAt = saved.confirmedAt ?? null; this.notice = saved.notice ?? null;
      this.offset = saved.offset ?? clockOffset(saved.payload, this.confirmedAt ?? this.clock());
      if (this.clock() - this.confirmedAt <= 3 * 3600000) this.payload = saved.payload ?? null;
    }
    // An unpaired or different device must never replay the previous sign-in's work.
    if (!owner || saved?.owner !== owner) this.write(null);
  }
  save() {
    this.write({ owner: this.owner, payload: this.payload ? snapshot(this.payload) : null,
      queue: this.queue, confirmedAt: this.confirmedAt, offset: this.offset, notice: this.notice });
  }
  run(operation) {
    const generation = this.generation;
    const current = () => generation === this.generation && !!this.owner;
    const job = this.tail.catch(() => {}).then(() => current() ? operation(current) : undefined);
    this.tail = job; return job;
  }
  async flush(current) {
    const { keep, expired } = prune(this.queue, this.clock() + this.offset);
    this.queue = keep;
    if (expired.length) this.notice = 'Saved actions are too old to send. Ask for a correction on My desk.';
    this.save();
    let warning = this.notice;
    while (this.queue.length && current()) {
      const item = this.queue[0], { action, extra } = queuedRequest(item);
      let accepted = false;
      try { await this.client().act(action, extra); accepted = true; }
      catch (error) {
        if (!current()) return;
        if (error.signedOut || outcomeOf(error) === 'retry') throw error;
        this.notice = 'A saved action could not be applied. Review attendance on My desk.';
        warning = this.notice;
      }
      if (!current()) return;
      if (accepted) this.payload = applyLocal(this.payload, action, item.at, item.body);
      this.queue = settle(this.queue, item.id, 'ok'); this.save();
    }
    return warning;
  }
  refresh() {
    return this.run(async (current) => {
      try {
        const warning = await this.flush(current);
        if (!current()) return;
        const payload = await this.client().companion();
        if (!current()) return;
        this.payload = payload; this.confirmedAt = this.clock(); this.offset = clockOffset(payload, this.confirmedAt); this.error = null; this.fresh = true; this.save();
        return { payload, warning };
      } catch (error) { if (current()) { this.error = error; throw error; } }
    });
  }
  act(action, extra = {}) {
    return this.run(async (current) => {
      // Persist before sending, including online taps: a lost response/restart keeps the same retry ID.
      const at = this.clock() + this.offset;
      const before = this.queue;
      this.queue = enqueue(this.queue, action, at, extra);
      try { this.save(); } catch { this.queue = before; throw { message: 'Could not save this action on your computer. Free some storage, then retry.' }; }
      try {
        const warning = await this.flush(current);
        if (!current()) return;
        const payload = await this.client().companion();
        if (!current()) return;
        this.payload = payload; this.confirmedAt = this.clock(); this.offset = clockOffset(payload, this.confirmedAt); this.error = null; this.fresh = true; this.save();
        return { payload, warning };
      } catch (error) { if (current()) { this.error = error; throw error; } }
    });
  }
}
