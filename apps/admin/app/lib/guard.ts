import type { NextRequest } from "next/server";

import { adminConfig } from "./config.ts";

/** A change must come from this admin site's own pages: its Origin is this host (PULSE-ADMIN; cookies are SameSite=Strict too). */
export function sameOrigin(request: Pick<NextRequest, "headers">): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    const from = new URL(origin);
    // Behind Pulse's web (production) the Host may be the admin server's own; this site's configured hosts count too.
    return (!!host && from.host === host) || (from.protocol === "https:" && adminConfig().hosts.includes(from.hostname));
  } catch {
    return false;
  }
}

export const secureCookie = (request: Pick<NextRequest, "headers" | "nextUrl">) =>
  request.headers.get("x-forwarded-proto") === "https" || request.nextUrl.protocol === "https:" || process.env.NODE_ENV === "production";
