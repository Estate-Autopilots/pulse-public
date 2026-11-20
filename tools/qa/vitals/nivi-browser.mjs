// QA-2 (QA system stage 1, research §5: "nivi: Vitals production monitor", "role walk runs on nivi"): a Chromium on
// nivi, driven from ea. ea keeps the script, the sign-ins and the network to dev; nivi does the rendering.
//
// nivi-builder refuses ssh port forwarding, so:
//   1. browser-server.mjs and playwright-core are copied to /home/eadev/work/qa-runtime on nivi (rsync, only changes);
//   2. builder-run starts browser-server.mjs in one of nivi's shared slots (it waits for a free one, like the gate);
//   3. a second ssh session runs `nc 127.0.0.1 <port>` on nivi: its stdin/stdout are the TCP stream, and a local
//      127.0.0.1 listener on ea pipes Playwright's one websocket into it.
// Requests a page makes are fulfilled from ea by the caller's context.route (dev: ea's 127.0.0.1:3200), or go out
// from nivi directly (production is public).
//
// With QA_BROWSER=local, or when nivi does not answer, the browser starts on this machine instead (reported in `where`).
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOST = process.env.QA_NIVI_HOST || "nivi-builder";
const RUNTIME = "/home/eadev/work/qa-runtime";
// The ssh config's ControlMaster is kept: nivi's firewall refuses bursts of new ssh connections, multiplexed sessions are fine.
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=20"];

/** playwright-core from this checkout (pnpm keeps it under node_modules/.pnpm). */
export function playwrightCore() {
  const roots = [path.resolve(here, "../../.."), "/home/eadev/work/pulse/strike"];
  for (const root of roots) {
    for (const rel of ["tests/e2e/node_modules/@playwright/test", "node_modules/@playwright/test"]) {
      try { return { pw: require(path.join(root, rel, "node_modules/playwright-core")), dir: path.join(root, rel, "node_modules/playwright-core") }; } catch { /* next */ }
      try {
        const test = require.resolve(path.join(root, rel, "package.json"));
        const core = require.resolve("playwright-core/package.json", { paths: [path.dirname(test)] });
        return { pw: require(path.dirname(core)), dir: path.dirname(core) };
      } catch { /* next */ }
    }
  }
  throw new Error("playwright-core not found (run pnpm install in this checkout)");
}

const ssh = (args, opts = {}) => spawnSync("ssh", [...SSH, HOST, ...args], { encoding: "utf8", timeout: 60_000, ...opts });

/** Starts a browser on nivi (or locally). Returns { browser, where, close }.
 *  slot: true (walks, the night matrix) waits for one of nivi's shared builder slots, as the land gate's steps do;
 *  slot: false (the 15-minute production monitor, about a minute of one page at a time) runs at nice 15 beside them,
 *  so a busy land queue never delays the alarm. */
export async function qaBrowser({ ttl = 3600, slot = true, log = () => {} } = {}) {
  const { pw, dir } = playwrightCore();
  const local = async (why) => {
    log(`browser: on this machine (${why})`);
    const browser = await pw.chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--disable-dev-shm-usage", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
    return { browser, where: `local (${why})`, close: () => browser.close().catch(() => {}) };
  };
  if (process.env.QA_BROWSER === "local") return local("QA_BROWSER=local");
  // 1. the runtime on nivi (the same playwright-core version as the client: the protocol must match)
  const sync = spawnSync("rsync", ["-a", "--delete", "--mkpath", "-e", `ssh ${SSH.join(" ")}`, path.join(here, "browser-server.mjs"), `${HOST}:${RUNTIME}/`], { encoding: "utf8", timeout: 60_000 });
  const syncCore = sync.status === 0 && spawnSync("rsync", ["-a", "--delete", "--mkpath", "-e", `ssh ${SSH.join(" ")}`, `${dir}/`, `${HOST}:${RUNTIME}/node_modules/playwright-core/`], { encoding: "utf8", timeout: 120_000 });
  if (sync.status !== 0 || !syncCore || syncCore.status !== 0) return local(`nivi unreachable: ${(sync.stderr || syncCore?.stderr || "").trim().split("\n").pop()}`);
  // 2. the browser server in a nivi slot (builder-run wants an env file; HOME=/home/eadev finds the Playwright browsers)
  const job = `qa2-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid}-${Math.floor(Math.random() * 1e5)}`;
  const port = 40000 + Math.floor(Math.random() * 20000);
  const env = [`PATH=/home/eadev/.local/opt/node/bin:/usr/local/bin:/usr/bin:/bin`, `PLAYWRIGHT_BROWSERS_PATH=/home/eadev/.cache/ms-playwright`, "NODE_ENV=production"].join("\0") + "\0";
  const mk = ssh([`umask 077; mkdir -p /var/tmp/builder-jobs/${job} && cat > /var/tmp/builder-jobs/${job}/env`], { input: env });
  if (mk.status !== 0) return local(`nivi job set-up failed: ${(mk.stderr || "").trim().slice(0, 120)}`);
  const run = slot
    ? `/usr/local/bin/builder-run run ${job} ${RUNTIME} -- node browser-server.mjs --port ${port} --ttl ${ttl}`
    : `cd ${RUNTIME} && exec env HOME=/home/eadev PLAYWRIGHT_BROWSERS_PATH=/home/eadev/.cache/ms-playwright PATH=/home/eadev/.local/opt/node/bin:/usr/bin:/bin nice -n 15 node browser-server.mjs --port ${port} --ttl ${ttl}`;
  const server = spawn("ssh", [...SSH, HOST, run], { stdio: ["ignore", "pipe", "pipe"] });
  let serverErr = "";
  server.stderr.on("data", (d) => { serverErr += d; if (/waiting for a nivi slot/.test(String(d))) log("browser: waiting for a nivi slot"); });
  const endpoint = await new Promise((resolve) => {
    let buf = "";
    const done = (v) => { clearTimeout(t); resolve(v); };
    const t = setTimeout(() => done(null), 15 * 60_000); // a busy nivi: wait for a slot up to 15 minutes
    server.stdout.on("data", (d) => { buf += d; const m = /ws (ws:\/\/\S+)/.exec(buf); if (m) done(m[1]); });
    server.on("exit", () => done(null));
  });
  // builder-run kill ends a slot job's process group; pkill ends the slot-less one (and anything left of either).
  const kill = () => { ssh([`/usr/local/bin/builder-run kill ${job}; pkill -f 'browser-server[.]mjs --port ${port} '; rm -rf /var/tmp/builder-jobs/${job}`], { timeout: 30_000 }); server.kill("SIGTERM"); };
  if (!endpoint) { kill(); return local(`nivi browser did not start: ${serverErr.trim().split("\n").pop() || "no answer"}`); }
  // 3. the stdio pipe: one local listener, one ssh `nc` per connection (Playwright opens exactly one)
  const pipes = [];
  const listener = net.createServer((sock) => {
    const nc = spawn("ssh", [...SSH, HOST, `nc 127.0.0.1 ${port}`], { stdio: ["pipe", "pipe", "ignore"] });
    pipes.push(nc);
    sock.pipe(nc.stdin); nc.stdout.pipe(sock);
    const end = () => { sock.destroy(); nc.kill("SIGTERM"); };
    sock.on("close", end); sock.on("error", end); nc.on("exit", end);
    // Either side closing first is the normal end of a run, not an error.
    nc.stdin.on("error", end); nc.stdout.on("error", end);
  });
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const ws = endpoint.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${listener.address().port}`);
  let browser;
  try { browser = await pw.chromium.connect(ws, { timeout: 60_000 }); }
  catch (e) { listener.close(); kill(); return local(`nivi connect failed: ${String(e.message).split("\n")[0].slice(0, 120)}`); }
  log(`browser: on nivi (${job})`);
  let closed = false;
  return {
    browser, where: `nivi (${job})`,
    close: async () => { if (closed) return; closed = true; await browser.close().catch(() => {}); listener.close(); for (const p of pipes) p.kill("SIGTERM"); kill(); },
  };
}
