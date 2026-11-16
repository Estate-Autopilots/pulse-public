// PULSE-ADMIN: the Pulse admin site (apps/admin) has its own address. In production it runs inside the Pulse container
// on 127.0.0.1:8083 and this web forwards requests for the admin site's host to it (proxy.ts). The hosts come from
// configuration: PULSE_ADMIN_HOSTS (comma-separated), else "pulse-admin." in front of Pulse's own domain
// (PULSE_PUBLIC_URL pulse.example.com → pulse-admin.example.com), so a new domain is a configuration change.

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The admin site's host names (lower case), possibly none. */
export function adminHosts(env = process.env) {
  const listed = (env.PULSE_ADMIN_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => HOST.test(h));
  if (listed.length || env.PULSE_ADMIN_HOSTS !== undefined) return listed;
  try {
    const host = new URL(env.PULSE_PUBLIC_URL ?? "").hostname.toLowerCase();
    const labels = host.split(".");
    return labels.length >= 3 && HOST.test(host) ? [["pulse-admin", ...labels.slice(1)].join(".")] : [];
  } catch {
    return [];
  }
}

/** Where a request for this host goes (the admin server's origin), or null for Pulse itself. */
export function adminOrigin(rawHost, env = process.env) {
  const host = typeof rawHost === "string" ? rawHost.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "") : "";
  if (!host || !adminHosts(env).includes(host)) return null;
  return env.PULSE_ADMIN_ORIGIN ?? "http://127.0.0.1:8083";
}

/** The admin site's address for links from Pulse (PULSE_ADMIN_URL, else https:// and its first host). */
export function adminUrl(env = process.env) {
  const set = (env.PULSE_ADMIN_URL ?? "").trim();
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(set)) return set.replace(/\/$/, "");
  const [host] = adminHosts(env);
  return host ? `https://${host}` : null;
}
