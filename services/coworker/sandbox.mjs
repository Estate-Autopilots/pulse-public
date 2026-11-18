// FIN-AGENT (17 Nov 2026): the AI employees' Python sandbox. Heavy analysis (a bank statement of a million lines, a GST
// return, a sheet) runs here, never in the model and never with the AI's key:
//   * bubblewrap: new user, network, PID, IPC and UTS namespaces (no network at all), no capabilities, a new session;
//     only /usr, the Python it needs (read only), the job's scripts (read only), its inputs (read only) and its own
//     output folder are visible; /tmp is a private tmpfs; nothing of the home folder, keys or other jobs is there.
//   * limits: address space (memory), CPU seconds, file size, open files, processes; a wall clock that kills the whole
//     sandbox; output read back only from the job's folder.
//   * files in and out go through the runtime, which reads and writes Pulse with the AI employee's own key, so "no
//     network except Pulse" holds with no network inside at all.
// One JSON line per progress step on stdout ({"t":"progress","p":40,"line":"…"}) is handed to onLine as it comes.
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cpus, loadavg, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../..");
export const LIB = join(HERE, "sandbox");
export const LIMITS = { memMb: 2048, cpuSec: 600, wallSec: 900, fileMb: 2048, nofile: 256, tasks: 64 };

/** The Python the sandbox runs: PULSE_SANDBOX_PYTHON, else this checkout's .venv (openpyxl, pypdf, xlrd), else python3. */
export function sandboxPython(env = process.env) {
  for (const p of [env.PULSE_SANDBOX_PYTHON, join(ROOT, ".venv/bin/python"), "/usr/bin/python3"]) if (p && existsSync(p)) return p;
  return "/usr/bin/python3";
}

/** Directories the interpreter needs, read only: the venv (pyvenv.cfg, site-packages) and its base Python. */
export async function pythonBinds(python) {
  const out = new Set();
  // Every hop of the interpreter's symlink chain (uv's "cpython-3.12-…" is itself a link to the patch release).
  let p = python;
  for (let i = 0; i < 12; i++) {
    out.add(dirname(dirname(p)));
    let next;
    try { next = await readlink(p); } catch { break; }
    p = resolve(dirname(p), next);
  }
  out.add(dirname(dirname(await realpath(python))));
  if (python.includes("/.venv/")) out.add(python.slice(0, python.indexOf("/.venv/") + 6));
  return [...out].filter((d) => !d.startsWith("/usr") && d !== "/" && existsSync(d));
}

/** The bwrap + prlimit command line for one run (exported for the tests). */
export function sandboxArgs({ python, binds = [], inDir, outDir, lib = LIB, standard = join(ROOT, "tools/statement-parse.py"), entry, args = [], limits = {}, scope = false, hasStandard = existsSync(standard) }) {
  const L = { ...LIMITS, ...limits };
  const ro = (a, b = a) => ["--ro-bind", a, b];
  // (No --nproc: RLIMIT_NPROC counts every process of this user on the server. The process cap is the scope's TasksMax.)
  return [...(scope ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", `TasksMax=${L.tasks}`, "-p", `MemoryMax=${L.memMb + 256}M`, "-p", "MemorySwapMax=0", "-p", "CPUWeight=20", "--"] : []),
    "prlimit", `--as=${L.memMb * 1024 * 1024}`, `--cpu=${L.cpuSec}`, `--fsize=${L.fileMb * 1024 * 1024}`, `--nofile=${L.nofile}`, "--core=0", "--",
    "bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    ...ro("/usr"), "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ...binds.flatMap((d) => ro(d)), ...ro(lib, "/job/lib"), ...(hasStandard ? ro(standard, "/job/standard/statement-parse.py") : []),
    ...ro(inDir, "/in"), "--bind", outDir, "/out", "--chdir", "/out",
    "--clearenv", "--setenv", "HOME", "/tmp", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "PYTHONDONTWRITEBYTECODE", "1", "--setenv", "LANG", "C.UTF-8",
    "--setenv", "PULSE_STANDARD_PARSER", "/job/standard/statement-parse.py",
    python, "-I", entry, ...args];
}

let scoped = null;
/** Whether a systemd user scope can hold the sandbox (a real cap on its processes and memory); asked once. */
export function scopeReady() {
  if (scoped === null) {
    try { execFileSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "-p", "TasksMax=8", "--", "/usr/bin/true"], { timeout: 8000, stdio: "ignore" }); scoped = true; }
    catch { scoped = false; }
  }
  return scoped;
}

/** Whether this server can run the sandbox at all (bwrap allowed to make namespaces); asked at most every 10 minutes. */
let readyAt = 0, ready = false;
export function sandboxReady() {
  if (Date.now() - readyAt < 600000) return ready;
  readyAt = Date.now();
  return (ready = probe());
}
function probe() {
  try { execFileSync("bwrap", ["--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "/usr/bin/true"], { timeout: 5000, stdio: "ignore" }); return true; }
  catch { return false; }
}

/**
 * Run one sandbox job. `script` is a file name in services/coworker/sandbox (e.g. "fin_ingest.py"); `code` instead runs
 * Python an AI employee wrote (mounted read only as /job/user/main.py). Returns {code, killed, seconds, stderr, lines}.
 */
export async function runSandbox({ script, code, inDir, outDir, args = ["/in", "/out"], limits = {}, python = sandboxPython() }, onLine = () => {}) {
  const L = { ...LIMITS, ...limits };
  await mkdir(outDir, { recursive: true });
  if (process.env.PULSE_SANDBOX_REMOTE && (busy() || !sandboxReady()) && await remoteReady()) return runRemote({ script, code, inDir, outDir, args, limits: L }, onLine);
  let lib = LIB, entry = `/job/lib/${script}`, scratch = null;
  if (code != null) {
    scratch = await mkdtemp(join(tmpdir(), "pulse-sbx-"));
    await writeFile(join(scratch, "main.py"), String(code));
    lib = scratch; entry = "/job/lib/main.py";
  }
  const argv = sandboxArgs({ python, binds: await pythonBinds(python), inDir, outDir, lib, entry, args, limits: L, scope: process.env.PULSE_SANDBOX_SCOPE !== "0" && scopeReady() });
  const t0 = Date.now();
  return await new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let killed = null, buf = "", err = "", lines = 0;
    const timer = setTimeout(() => { killed = "time"; child.kill("SIGKILL"); }, L.wallSec * 1000);
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        lines++;
        let j = null; try { j = JSON.parse(line); } catch { /* plain output */ }
        try { onLine(j ?? { t: "text", line: line.slice(0, 500) }); } catch { /* a listener's error never stops the job */ }
      }
    });
    child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
      if (!killed && signal === "SIGXCPU") killed = "cpu";
      if (!killed && /MemoryError|Cannot allocate|std::bad_alloc/.test(err)) killed = "memory";
      done({ code, signal, killed, seconds: (Date.now() - t0) / 1000, stderr: err.replace(/\/home\/[^\s'"]+/g, "…"), lines });
    });
  });
}

// ------------------------------------------------------------------------------------------------- jobs on another server
// FIN-AGENT-2 (18 Nov 2026): "jobs on nivi when ea is busy". Off unless PULSE_SANDBOX_REMOTE names an ssh host (for
// example nivi-builder). Then a job runs there when this server's load is above PULSE_SANDBOX_BUSY (default 1.5) per
// core, or when this server cannot make the sandbox, and only if that host passes the same probe: bubblewrap with every
// namespace unshared and a systemd user scope for the process and memory caps. The same command line runs there (no
// network, read-only inputs, limits, a wall clock, here and there); the job's files travel over ssh into a private
// folder (mode 700) that is removed when the run ends, however it ends. Nothing ever runs there outside the sandbox.
const sh = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
const D = "@D@"; // the remote run's private folder, filled in by its shell
/** Whether this server is busy: its 1-minute load above PULSE_SANDBOX_BUSY × its cores. */
export function busy(load = loadavg()[0], cores = cpus().length, env = process.env) { return load > (Number(env.PULSE_SANDBOX_BUSY) || 1.5) * Math.max(1, cores); }
const sshArgv = (env = process.env) => [env.PULSE_SANDBOX_SSH || "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", env.PULSE_SANDBOX_REMOTE];

/** The remote run, as one shell command: unpack the job (tar on stdin) into a private folder, run the sandbox there
 *  (progress lines stream back), then a marker line and the output folder as base64 tar; the folder is removed. */
export function remoteCommand({ entry, args = [], limits = {}, python = "/usr/bin/python3", binds = [] }) {
  const L = { ...LIMITS, ...limits };
  const argv = sandboxArgs({ python, binds, inDir: `${D}/in`, outDir: `${D}/out`, lib: `${D}/lib`, standard: `${D}/standard.py`, hasStandard: true, entry, args, limits: L, scope: true });
  const line = argv.map((a) => sh(a).split(D).join(`'"$d"'`)).join(" ");
  return ["set -eu", 'd=$(mktemp -d "${TMPDIR:-/tmp}/pulse-sbx-XXXXXX")', 'chmod 700 "$d"', "trap 'rm -rf \"$d\"' EXIT HUP INT TERM",
    'tar -x -C "$d" -f -', 'mkdir -p "$d/out"', `rc=0; timeout -s KILL ${L.wallSec + 5} ${line} || rc=$?`,
    'echo "@@PULSE-OUT@@ $rc"', 'tar -c -C "$d/out" -f - . | gzip -1 | base64 -w0', "echo"].join("\n");
}

let remoteAt = 0, remoteOk = false;
/** Whether the remote host can hold the sandbox (bwrap with namespaces, a user scope), asked at most every 10 minutes. */
export async function remoteReady(env = process.env) {
  if (!env.PULSE_SANDBOX_REMOTE) return false;
  if (Date.now() - remoteAt < 600000) return remoteOk;
  remoteAt = Date.now();
  const probe = "bwrap --unshare-all --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 /usr/bin/true && systemd-run --user --scope --quiet --collect -p TasksMax=8 -- /usr/bin/true && echo ready";
  const argv = sshArgv(env);
  remoteOk = await new Promise((done) => {
    const child = spawn(argv[0], [...argv.slice(1), probe], { stdio: ["ignore", "pipe", "ignore"] });
    let out = ""; const t = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => { clearTimeout(t); done(code === 0 && out.trim().endsWith("ready")); });
    child.on("error", () => { clearTimeout(t); done(false); });
  });
  return remoteOk;
}

/** One sandbox run on the remote host. Same answer as runSandbox: {code, killed, seconds, stderr, lines, remote}. */
export async function runRemote({ script, code, inDir, outDir, args = ["/in", "/out"], limits = {} }, onLine = () => {}, env = process.env) {
  const L = { ...LIMITS, ...limits };
  const pack = await mkdtemp(join(tmpdir(), "pulse-remote-"));
  try {
    await cp(inDir, join(pack, "in"), { recursive: true });
    await mkdir(join(pack, "lib"), { recursive: true });
    if (code != null) await writeFile(join(pack, "lib", "main.py"), String(code));
    else for (const f of ["fin_ingest.py", "gst_recon.py", script]) if (f && existsSync(join(LIB, f))) await cp(join(LIB, f), join(pack, "lib", f));
    const standard = join(ROOT, "tools/statement-parse.py");
    if (existsSync(standard)) await cp(standard, join(pack, "standard.py")); else await writeFile(join(pack, "standard.py"), "");
    const python = env.PULSE_SANDBOX_REMOTE_PYTHON || "/usr/bin/python3";
    const binds = String(env.PULSE_SANDBOX_REMOTE_BINDS || "").split(":").filter(Boolean);
    const cmd = remoteCommand({ entry: code != null ? "/job/lib/main.py" : `/job/lib/${script}`, args, limits: L, python, binds });
    const argv = sshArgv(env);
    const t0 = Date.now();
    return await new Promise((done) => {
      const child = spawn(argv[0], [...argv.slice(1), cmd], { stdio: ["pipe", "pipe", "pipe"] });
      const tar = spawn("tar", ["-c", "-C", pack, "-f", "-", "."], { stdio: ["ignore", "pipe", "ignore"] });
      tar.stdout.pipe(child.stdin);
      let killed = null, buf = "", err = "", lines = 0, rc = null, b64 = [];
      const timer = setTimeout(() => { killed = "time"; child.kill("SIGKILL"); }, (L.wallSec + 30) * 1000);
      child.stdout.on("data", (d) => {
        if (rc !== null) { b64.push(String(d)); return; }
        buf += d;
        let i;
        while (rc === null && (i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const m = /^@@PULSE-OUT@@ (\d+)$/.exec(line);
          if (m) { rc = Number(m[1]); b64.push(buf); buf = ""; break; }
          if (!line.trim()) continue;
          lines++;
          let j = null; try { j = JSON.parse(line); } catch { /* plain output */ }
          try { onLine(j ?? { t: "text", line: line.slice(0, 500) }); } catch { /* a listener's error never stops the job */ }
        }
      });
      child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
      child.on("close", async (sshCode) => {
        clearTimeout(timer);
        if (rc !== null) {
          const data = b64.join("").replace(/\s+/g, "");
          if (data) await new Promise((ok) => { const x = spawn("tar", ["-x", "-z", "-C", outDir, "-f", "-"], { stdio: ["pipe", "ignore", "ignore"] }); x.on("close", ok); x.stdin.end(Buffer.from(data, "base64")); });
        }
        const exit = rc ?? (sshCode || 255);
        if (!killed && exit === 137) killed = "time";
        if (!killed && /MemoryError|Cannot allocate|std::bad_alloc/.test(err)) killed = "memory";
        done({ code: exit, signal: null, killed, seconds: (Date.now() - t0) / 1000, stderr: err.replace(/\/home\/[^\s'"]+/g, "…"), lines, remote: env.PULSE_SANDBOX_REMOTE });
      });
      child.on("error", () => {});
    });
  } finally {
    await rm(pack, { recursive: true, force: true }).catch(() => {});
  }
}
