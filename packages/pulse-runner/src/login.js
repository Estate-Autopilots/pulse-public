import os from 'node:os';
import { spawn } from 'node:child_process';
import { agentAuthEnv, safePath } from './paths.js';
import { findOnPath } from './sandbox.js';

// RUNNERS-FULL (6 Nov 2026): "Connect Claude / Connect Codex" from Pulse (PROTOCOL.md §10). Pulse asks for a login; the
// runner starts the CLI's OWN login flow on this server, as the runner's user, with the runner's login folders, and tells
// Pulse only the sign-in link and the short code the CLI prints for a person to open in their own browser. The admin
// finishes the login there with their own subscription. The token the CLI then writes stays in the runner's login folder
// on this server: the runner never reads it, and nothing of it is sent to Pulse.
// Claude Code's flow ends with a one-time authorisation code that the person pastes back; Pulse relays it here once
// ("code"), and it is written to the CLI's stdin. That code is useless without the PKCE verifier only this CLI holds.

export const LOGIN_TOOLS = Object.freeze({
  claude: { login: ['auth', 'login', '--claudeai'], logout: ['auth', 'logout'] },
  codex: { login: ['login', '--device-auth'], logout: ['logout'] },
});
const LOGIN_ID = /^lgn_[0-9a-f]{32}$/;
const LOGIN_MS = 15 * 60_000;
// A terminal hyperlink (OSC 8) or colour code around the link, as Claude prints it under `script`.
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;
const URL_RE = /https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[^\s"'<>\x1b]*/g;
const USER_CODE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/;

/** The sign-in link and the device code a CLI printed so far (or nulls), and whether it waits for a pasted code. */
export function readLoginOutput(text) {
  const clean = String(text).replace(ANSI, '');
  const urls = clean.match(URL_RE) ?? [];
  // The authorisation page: Claude's oauth/authorize, Codex's device page; else the first link it printed.
  const url = urls.find((u) => /oauth\/authorize|\/device|\/activate|codex/i.test(u)) ?? urls[0] ?? null;
  const code = clean.replace(URL_RE, ' ').match(USER_CODE)?.[1] ?? null;
  return { url: url && url.length <= 2048 ? url : null, userCode: code, needsCode: /paste (the )?code/i.test(clean) };
}

/** A pasted authorisation code: one token of printable characters, as the provider's page shows it. */
export function cleanPastedCode(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s.length >= 4 && s.length <= 512 && /^[\x21-\x7e]+$/.test(s) ? s : null;
}

/** Runs the logins Pulse asks for, one per tool at a time. `report(id, body)` posts to /logins/{id}. */
export class LoginManager {
  constructor({ paths, pathValue = process.env.PATH ?? '', report, log = () => {}, onChange = () => {}, timeoutMs = LOGIN_MS }) {
    Object.assign(this, { paths, pathValue, report, log, onChange, timeoutMs });
    this.active = new Map(); // id → { tool, child, timer, sent }
  }

  handle(msg) {
    if (!msg || !LOGIN_ID.test(msg.id ?? '')) return this.log('warn', 'ignored a login message with an invalid id');
    if (msg.action === 'start' || msg.action === 'logout') {
      if (!LOGIN_TOOLS[msg.tool]) return this.#send(msg.id, { state: 'failed', error: { code: 'unknown_tool', message: 'Only claude and codex logins are supported' } });
      return msg.action === 'start' ? this.#start(msg.id, msg.tool) : this.#logout(msg.id, msg.tool);
    }
    if (msg.action === 'code') return this.#code(msg.id, msg.code);
    if (msg.action === 'cancel') return this.#cancel(msg.id);
    return this.log('warn', 'ignored an unknown login action');
  }

  /** Ends every login still open (the runner is stopping). */
  stopAll() {
    for (const id of this.active.keys()) this.#cancel(id, 'runner_shutdown');
  }

  #env() {
    return { PATH: safePath(this.pathValue), HOME: os.homedir(), LANG: 'C.UTF-8', NO_COLOR: '1', TERM: 'dumb', ...agentAuthEnv(this.paths) };
  }

  #send(id, body) {
    return Promise.resolve(this.report(id, body)).catch((err) => this.log('warn', 'could not tell Pulse about a login', { loginId: id, error: err.message }));
  }

  #start(id, tool) {
    if (this.active.has(id)) return undefined;
    for (const [other, l] of this.active) if (l.tool === tool) this.#cancel(other, 'replaced');
    const bin = findOnPath(tool, safePath(this.pathValue));
    if (!bin) return this.#send(id, { state: 'failed', error: { code: 'binary_not_found', message: `${tool} is not installed on this server` } });
    let output = '';
    const entry = { tool, child: null, timer: null, sent: '' };
    this.active.set(id, entry);
    this.#send(id, { state: 'starting' });
    const child = spawn(bin, LOGIN_TOOLS[tool].login, { env: this.#env(), cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'] });
    entry.child = child;
    child.stdin.on('error', () => {});
    const seen = (chunk) => {
      // Only the link and the device code leave this function. Output is kept to 64 KiB.
      output = (output + chunk).slice(-65536);
      const found = readLoginOutput(output);
      const key = `${found.url}|${found.userCode}|${found.needsCode}`;
      if (found.url && key !== entry.sent) {
        entry.sent = key;
        this.#send(id, { state: 'waiting', url: found.url, userCode: found.userCode, needsCode: found.needsCode });
      }
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    entry.timer = setTimeout(() => this.#cancel(id, 'login_timeout'), this.timeoutMs);
    child.once('error', () => { this.#finish(id, { state: 'failed', error: { code: 'login_failed', message: `${tool} login could not start` } }); });
    child.once('exit', (code) => {
      if (!this.active.has(id)) return;
      if (code === 0) this.#finish(id, { state: 'succeeded' });
      else this.#finish(id, { state: 'failed', error: { code: 'login_failed', message: `The ${tool} login did not finish (exit ${code ?? 'signal'}). Try again.` } });
    });
    return undefined;
  }

  #code(id, raw) {
    const entry = this.active.get(id);
    if (!entry?.child) return this.#send(id, { state: 'failed', error: { code: 'login_not_running', message: 'This login is no longer running on the server. Start again.' } });
    const code = cleanPastedCode(raw);
    if (!code) return this.#send(id, { state: 'waiting', url: null, error: { code: 'invalid_code', message: 'That code does not look right. Paste it again.' } });
    entry.child.stdin.write(`${code}\n`);
    return this.#send(id, { state: 'verifying' });
  }

  #cancel(id, why = 'cancelled') {
    const entry = this.active.get(id);
    if (!entry) return this.#send(id, { state: 'cancelled' });
    try { entry.child?.kill('SIGTERM'); } catch { /* already gone */ }
    return this.#finish(id, why === 'login_timeout'
      ? { state: 'failed', error: { code: 'login_timeout', message: 'Nobody finished the login within 15 minutes' } }
      : { state: 'cancelled', ...(why !== 'cancelled' ? { error: { code: why, message: 'The login was stopped on the server' } } : {}) });
  }

  #finish(id, body) {
    const entry = this.active.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.active.delete(id);
    const done = this.#send(id, body);
    if (body.state === 'succeeded') this.onChange(entry.tool);
    return done;
  }

  #logout(id, tool) {
    const bin = findOnPath(tool, safePath(this.pathValue));
    if (!bin) return this.#send(id, { state: 'failed', error: { code: 'binary_not_found', message: `${tool} is not installed on this server` } });
    const child = spawn(bin, LOGIN_TOOLS[tool].logout, { env: this.#env(), cwd: os.homedir(), stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', () => { clearTimeout(timer); this.#send(id, { state: 'failed', error: { code: 'logout_failed', message: `${tool} logout could not start` } }); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      this.#send(id, code === 0 ? { state: 'succeeded' } : { state: 'failed', error: { code: 'logout_failed', message: `${tool} logout did not finish (exit ${code ?? 'signal'})` } });
      this.onChange(tool);
    });
    return undefined;
  }
}
