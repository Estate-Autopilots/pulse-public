// The rail a person sees, worked out once for the root layout and for pages that list it again (the sales home's
// "All modules", EST-1241), so both always match. Server only: it reads the install's Network settings.
import type { ShellRename } from "@pulse/ui-shell";
import type { Me } from "./api";
import { hiddenRename } from "./screens.mjs";

/** The shell picks a role's pages by this label. */
export function roleLabelFor(me: Pick<Me, "role"> & Partial<Pick<Me, "side" | "account" | "lead" | "salesSeat">>): string {
  // E2E-4P: someone seated here through a connection is a client (or, for the inviting company's people, a partner).
  if (me.side === "client") return me.account?.orgs?.find((o) => o.current)?.kind === "partner" ? "Partner" : "Client";
  // VISIBLE: HR who also holds leadership gets both rails' pages ("HR and leadership" in the shell).
  return me.role === "accountant" ? "Accountant" : me.role === "admin" ? "Organisation owner/admin" : me.role === "hr" ? (me.lead ? "HR and leadership" : "HR") : me.role === "leadership" ? "Leadership"
    : me.role === "finance" ? "Finance" : ["manager", "pgs"].includes(me.role) ? "Manager / PGS" : me.salesSeat ? "Sales" : "Member";
}

/** E2E-4P: the staff screens a client's seat never sees (their own profile, /people/<them>, stays open). */
export const CLIENT_CLOSED = ["/dashboard", "/people", "/creative", "/clients", "/projects", "/delivery", "/deliveries", "/finance", "/money", "/erp", "/hr", "/hr-history", "/shifts",
  "/leadership", "/pod", "/pods", "/contacts", "/relationships", "/acquisition", "/map", "/processes", "/sops", "/runs", "/hq", "/network", "/review-data", "/opshub",
  "/audit", "/admin", "/features", "/me", "/my-week", "/connections", "/designers", "/activity", "/apps/sales-xray", "/briefs", "/kit", "/brand", "/connect", "/companies",
  "/updates", "/stewardship", "/intelligence", "/insights", "/communication", "/groups", "/attendance", "/leave", "/welcome", "/steps", "/workflows", "/offer-studio", "/appointments",
  // IA-NAV: the staff screens the new menu shows (a client's seat never had them).
  "/meetings", "/listen", "/pr", "/goals", "/sales"];

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
  // PRIVACY (owner, 2 Nov 2026): a freelancer's seat closes the same staff screens (the API refuses them too: routes.ts).
  const hiddenPaths = accountant || me?.mustChange ? undefined : me?.side === "client" || me?.side === "freelancer" ? [...new Set([...(me.hiddenScreens?.paths ?? []), ...CLIENT_CLOSED])] : me?.hiddenScreens?.paths;
  const updatesOff: Record<string, null> = me?.person && !accountant && !me.mustChange && hasUpdates ? {} : { "/updates": null };
  // CLIENT-PORTAL: the client's home is only for a client's seat.
  const clientHome: Record<string, null> = me?.side === "client" ? {} : { "/client": null };
  // PULSE-ADMIN (1140): the admin console is for Pulse's platform admins only.
  // SETTINGS-APPLE (T1.3.4): from any company the person is in (their account's seat in the install's own company).
  const platformOff: Record<string, null> = (me?.platformAdmin || me?.platformConsole) && !me.mustChange ? {} : { "/admin": null };
  // SELF-SERVE (review, 5 Nov 2026): Appointments and Add and invite belong to a space set up by sign-up (a practice, a
  // shop …); a company set up otherwise (EA, AC, WL) keeps its Clients menu as it was (Pulse access invites there).
  const spaceOff: Record<string, null> = me?.space ? {} : { "/appointments": null, "/clients/add": null };
  // PERSONAL-WORKSPACE (1640): a personal workspace is one person's life and work, not a company: Goals and My brand are
  // its own; the company's people, HR, leadership, clients and process screens leave its rail (a link still opens them).
  // A company keeps its rail as it was (Goals open from Work; PR Studio from its own link).
  const personal = me?.orgKind === "personal";
  // IA-NAV (owner, 10 Nov 2026: "I don't even see where PR Studio is"): a company shows Goals and PR Studio too, under
  // Money and Growth. PR Studio, AI employees and My sales are for the people who can use them (pulse.pr_can(): admins
  // and leadership; the AI workload: admins and leaders; a sales seat's own home).
  const kindOff: Record<string, null> = personal
    ? { "/people": null, "/hr": null, "/leadership": null, "/insights": null, "/acquisition": null, "/contacts": null, "/map": null, "/processes": null, "/runs": null,
        "/review-data": null, "/clients": null, "/updates": null, "/people/ai": null, "/sales": null }
    : {};
  // GAP-FOUNDER-VIEW: "All my companies" lives in the person's own workspace, and only for someone who is the owner or an
  // admin of two or more companies (account_seat_looks' access, ORG-SWITCHER-UX); nowhere else.
  const runs = (me?.account?.orgs ?? []).filter((o) => o.orgKind !== "personal" && (o.access === "owner" || o.access === "admin")).length;
  const founderOff: Record<string, null> = personal && runs >= 2 ? {} : { "/founder": null };
  const lead = me?.role === "admin" || me?.role === "leadership" || !!me?.lead;
  // VISUAL-QA (owner, 10 Nov 2026: "the nav shows Finance and the page is a dead 'Finance access required' box"):
  // Finance leaves the menu for anyone it would refuse (no money.read / money.amount.read grants). A direct link still
  // explains, and tells an admin how to give themselves the Finance role.
  const financeOff: Record<string, null> = accountant || me?.financeAccess !== false ? {} : { "/finance": null };
  // VISUAL-QA: Billing too: an admin without the Finance role or the money grants got Money → Billing and its seven
  // places, each "This view is unavailable: ERP is for leadership, Finance and the Accountant".
  const billingOff: Record<string, null> = accountant || me?.billingAccess !== false ? {} : { "/erp": null, "/erp/documents?view=quotation": null, "/money": null };
  // VISUAL-QA: Bug reports → From other companies is the Pulse dev organisation's inbox; anywhere else it only explains that.
  const devOff: Record<string, null> = me?.devOrg === false ? { "/bug-reports/dev": null } : {};
  // VISUAL-QA (12 Nov 2026): People & pay too, for the roles whose menu has it (admin, leadership, HR): without the salary
  // grant (/me hrAccess, the same answer as GET comp/people) it said "This view is unavailable" from nine pages.
  const payOff: Record<string, null> = me && ["admin", "leadership", "hr"].includes(me.role) && me.hrAccess === false ? { "/people/pay": null } : {};
  // VISUAL-QA (12 Nov 2026, round 2 HR pass): an HR-only account (HR, not a lead) is refused by these Work and Team pages
  // (the API's work(): "This account has HR access only"), yet its menu listed them and lit My week on the refusal.
  const hrOnlyOff: Record<string, null> = me?.role === "hr" && !me.lead ? { "/my-week": null, "/tasks?view=projects": null, "/designers": null } : {};
  const roleOff: Record<string, null> = { ...(lead || personal ? {} : { "/pr": null, "/people/ai": null }), ...(me?.salesSeat ? {} : { "/sales": null }), ...financeOff, ...billingOff, ...devOff, ...payOff, ...hrOnlyOff };
  const hidden = { ...off, ...networkOff, ...hiddenRename(hiddenPaths), ...updatesOff, ...clientHome, ...platformOff, ...spaceOff, ...kindOff, ...roleOff, ...founderOff };
  const rename: ShellRename | undefined = renamed || Object.keys(hidden).length ? { ...renamed, ...hidden } as ShellRename : undefined;
  return { off, hiddenPaths, rename };
}
