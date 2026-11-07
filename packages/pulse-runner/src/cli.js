import os from 'node:os';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SERVICE_HOME, SERVICE_UNIT_PATH, SERVICE_USER, agentAuthEnv, pathsFor, resolvePaths, safePath } from './paths.js';
import { deleteCredential, ensureStateDirs, loadConfig, loadCredential, saveConfig, saveCredential } from './store.js';
import { PulseClient, assertSafeApiUrl } from './http.js';
import { collectCapabilities } from './capabilities.js';
import { Isolation, findOnPath } from './sandbox.js';
import { Daemon, EXIT_REVOKED } from './daemon.js';
import { VERSION } from './version.js';
import {
  checkNodePath, describeStep, executePlan, findUserPairing, installPlan, uninstallPlan, userExists,
} from './service.js';

const SELF = fileURLToPath(new URL('../bin/pulse-runner.js', import.meta.url));

const HELP = `pulse-runner ${VERSION}: connect this server and its AI subscriptions to Pulse

Usage:
  pulse-runner connect --code ABCD-1234    Pair with Pulse (as root: also installs the service)
  pulse-runner run                         Run in the foreground
  pulse-runner status                      Show pairing and capabilities
  pulse-runner report                      Send a capability report to Pulse now
  pulse-runner login claude|codex          Run the official login for the runner
  pulse-runner install-service [--dry-run] Install the systemd service (needs root)
  pulse-runner uninstall [--dry-run]       Remove the service, user, data and pairing
  pulse-runner version

Options:
  --force          connect: replace an existing pairing
  --api-url URL    connect: use a different Pulse API
`;

const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const isRoot = () => process.getuid?.() === 0;

function fail(message, code = 1) {
  process.stderr.write(`Error: ${message}\n`);
  return code;
}

async function pair(paths, values) {
  const code = String(values.code ?? '').trim().toUpperCase();
  if (!CODE_RE.test(code)) throw new Error('A pairing code looks like ABCD-1234. Get one from Pulse: Settings, Servers & AI, Connect a server.');
  if (loadCredential(paths) && !values.force) throw new Error('This server is already paired. Use --force to replace the pairing.');
  const config = loadConfig(paths);
  const apiUrl = values['api-url'] ?? process.env.PULSE_API_URL ?? config.apiUrl;
  assertSafeApiUrl(apiUrl);
  const client = new PulseClient({ apiUrl });
  const response = await client.pair(code, { hostname: os.hostname(), os: process.platform, arch: process.arch, version: VERSION });
  if (!response?.credential || !response.runnerId || !response.orgId) throw new Error('Pulse returned an incomplete pairing response.');
  return { response, config: { ...config, apiUrl } };
}

function storePairing(paths, { response, config }) {
  ensureStateDirs(paths);
  saveConfig(paths, config);
  saveCredential(paths, {
    runnerId: response.runnerId,
    orgId: response.orgId,
    orgName: response.orgName ?? null,
    credential: response.credential,
    pairedAt: new Date().toISOString(),
  });
}

function bubblewrapHint() {
  if (findOnPath('bwrap')) return '';
  return '\nWarning: bubblewrap is not installed, so this server will reject every job. Install it, for example: apt-get install bubblewrap\n';
}

async function cmdConnect(values) {
  const paths = resolvePaths();
  if (isRoot()) {
    checkNodePath(process.execPath);
    const pairing = await pair(paths, values);
    const steps = installPlan({ nodePath: process.execPath, userExists: userExists() }).filter((s) => !(s.type === 'run' && s.cmd === 'systemctl' && s.args[0] === 'enable'));
    executePlan(steps, { ensureDirs: ensureStateDirs });
    storePairing(paths, pairing);
    spawnSync('chown', ['-R', `${SERVICE_USER}:${SERVICE_USER}`, paths.stateDir], { stdio: 'inherit' });
    spawnSync('systemctl', ['enable', 'pulse-runner.service'], { stdio: 'inherit' });
    // Restart, not start: a running service must pick up a replaced pairing.
    const started = spawnSync('systemctl', ['restart', 'pulse-runner.service'], { stdio: 'inherit' });
    if (started.status !== 0) throw new Error('Paired, but the service did not start. See: journalctl -u pulse-runner');
    process.stdout.write(`Connected to ${pairing.response.orgName ?? pairing.response.orgId} as ${pairing.response.runnerId}. The pulse-runner service is running.\nNext: pulse-runner login claude\n${bubblewrapHint()}`);
    return 0;
  }
  const pairing = await pair(paths, values);
  storePairing(paths, pairing);
  process.stdout.write(`Connected to ${pairing.response.orgName ?? pairing.response.orgId} as ${pairing.response.runnerId}.\nThe credential is stored in ${paths.credentialFile} (mode 0600).\nNext: run "sudo pulse-runner install-service" to run as a service, or "pulse-runner run" for the foreground.\n${bubblewrapHint()}`);
  return 0;
}

async function cmdRun() {
  process.umask(0o077);
  const paths = resolvePaths();
  const credential = loadCredential(paths);
  if (!credential) return fail('This server is not paired. Run: pulse-runner connect --code ABCD-1234', EXIT_REVOKED);
  ensureStateDirs(paths);
  const daemon = new Daemon({ paths, config: loadConfig(paths), credential });
  process.on('SIGTERM', () => daemon.shutdown());
  process.on('SIGINT', () => daemon.shutdown());
  return daemon.run();
}

async function buildReport(paths, config) {
  const isolation = new Isolation({ mode: config.isolation, paths });
  const isolationStatus = await isolation.probe();
  return collectCapabilities({ paths, config, isolationStatus });
}

async function cmdStatus() {
  const paths = resolvePaths();
  const credential = loadCredential(paths);
  const config = loadConfig(paths);
  const report = await buildReport(paths, config);
  // Prints chosen fields only. The credential is never one of them.
  process.stdout.write(`${JSON.stringify({
    paired: Boolean(credential),
    runnerId: credential?.runnerId ?? null,
    orgId: credential?.orgId ?? null,
    orgName: credential?.orgName ?? null,
    apiUrl: config.apiUrl,
    stateDir: paths.stateDir,
    ai: report.ai,
    tools: report.tools,
    isolation: report.isolation,
    limits: report.limits,
  }, null, 2)}\n`);
  return 0;
}

async function cmdReport() {
  const paths = resolvePaths();
  const credential = loadCredential(paths);
  if (!credential) return fail('This server is not paired.', EXIT_REVOKED);
  const config = loadConfig(paths);
  const client = new PulseClient({ apiUrl: config.apiUrl, credential: credential.credential, onRevoked: () => deleteCredential(paths) });
  await client.capabilities(await buildReport(paths, config));
  process.stdout.write('Capabilities sent to Pulse.\n');
  return 0;
}

/** Runs a command as the service user when root is managing an installed service. */
function asRunner(paths, cmd, args, extraEnv) {
  const env = { PATH: safePath(), HOME: paths.stateDir, PULSE_RUNNER_HOME: paths.stateDir, TERM: process.env.TERM ?? 'dumb', LANG: process.env.LANG ?? 'C.UTF-8', ...extraEnv };
  if (isRoot() && paths.stateDir === SERVICE_HOME && userExists()) {
    const pairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    return spawnSync('runuser', ['-u', SERVICE_USER, '--', 'env', ...pairs, cmd, ...args], { stdio: 'inherit' });
  }
  return spawnSync(cmd, args, { stdio: 'inherit', env: { ...env, HOME: process.env.HOME } });
}

const LOGIN_COMMANDS = {
  claude: ['auth', 'login'],
  codex: ['login', '--device-auth'],
};

async function cmdLogin(tool) {
  const args = LOGIN_COMMANDS[tool];
  if (!args) return fail('Usage: pulse-runner login claude|codex', 2);
  const binary = findOnPath(tool, safePath());
  if (!binary) return fail(`${tool} is not installed. Install it system-wide, then run this again.`);
  const paths = resolvePaths();
  if (!isRoot()) ensureStateDirs(paths);
  const login = asRunner(paths, binary, args, agentAuthEnv(paths));
  if (login.status !== 0) return fail(`${tool} login did not complete.`);
  const credential = loadCredential(paths);
  if (credential) {
    const report = asRunner(paths, process.execPath, [SELF, 'report'], {});
    if (report.status !== 0) process.stderr.write('Warning: login worked, but Pulse could not be told yet. The runner will report it within the hour.\n');
  }
  return 0;
}

function cmdInstallService(values) {
  const dryRun = values['dry-run'] === true;
  // Root first: without it nothing can be installed, whatever else is wrong.
  if (!dryRun && !isRoot()) return fail('install-service needs root. Run it with sudo, or use --dry-run to see what it would do.');
  const importFrom = findUserPairing();
  let nodeNote = '';
  try {
    checkNodePath(process.execPath);
  } catch (err) {
    if (!dryRun) throw err;
    nodeNote = `Note: ${err.message}\n`; // a dry run shows the plan, and what would stop it
  }
  const steps = installPlan({ nodePath: process.execPath, userExists: userExists(), importFrom });
  if (dryRun) {
    process.stdout.write(`${steps.map(describeStep).join('\n')}\n${nodeNote}`);
    return 0;
  }
  executePlan(steps, { ensureDirs: ensureStateDirs });
  process.stdout.write(`The pulse-runner service is installed and started.\nLogs: journalctl -u pulse-runner -f\n${bubblewrapHint()}`);
  return 0;
}

/** Without the marker file this is not our directory, whatever PULSE_RUNNER_HOME says. */
function removeUserState(paths) {
  if (!fs.existsSync(paths.marker)) return false;
  fs.rmSync(paths.stateDir, { recursive: true, force: true });
  return true;
}

async function tellPulseGoodbye(paths) {
  const credential = loadCredential(paths);
  if (!credential) return;
  const config = loadConfig(paths);
  try {
    await new PulseClient({ apiUrl: config.apiUrl, credential: credential.credential }).deregister();
  } catch {
    process.stderr.write('Warning: could not reach Pulse. Revoke this server in Pulse: Settings, Servers & AI.\n');
  }
}

async function cmdUninstall(values) {
  const dryRun = values['dry-run'] === true;
  const paths = resolvePaths();
  if (isRoot() || paths.stateDir === SERVICE_HOME) {
    const steps = uninstallPlan({ userExists: userExists() });
    if (dryRun) {
      process.stdout.write(`${steps.map(describeStep).join('\n')}\n`);
      return 0;
    }
    if (!isRoot()) return fail('Removing the service needs root. Run it with sudo.');
    await tellPulseGoodbye(pathsFor(SERVICE_HOME));
    executePlan(steps, { ensureDirs: ensureStateDirs });
    process.stdout.write('pulse-runner has been removed.\n');
    return 0;
  }
  if (fs.existsSync(SERVICE_UNIT_PATH)) process.stderr.write('Note: the system service is installed. Removing it needs: sudo pulse-runner uninstall\n');
  if (dryRun) {
    process.stdout.write(`remove ${paths.stateDir}\n`);
    return 0;
  }
  await tellPulseGoodbye(paths);
  if (!removeUserState(paths)) process.stdout.write(`Nothing to remove at ${paths.stateDir}.\n`);
  else process.stdout.write('pulse-runner has been removed.\n');
  return 0;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        code: { type: 'string' },
        force: { type: 'boolean' },
        'api-url': { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    });
  } catch (err) {
    return fail(err.message, 2);
  }
  const { values, positionals } = parsed;
  try {
    switch (command) {
      case 'connect': return await cmdConnect(values);
      case 'run': return await cmdRun();
      case 'status': return await cmdStatus();
      case 'report': return await cmdReport();
      case 'login': return await cmdLogin(positionals[0]);
      case 'install-service': return cmdInstallService(values);
      case 'uninstall': return await cmdUninstall(values);
      case 'version': case '--version': case '-v':
        process.stdout.write(`${VERSION}\n`);
        return 0;
      case 'help': case '--help': case '-h': case undefined:
        process.stdout.write(HELP);
        return 0;
      default:
        process.stderr.write(HELP);
        return 2;
    }
  } catch (err) {
    return fail(err.message);
  }
}
