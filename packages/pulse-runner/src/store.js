import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_CONFIG = Object.freeze({
  apiUrl: 'https://api.vitalsos.ai',
  mcpUrl: 'https://mcp.vitalsos.ai/mcp',
  maxConcurrent: 2,
  // 'bwrap' refuses jobs unless the sandbox passes its self-test. 'none' removes the
  // guarantee that jobs cannot read the credential, so it can only be set by hand here.
  isolation: 'bwrap',
  // RUNNERS-FULL: a job may run outside the sandbox only if this is true here AND Pulse's admin turned the sandbox off
  // for this server (job.access.sandbox false). Set by hand, like isolation.
  allowNoSandbox: false,
  maxProfile: 'shell',
  // AI-EMPLOYEE-POWER: root shell jobs (the owner's grant in Pulse) run only when this is true here, set by hand.
  allowRoot: false,
  pollWaitSec: 25,
  pollMinMs: 1000,
  heartbeatSec: 30,
  capabilitiesSec: 3600,
  graceSec: 5,
  maxTimeLimitSec: 4 * 3600,
  maxOutputBytes: 100 * 1024 * 1024,
  maxLogBytes: 50 * 1024 * 1024,
});

function atomicWrite(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function ensureStateDirs(paths) {
  for (const dir of [paths.stateDir, paths.configDir, paths.jobsDir, paths.authDir, paths.claudeConfigDir, paths.codexHome]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(paths.stateDir, 0o700);
  fs.chmodSync(paths.configDir, 0o700);
  if (!fs.existsSync(paths.marker)) fs.writeFileSync(paths.marker, 'pulse-runner state directory\n', { mode: 0o600 });
}

export function loadConfig(paths) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read ${paths.configFile}: ${err.message}`);
  }
  return { ...DEFAULT_CONFIG, ...saved };
}

/** Saves only the settings that differ from the defaults, so future default changes still apply. */
export function saveConfig(paths, config) {
  const toSave = {};
  for (const [key, value] of Object.entries(config)) {
    if (DEFAULT_CONFIG[key] !== value) toSave[key] = value;
  }
  atomicWrite(paths.configFile, `${JSON.stringify(toSave, null, 2)}\n`, 0o600);
}

export function saveCredential(paths, record) {
  atomicWrite(paths.credentialFile, `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

/** Returns the credential record, or null if not paired. Refuses a file others could read. */
export function loadCredential(paths) {
  let stat;
  try {
    stat = fs.statSync(paths.credentialFile);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (stat.mode & 0o077) {
    throw new Error(`Refusing to use ${paths.credentialFile}: it must have mode 0600. Fix it with chmod 600.`);
  }
  return JSON.parse(fs.readFileSync(paths.credentialFile, 'utf8'));
}

export function deleteCredential(paths) {
  fs.rmSync(paths.credentialFile, { force: true });
}

const AUDIT_MAX_BYTES = 10 * 1024 * 1024;

/** Local audit trail for the server's owner. Holds metadata only, never prompts or tokens. */
export function appendAudit(paths, entry) {
  try {
    if (fs.statSync(paths.auditLog).size > AUDIT_MAX_BYTES) fs.renameSync(paths.auditLog, `${paths.auditLog}.1`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.appendFileSync(paths.auditLog, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
