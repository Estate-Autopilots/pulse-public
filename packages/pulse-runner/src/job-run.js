import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildCommand, jobDirs } from './commands.js';
import { EventStream } from './event-stream.js';
import { OutputRefused, readOutput } from './outputs.js';
import { parseAgentLine } from './usage.js';
import { appendAudit } from './store.js';

const MAX_LINE_BYTES = 64 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STOP_RESULTS = {
  cancelled: { status: 'cancelled', code: 'cancelled', message: 'Cancelled by Pulse' },
  timed_out: { status: 'timed_out', code: 'time_limit_exceeded', message: 'The time limit was reached' },
  cost_cap: { status: 'failed', code: 'cost_cap_exceeded', message: 'The cost cap was reached' },
  shutdown: { status: 'failed', code: 'runner_shutdown', message: 'The runner was stopped' },
  revoked: { status: 'failed', code: 'runner_shutdown', message: 'The runner was revoked' },
};

/** Sends a job's final result, for jobs that never reached execution as well as those that did. */
export async function sendResult(client, jobId, result, { log = () => {}, attempts = 8 } = {}) {
  let delay = 1000;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await client.result(jobId, result);
      return true;
    } catch (err) {
      if (err.revoked || err.jobGone) return false;
      log('warn', 'could not send job result', { jobId, attempt: i, error: err.message });
      if (i === attempts) return false;
      await sleep(delay);
      delay = Math.min(delay * 2, 60_000);
    }
  }
  return false;
}

export function buildAudit(job, isolationMode) {
  return {
    requestedBy: job?.requestedBy ?? null,
    kind: job?.kind ?? null,
    profile: job?.profile ?? null,
    approval: job?.approval ?? null,
    isolation: isolationMode,
    promptSha256: typeof job?.prompt === 'string' ? crypto.createHash('sha256').update(job.prompt).digest('hex') : null,
  };
}

/** Runs one validated job from start to final result. */
export class JobRun {
  constructor({ job, client, config, paths, isolation, redactor, log, pathValue }) {
    Object.assign(this, { job, client, config, paths, isolation, log, pathValue });
    this.redactor = redactor;
    if (job.mcp?.token) this.redactor.add(job.mcp.token);
    this.dirs = jobDirs(paths, job.id);
    this.stopReason = null;
    this.child = null;
    this.usage = null;
    this.agentError = false;
    this.logBytes = 0;
    this.logLimitWarned = false;
    this.stream = new EventStream({
      client,
      jobId: job.id,
      redactor,
      onCancel: () => this.stop('cancelled'),
      onError: (err) => log('warn', 'could not send job events', { jobId: job.id, error: err.message }),
    });
  }

  /** Stops the job. The first reason wins. Safe to call at any time and repeatedly. */
  stop(reason) {
    if (this.stopReason) return;
    this.stopReason = reason;
    this.stream.push('status', { state: 'stopping', reason });
    this.#terminate();
  }

  #signalGroup(signal) {
    if (!this.child?.pid) return;
    try {
      process.kill(-this.child.pid, signal);
    } catch (err) {
      if (err.code !== 'ESRCH') this.log('warn', 'could not signal job', { jobId: this.job.id, error: err.code });
    }
  }

  #terminate() {
    if (!this.child || this.exited) return;
    this.#signalGroup('SIGTERM');
    this.killTimer = setTimeout(() => this.#signalGroup('SIGKILL'), this.config.graceSec * 1000);
  }

  async run() {
    const startedAt = new Date();
    const { job } = this;
    let outcome;
    let outputs = [];
    try {
      this.stream.push('status', { state: 'accepted' });
      const plan = this.#prepare();
      outcome = job.dryRun ? this.#dryRun(plan) : await this.#execute(plan);
      if (!job.dryRun && !this.stopReason) {
        const uploaded = await this.#uploadOutputs();
        outputs = uploaded.outputs;
        if (uploaded.error && outcome.status === 'succeeded') outcome = { ...outcome, status: 'failed', error: uploaded.error.error };
      }
    } catch (err) {
      this.log('error', 'job failed unexpectedly', { jobId: job.id, error: err.message });
      outcome = { status: 'failed', error: { code: err.code === 'binary_not_found' ? err.code : 'internal_error', message: err.message } };
    }

    const finishedAt = new Date();
    const result = {
      status: outcome.status,
      dryRun: job.dryRun,
      exitCode: outcome.exitCode ?? null,
      signal: outcome.signal ?? null,
      error: outcome.error ?? null,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      usage: this.usage,
      outputs,
      audit: buildAudit(job, this.isolation.mode),
    };
    await this.stream.close();
    this.#cleanup();
    this.#audit(result);
    if (this.stopReason !== 'revoked') await sendResult(this.client, job.id, this.redactor.deep(result), { log: this.log });
    return result;
  }

  #prepare() {
    const { job, dirs } = this;
    for (const dir of [dirs.root, dirs.work, dirs.tmp, dirs.home, dirs.private]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const plan = buildCommand(job, { paths: this.paths, dirs, pathValue: this.pathValue, config: this.config });
    if (!job.dryRun) {
      if (!plan.cmd) {
        const err = new Error(`${plan.name} is not installed on this server`);
        err.code = 'binary_not_found';
        throw err;
      }
      for (const file of plan.files) fs.writeFileSync(file.path, file.content, { mode: 0o600 });
    }
    return plan;
  }

  #dryRun(plan) {
    const { job } = this;
    this.stream.push('dry_run', {
      kind: job.kind,
      profile: job.profile,
      command: [plan.cmd ?? plan.name, ...plan.args],
      promptBytes: job.prompt ? Buffer.byteLength(job.prompt) : 0,
      binaryFound: Boolean(plan.cmd),
      isolation: this.isolation.mode,
      outputs: job.outputs.map((o) => o.path),
      workdir: '<job workdir>',
    });
    return { status: 'succeeded' };
  }

  #warn(code, message) {
    this.stream.push('warning', { code, message });
  }

  #handleLine(streamName, raw) {
    const truncated = raw.length > MAX_LINE_BYTES;
    const line = truncated ? raw.subarray(0, MAX_LINE_BYTES).toString('utf8') : raw.toString('utf8');
    if (this.logBytes > this.config.maxLogBytes) return;
    this.logBytes += raw.length;
    if (this.logBytes > this.config.maxLogBytes) {
      if (!this.logLimitWarned) this.#warn('log_limit_reached', 'This job reached its log limit. Further output is discarded.');
      this.logLimitWarned = true;
      return;
    }
    if (streamName === 'stdout' && !truncated && (this.job.kind === 'claude' || this.job.kind === 'codex')) {
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        event = null;
      }
      if (event && typeof event === 'object') {
        this.stream.push('agent', event);
        this.#inspect(event);
        return;
      }
    }
    this.stream.push('log', { stream: streamName, line, ...(truncated ? { truncated: true } : {}) });
  }

  #inspect(event) {
    const parsed = parseAgentLine(this.job.kind, event, this.usage);
    if (parsed.limits) this.stream.push('limits', parsed.limits);
    if (parsed.usage) {
      this.usage = parsed.usage;
      this.stream.push('usage', parsed.usage);
    }
    if (parsed.isError) this.agentError = true;
    const cap = this.job.limits.costCapUsd;
    if (parsed.budgetExceeded || (cap && this.usage?.costUsd > cap)) this.stop('cost_cap');
  }

  #pipe(stream, name) {
    let pending = Buffer.alloc(0);
    stream.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        this.#handleLine(name, pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
      }
      if (pending.length > MAX_LINE_BYTES * 16) {
        this.#handleLine(name, pending);
        pending = Buffer.alloc(0);
      }
    });
    stream.on('end', () => {
      if (pending.length) this.#handleLine(name, pending);
    });
    stream.on('error', () => {});
  }

  async #execute(plan) {
    const { job, dirs } = this;
    if (this.stopReason) return this.#stoppedOutcome();
    if ((job.kind === 'claude' || job.kind === 'codex') && !plan.costCapEnforced) {
      this.#warn('cost_cap_not_enforced', `${plan.name} does not report cost, so the cost cap cannot be enforced. The time limit still applies.`);
    }
    // AI-EMPLOYEE-POWER: a root job runs outside the sandbox (the root helper is the boundary); a direct shell sees the
    // server read-only.
    const wrapped = plan.root ? { cmd: plan.cmd, args: plan.args } : this.isolation.wrap({
      cmd: plan.cmd,
      args: plan.args,
      cwd: dirs.work,
      jobDir: dirs.root,
      privateDir: dirs.private,
      rwBinds: plan.rwBinds,
      hostView: plan.hostView === true,
    });
    this.stream.push('status', { state: 'running' });

    let exit;
    try {
      exit = await new Promise((resolve, reject) => {
      this.child = spawn(wrapped.cmd, wrapped.args, {
        cwd: dirs.work,
        env: plan.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child.once('error', reject);
      this.#pipe(this.child.stdout, 'stdout');
      this.#pipe(this.child.stderr, 'stderr');
      this.child.stdin.on('error', () => {});
      this.child.stdin.end(plan.stdin ?? '');
      this.timeLimit = setTimeout(() => this.stop('timed_out'), job.limits.timeLimitSec * 1000);
      this.child.once('exit', (exitCode, exitSignal) => {
        this.exited = true;
        // Anything the job left running in its process group ends with it.
        this.#signalGroup('SIGKILL');
        const closeWait = setTimeout(() => {
          this.child.stdout.destroy();
          this.child.stderr.destroy();
        }, 2000);
        this.child.once('close', () => {
          clearTimeout(closeWait);
          resolve({ code: exitCode, signal: exitSignal });
        });
      });
      });
    } finally {
      clearTimeout(this.timeLimit);
      clearTimeout(this.killTimer);
    }
    const { code, signal } = exit;

    if (this.stopReason) return { ...this.#stoppedOutcome(), exitCode: code, signal };
    if (code === 0 && !this.agentError) return { status: 'succeeded', exitCode: 0 };
    if (this.agentError) return { status: 'failed', exitCode: code, signal, error: { code: 'agent_error', message: 'The CLI reported an error' } };
    return { status: 'failed', exitCode: code, signal, error: { code: 'nonzero_exit', message: `The process exited with ${code ?? signal}` } };
  }

  #stoppedOutcome() {
    const { status, code, message } = STOP_RESULTS[this.stopReason] ?? STOP_RESULTS.cancelled;
    return { status, error: { code, message } };
  }

  async #uploadOutputs() {
    const outputs = [];
    let error = null;
    const declared = this.job.outputs;
    if (declared.length) this.stream.push('status', { state: 'uploading' });
    for (const { path: relPath, required } of declared) {
      try {
        const { bytes, sha256 } = readOutput(this.dirs.work, relPath, this.config.maxOutputBytes);
        const response = await this.client.upload(this.job.id, relPath, bytes, sha256);
        outputs.push({ path: relPath, bytes: bytes.length, sha256, outputId: response?.outputId ?? null });
      } catch (err) {
        const refused = err instanceof OutputRefused;
        const missing = refused || err.code === 'ELOOP' || err.code === 'ENOENT';
        const message = refused ? err.message : (err.code ?? err.message);
        if (!(refused && err.code === 'missing' && !required)) {
          this.#warn('output_skipped', `${relPath}: ${message}`);
        }
        if (required || !missing) {
          error ??= { code: missing ? 'output_missing' : 'output_upload_failed', message: `${relPath}: ${message}` };
        }
      }
    }
    return { outputs, error: error ? { error } : null };
  }

  #cleanup() {
    try {
      fs.rmSync(this.dirs.root, { recursive: true, force: true });
    } catch (err) {
      this.log('warn', 'could not remove job directory', { jobId: this.job.id, error: err.code });
    }
  }

  #audit(result) {
    try {
      appendAudit(this.paths, {
        ts: result.finishedAt,
        jobId: this.job.id,
        status: result.status,
        errorCode: result.error?.code ?? null,
        startedAt: result.startedAt,
        dryRun: result.dryRun,
        ...result.audit,
      });
    } catch (err) {
      this.log('warn', 'could not write local audit log', { error: err.code });
    }
  }
}
