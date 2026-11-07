/**
 * Who runs this Pulse and where its admin sites live, from the server's environment only (PULSE-ADMIN). Pulse moves
 * to its own company (an LLP, later a Pvt Ltd) and domain later: that move changes these variables, never code.
 *
 *   PULSE_PLATFORM_NAME        the product (default "Pulse")
 *   PULSE_PLATFORM_COMPANY     the company that runs it (shown in the console; unset until it exists)
 *   PULSE_SUPPORT_EMAIL        where people write for help
 *   PULSE_ADMIN_ENV            this admin site's environment: production | development (default from NODE_ENV)
 *   PULSE_ADMIN_PRODUCTION_URL the production admin site (e.g. https://pulse-admin.<domain>)
 *   PULSE_ADMIN_DEV_URL        the development admin site
 *   PULSE_APP_URL              the Pulse app itself (links back to the product)
 */
export type AdminConfig = {
  product: string;
  company: string | null;
  supportEmail: string | null;
  environment: "production" | "development";
  sites: { key: "production" | "development"; label: string; url: string }[];
  appUrl: string | null;
  /** This site's host names (PULSE_ADMIN_HOSTS, else pulse-admin. and pulse-admin-dev. on Pulse's own domain). */
  hosts: string[];
};

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** Pulse's own domain without its first label (pulse.example.com → example.com), from PULSE_PUBLIC_URL. */
function parentDomain(env: NodeJS.ProcessEnv): string | null {
  try {
    const labels = new URL(env.PULSE_PUBLIC_URL ?? "").hostname.toLowerCase().split(".");
    return labels.length >= 3 ? labels.slice(1).join(".") : null;
  } catch {
    return null;
  }
}

const clean = (value: string | undefined, max = 200) => (value ?? "").trim().slice(0, max) || null;
const httpsUrl = (value: string | undefined) => {
  const v = clean(value, 300);
  if (!v) return null;
  try {
    const url = new URL(v);
    return url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost" ? url.origin : null;
  } catch {
    return null;
  }
};

export function adminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const environment = env.PULSE_ADMIN_ENV === "development" || (!env.PULSE_ADMIN_ENV && env.NODE_ENV === "development") ? "development" : "production";
  const sites: AdminConfig["sites"] = [];
  const parent = parentDomain(env);
  const prod = httpsUrl(env.PULSE_ADMIN_PRODUCTION_URL) ?? (parent ? `https://pulse-admin.${parent}` : null);
  const dev = httpsUrl(env.PULSE_ADMIN_DEV_URL) ?? (parent ? `https://pulse-admin-dev.${parent}` : null);
  const listed = (env.PULSE_ADMIN_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => HOST.test(h));
  const hosts = listed.length ? listed : [prod, dev].filter((u): u is string => !!u).map((u) => new URL(u).hostname);
  if (prod) sites.push({ key: "production", label: "Production", url: prod });
  if (dev) sites.push({ key: "development", label: "Development", url: dev });
  const support = clean(env.PULSE_SUPPORT_EMAIL);
  return {
    product: clean(env.PULSE_PLATFORM_NAME, 60) ?? "Pulse",
    company: clean(env.PULSE_PLATFORM_COMPANY, 120),
    supportEmail: support && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support) ? support : null,
    environment,
    sites,
    appUrl: httpsUrl(env.PULSE_APP_URL ?? env.PULSE_PUBLIC_URL),
    hosts,
  };
}
