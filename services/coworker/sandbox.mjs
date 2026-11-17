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
import { mkdtemp, mkdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
export function sandboxArgs({ python, binds = [], inDir, outDir, lib = LIB, standard = join(ROOT, "tools/statement-parse.py"), entry, args = [], limits = {}, scope = false }) {
  const L = { ...LIMITS, ...limits };
  const ro = (a, b = a) => ["--ro-bind", a, b];
  // (No --nproc: RLIMIT_NPROC counts every process of this user on the server. The process cap is the scope's TasksMax.)
  return [...(scope ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", `TasksMax=${L.tasks}`, "-p", `MemoryMax=${L.memMb + 256}M`, "-p", "MemorySwapMax=0", "-p", "CPUWeight=20", "--"] : []),
    "prlimit", `--as=${L.memMb * 1024 * 1024}`, `--cpu=${L.cpuSec}`, `--fsize=${L.fileMb * 1024 * 1024}`, `--nofile=${L.nofile}`, "--core=0", "--",
    "bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    ...ro("/usr"), "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ...binds.flatMap((d) => ro(d)), ...ro(lib, "/job/lib"), ...(existsSync(standard) ? ro(standard, "/job/standard/statement-parse.py") : []),
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
