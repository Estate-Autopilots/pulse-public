// DOMAIN (owner, 22 Nov 2026: "Pulse is just what we call Vitals OS; the old pulse.estateautopilots domain isn't even
// working … clear it up"): a page opened on an old address goes to the brand's, the path kept (a quotation link sent last
// week still opens). Off until both PULSE_LEGACY_HOSTS (comma list) and PULSE_LEGACY_TO (https origin) are set. Only
// page reads move (GET, HEAD): API calls, OAuth and discovery, and app updates stay where installed phones, the CLI and
// connected apps call them.

/** The address to send this request to (301), or null to serve it here. */
export function legacyRedirect(host, path, search, method, env = process.env) {
  const hosts = String(env.PULSE_LEGACY_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length || !env.PULSE_LEGACY_TO) return null;
  let target;
  try { target = new URL(env.PULSE_LEGACY_TO); } catch { return null; }
  if (target.protocol !== "https:") return null;
  const bare = String(host ?? "").trim().toLowerCase().replace(/:\d{1,5}$/, "");
  if (!hosts.includes(bare) || bare === target.hostname) return null;
  if (method !== "GET" && method !== "HEAD") return null;
  if (/^\/(api|oauth|\.well-known|_next)(\/|$)/.test(path)) return null;
  return `${target.origin}${path}${search ?? ""}`;
}
