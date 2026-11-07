// VITALS-HOSTS (owner, 4 Nov 2026: "move Pulse to vitalsos.ai", F3/F4 groundwork): the platform's own addresses come
// in families, like Sales X-Ray's (_SALES_XRAY_FAMILIES). One container serves every family; each host has one job:
//   app  the web app: pages, sign-in, the API proxy and /mcp (a family's sign-in happens here or on id)
//   api  the public API: /api/* and /.well-known/* only
//   mcp  the remote MCP server: /mcp and its OAuth discovery only
//   id   "Sign in with Pulse": the OAuth issuer (/.well-known/*, /oauth/*) and the sign-in page it needs
// Any other GET on api, mcp or id goes 302 to the family's app host; anything else there is a plain 404.
//
//   PULSE_HOST_FAMILIES  JSON, e.g. [{"name":"vitals","app":"app.vitalsos.ai","api":"api.vitalsos.ai",
//                        "mcp":"mcp.vitalsos.ai","id":"id.vitalsos.ai"}]. Only "app" is required.
//
// The install's own address (PULSE_PUBLIC_URL) is always a family too, "install", whose one host does every job and is
// its own issuer: it stays for good (installed apps, Google callbacks and MCP connections use it) and behaves as before.
// Cookies stay host-only on every host (no Domain=), so each host of a family signs in on its own.
// Mirrored in services/api/src/host-families.ts (test: services/api/test/host-families.test.mjs compares the two).

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const ROLES = ["app", "api", "mcp", "id"];
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

const bare = (raw) => typeof raw === "string" ? raw.trim().toLowerCase().replace(/:\d{1,5}$/, "").replace(/\.$/, "") : "";
const portOf = (raw) => typeof raw === "string" ? raw.trim().match(/:(\d{1,5})$/)?.[1] ?? null : null;
const local = (host) => host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");

let memo = { key: null, value: [] };
/** The configured families, then the install's own; a host belongs to the first family that names it. Bad entries are skipped. */
export function hostFamilies(env = process.env) {
  const key = `${env.PULSE_HOST_FAMILIES ?? ""}\n${env.PULSE_PUBLIC_URL ?? ""}`;
  if (memo.key === key) return memo.value;
  let listed = [];
  try { const parsed = JSON.parse(env.PULSE_HOST_FAMILIES || "[]"); listed = Array.isArray(parsed) ? parsed : []; } catch { listed = []; }
  const seen = new Set(), families = [];
  for (const [i, f] of listed.entries()) {
    if (!f || typeof f !== "object") continue;
    const hosts = Object.fromEntries(ROLES.map((role) => [role, typeof f[role] === "string" && HOST.test(bare(f[role])) ? bare(f[role]) : null]));
    if (!hosts.app || ROLES.some((role) => hosts[role] && seen.has(hosts[role]))) continue;
    if (new Set(ROLES.map((r) => hosts[r]).filter(Boolean)).size !== ROLES.filter((r) => hosts[r]).length) continue;
    ROLES.forEach((role) => hosts[role] && seen.add(hosts[role]));
    families.push({ name: typeof f.name === "string" && NAME.test(f.name) ? f.name : `family-${i + 1}`, listed: true, ...hosts });
  }
  let install = null;
  try { install = bare(new URL(env.PULSE_PUBLIC_URL ?? "").host); } catch { install = null; }
  if (install && HOST.test(install) && !seen.has(install)) families.push({ name: "install", listed: false, app: install, api: null, mcp: null, id: null });
  memo = { key, value: families };
  return families;
}

/** https://host, except plain http with the request's port on this computer (a *.localhost rehearsal of the family). */
export function hostOrigin(host, port = null) {
  return local(host) ? `http://${host}${port ? `:${port}` : ""}` : `https://${host}`;
}

/** The family a host (as the Host header gives it, port allowed) belongs to, with this host's job and the family's
 *  addresses, or null for any other host (a company's own address, a bare dev server). */
export function hostFamily(rawHost, env = process.env) {
  const host = bare(rawHost);
  if (!host) return null;
  const family = hostFamilies(env).find((f) => ROLES.some((role) => f[role] === host));
  if (!family) return null;
  const port = portOf(rawHost), at = (h) => hostOrigin(h, port);
  const role = ROLES.find((r) => family[r] === host);
  const app = at(family.app), self = at(host);
  return {
    name: family.name, listed: family.listed, role, host, self, app,
    /** One issuer per family, for MCP and third-party apps: id when the family has it, else the app host. */
    issuer: at(family.id ?? family.app),
    /** Where MCP lives for this family: this host when it serves /mcp itself (app or mcp), else the family's MCP host. */
    mcp: role === "app" || role === "mcp" ? self : at(family.mcp ?? family.app),
    /** Where people sign in on this host: here on app and id, else on the family's app host. */
    signIn: role === "app" || role === "id" ? self : app,
  };
}

const STATIC = /^\/(favicon\.ico|icon[\w.-]*|apple-icon[\w.-]*|manifest\.webmanifest|robots\.txt|brand\/[\w./-]+)$/;
const ALLOW = {
  // SERVERS-AI: Pulse Runner servers call api./runner/v1/* (POST/PUT; never redirected: the runner does not follow redirects).
  api: (p) => p.startsWith("/api/") || p.startsWith("/.well-known/") || p.startsWith("/runner/v1/"),
  mcp: (p) => p === "/mcp" || p.startsWith("/mcp/") || /^\/\.well-known\/oauth-(protected-resource|authorization-server)(\/mcp)?$/.test(p),
  id: (p) => p.startsWith("/.well-known/") || p.startsWith("/oauth/") || p === "/login" || p.startsWith("/login/")
    || p.startsWith("/api/") || p.startsWith("/_next/") || STATIC.test(p),
};

/** What proxy.ts does with a request on a family's api, mcp or id host: null lets it through; otherwise a 302 to the
 *  family's app host (GET, HEAD) or a 404 that says where Pulse is. The app host, and any host outside a family, pass. */
export function hostRoute(rawHost, path, search = "", method = "GET", env = process.env) {
  const family = hostFamily(rawHost, env);
  if (!family || family.role === "app" || ALLOW[family.role](path)) return null;
  if (method === "GET" || method === "HEAD") return { status: 302, location: `${family.app}${path}${search}` };
  return { status: 404, body: `Pulse is at ${family.app}\n` };
}

/** The origin a browser's same-origin request must carry (the API proxy's Origin check): a family host is its own
 *  origin; any other address keeps the caller's rule (`fallback`). */
export function sameOriginFor(rawHost, fallback, env = process.env) {
  const family = hostFamily(rawHost, env);
  return family?.listed ? family.self : fallback;
}
