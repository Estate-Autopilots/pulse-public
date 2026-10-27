/** The phone's bottom bar holds this many pages; More holds the rest and Settings. */
export const MOBILE_TABS = 4;
/** EST-1198: Home, Work, Chats and Me (My desk: check-in, leave and requests) come first for every role that has them. */
const FIRST: readonly string[] = ["/dashboard", "/client", "/tasks", "/chats", "/me"];

/** The role's phone tabs, in rail order: the everyday pages first, then the role's next pages (HR's desk) to fill the bar. */
export function mobileTabs<T extends { href: string }>(pages: readonly T[], size = MOBILE_TABS): T[] {
  const chosen = new Set(pages.filter((page) => FIRST.includes(page.href)).slice(0, size).map((page) => page.href));
  for (const page of pages) { if (chosen.size >= size) break; chosen.add(page.href); }
  return pages.filter((page) => chosen.has(page.href));
}
