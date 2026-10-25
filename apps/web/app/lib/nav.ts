// The rail a person sees, worked out once for the root layout and for pages that list it again (the sales home's
// "All modules", EST-1241), so both always match. Server only: it reads the install's Network settings.
import type { ShellRename } from "@pulse/ui-shell";
import type { Me } from "./api";
import { hiddenRename } from "./screens.mjs";

/** The shell picks a role's pages by this label. */
export function roleLabelFor(me: Pick<Me, "role"> & Partial<Pick<Me, "side" | "account">>): string {
  // E2E-4P: someone seated here through a connection is a client (or, for the inviting company's people, a partner).
  if (me.side === "client") return me.account?.orgs?.find((o) => o.current)?.kind === "partner" ? "Partner" : "Client";
  return me.role === "accountant" ? "Accountant" : me.role === "admin" ? "Organisation owner/admin" : me.role === "hr" ? "HR" : me.role === "leadership" ? "Leadership"
    : me.role === "finance" ? "Finance" : ["manager", "pgs"].includes(me.role) ? "Manager / PGS" : "Member";
}

/** E2E-4P: the staff screens a client's seat never sees (their own profile, /people/<them>, stays open). */
export const CLIENT_CLOSED = ["/dashboard", "/people", "/creative", "/clients", "/projects", "/delivery", "/deliveries", "/finance", "/money", "/erp", "/hr", "/hr-history", "/shifts",
  "/leadership", "/pod", "/pods", "/contacts", "/relationships", "/acquisition", "/map", "/processes", "/sops", "/runs", "/hq", "/network", "/review-data", "/opshub",
  "/audit", "/features", "/me", "/my-week", "/connections", "/designers", "/activity", "/apps/sales-xray", "/briefs", "/kit", "/brand", "/connect", "/companies",
  "/updates", "/stewardship", "/intelligence", "/insights", "/communication", "/groups", "/attendance", "/leave", "/welcome", "/steps", "/workflows", "/offer-studio"];

/** What leaves or renames rail entries for this person (a null removes an entry). */
export function navFor(me: Me | undefined, hasUpdates = false) {
  const accountant = me?.role === "accountant";
  // UX-TENANT: modules the company switched off in its setup leave the rail too (null removes a page).
  const switches = me?.companyModules;
  const off: Record<string, null> = switches ? { ...(switches.tasks === false ? { "/tasks": null } : {}), ...(switches.chats === false ? { "/chats": null } : {}),
    ...(switches.finance === false ? { "/finance": null, "/erp": null } : {}) } : {};
  // UX-TASKS-2: the rail follows the business model (a product company's Products / Customers / Releases; none for an internal team).
  const words = me?.workLabels;
  // FLOW-E: a company's own words (Settings → Industry & roles: Customers, Sites, Jobs) rename the rail too.
  const own = me?.words;
  const renamed = words && (words.model !== "agency" || own) ? { "/clients": words.section, "/projects": words.clientProjects,
    ...(own?.runs && own.runs !== "Runs" ? { "/runs": own.runs } : {}) } : undefined;
  // PULSE-NETWORK (EST-1026): the Network entry shows only where this company's connector is set up.
  const networkOff: Record<string, null> = process.env.PULSE_NETWORK_URL && process.env.PULSE_NETWORK_CONNECTOR_KEY_FILE ? {} : { "/network": null };
  // EST-1420: screens the organisation hides from this person's role leave every menu too.
  // E2E-4P: a client's seat has Work and Chats (and their own account, profile and preferences): every staff module
  // leaves the menus, and a direct link shows "Not part of your access" (hidden/notice.tsx).
  const hiddenPaths = accountant || me?.mustChange ? undefined : me?.side === "client" ? [...new Set([...(me.hiddenScreens?.paths ?? []), ...CLIENT_CLOSED])] : me?.hiddenScreens?.paths;
  const updatesOff: Record<string, null> = me?.person && !accountant && !me.mustChange && hasUpdates ? {} : { "/updates": null };
  // CLIENT-PORTAL: the client's home is only for a client's seat.
  const clientHome: Record<string, null> = me?.side === "client" ? {} : { "/client": null };
  const hidden = { ...off, ...networkOff, ...hiddenRename(hiddenPaths), ...updatesOff, ...clientHome };
  const rename: ShellRename | undefined = renamed || Object.keys(hidden).length ? { ...renamed, ...hidden } as ShellRename : undefined;
  return { off, hiddenPaths, rename };
}
