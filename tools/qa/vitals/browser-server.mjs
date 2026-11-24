// QA-2 (QA system stage 1): the Chromium the Vitals QA scripts drive, started on nivi (the remote half of
// nivi-browser.mjs). Playwright's server listens on a private port; ea reaches it through --port, a small proxy on
// 127.0.0.1 that ea's ssh stdio pipe connects to (nivi refuses ssh port forwarding). When ea's connection has come
// and gone (the run ended, or ea's side was killed), the server exits 10 s later, so a nivi slot is never held by a
// dead run. Prints one line, "ws <endpoint>", then runs until then, until builder-run kills it, or --ttl seconds.
//   node browser-server.mjs --port 41234 [--ttl 3600]
import net from "node:net";
import { chromium } from "playwright-core";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const port = Number(arg("port", "0"));
const ttl = Number(arg("ttl", "3600"));
const server = await chromium.launchServer({
  host: "127.0.0.1",
  port: 0,
  // Fake camera and microphone: the call journey connects audio without a device; swiftshader as the other QA shooters.
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--disable-dev-shm-usage", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const inner = new URL(server.wsEndpoint());
const stop = async () => { await server.close().catch(() => {}); process.exit(0); };
let open = 0, seen = false, idle = null;
const proxy = net.createServer((sock) => {
  open++; seen = true; clearTimeout(idle);
  const up = net.connect(Number(inner.port), "127.0.0.1");
  sock.pipe(up); up.pipe(sock);
  const end = () => { sock.destroy(); up.destroy(); };
  sock.on("error", end); up.on("error", end);
  sock.on("close", () => { end(); open--; if (!open) idle = setTimeout(stop, 10_000); });
});
proxy.listen(port, "127.0.0.1", () => console.log(`ws ws://127.0.0.1:${port}${inner.pathname}`));
// Nobody connected within two minutes: ea gave up.
setTimeout(() => { if (!seen) stop(); }, 120_000).unref?.();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setTimeout(stop, ttl * 1000).unref?.();
setInterval(() => {}, 60_000);
