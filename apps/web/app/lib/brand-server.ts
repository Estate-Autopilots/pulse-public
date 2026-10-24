// The organisation's brand for server pages (the address's company, UX-TENANT). Client components import ./brand.
import { headers } from "next/headers";
import { cache } from "react";
import type { OrgBrand } from "./brand";
import { hostHeader } from "./host-mode.mjs";
import { FALLBACK_ZONE } from "./zone.mjs";

/** Read once per request: the root layout and a page share one answer. */
export const readBrand = cache(async (): Promise<OrgBrand | null> => {
  try {
    // UX-TENANT: the company whose address this is.
    const r = await fetch(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/api/v0/brand`, { cache: "no-store", headers: hostHeader(await headers()), signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() as OrgBrand : null;
  } catch { return null; }
});

/** R51: the company's IANA time zone, for server pages that count days (lib/zone.mjs). */
export async function orgZone(): Promise<string> {
  return (await readBrand())?.timeZone ?? FALLBACK_ZONE;
}
