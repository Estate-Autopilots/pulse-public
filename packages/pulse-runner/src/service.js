import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SERVICE_APP_DIR, SERVICE_BIN_LINK, SERVICE_HOME, SERVICE_UNIT_PATH, SERVICE_USER,
  pathsFor,
} from './paths.js';
import { EXIT_REVOKED } from './daemon.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_ITEMS = ['bin', 'src', 'scripts', 'package.json', 'LICENSE', 'README.md', 'PROTOCOL.md'];

export function renderUnit({ nodePath, appDir = SERVICE_APP_DIR, stateDir = SERVICE_HOME, user = SERVICE_USER }) {
  const pathDirs = [...new Set([path.dirname(nodePath), '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'])];
  return `[Unit]
Description=Pulse Runner (connects this server to Pulse, outbound only)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=${user}
Group=${user}
Environment=PULSE_RUNNER_HOME=${stateDir}
Environment=HOME=${stateDir}
Environment=PATH=${pathDirs.join(':')}
WorkingDirectory=${stateDir}
ExecStart=${nodePath} ${appDir}/bin/pulse-runner.js run
Restart=always
RestartSec=5
# Exit code ${EXIT_REVOKED} means revoked in Pulse. Restarting could not help.
RestartPreventExitStatus=${EXIT_REVOKED}
TimeoutStopSec=30
KillMode=control-group

# Log limits
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pulse-runner
LogRateLimitIntervalSec=30s
LogRateLimitBurst=2000

# Hardening. Namespaces stay allowed because bubblewrap needs them to sandbox jobs.
# ProtectKernelTunables, ProtectKernelLogs and ProtectProc are left out on purpose: they
# overmount /proc, and the kernel then refuses the fresh /proc mount bubblewrap makes.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=${stateDir}
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

/** Install steps as data, so they can be printed by --dry-run and tested without root. */
export function installPlan({ nodePath, packageRoot = PACKAGE_ROOT, userExists = false, importFrom = null }) {
  const statePaths = pathsFor(SERVICE_HOME);
  const steps = [];
  if (!userExists) {
    steps.push({ type: 'run', cmd: 'useradd', args: ['--system', '--user-group', '--home-dir', SERVICE_HOME, '--shell', '/usr/sbin/nologin', SERVICE_USER] });
  }
  steps.push({ type: 'run', cmd: 'install', args: ['-d', '-m', '0700', '-o', SERVICE_USER, '-g', SERVICE_USER, SERVICE_HOME] });
  // When run from the installed copy, deleting the app directory would delete this program.
  if (path.resolve(packageRoot) !== SERVICE_APP_DIR) {
    steps.push({ type: 'run', cmd: 'rm', args: ['-rf', SERVICE_APP_DIR] });
    steps.push({ type: 'run', cmd: 'install', args: ['-d', '-m', '0755', SERVICE_APP_DIR] });
    for (const item of APP_ITEMS) {
      steps.push({ type: 'copy-if-exists', from: path.join(packageRoot, item), to: path.join(SERVICE_APP_DIR, item) });
    }
  }
  steps.push({ type: 'run', cmd: 'chmod', args: ['-R', 'a+rX', SERVICE_APP_DIR] });
  steps.push({ type: 'run', cmd: 'ln', args: ['-sf', `${SERVICE_APP_DIR}/bin/pulse-runner.js`, SERVICE_BIN_LINK] });
  steps.push({ type: 'run', cmd: 'chmod', args: ['0755', `${SERVICE_APP_DIR}/bin/pulse-runner.js`] });
  if (importFrom) steps.push({ type: 'import-state', from: importFrom, to: statePaths });
  steps.push({ type: 'init-state', paths: statePaths });
  steps.push({ type: 'run', cmd: 'chown', args: ['-R', `${SERVICE_USER}:${SERVICE_USER}`, SERVICE_HOME] });
  steps.push({ type: 'write', path: SERVICE_UNIT_PATH, content: renderUnit({ nodePath }), mode: 0o644 });
  steps.push({ type: 'run', cmd: 'systemctl', args: ['daemon-reload'] });
  steps.push({ type: 'run', cmd: 'systemctl', args: ['enable', '--now', 'pulse-runner.service'] });
  return steps;
}

export function uninstallPlan({ userExists = true } = {}) {
  const steps = [
    { type: 'run', cmd: 'systemctl', args: ['disable', '--now', 'pulse-runner.service'], allowFailure: true },
    { type: 'run', cmd: 'rm', args: ['-f', SERVICE_UNIT_PATH] },
    { type: 'run', cmd: 'systemctl', args: ['daemon-reload'], allowFailure: true },
    { type: 'run', cmd: 'rm', args: ['-rf', SERVICE_APP_DIR, SERVICE_HOME] },
    { type: 'run', cmd: 'rm', args: ['-f', SERVICE_BIN_LINK] },
  ];
  if (userExists) steps.push({ type: 'run', cmd: 'userdel', args: [SERVICE_USER], allowFailure: true });
  return steps;
}

export function describeStep(step) {
  switch (step.type) {
    case 'run': return `${step.cmd} ${step.args.join(' ')}`;
    case 'write': return `write ${step.path} (mode ${step.mode.toString(8)})`;
    case 'copy-if-exists': return `copy ${step.from} to ${step.to}`;
    case 'import-state': return `move the existing pairing from ${step.from.stateDir} to ${step.to.stateDir}`;
    case 'init-state': return `create state directories under ${step.paths.stateDir}`;
    default: return step.type;
  }
}

function importState(from, to, ensureDirs) {
  ensureDirs(to);
  for (const name of ['configFile', 'credentialFile']) {
    if (fs.existsSync(from[name])) fs.copyFileSync(from[name], to[name]);
  }
  fs.chmodSync(to.credentialFile, 0o600);
  // Only one copy of the credential should exist.
  fs.rmSync(from.credentialFile, { force: true });
}

export function executePlan(steps, { ensureDirs, run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' }) }) {
  for (const step of steps) {
    try {
      switch (step.type) {
        case 'run': run(step.cmd, step.args); break;
        case 'write': fs.writeFileSync(step.path, step.content, { mode: step.mode }); break;
        case 'copy-if-exists':
          if (fs.existsSync(step.from)) fs.cpSync(step.from, step.to, { recursive: true });
          break;
        case 'import-state': importState(step.from, step.to, ensureDirs); break;
        case 'init-state': ensureDirs(step.paths); break;
        default: throw new Error(`Unknown step ${step.type}`);
      }
    } catch (err) {
      if (!step.allowFailure) throw new Error(`Step failed: ${describeStep(step)}: ${err.message}`);
    }
  }
}

export function userExists(name = SERVICE_USER) {
  try {
    execFileSync('id', ['-u', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A service user cannot run a node that lives in somebody's home directory. */
export function checkNodePath(nodePath) {
  if (/^\/(home|root)(\/|$)/.test(nodePath)) {
    throw new Error(`Node is at ${nodePath}, which the ${SERVICE_USER} user cannot reach. Install Node.js system-wide (for example under /usr/local) and run this again.`);
  }
}

/** When run with sudo, finds a pairing made earlier by the invoking user. */
export function findUserPairing(env = process.env) {
  const sudoUser = env.SUDO_USER;
  if (!sudoUser || !/^[a-z_][a-z0-9_.-]*$/i.test(sudoUser)) return null;
  try {
    const entry = execFileSync('getent', ['passwd', sudoUser], { encoding: 'utf8' });
    const home = entry.split(':')[5];
    if (!home) return null;
    const candidate = pathsFor(path.join(home, '.pulse-runner'));
    return fs.existsSync(candidate.credentialFile) ? candidate : null;
  } catch {
    return null;
  }
}
