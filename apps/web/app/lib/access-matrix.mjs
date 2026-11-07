// UX-PEOPLE (owner, 5 Nov 2026: "one permissions matrix, not a tab per role"): what each person can do in Pulse, read
// from the roles they hold (the role templates) and the five named HR grants, exactly as the service enforces them
// (settings.ts, pulse.hr_can, the work rules). Nothing here grants anything: changes still go through
// POST settings/roles and settings/permissions, which make the same checks as before.
// DE-EA: the team word is the company's own. The tables keep {team}/{Team} tokens; accessWords(words) says them (a screen
// passes useWords()); the plain exports say them in the neutral vocabulary ("Team").
import { say } from "./words.mjs";

/** The role templates, in the order the matrix shows them. `pod` roles act on their assigned team. */
const RAW_TEMPLATES = [
  { key: "admin", title: "Organisation admins", short: "Admin", one: "organisation admin", hue: 262, sees: "everything in Pulse, including Leadership, Settings and editing records; restricted HR data needs the named grants" },
  { key: "hr", title: "HR", short: "HR", one: "HR", hue: 330, sees: "all people data, attendance and leave, payroll, employee invites and reset requests" },
  { key: "leadership", title: "Leadership", short: "Leadership", one: "leadership", hue: 30, sees: "all people, company performance, salaries and money" },
  { key: "finance", title: "Finance", short: "Finance", one: "Finance", hue: 150, sees: "Billing: invoices, quotations, credit notes, payments, the catalogue and stock (not salaries or other Finance views)" },
  { key: "manager", title: "Managers", short: "Manager", one: "manager", hue: 200, pod: true, sees: "their assigned {team}’s work, performance, attendance and leave" },
  { key: "pgs", title: "PGS", short: "PGS", one: "PGS", hue: 185, pod: true, sees: "their assigned {team}’s work, performance, attendance and leave" },
  { key: "head_pgs", title: "{Team} leads", short: "{Team} lead", one: "{team} lead", hue: 220, pod: true, sees: "their assigned {team}’s work, performance, attendance and leave" },
  // KAZUK-FLOW (1670): a salesperson runs their own deals in Billing; the sales head sees the whole team's.
  { key: "sales", title: "Sales", short: "Sales", one: "salesperson", hue: 100, sees: "their own deals in Billing: quotations, invoices and payments, and the catalogue's prices (never its cost)" },
  { key: "sales_head", title: "Sales heads", short: "Sales head", one: "sales head", hue: 120, sees: "every salesperson's deals in Billing, and the catalogue's prices (never its cost)" },
];

/** The five named HR permissions (pulse.sensitive_permission). */
export const NAMED = [
  { key: "hr.salary.read", label: "Read salary", what: "see salary history and the payroll overview" },
  { key: "hr.salary.write", label: "Edit salary", what: "record a new salary figure for a person" },
  { key: "hr.contact.read", label: "Read personal contact", what: "see personal phone, personal e-mail and emergency contact" },
  { key: "hr.contact.write", label: "Edit personal contact", what: "change personal phone, personal e-mail and emergency contact" },
  { key: "hr.documents.read", label: "Read HR document names", what: "see which letters and identity documents are on file (names only, never the contents)" },
];

// Per capability, what each kind of account gets: "yes", "no", "grant" (only with a named grant) or a few words for a
// part (their pod). `pod` is manager, PGS and pod lead. Read from the old "What each role can do" table (EST-1205).
// `hint`: for a role that does not get it, what does give it (said in the cell's tooltip and the person view).
const C = (key, group, label, short, cells, note, hint) => ({ key, group, label, short, cells, note: note ?? undefined, hint });
const RAW_CAPABILITIES = [
  C("work", "People and work", "See other people’s work and performance", "Others’ work", { employee: "no", pod: "Their {team}", hr: "People data only", leadership: "yes", finance: "no", admin: "yes" }),
  C("time", "People and work", "See other people’s attendance and leave", "Attendance", { employee: "no", pod: "Their {team}", hr: "yes", leadership: "yes", finance: "no", admin: "yes" }),
  C("edit", "People and work", "Edit people and past HR months", "Edit people", { employee: "no", pod: "no", hr: "yes", leadership: "yes", finance: "no", admin: "yes" }),
  C("approve", "HR requests", "Approve leave and requests within policy", "Approve", { employee: "no", pod: "Their {team}", hr: "yes", leadership: "yes", finance: "no", admin: "yes" }, "Nobody decides their own request"),
  C("override", "HR requests", "Override with a reason; set {team} heads and working patterns", "Override", { employee: "no", pod: "no", hr: "yes", leadership: "yes", finance: "no", admin: "yes" }),
  C("money", "Money", "Company performance, Finance and billing", "Money", { employee: "no", pod: "no", hr: "no", leadership: "yes", finance: "Billing only", sales: "Own deals in Billing", sales_head: "Team's deals in Billing", admin: "no" }, null, { admin: "Only with Leadership" }),
  C("invite", "Administration", "Invite staff and answer password resets", "Invite", { employee: "no", pod: "no", hr: "yes", leadership: "no", finance: "no", admin: "yes" }, "HR cannot issue leadership or admin credentials"),
  C("access", "Administration", "Change roles, groups and access", "Access", { employee: "no", pod: "no", hr: "no", leadership: "no", finance: "no", admin: "yes" }),
];

/** The templates and capabilities in a company's words (`words` as useWords() gives them; null for the neutral ones). */
function tables(words) {
  const s = (t) => say(t, words);
  const templates = RAW_TEMPLATES.map((t) => ({ ...t, title: s(t.title), short: s(t.short), one: s(t.one), sees: s(t.sees) }));
  const capabilities = RAW_CAPABILITIES.map((c) => ({ ...c, label: s(c.label), cells: Object.fromEntries(Object.entries(c.cells).map(([k, v]) => [k, s(v)])) }));
  return { TEMPLATES: templates, TEMPLATE: Object.fromEntries(templates.map((t) => [t.key, t])), CAPABILITIES: capabilities, teamWord: s("{team}") };
}
const NEUTRAL = tables(null);
export const TEMPLATES = NEUTRAL.TEMPLATES;
export const TEMPLATE = NEUTRAL.TEMPLATE;
export const CAPABILITIES = NEUTRAL.CAPABILITIES;
/** What everyone can do, whatever their roles. */
export const EVERYONE = ["Their own profile, performance, attendance and leave", "The team directory (without restricted fields)", "Chats: their channels and direct messages", "Ask HR for leave, corrections and other requests"];

const RANK = { no: 0, grant: 1, part: 2, yes: 3 };
const kindOf = (v) => v === "yes" || v === "no" || v === "grant" ? v : "part";
const columnOf = (role) => TEMPLATE[role]?.pod ? "pod" : role;

/** One capability for a set of roles: the widest any role gives, and which role gives it. */
export function capability(cap, roles) {
  let best = { level: "no", text: "No", from: null };
  for (const role of roles) {
    const v = cap.cells[columnOf(role)]; if (v === undefined) continue;
    const level = kindOf(v);
    if (RANK[level] > RANK[best.level]) best = { level, text: level === "yes" ? "Yes" : level === "grant" ? "Needs permission" : v, from: role };
  }
  if (best.level === "no") { const h = roles.map((r) => cap.hint?.[columnOf(r)]).find(Boolean); if (h) best = { ...best, text: h }; }
  return best;
}

const ROLE_DATA = ["hr", "leadership"];
/** A named HR permission for one person: by role, by grant, a grant without effect, or no.
 *  Off the named list, HR and leadership hold every one by role; on it, salary needs the grant for every role. */
export function named(key, roles, grants, salaryListOn) {
  const grant = grants.find((g) => g.permission === key) ?? null;
  const byRole = roles.some((r) => ROLE_DATA.includes(r)) && !(salaryListOn && key.startsWith("hr.salary."));
  const roleOk = roles.some((r) => r === "admin" || ROLE_DATA.includes(r));
  if (grant && roleOk && grant.effective !== false) return { level: "yes", text: "Granted", grant, byRole };
  if (byRole) return { level: "yes", text: "By role", grant, byRole };
  if (grant) return { level: "idle", text: "Grant has no effect", grant, byRole };
  return { level: "no", text: "No", grant: null, byRole };
}

/** The work-rule column a person falls in (Settings → Who can do what): leadership & admins, HR, pod heads, members. */
export function workRole(roles, leadsSomeone) {
  if (roles.includes("leadership") || roles.includes("admin")) return "leadership";
  if (roles.includes("hr")) return "hr";
  if (leadsSomeone || roles.some((r) => TEMPLATE[r]?.pod)) return "pod_head";
  return "member";
}

/** Everything one person can do, for the "What can this person do" view and the matrix row. */
export function profile(person, holders, grants, salaryListOn, t = NEUTRAL) {
  const { CAPABILITIES } = t;
  const roles = holders.filter((h) => h.personId === person.id).map((h) => h.role);
  const own = grants.filter((g) => g.personId === person.id);
  const caps = CAPABILITIES.map((c) => ({ ...c, ...capability(c, roles) }));
  const perms = NAMED.map((n) => ({ ...n, ...named(n.key, roles, own, salaryListOn) }));
  return { roles, caps, perms, can: caps.filter((c) => c.level !== "no").length + perms.filter((p) => p.level === "yes").length, idle: perms.filter((p) => p.level === "idle") };
}

/** A bulk change as single requests, leaving out the ones that would change nothing (or that the service refuses for
 *  a plain reason we already know: ending your own admin role, a team role for someone without a team). */
export function planBulk(people, holders, action, role, viewer, t = NEUTRAL) {
  const { TEMPLATE } = t;
  const plan = [], skipped = [];
  for (const p of people) {
    const has = holders.some((h) => h.personId === p.id && h.role === role);
    if (action === "grant" && has) skipped.push({ person: p, why: `already ${TEMPLATE[role]?.one ?? role}` });
    else if (action === "revoke" && !has) skipped.push({ person: p, why: `not ${TEMPLATE[role]?.one ?? role}` });
    else if (action === "revoke" && role === "admin" && p.id === viewer) skipped.push({ person: p, why: "you cannot end your own admin role" });
    else if (action === "grant" && TEMPLATE[role]?.pod && !p.pod) skipped.push({ person: p, why: `needs a ${t.teamWord} first` });
    else plan.push({ personId: p.id, name: p.name, role, action });
  }
  return { plan, skipped };
}

/** Everything above in one company's words: the tables, and profile and planBulk saying them. */
export function accessWords(words) {
  const t = tables(words);
  return { ...t, profile: (person, holders, grants, salaryListOn) => profile(person, holders, grants, salaryListOn, t),
    planBulk: (people, holders, action, role, viewer) => planBulk(people, holders, action, role, viewer, t) };
}
