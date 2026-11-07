// EST-1420: screens an organisation hides from a role (Settings → Modules → Screens and menu; the API's registry is
// services/api/src/screens.ts). /me names the page bases this person's role does not see; their menu entries go and a
// direct link lands on /hidden before the page renders. Hiding is not a permission: nothing else changes.

/** Whether the path is one of the bases or below one. */
export function underBase(path, bases) {
  const p = (path ?? "").split(/[?#]/)[0];
  return !!bases?.some((base) => p === base || p.startsWith(base + "/"));
}

/** The shell's rename entries that take the hidden screens off the rail, the phone tabs and both palettes. */
export function hiddenRename(bases) {
  return Object.fromEntries((bases ?? []).map((base) => [base, null]));
}

/** Where a direct link to a hidden page goes, or null. The hidden page itself and the person's own profile never count. */
export function hiddenRedirect(path, bases, person) {
  if (!path || path === "/hidden" || (person && underBase(path, [`/people/${person}`]))) return null;
  return underBase(path, bases) ? "/hidden" : null;
}
