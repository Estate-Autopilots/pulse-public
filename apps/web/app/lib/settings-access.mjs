// UX-SETTINGS-CHAT: which Settings sections each role may open, in one place so the page, its home and the tests read
// the same rules. Admins open every section. Everyone opens their own sections; leadership also sets the industry, AI
// and who reads client groups (FLOW-E, CONNECT-AI, GROUP-ACCESS); HR runs sign-in. Everyone reads Apps and Who can do
// what. "Roles & permissions" is a part of Who can do what for admins only. The API checks every write on its own.

/** A person's own sections, open to every role (AGENT-API: API keys, each person's own tokens). */
export const PERSONAL = Object.freeze(["account", "notifications", "appearance", "privacy", "connected-apps", "api-keys", "devices"]);
/** The company sections each role may open besides PERSONAL (admins: all; a role not named: EVERYONE). */
export const EVERYONE = Object.freeze(["work-rules", "apps"]);
export const BY_ROLE = Object.freeze({
  leadership: Object.freeze(["work-rules", "apps", "ai", "chats", "industry"]),
  hr: Object.freeze(["sign-in", "work-rules", "apps"]),
});

/** Sections for organisation admins only, whatever other lists say. SERVERS-AI: Servers & AI pairs the company's own
 *  servers and starts work on them (the API refuses everyone else: /api/v0/admin/runners*). */
export const ADMIN_ONLY = Object.freeze(["roles", "servers", "connectors"]);

/** May this role open this section? `hrSetup`: the company follows the setup checklist (HR then reads Organisation → Setup). */
export function canOpenSection(role, key, { hrSetup = false } = {}) {
  if (ADMIN_ONLY.includes(key)) return role === "admin";
  if (role === "admin") return true;
  if (PERSONAL.includes(key)) return true;
  if (role === "hr" && key === "organisation" && hrSetup) return true;
  return (BY_ROLE[role] ?? EVERYONE).includes(key);
}
/** Registered developer apps under Connected apps: the install's admins and HR. */
export const seesDeveloperApps = (role) => role === "admin" || role === "hr";
