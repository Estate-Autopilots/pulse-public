// PM-UI: the screen previews are for building and judging only. This app tells a development server from a production
// build by NODE_ENV (`next dev` = "development"; `next build`/`next start` = "production"; app/lib/telemetry-release.ts
// reads it the same way). A production-built QA host can opt in with PULSE_PM_PREVIEW=1. Everything else gets a 404.
import type { ReactNode } from "react";

export const previewEnabled = () => process.env.NODE_ENV === "development" || process.env.PULSE_PM_PREVIEW === "1";

/** A screen slug: lower-case words joined by hyphens (also keeps the dynamic import inside screens/ and fixtures/). */
export const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

type ScreenFn = (props: { vm: never }) => ReactNode | Promise<ReactNode>;
type ScreenModule = { default?: ScreenFn };
type FixturesModule = { states?: Record<string, unknown> };

/** A missing file is "no such screen"; any other error (a bug in the screen) is thrown, so the builder sees it. */
const missing = (e: unknown) => { const x = e as { code?: string; message?: string }; return x?.code === "MODULE_NOT_FOUND" || /Cannot find module|Module not found/i.test(String(x?.message ?? "")); };
async function load<T>(get: () => Promise<T>): Promise<T | null> { try { return await get(); } catch (e) { if (missing(e)) return null; throw e; } }

/** Loads a screen and its fixtures by naming convention (no registry): the default export of `screens/<slug>.tsx` and
 *  `states` of `fixtures/<slug>.ts`. Null when either is missing. */
export async function loadScreen(slug: string): Promise<{ Screen: ScreenFn; states: Record<string, unknown> } | null> {
  if (!SLUG.test(slug)) return null;
  const [screen, fixtures] = await Promise.all([
    load(() => import(`../screens/${slug}.tsx`) as Promise<ScreenModule>),
    load(() => import(`../fixtures/${slug}.ts`) as Promise<FixturesModule>),
  ]);
  if (typeof screen?.default !== "function" || !fixtures?.states || !Object.keys(fixtures.states).length) return null;
  return { Screen: screen.default, states: fixtures.states };
}

/** Loads only a screen's state keys (the index page). */
export async function loadStates(slug: string): Promise<string[] | null> {
  if (!SLUG.test(slug)) return null;
  const fixtures = await load(() => import(`../fixtures/${slug}.ts`) as Promise<FixturesModule>);
  return fixtures?.states ? Object.keys(fixtures.states) : null;
}
