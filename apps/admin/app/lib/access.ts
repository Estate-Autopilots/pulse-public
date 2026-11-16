import { cache } from "react";

import { read } from "./api";

/** Who is signed in to the admin site (PULSE-ADMIN): read once per request from Pulse's /api/v0/me. */
export type ConsoleAccess = Readonly<{
  state: "verified" | "signed-out" | "refused" | "unavailable";
  email: string | null;
  displayName: string | null;
  role: string | null;
  orgName: string | null;
  platformAdmin: boolean;
  reason?: string;
}>;

type Me = { email?: string; name?: string; role?: string; orgName?: string; person?: string | null; platformAdmin?: boolean; mustChange?: boolean };

export const loadAccess = cache(async (): Promise<ConsoleAccess> => {
  const me = await read<Me>("me");
  if (me.error || !me.data) {
    const state = me.status === 401 ? "signed-out" : me.status === 403 ? "refused" : "unavailable";
    return { state, email: null, displayName: null, role: null, orgName: null, platformAdmin: false, reason: me.error };
  }
  const d = me.data;
  const platformAdmin = d.platformAdmin === true && !d.mustChange;
  return {
    state: platformAdmin ? "verified" : "refused",
    email: d.email ?? null,
    displayName: d.name ?? null,
    role: d.role ?? null,
    orgName: d.orgName ?? null,
    platformAdmin,
    reason: platformAdmin ? undefined : d.mustChange ? "Choose your own Pulse password in Pulse first, then come back." : "Only Pulse’s platform admins use the admin console.",
  };
});
