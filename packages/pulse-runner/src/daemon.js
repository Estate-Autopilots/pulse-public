import fs from 'node:fs';
import path from 'node:path';
import { PulseClient } from './http.js';
import { Isolation } from './sandbox.js';
import { JobRejected, isValidJobId, validateJob } from './job-validate.js';
import { JobRun, buildAudit, sendResult } from './job-run.js';
import { collectCapabilities } from './capabilities.js';
import { Redactor, log as writeLog } from './redact.js';
import { VERSION } from './version.js';
import { appendAudit, deleteCredential } from './store.js';
import { LoginManager } from './login.js';

export const EXIT_REVOKED = 78;
const SEEN_LIMIT = 2000;
const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export class Daemon {
  constructor({ paths, config, credential, pathValue = process.env.PATH ?? '' }) {
    Object.assign(this, { paths, config, credentialRecord: credential, pathValue });
    this.redactor = new Redactor([credential.credential]);
    this.log = (level, message, fields) => writeLog(level, message, fields, this.redactor);
    this.client = new PulseClient({ apiUrl: config.apiUrl, credential: credential.credential, onRevoked: () => this.#revoked() });
    this.isolation = new Isolation({ mode: config.isolation, paths, pathValue });
    this.jobs = new Map();
    this.seen = new Set();
    this.stopping = false;
    this.exitCode = 0;
    this.stopSignal = new AbortController();
    this.startedAt = Date.now();
    this.jobPromises = new Set();
    // PROTOCOL.md §10: logins Pulse asks for run the CLI's own flow here; a finished one is reported at once.
    this.logins = new LoginManager({
      paths, pathValue,
      report: (id, body) => this.client.login(id, body),
      log: this.log,
      onChange: () => { void this.#reportCapabilities(); },
    });
  }

  async run() {
    this.#clearStaleJobs();
    const status = await this.isolation.probe();
    if (status.mode === 'none') {
      this.log('warn', 'job isolation is OFF in the local config: jobs could read the runner credential');
    } else if (!status.verified) {
      this.log('error', 'job isolation is unavailable, so every job will be rejected', { reason: status.reason });
    }
    this.log('info', 'pulse-runner started', { version: VERSION, runnerId: this.credentialRecord.runnerId, maxConcurrent: this.config.maxConcurrent });

    await this.#reportCapabilities();
    await this.#heartbeat();
    const beat = setInterval(() => this.#heartbeat(), this.config.heartbeatSec * 1000);
    const caps = setInterval(() => this.#reportCapabilities(), this.config.capabilitiesSec * 1000);
    try {
      await this.#pollLoop();
    } finally {
      clearInterval(beat);
      clearInterval(caps);
    }
    await Promise.allSettled(this.jobPromises);
    this.client.abort();
    this.log('info', 'pulse-runner stopped', { exitCode: this.exitCode });
    return this.exitCode;
  }

  /** Graceful stop: running jobs are ended and reported as interrupted. */
  shutdown() {
    if (this.stopping) return;
    this.stopping = true;
    for (const job of this.jobs.values()) job.stop?.('shutdown');
    this.logins.stopAll();
    this.stopSignal.abort();
    this.pollAbort?.();
  }

  #revoked() {
    if (this.stopping && this.exitCode === EXIT_REVOKED) return;
    this.exitCode = EXIT_REVOKED;
    this.log('error', 'this runner was revoked in Pulse: stopping all jobs and deleting the credential');
    deleteCredential(this.paths);
    this.stopping = true;
    for (const job of this.jobs.values()) job.stop?.('revoked');
    this.logins.stopAll();
    this.stopSignal.abort();
    this.pollAbort?.();
  }

  #clearStaleJobs() {
    // No job survives a runner restart, so whatever is here is left over from a crash.
    fs.mkdirSync(this.paths.jobsDir, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(this.paths.jobsDir)) {
      fs.rmSync(path.join(this.paths.jobsDir, entry), { recursive: true, force: true });
    }
  }

  async #reportCapabilities() {
    try {
      const report = await collectCapabilities({
        paths: this.paths,
        config: this.config,
        isolationStatus: this.isolation.status,
        pathValue: this.pathValue,
      });
      await this.client.capabilities(report);
    } catch (err) {
      this.log('warn', 'could not report capabilities', { error: err.message });
    }
  }

  async #heartbeat() {
    try {
      await this.client.heartbeat({
        version: VERSION,
        status: this.stopping ? 'draining' : 'ready',
        runningJobs: [...this.jobs.keys()],
        maxConcurrent: this.config.maxConcurrent,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      });
    } catch (err) {
      this.log('warn', 'heartbeat failed', { error: err.message });
    }
  }

  async #pollLoop() {
    let backoff = 1000;
    while (!this.stopping) {
      const began = Date.now();
      let response;
      try {
        const poll = this.client.poll({
          waitSec: this.config.pollWaitSec,
          slots: Math.max(0, this.config.maxConcurrent - this.jobs.size),
          runningJobs: [...this.jobs.keys()],
        });
        response = await new Promise((resolve, reject) => {
          this.pollAbort = () => resolve(null);
          poll.then(resolve, reject);
        });
      } catch (err) {
        if (this.stopping) break;
        this.log('warn', 'poll failed', { error: err.message });
        const jitter = Math.random() * 0.3 * backoff;
        await sleep(backoff + jitter, this.stopSignal.signal);
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }
      if (this.stopping) break;
      backoff = 1000;
      for (const id of response?.cancel ?? []) this.jobs.get(id)?.stop?.('cancelled');
      for (const job of response?.jobs ?? []) this.#receive(job);
      // An older Pulse sends no logins; unknown fields are ignored (PROTOCOL.md conventions).
      for (const login of Array.isArray(response?.logins) ? response.logins.slice(0, 10) : []) this.logins.handle(login);
      if (Date.now() - began < this.config.pollMinMs && !response?.jobs?.length && !response?.logins?.length) {
        await sleep(this.config.pollMinMs, this.stopSignal.signal);
      }
    }
  }

  #receive(rawJob) {
    if (!isValidJobId(rawJob?.id)) {
      this.log('warn', 'ignored a job with an invalid id');
      return;
    }
    const { id } = rawJob;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value);

    if (this.jobs.size >= this.config.maxConcurrent) {
      // Pulse requeues this job, so the same id has to be accepted when it comes back.
      this.seen.delete(id);
      this.#track(this.#reject(rawJob, new JobRejected('capacity', 'This server has no free job slot')));
      return;
    }
    // Hold the slot straight away so a job later in this batch cannot take it.
    const slot = { pending: null, stop(reason) { this.pending ??= reason; } };
    this.jobs.set(id, slot);
    this.#track(this.#start(rawJob, slot).finally(() => this.jobs.delete(id)));
  }

  #track(promise) {
    const tracked = promise.catch((err) => this.log('error', 'job handling failed', { error: err.message })).finally(() => this.jobPromises.delete(tracked));
    this.jobPromises.add(tracked);
  }

  async #start(rawJob, slot) {
    try {
      await this.client.ack(rawJob.id);
    } catch (err) {
      // Pulse will redeliver if it never saw the ack, so forget this id and do not run it.
      this.seen.delete(rawJob.id);
      this.log('warn', 'could not acknowledge job', { jobId: rawJob.id, error: err.message });
      return;
    }
    let job;
    let isolation = this.isolation;
    try {
      job = validateJob(rawJob, { config: this.config, orgId: this.credentialRecord.orgId });
      // RUNNERS-FULL (PROTOCOL.md §4 "access"): a job runs outside the sandbox only when BOTH keys are turned: the
      // company's admin turned the sandbox off for this server in Pulse (access.sandbox false) AND this server's own
      // admin allowed it in the local config (allowNoSandbox). Either alone changes nothing.
      if (job.access?.sandbox === false && this.config.allowNoSandbox === true) {
        isolation = new Isolation({ mode: 'none', paths: this.paths, pathValue: this.pathValue });
        await isolation.probe();
      }
      // AI-EMPLOYEE-POWER: a root job (validated: allowRoot here, the owner's grant in Pulse) runs outside the sandbox.
      if (job.profile === 'root') {
        isolation = new Isolation({ mode: 'none', paths: this.paths, pathValue: this.pathValue });
        await isolation.probe();
      }
      if (!job.dryRun && !isolation.canRunJobs) {
        throw new JobRejected('isolation_unavailable', this.isolation.status?.reason ?? 'The job sandbox is unavailable');
      }
    } catch (err) {
      if (!(err instanceof JobRejected)) throw err;
      await this.#reject(rawJob, err);
      return;
    }
    if (this.stopping) {
      await this.#reject(rawJob, new JobRejected('runner_shutdown', 'The runner is stopping'));
      return;
    }
    const run = new JobRun({
      job,
      client: this.client,
      config: this.config,
      paths: this.paths,
      isolation,
      redactor: new Redactor([this.credentialRecord.credential]),
      log: this.log,
      pathValue: this.pathValue,
    });
    slot.stop = (reason) => run.stop(reason);
    if (slot.pending) run.stop(slot.pending);
    const result = await run.run();
    this.log('info', 'job finished', { jobId: job.id, status: result.status, errorCode: result.error?.code ?? null });
  }

  async #reject(rawJob, rejection) {
    const now = new Date().toISOString();
    const audit = buildAudit(rawJob, this.isolation.mode);
    this.log('warn', 'job rejected', { jobId: rawJob.id, code: rejection.code });
    try {
      appendAudit(this.paths, { ts: now, jobId: rawJob.id, status: 'rejected', errorCode: rejection.code, dryRun: rawJob.dryRun === true, ...audit });
    } catch (err) {
      this.log('warn', 'could not write local audit log', { error: err.code });
    }
    await sendResult(this.client, rawJob.id, this.redactor.deep({
      status: 'rejected',
      dryRun: rawJob.dryRun === true,
      exitCode: null,
      signal: null,
      error: { code: rejection.code, message: rejection.message },
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      usage: null,
      outputs: [],
      audit,
    }), { log: this.log });
  }
}
