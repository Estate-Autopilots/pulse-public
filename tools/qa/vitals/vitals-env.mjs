// QA-2: what every Vitals QA script shares: the QA company's credentials (QA-1's qa-org.py; never a real person's
// login, never printed), HTTP from ea (dev through ea's own dev server, production directly), sign-in and sign-out,
// and a browser context that only reads (every write held) and, on dev, is fed from ea (dev.vitalsos.ai sits behind
// Cloudflare Access, so the browser on nivi cannot reach it).
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const UA = "vitals-qa-2";
export const STAFF = ["owner", "admin", "sales_head", "seller", "finance", "hr"];
/** A page a person cannot use: a refusal, a dead wall, a not-found or an error page. */
export const REFUSAL = /Not part of your access|Hidden by your admin|view is unavailable|access required|You don.t have access|isn.t available to you|not switched on|Page not found|This page could not be found|Something went wrong|didn.t load|could not load|couldn.t load/i;
/** R10: junk on screen. */
export const JUNK = /\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date|\uFFFD/;

// What a page shows once it settles: refusal, blank, junk, sideways overflow.
export const probe = () => {
  const main = document.querySelector("main") || document.body;
  const text = (main.innerText || "").replace(/\s+/g, " ").trim();
  const head = [...document.querySelectorAll("main h1, main h2, h1")].map((h) => h.innerText.trim()).filter(Boolean)[0] || document.title;
  return { text: text.slice(0, 4000), textLen: text.length, head: head.slice(0, 80), overflowX: document.documentElement.scrollWidth - innerWidth };
};


export function vitalsEnv(env, { credentials } = {}) {
  const file = credentials || path.join(os.homedir(), ".config/vitals-qa", `${env === "prod" ? "production" : env}.json`);
  const creds = JSON.parse(fs.readFileSync(file, "utf8"));
  const ORIGIN = creds.baseUrl.replace(/\/$/, "");
  const HOSTNAME = new URL(ORIGIN).host;
  const DEV = env === "dev" ? { host: "127.0.0.1", port: Number(process.env.QA_DEV_PORT || 3200) } : null;

  const raw = (p, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ ...DEV, path: p, method, headers: { ...headers, host: HOSTNAME, "x-forwarded-proto": "https" }, timeout: 90_000 }, (up) => {
      const chunks = []; up.on("data", (c) => chunks.push(c)); up.on("end", () => resolve({ status: up.statusCode, headers: up.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject); r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body) r.write(body); r.end();
  });

  async function call(p, { method, body, cookies, headers } = {}) {
    const h = { "content-type": "application/json", origin: ORIGIN, "user-agent": UA, accept: "application/json", ...(headers || {}) };
    if (cookies) h.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const m = method || (body !== undefined ? "POST" : "GET");
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    let status, text, setCookies;
    if (DEV) {
      if (data) h["content-length"] = String(Buffer.byteLength(data));
      const r = await raw(p, { method: m, headers: h, body: data });
      status = r.status; text = r.body.toString("utf8"); setCookies = [].concat(r.headers["set-cookie"] || []);
    } else {
      const r = await fetch(ORIGIN + p, { method: m, headers: h, body: data, redirect: "manual", signal: AbortSignal.timeout(60_000) });
      status = r.status; text = await r.text(); setCookies = r.headers.getSetCookie?.() || [];
    }
    const jar = {};
    for (const c of setCookies) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (i > 0 && kv.slice(i + 1)) jar[kv.slice(0, i)] = kv.slice(i + 1); }
    let json = null; try { json = JSON.parse(text); } catch { /* SSE or HTML */ }
    return { status, json, text, jar };
  }

  /** Signs a staff login in (dev's API restarts whenever a lane lands: a 502/503 is waited out up to a minute). */
  async function signIn(role) {
    const v = creds.logins[role];
    if (!v || v.kind !== "staff") return { error: `no staff login "${role}"` };
    let r;
    for (let i = 0; i < 4; i++) {
      r = await call("/api/v0/auth/account-sign-in", { body: { login: v.handle, password: v.password } });
      if (r.status !== 502 && r.status !== 503) break;
      await new Promise((ok) => setTimeout(ok, 20_000));
    }
    if (r.status !== 200 || !r.jar.pulse_session) return { error: `sign-in ${r.status}: ${String(r.json?.error || r.text).slice(0, 120)}` };
    if (r.json?.org && r.json.org !== creds.org.id) { await signOut(r.jar); return { error: `signed in to another company (${r.json.org})` }; }
    return { jar: r.jar };
  }
  const signOut = (jar) => (jar?.pulse_session ? call("/api/v0/auth/sign-out", { body: {}, cookies: { pulse_session: jar.pulse_session } }).catch(() => null) : null);

  /** Read-only browsing for a context: every non-GET is held (answered 204, counted); live streams are dropped; on dev every
   *  request is fetched from ea's dev server. Register AFTER any other ctx.route (the last registered runs first).
   *  `allowWrites` (journeys on dev only) lets writes through to dev. Returns the held list. */
  async function routeContext(ctx, { allowWrites = false } = {}) {
    const held = [];
    if (allowWrites && !DEV) throw new Error("writes are only ever allowed on dev");
    await ctx.route(`${ORIGIN}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (!allowWrites && !["GET", "HEAD", "OPTIONS"].includes(req.method())) {
        held.push(`${req.method()} ${url.pathname}`);
        // 204, as QA-1's gate context answers a held write: a 5xx here would read as a failed request to every check.
        return route.fulfill({ status: 204, body: "" });
      }
      // Live streams (chat and call events) never end, so a page that waits on them never settles. An aborted one is
      // retried at once and logs "Failed to load resource" (a false R11). Answer an empty stream that asks the browser to
      // wait ten minutes before reconnecting.
      if (/\/events$|\/stream$/.test(url.pathname) || (req.headers().accept || "").includes("text/event-stream")) {
        return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" }, body: "retry: 600000\n\n" });
      }
      if (!DEV) return route.continue();
      try {
        const res = await raw(url.pathname + url.search, { method: req.method(), headers: { ...req.headers(), "accept-encoding": "identity" }, body: req.postDataBuffer() || undefined });
        const headers = {};
        for (const [k, v] of Object.entries(res.headers)) if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(k)) headers[k] = Array.isArray(v) ? v.join(k === "set-cookie" ? "\n" : ", ") : String(v);
        if (res.status >= 300 && res.status < 400 && headers.location) {
          const to = new URL(headers.location, ORIGIN);
          // A redirect answered by fulfill is not followed for a navigation: send the page there instead.
          if (req.isNavigationRequest()) return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><script>location.replace(${JSON.stringify(ORIGIN + to.pathname + to.search)})</script>` });
          headers.location = ORIGIN + to.pathname + to.search;
        }
        await route.fulfill({ status: res.status, headers, body: res.body });
      } catch { await route.abort().catch(() => {}); }
    });
    return held;
  }

  async function addSession(ctx, jar) {
    if (!jar) return;
    await ctx.addCookies(Object.entries(jar).filter(([k]) => ["pulse_session", "pulse_device_key"].includes(k))
      .map(([name, value]) => ({ name, value, domain: HOSTNAME, path: "/", httpOnly: true, secure: true, sameSite: "Lax" })));
  }

  return { env, creds, ORIGIN, HOSTNAME, DEV, call, signIn, signOut, routeContext, addSession };
}

export const parseArgs = (argv) => Object.fromEntries(argv.reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]] : a), []));
