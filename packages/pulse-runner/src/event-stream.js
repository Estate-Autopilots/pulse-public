const MAX_BATCH = 100;
const FLUSH_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ordered, batched, retried delivery of one job's events. */
export class EventStream {
  constructor({ client, jobId, redactor, onCancel = () => {}, onError = () => {}, maxQueue = 5000 }) {
    Object.assign(this, { client, jobId, redactor, onCancel, onError, maxQueue });
    this.seq = 0;
    this.queue = [];
    this.dropped = 0;
    this.closed = false;
    this.abandoned = false;
    this.wake = null;
    this.loop = this.#run();
  }

  /** Log lines may be dropped under pressure. Everything else is always queued. */
  push(type, data) {
    if (this.closed || this.abandoned) return;
    if (type === 'log' && this.queue.length >= this.maxQueue) {
      this.dropped += 1;
      return;
    }
    this.seq += 1;
    this.queue.push({ seq: this.seq, ts: new Date().toISOString(), type, data: this.redactor.deep(data) });
    this.wake?.();
  }

  async #run() {
    let backoff = 1000;
    while (!this.abandoned) {
      if (this.dropped > 0 && this.queue.length < this.maxQueue) {
        const count = this.dropped;
        this.dropped = 0;
        this.seq += 1;
        this.queue.push({ seq: this.seq, ts: new Date().toISOString(), type: 'warning', data: { code: 'events_dropped', message: `${count} log lines were dropped` } });
      }
      if (this.queue.length === 0) {
        if (this.closed) return;
        await new Promise((resolve) => {
          this.wake = resolve;
          setTimeout(resolve, FLUSH_MS * 4);
        });
        this.wake = null;
        continue;
      }
      const batch = this.queue.slice(0, MAX_BATCH);
      try {
        const response = await this.client.events(this.jobId, batch);
        this.queue.splice(0, batch.length);
        backoff = 1000;
        if (response?.cancel === true) this.onCancel();
        if (!this.closed) await sleep(FLUSH_MS);
      } catch (err) {
        if (err.jobGone || err.revoked) {
          this.abandoned = true;
          this.queue = [];
          if (err.jobGone) this.onCancel();
          return;
        }
        if (!err.retryable) {
          // Pulse rejected this batch outright. Retrying it would block every later event.
          this.onError(err);
          this.queue.splice(0, batch.length);
          continue;
        }
        if (this.closed && this.deadline && Date.now() > this.deadline) {
          this.onError(err);
          this.queue = [];
          return;
        }
        this.onError(err);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Stops accepting events and waits for the backlog to be delivered, up to a deadline. */
  async close(deadlineMs = 5 * 60_000) {
    this.closed = true;
    this.deadline = Date.now() + deadlineMs;
    this.wake?.();
    await this.loop;
  }
}
