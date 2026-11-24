// ROLE-FIX (QA-2 role walk, 18 Nov 2026): which menu places leave with the entries the app removed for a person (a null
// rename from apps/web/app/lib/nav.ts: a role rule, a hidden screen, a switched-off module). Plain functions, no React:
// the web's unit tests import it (apps/web/app/lib/role-fix.test.mjs).

/** The entries the app removed for this person (a null rename). */
export const removedOf = (rename?: Readonly<Record<string, string | null>>): string[] =>
  Object.entries(rename ?? {}).filter(([, label]) => label === null).map(([href]) => href);

/** Whether an address is gone with a removed entry: an entry without a query takes its page and everything under it; one
 *  with a query (Work → Projects, /tasks?view=projects) only itself. Query entries used to be skipped, so HR's menu kept
 *  Work → Projects, which nav.ts removes for HR, and the page said "This account has HR access only". */
export function removedUnder(href: string, removed: readonly string[]): boolean {
  const path = href.split(/[?#]/)[0];
  return removed.some((base) => base.includes("?") ? href === base : path === base || path.startsWith(base + "/"));
}
