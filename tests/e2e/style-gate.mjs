// The unstyled-page gate (RELEASE-DEV release-proof.mjs, as in tasks-p0-shots.mjs): run in the page with
// page.evaluate(STYLE_AUDIT, { theme, width }); returns { problems, stats }. Stylesheets loaded, module classes defined,
// no browser-default controls, the theme background, the app font, a framed page, nothing spilling sideways.
export const STYLE_AUDIT = ({ theme, width }) => {
  const problems = []; const stats = {};
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const c = getComputedStyle(el); return c.visibility !== "hidden" && c.display !== "none"; };
  const label = (el) => `${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "").split(" ")[0]} «${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}»`;
  let rules = 0; const defined = new Set();
  const walk = (list) => { for (const r of list) { rules++; if (r.selectorText) for (const m of r.selectorText.matchAll(/\.([A-Za-z_-][\w-]*)/g)) defined.add(m[1]); if (r.cssRules) walk(r.cssRules); } };
  for (const s of document.styleSheets) { try { walk(s.cssRules); } catch { problems.push(`stylesheet unreadable: ${s.href}`); } }
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) if (!l.sheet) problems.push(`stylesheet not applied: ${l.getAttribute("href")}`);
  stats.rules = rules; if (rules < 300) problems.push(`only ${rules} CSS rules on the page`);
  const missing = new Map(); let moduleClasses = 0;
  for (const el of document.querySelectorAll("body [class]")) {
    if (el instanceof SVGElement || !visible(el)) continue;
    const bad = []; let good = 0;
    for (const t of el.classList) { const hashed = /module__/.test(t); if (hashed) moduleClasses++; if (t === "undefined" || t === "null" || t === "false" || (hashed && !defined.has(t))) bad.push(t); else if (hashed && defined.has(t)) good++; }
    if (!good) for (const t of bad) missing.set(t, label(el));
  }
  stats.moduleClasses = moduleClasses; if (moduleClasses < 20) problems.push(`only ${moduleClasses} CSS-module class names on visible elements`);
  for (const [t, where] of [...missing].slice(0, 8)) problems.push(`class "${t}" has no CSS rule (${where})`);
  for (const b of document.querySelectorAll("button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea")) {
    if (!visible(b)) continue; const c = getComputedStyle(b);
    if (getComputedStyle(b).opacity === "0") continue;
    if (c.borderTopStyle === "outset" || (c.borderTopStyle === "inset" && b.matches("input,textarea") && c.borderTopWidth === "2px") || c.fontSize === "13.3333px") problems.push(`unstyled control ${label(b)}: border ${c.borderTopStyle} ${c.borderTopWidth}, font ${c.fontSize}`);
  }
  const lum = (rgb) => { const m = rgb.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0]; return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return "rgb(255, 255, 255)"; };
  const main = document.querySelector("main"); const bg = bgOf(main ?? document.body); stats.background = bg;
  if (theme === "dark" ? lum(bg) > 0.35 : lum(bg) < 0.6) problems.push(`background ${bg} does not match the ${theme} theme`);
  const font = getComputedStyle(document.body).fontFamily; if (/^"?Times/i.test(font) || font === "serif") problems.push(`body font is the browser default (${font})`);
  if (!main || !visible(main)) problems.push("no visible <main>");
  else {
    const m = main.getBoundingClientRect();
    if (m.width < (width >= 1180 ? 0.5 : 0.85) * innerWidth) problems.push(`main is only ${Math.round(m.width)} px wide`);
    if (m.height < 200) problems.push(`main is only ${Math.round(m.height)} px tall`);
    if (![...document.querySelectorAll("main h1, main h2, h1, h2, main h3, [role=heading]")].some(visible)) problems.push("no visible page heading");
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page is ${document.documentElement.scrollWidth} px wide at ${innerWidth}`);
  const clipped = (el) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const c = getComputedStyle(e); if (c.overflowX !== "visible" || c.position === "fixed") return true; } return false; };
  const spill = [...(main?.querySelectorAll("*") ?? [])].filter((el) => !(el instanceof SVGElement) && visible(el) && el.getBoundingClientRect().right > innerWidth + 2 && !clipped(el));
  if (spill.length) problems.push(`${spill.length} element(s) run past the right edge, e.g. ${label(spill[0])}`);
  return { problems, stats };
};
