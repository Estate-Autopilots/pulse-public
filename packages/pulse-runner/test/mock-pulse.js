import http from 'node:http';
import crypto from 'node:crypto';

const PREFIX = '/runner/v1';

/** The Pulse side of PROTOCOL.md, in memory, for tests. Rejects anything off-contract. */
export class MockPulse {
  constructor() {
    this.codes = new Map();
    this.runners = new Map();
    this.queue = [];
    this.cancels = [];
    this.heartbeats = [];
    this.capabilities = [];
    this.polls = [];
    this.acks = [];
    this.events = new Map();
    this.results = new Map();
    this.uploads = new Map();
    this.deregistered = [];
    this.violations = [];
    this.requests = [];
    this.cancelOnEvents = new Set();
    this.goneJobs = new Set();
    this.goneHits = 0;
    this.waiters = new Set();
    this.heldPolls = new Set();
    this.loginQueue = [];
    this.loginReports = new Map();
    this.server = http.createServer((req, res) => this.#handle(req, res));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  async stop() {
    for (const release of this.heldPolls) release();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  issueCode({ code = 'ABCD-1234', orgId = 'org_test', expiresInMs = 600_000 } = {}) {
    this.codes.set(code, { orgId, expiresAt: Date.now() + expiresInMs, used: false });
    return code;
  }

  enqueue(...jobs) {
    this.queue.push(...jobs);
    this.#wakePolls();
  }

  /** PROTOCOL.md §10: a login message for the next poll ({ id, tool, action, code? }). */
  sendLogin(message) {
    this.loginQueue.push(message);
    this.#wakePolls();
  }

  loginsOf(id) {
    return this.loginReports.get(id) ?? [];
  }

  cancel(id) {
    this.cancels.push(id);
    this.#wakePolls();
  }

  revokeAll() {
    for (const runner of this.runners.values()) runner.revoked = true;
    this.#wakePolls();
  }

  #wakePolls() {
    for (const release of [...this.heldPolls]) release();
    this.#notify();
  }

  #notify() {
    for (const check of this.waiters) check();
  }

  /** Waits until predicate returns something truthy, re-checking on every request. */
  waitFor(predicate, { timeoutMs = 15_000, label = 'condition' } = {}) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const value = predicate();
        if (value) {
          this.waiters.delete(check);
          clearTimeout(timer);
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  waitForResult(id, options) {
    return this.waitFor(() => this.results.get(id), { label: `result of ${id}`, ...options });
  }

  eventsOf(id) {
    return this.events.get(id) ?? [];
  }

  #send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    this.#notify();
  }

  #error(res, status, code, message = code) {
    this.#send(res, status, { error: { code, message } });
  }

  #violation(res, message) {
    this.violations.push(message);
    this.#error(res, 400, 'invalid_request', message);
  }

  async #handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://mock');
    const route = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : null;
    this.requests.push({ method: req.method, route, authorization: req.headers.authorization, raw: raw.toString('latin1') });
    if (route === null) return this.#error(res, 404, 'not_found');

    if (req.method === 'PUT') {
      const auth = this.#auth(req, res);
      if (!auth) return undefined;
      return this.#upload(req, res, route, url, raw);
    }
    let body;
    try {
      body = raw.length ? JSON.parse(raw) : {};
    } catch {
      return this.#violation(res, `${route}: body is not JSON`);
    }
    if (route === '/pair' && req.method === 'POST') return this.#pair(res, body);
    const runner = this.#auth(req, res);
    if (!runner) return undefined;

    if (route === '/heartbeat') {
      if (!Array.isArray(body.runningJobs) || !['ready', 'draining'].includes(body.status)) return this.#violation(res, 'heartbeat shape');
      this.heartbeats.push(body);
      return this.#send(res, 200, { ok: true, serverTime: new Date().toISOString() });
    }
    if (route === '/capabilities') {
      if (!body.system || !body.ai || !body.tools || !body.isolation) return this.#violation(res, 'capabilities shape');
      this.capabilities.push(body);
      return this.#send(res, 200, { ok: true });
    }
    if (route === '/deregister') {
      this.deregistered.push(runner.runnerId);
      runner.revoked = true;
      return this.#send(res, 200, { ok: true });
    }
    if (route === '/poll') return this.#poll(res, body, runner);
    const login = route.match(/^\/logins\/(lgn_[0-9a-f]{32})$/);
    if (login) {
      const states = ['starting', 'waiting', 'verifying', 'succeeded', 'failed', 'cancelled'];
      if (!states.includes(body.state)) return this.#violation(res, `login shape: ${body.state}`);
      if (body.url !== undefined && body.url !== null && !/^https:\/\//.test(body.url)) return this.#violation(res, 'login url');
      const list = this.loginReports.get(login[1]) ?? [];
      list.push(body);
      this.loginReports.set(login[1], list);
      return this.#send(res, 200, { ok: true });
    }

    const match = route.match(/^\/jobs\/([^/]+)\/(ack|events|result)$/);
    if (!match) return this.#error(res, 404, 'not_found');
    const [, id, action] = match;
    if (action === 'ack') {
      this.acks.push(id);
      return this.#send(res, 200, { ok: true });
    }
    if (action === 'events') {
      if (this.goneJobs.has(id)) {
        this.goneHits += 1;
        return this.#error(res, 409, 'job_not_active');
      }
      if (!Array.isArray(body.events)) return this.#violation(res, 'events shape');
      const list = this.events.get(id) ?? [];
      for (const event of body.events) {
        if (!Number.isInteger(event.seq) || !event.ts || !event.type) return this.#violation(res, 'event shape');
        if (!list.some((e) => e.seq === event.seq)) list.push(event);
      }
      this.events.set(id, list);
      return this.#send(res, 200, { ok: true, cancel: this.cancelOnEvents.has(id) });
    }
    if (!['succeeded', 'failed', 'timed_out', 'cancelled', 'rejected'].includes(body.status) || !body.audit) {
      return this.#violation(res, `result shape: ${body.status}`);
    }
    if (this.goneJobs.has(id)) return this.#error(res, 409, 'job_not_active');
    this.results.set(id, body);
    return this.#send(res, 200, { ok: true });
  }

  #pair(res, body) {
    if (typeof body.code !== 'string' || !body.runner?.version) return this.#violation(res, 'pair shape');
    const entry = this.codes.get(body.code);
    if (!entry) return this.#error(res, 404, 'invalid_code', 'That code is not valid.');
    if (entry.used) return this.#error(res, 409, 'code_used', 'That code was already used.');
    if (entry.expiresAt < Date.now()) return this.#error(res, 410, 'expired_code', 'That code has expired.');
    entry.used = true;
    const credential = `prc_${crypto.randomBytes(24).toString('hex')}`;
    const runnerId = `run_${this.runners.size + 1}`;
    this.runners.set(credential, { runnerId, orgId: entry.orgId, revoked: false });
    this.lastCredential = credential;
    return this.#send(res, 200, { runnerId, orgId: entry.orgId, orgName: 'Test Org', credential });
  }

  #auth(req, res) {
    const header = req.headers.authorization ?? '';
    const runner = this.runners.get(header.replace(/^Bearer /, ''));
    if (!runner) {
      this.#error(res, 401, 'invalid_credential');
      return null;
    }
    if (runner.revoked) {
      this.#error(res, 401, 'runner_revoked', 'This runner was revoked in Pulse.');
      return null;
    }
    return runner;
  }

  #poll(res, body, runner) {
    if (!Number.isInteger(body.waitSec) || !Number.isInteger(body.slots) || !Array.isArray(body.runningJobs)) {
      return this.#violation(res, 'poll shape');
    }
    this.polls.push(body);
    const answer = () => {
      if (runner.revoked) return this.#error(res, 401, 'runner_revoked');
      const jobs = this.queue.splice(0, this.overDeliver ? this.queue.length : body.slots);
      const cancel = this.cancels.splice(0, this.cancels.length);
      const logins = this.loginQueue.splice(0, this.loginQueue.length);
      return this.#send(res, 200, { jobs, cancel, ...(logins.length ? { logins } : {}) });
    };
    const hasWork = (this.queue.length > 0 && body.slots > 0) || this.cancels.length > 0 || this.loginQueue.length > 0;
    if (hasWork) return answer();
    let release;
    const timer = setTimeout(() => release(), Math.min(body.waitSec * 1000, 1000));
    release = () => {
      clearTimeout(timer);
      this.heldPolls.delete(release);
      answer();
    };
    this.heldPolls.add(release);
    return undefined;
  }

  #upload(req, res, route, url, raw) {
    const match = route.match(/^\/jobs\/([^/]+)\/outputs$/);
    const relPath = url.searchParams.get('path');
    if (!match || !relPath) return this.#violation(res, 'upload route');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    if (hash !== req.headers['x-content-sha256']) return this.#violation(res, 'upload hash mismatch');
    const files = this.uploads.get(match[1]) ?? new Map();
    files.set(relPath, raw);
    this.uploads.set(match[1], files);
    return this.#send(res, 201, { outputId: `out_${files.size}` });
  }
}

export function makeJob(overrides = {}) {
  return {
    id: `job_${crypto.randomBytes(4).toString('hex')}`,
    orgId: 'org_test',
    kind: 'claude',
    prompt: 'Say hello',
    profile: 'read-only',
    limits: { timeLimitSec: 30, costCapUsd: 1 },
    outputs: [],
    mcp: { url: 'https://mcp.vitalsos.ai/mcp', token: `pmt_${crypto.randomBytes(12).toString('hex')}`, expiresAt: new Date(Date.now() + 600_000).toISOString() },
    requestedBy: { type: 'user', id: 'usr_1', name: 'Test Admin' },
    ...overrides,
  };
}
