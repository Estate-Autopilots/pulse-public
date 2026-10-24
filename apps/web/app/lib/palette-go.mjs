import { DESTINATIONS, canSee, goHref } from "../destinations/registry.mjs";
import { underBase } from "./screens.mjs";

const base = (href) => href.split(/[?#]/)[0];

/** Build local navigation results without React; the palette supplies icons afterwards. */
export function paletteGoItems({ pages, places = [], financeOnly = false, role, modulesOff = [], hidden = [], isSwitchedOff = () => false }) {
  const seen = new Set(), hrefs = new Set([...pages, ...places].map((p) => p.href));
  const go = [];
  const visible = (href) => !isSwitchedOff(href) && !underBase(href, hidden);
  const addPage = (page, menu) => {
    if (!visible(page.href)) return;
    const d = menu ? DESTINATIONS.find((d) => d.kind === "page" && base(d.href) === base(page.href) && canSee(d, { role, modulesOff })) : undefined;
    seen.add(menu ? base(page.href) : page.href);
    go.push({ key: `page:${page.href}`, group: "go", kind: "page", label: page.label, href: page.href, page, path: d?.path, synonyms: d?.synonyms });
  };
  for (const page of pages) addPage(page, true);
  if (financeOnly) return go;
  for (const page of places) if (!seen.has(page.href)) addPage(page, false);
  const reach = pages.map((p) => base(p.href));
  for (const d of DESTINATIONS) {
    if (!canSee(d, { role, modulesOff }) || !visible(d.href)) continue;
    // Keep the menu's renamed page once, and offer destinations on or under its route.
    if ((d.kind === "page" && seen.has(base(d.href))) || hrefs.has(d.href)) continue;
    if (!underBase(d.href, reach) && !["/settings", "/me", "/notifications", "/briefs", "/people"].includes(base(d.href)) && d.access !== "all") continue;
    go.push({ key: `dest:${d.id}`, group: "go", kind: d.kind, label: d.label, path: d.path?.length ? d.path : undefined,
      sub: d.path?.length > 1 ? d.path.slice(0, -1).join(" › ") : undefined, synonyms: d.synonyms, href: goHref(d), coach: d.coach, destination: d });
  }
  return go;
}
