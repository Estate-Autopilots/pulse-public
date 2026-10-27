// LAYOUT-SWEEP: the organisation's own logo (Settings → Organisation, pulse.org_brand). Read without a sign-in: the
// sign-in page shows it before anyone signs in.
export type OrgBrand = { name: string | null; version: number; mark: boolean; logo: boolean; logoDark: boolean; logoPng: boolean; accent?: string | null; code?: string; timeZone?: string | null };
export type OrgLogo = { name: string; mark: string | null; logo: string | null; logoDark: string | null };

/** The addresses the browser loads (through the app's API proxy); each carries the version, so a new logo shows at once. */
export function orgLogo(b: OrgBrand | null): OrgLogo | null {
  if (!b?.name) return null;
  const at = (kind: string, has: boolean) => has ? `/api/v0/brand/${kind}?v=${b.version}` : null;
  return { name: b.name, mark: at("mark", b.mark), logo: at("logo", b.logo), logoDark: at("logo-dark", b.logoDark) };
}

/** UX-TENANT: the company's accent becomes Pulse's action colour (buttons, links, focus). The dark theme uses a lighter
 *  mix so it stays readable on the dark canvas. Only a validated #rrggbb reaches this (database check). */
export function accentCss(accent: string | null | undefined): string | null {
  if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) return null;
  return `:root,:root[data-theme="light"]{--theme-action:${accent};--theme-action-hover:color-mix(in oklab,${accent} 84%,black);--theme-focus:color-mix(in oklab,${accent} 70%,white)}`
    + `:root[data-theme="dark"]{--theme-action:color-mix(in oklab,${accent} 55%,white);--theme-action-hover:color-mix(in oklab,${accent} 42%,white);--theme-focus:color-mix(in oklab,${accent} 45%,white)}`;
}
