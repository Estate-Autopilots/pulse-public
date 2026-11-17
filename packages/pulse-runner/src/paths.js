import os from 'node:os';
import path from 'node:path';

export const SERVICE_USER = 'pulse-runner';
export const SERVICE_HOME = '/var/lib/pulse-runner';
export const SERVICE_APP_DIR = '/opt/pulse-runner';
export const SERVICE_UNIT_PATH = '/etc/systemd/system/pulse-runner.service';
export const SERVICE_BIN_LINK = '/usr/local/bin/pulse-runner';

/** Every location the runner uses, derived from a single state directory. */
export function pathsFor(stateDir) {
  const configDir = path.join(stateDir, 'config');
  const authDir = path.join(stateDir, 'auth');
  return {
    stateDir,
    marker: path.join(stateDir, '.pulse-runner-state'),
    configDir,
    configFile: path.join(configDir, 'config.json'),
    credentialFile: path.join(configDir, 'credential.json'),
    auditLog: path.join(configDir, 'audit.log'),
    jobsDir: path.join(stateDir, 'jobs'),
    authDir,
    claudeConfigDir: path.join(authDir, 'claude'),
    codexHome: path.join(authDir, 'codex'),
  };
}

export function resolvePaths({ env = process.env, uid = process.getuid?.() ?? -1, home = os.homedir() } = {}) {
  if (env.PULSE_RUNNER_HOME) return pathsFor(path.resolve(env.PULSE_RUNNER_HOME));
  return pathsFor(uid === 0 ? SERVICE_HOME : path.join(home, '.pulse-runner'));
}

/** Environment that points the AI CLIs at the runner's own login state, separate from any human's. */
export function agentAuthEnv(paths) {
  return { CLAUDE_CONFIG_DIR: paths.claudeConfigDir, CODEX_HOME: paths.codexHome };
}

/** PATH with empty and relative entries removed, so the current directory can never supply a binary. */
export function safePath(value = process.env.PATH ?? '') {
  return value.split(':').filter((p) => p && path.isAbsolute(p)).join(':');
}
