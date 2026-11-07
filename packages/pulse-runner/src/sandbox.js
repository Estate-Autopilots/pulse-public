import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function findOnPath(name, pathValue = process.env.PATH ?? '') {
  for (const dir of pathValue.split(':')) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next directory.
    }
  }
  return null;
}

/** The only parts of the host a job can see, on top of its own directories. */
const SYSTEM_RO_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64'];
const ETC_RO_PATHS = [
  '/etc/resolv.conf', '/etc/hosts', '/etc/host.conf', '/etc/nsswitch.conf', '/etc/gai.conf',
  '/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/passwd', '/etc/group', '/etc/localtime',
  '/etc/alternatives', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d',
];

const contains = (parent, child) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

/** Directories a program needs when it lives outside /usr. Refuses to expose the runner's state. */
export function programBinds(cmd, paths) {
  const dirs = new Set();
  for (const file of [cmd, process.execPath]) {
    let real;
    try {
      real = fs.realpathSync(file);
    } catch {
      continue;
    }
    const dir = path.dirname(real);
    if (contains('/usr', dir) || contains('/bin', dir)) continue;
    if (contains(dir, paths.stateDir) || contains(paths.stateDir, dir)) {
      throw new Error(`Cannot expose ${dir} to a job: it overlaps the runner's state directory.`);
    }
    dirs.add(dir);
  }
  return [...dirs];
}

export function buildBwrapArgs({ cwd, jobDir, privateDir = null, rwBinds = [], roBinds = [], hostView = null }) {
  const args = [
    '--die-with-parent', '--new-session',
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--cap-drop', 'ALL',
  ];
  if (hostView) {
    // AI-EMPLOYEE-POWER: a direct shell sees the whole server read-only, except the runner's state (its credential and
    // the CLI logins) and its user's home, which are replaced by empty folders.
    args.push('--ro-bind', '/', '/');
    for (const p of hostView.hide ?? []) args.push('--tmpfs', p);
  } else {
    for (const p of [...SYSTEM_RO_DIRS, ...ETC_RO_PATHS]) args.push('--ro-bind-try', p, p);
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/run');
  // /etc/resolv.conf is often a symlink into here.
  args.push('--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve');
  for (const p of roBinds) args.push('--ro-bind', p, p);
  for (const p of rwBinds) args.push('--bind', p, p);
  args.push('--bind', jobDir, jobDir);
  if (privateDir) args.push('--ro-bind', privateDir, privateDir);
  args.push('--chdir', cwd);
  return args;
}

const PROBE_SCRIPT = 'if [ -e "$1" ] || [ -e "$2" ]; then echo PROBE_EXPOSED; else echo PROBE_OK; fi';

/**
 * Runs jobs inside a sandbox where the runner's config directory (with the credential)
 * does not exist. Jobs run as the same uid as the runner, so file permissions cannot
 * protect the credential: the mount namespace is what does.
 */
export class Isolation {
  constructor({ mode, paths, pathValue = process.env.PATH ?? '' }) {
    this.mode = mode;
    this.paths = paths;
    this.pathValue = pathValue;
    this.status = null;
  }

  get bwrapPath() {
    return findOnPath('bwrap', this.pathValue);
  }

  wrap({ cmd, args, cwd, jobDir, privateDir, rwBinds = [], hostView = false }) {
    if (this.mode === 'none') return { cmd, args };
    const bwrap = this.bwrapPath;
    if (!bwrap) throw new Error('bwrap is not installed');
    if (hostView) {
      const home = process.env.HOME && path.isAbsolute(process.env.HOME) ? process.env.HOME : null;
      const hide = [...new Set([this.paths.stateDir, home].filter(Boolean))];
      return { cmd: bwrap, args: [...buildBwrapArgs({ cwd, jobDir, privateDir, rwBinds, hostView: { hide } }), '--', cmd, ...args] };
    }
    const roBinds = programBinds(cmd, this.paths);
    // RUNNERS-FULL: a CLI reached through a symlink outside /usr (Claude Code's ~/.local/bin/claude → its versions folder)
    // runs by its real path: only the real file's folder is bound into the sandbox, so the link itself is not there.
    let inside = cmd;
    try { inside = fs.realpathSync(cmd); } catch { /* keep the given path */ }
    return { cmd: bwrap, args: [...buildBwrapArgs({ cwd, jobDir, privateDir, rwBinds, roBinds }), '--', inside, ...args] };
  }

  /** Proves the sandbox hides the credential by trying to see it from inside. */
  async probe() {
    if (this.mode === 'none') {
      this.status = { mode: 'none', available: true, verified: false, reason: 'isolation is turned off in the local config' };
      return this.status;
    }
    if (this.mode !== 'bwrap') {
      this.status = { mode: this.mode, available: false, verified: false, reason: 'unknown isolation mode in the local config' };
      return this.status;
    }
    if (!this.bwrapPath) {
      this.status = { mode: 'bwrap', available: false, verified: false, reason: 'bubblewrap (bwrap) is not installed' };
      return this.status;
    }
    const probeDir = path.join(this.paths.jobsDir, `.probe-${process.pid}`);
    fs.mkdirSync(probeDir, { recursive: true, mode: 0o700 });
    try {
      const wrapped = this.wrap({
        cmd: '/bin/sh',
        args: ['-c', PROBE_SCRIPT, 'pulse-probe', this.paths.configDir, this.paths.credentialFile],
        cwd: probeDir,
        jobDir: probeDir,
      });
      const { code, stdout } = await runForOutput(wrapped.cmd, wrapped.args, { cwd: probeDir });
      if (stdout.trim() === 'PROBE_OK') {
        this.status = { mode: 'bwrap', available: true, verified: true, reason: null };
      } else if (stdout.includes('PROBE_EXPOSED')) {
        this.status = { mode: 'bwrap', available: true, verified: false, reason: 'the sandbox self-test could see the credential' };
      } else {
        this.status = { mode: 'bwrap', available: true, verified: false, reason: `bwrap could not start a sandbox (exit ${code}); see the Troubleshooting section of the README` };
      }
    } catch (err) {
      this.status = { mode: 'bwrap', available: true, verified: false, reason: err.message };
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
    return this.status;
  }

  /** Jobs may run only when the sandbox is proven, or isolation was turned off by hand. */
  get canRunJobs() {
    return this.status?.mode === 'none' || this.status?.verified === true;
  }
}

function runForOutput(cmd, args, { cwd, timeoutMs = 10_000 }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => resolve({ code: -1, stdout }));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}
