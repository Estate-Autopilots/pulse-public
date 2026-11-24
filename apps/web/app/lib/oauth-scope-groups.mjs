// AI-CONNECT (owner, 8 Nov 2026: "copy the MCP link, add it, and you can log in easily"): the OAuth scopes an AI app
// asks for, in six plain groups. The consent screen shows one tick box per group instead of 27 lines, and Settings →
// Connect your AI says what each connected app may do in the same words. Every scope in OAUTH_SCOPES
// (oauth-web.mjs, services/api/src/oauth.ts) is in exactly one group (test: oauth-scope-groups.test.mjs).
// No imports: the settings page (a client component) and the consent screen (a route) both use it.

/** @typedef {{ key: string, label: string, short: string, scopes: readonly string[] }} ScopeGroup */
/** @type {readonly ScopeGroup[]} */
export const SCOPE_GROUPS = Object.freeze([
  { key: "read", label: "See your docs, tasks and projects, and find colleagues", short: "sees docs, tasks and projects",
    scopes: ["docs.read", "tasks.read", "projects.read", "search.read", "people.read"] },
  { key: "write", label: "Write and change docs, tasks and projects as you", short: "writes docs, tasks and projects",
    scopes: ["docs.write", "tasks.write", "projects.write"] },
  { key: "contracts", label: "Read your contracts, and draft and change them as you (a change after sending makes a new version)", short: "contracts",
    scopes: ["contracts.read", "contracts.write"] },
  { key: "quotes", label: "Read quotes and bills, draft new quotes and find clients, if your role allows it", short: "quotes and clients",
    scopes: ["billing.read", "billing.write", "companies.read", "companies.write"] },
  { key: "chats", label: "Read your chats and send messages as you", short: "chats",
    scopes: ["chats.read", "chats.write"] },
  { key: "more", label: "Other areas your role opens: leave, finance, PR Studio, bug reports and your company's other apps", short: "other areas",
    scopes: ["hr.read", "hr.write", "finance.read", "finance.write", "pr.read", "pr.write", "events.read", "events.write",
      "connectors.read", "connectors.write", "people.write"] },
].map((g) => Object.freeze({ ...g, scopes: Object.freeze(g.scopes) })));

/** The groups that hold at least one of these scopes, each with only those scopes. */
export function groupsOf(scopes) {
  const set = new Set(scopes);
  return SCOPE_GROUPS.map((g) => ({ ...g, scopes: g.scopes.filter((s) => set.has(s)) })).filter((g) => g.scopes.length);
}

/** What a connected app may do, in one short line ("sees docs, tasks and projects · contracts"). */
export function scopeSummary(scopes) {
  const groups = groupsOf(scopes);
  return groups.length ? groups.map((g) => g.short).join(" · ") : "nothing yet";
}

/** The scopes left after the person's ticks: only scopes the app asked for, only in the groups ticked. */
export function narrowScopes(asked, tickedGroups) {
  const keep = new Set(SCOPE_GROUPS.filter((g) => tickedGroups.includes(g.key)).flatMap((g) => g.scopes));
  return [...new Set(asked)].filter((s) => keep.has(s));
}
