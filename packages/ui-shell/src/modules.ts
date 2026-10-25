/** The modules an organisation can switch off (`tenant/modules` config) and the pages each one owns. Every other
 *  page is always on. Keys match `packages/schemas/config/modules.json`. `/leave` is redirected to My desk → Leave
 *  (next.config) before any page renders, so My desk decides its own tabs. */
export const MODULE_PATHS = {
  designers: ["/designers"],
  map: ["/map"],
  acquisition: ["/acquisition", "/portal"],
  chats: ["/chats", "/communication", "/inbox", "/groups"],
  briefs: ["/briefs"],
  money: ["/finance", "/money", "/erp"],
  hr: ["/hr", "/hr-history", "/shifts", "/leave"],
  // RELEASE-5: lane C's rounds, off until the server switches them on (services/api/src/modules.ts SERVER_SWITCHED).
  relationships: ["/relationships"],
  skills: ["/people/skills"],
  jobs: ["/people/jobs"],
  chat_import: ["/chats/import"],
  // RELEASE-6: R52's connectors have no page of their own: their Settings tab and source card follow the switch.
  connectors: [],
  // EST-1474: the Creative Strategy app.
  creative: ["/creative"],
  // EST-1363: the Sales X-Ray app (the Apps list and the install guides under /apps stay on).
  sales_xray: ["/apps/sales-xray"],
  // PULSE-HQ: Pulse HQ, on only in the Pulse organisation (organisation-only, services/api/src/modules.ts ORG_ONLY).
  pulse_hq: ["/hq"],
} as const satisfies Record<string, readonly string[]>;

export type PulseModule = keyof typeof MODULE_PATHS;

/** The switchable module a page belongs to, or null when the page is always on. The longest base decides
 *  (/chats/import is chat_import's, the rest of /chats is chats'). */
export function moduleForPath(pathname: string | null | undefined): PulseModule | null {
  const path = pathname?.split(/[?#]/)[0] ?? "";
  let found: PulseModule | null = null, length = 0;
  for (const [key, bases] of Object.entries(MODULE_PATHS) as [PulseModule, readonly string[]][])
    for (const base of bases) if ((path === base || path.startsWith(base + "/")) && base.length > length) { found = key; length = base.length; }
  return found;
}

/** Whether the page is hidden because its module is off. */
export function pathSwitchedOff(pathname: string | null | undefined, off: readonly string[] | undefined) {
  const key = moduleForPath(pathname);
  return key !== null && !!off?.includes(key);
}
