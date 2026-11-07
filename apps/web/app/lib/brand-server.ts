// The organisation's brand for server pages (the address's company, UX-TENANT). Client components import ./brand.
import { cookies, headers } from "next/headers";
import { cache } from "react";
import type { OrgBrand } from "./brand";
import { hostHeader } from "./host-mode.mjs";
import { FALLBACK_ZONE } from "./zone.mjs";

/** Read once per request: the root layout and a page share one answer. */
export const readBrand = cache(async (): Promise<OrgBrand | null> => {
  try {
    // UX-TENANT: the company whose address this is. SELFSERVE-P1: at the shared address, the signed-in person's own
    // company (the API opens a session's organisation, as for every other read), so a self-started company's employee
    // IDs carry its own code and the shell its own name and logo, never the install company's.
    const token = (await cookies()).get("pulse_session")?.value;
    const session: Record<string, string> = token && /^[A-Za-z0-9_-]{40,64}$/.test(token) ? { "x-pulse-session": token } : {};
    const r = await fetch(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/api/v0/brand`, { cache: "no-store", headers: { ...hostHeader(await headers()), ...session }, signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() as OrgBrand : null;
  } catch { return null; }
});

/** R51: the company's IANA time zone, for server pages that count days (lib/zone.mjs). */
export async function orgZone(): Promise<string> {
  return (await readBrand())?.timeZone ?? FALLBACK_ZONE;
}
