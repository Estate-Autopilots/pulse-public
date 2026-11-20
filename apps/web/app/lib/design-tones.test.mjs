// VITALS-DESIGN (19 Nov 2026): the design system's own rules, checked on the real token files.
// 1. The five work tones (--tone-done/info/action/waiting/problem in tokens.css) are built from the theme's state
//    colours, never a new hex, and every ink reads at 4.5:1 or more on its soft fill, the surface, the canvas and the
//    subtle surface (marks 3:1 on the surface), in light and in dark.
// 2. Space, radius and icon steps sit on the 4 px grid (2 px steps allowed for nothing); type has no step under 12 px.
// 3. The docs purple token pair (below, with its own note).
// 4. The type floor (12 px) on the sidebar's labels and the Team card, and a card name that wraps before it is cut.
// 5. The AI badge at the floor with a ladder icon; the avatar's AI mark is that icon, not tiny text.
// 6. The AI chip's baseline is its text, its space is on the 4 px grid; the avatar's AI tile is a whole-pixel step.
// 7. Chats' count pills, small list headings and privacy note read the scale's xs step; no xs fallback is under 12 px.
// 8. Every count on an icon's shoulder (bell, Chat button, rail, phone tabs, new dots, notify island, workspace toggle,
//    scroll-to-latest, groups filter) reads the xs step at 12 px, on the family's pill heights (16, 18, 20 px).
// 9. Small section labels (tasks, a person's page, Settings) read the xs step; an avatar's initial keeps its floor.
// 10. The kits' small chips and inline counts and the chats start pane: nothing under 12 px in their files.
// 11. Chats' thread text (message times, day and unread chips, captions, the composer and its command menu, the
//     members panel): nothing under 12 px; the spacer under a message keeps its last line clear of the wider time.
// 12. The rest of chats' small text (the groups hub, WhatsApp groups, the chat dock, the jump box and shortcuts, the
//     pickers, polls, the work list, the command card, the workspace panel and the smaller chat cards): nothing under 12 px.
// 13. A chat dialog stays inside a phone (min-width 0 in its grid), the jump box's key hints wrap whole (hidden on touch);
//     the top bar's review count is the 18 px count pill.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../../../packages/design-system/src");
const tokens = fs.readFileSync(path.join(SRC, "tokens.css"), "utf8");
const scale = fs.readFileSync(path.join(SRC, "scale.css"), "utf8");

/** Top-level rule blocks: [selector, { --name: value }]. Blocks inside @media are skipped. */
function blocks(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let depth = 0, sel = "", body = "", inMedia = false;
  for (const ch of src) {
    if (ch === "{") {
      if (depth === 0) { inMedia = sel.trim().startsWith("@"); }
      depth++;
      if (depth === 1 && !inMedia) body = "";
      if (depth > 1 || inMedia) { if (depth === 1) sel = ""; continue; }
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        if (!inMedia) {
          const vars = {};
          for (const d of body.split(";")) { const m = d.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/); if (m) vars[m[1]] = m[2]; }
          out.push([sel.trim().replace(/\s+/g, " "), vars]);
        }
        sel = ""; inMedia = false;
      }
      continue;
    }
    if (depth === 0) sel += ch; else if (!inMedia) body += ch;
  }
  return out;
}

/** The custom properties in force on <html> for a theme, in source order (later blocks win). */
function themeVars(mode) {
  const vars = {};
  for (const css of [tokens, scale]) {
    for (const [sel, v] of blocks(css)) {
      const parts = sel.split(",").map((s) => s.trim());
      const applies = parts.some((s) => s === ":root" || (mode === "light" && s === ':root[data-theme="light"]') || (mode === "dark" && s === ':root[data-theme="dark"]'));
      if (applies) Object.assign(vars, v);
    }
  }
  // specificity: a [data-theme] block beats a bare :root block even when it comes first
  for (const css of [tokens, scale]) for (const [sel, v] of blocks(css)) if (sel.split(",").map((s) => s.trim()).includes(`:root[data-theme="${mode}"]`)) Object.assign(vars, v);
  return vars;
}

const rgb = (h) => { const x = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); };
const toHex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** Resolves a value to a hex: #hex, var(--x[, fallback]), color-mix(in srgb, A p%, B). */
function resolve(value, vars, depth = 0) {
  assert.ok(depth < 12, `too deep: ${value}`);
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  let m = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (m) return resolve(vars[m[1]] ?? m[2] ?? assert.fail(`undefined ${m[1]}`), vars, depth + 1);
  m = v.match(/^color-mix\(\s*in srgb\s*,\s*(var\([^)]*\)|#[0-9a-f]{6})\s+(var\([^)]*\)|[\d.]+%)\s*,\s*(var\([^)]*\)|#[0-9a-f]{6})\s*\)$/i);
  if (m) {
    const share = m[2].startsWith("var(") ? resolvePct(m[2], vars) : parseFloat(m[2]) / 100;
    const a = rgb(resolve(m[1], vars, depth + 1)), b = rgb(resolve(m[3], vars, depth + 1));
    return toHex(a.map((x, i) => x * share + b[i] * (1 - share)));
  }
  return assert.fail(`cannot resolve "${v}"`);
}
function resolvePct(value, vars) {
  const m = value.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\d.]+%))?\)$/);
  const raw = vars[m[1]] ?? m[2];
  return parseFloat(raw) / 100;
}
const lum = (h) => { const [r, g, b] = rgb(h).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const TONES = ["done", "info", "action", "waiting", "problem"];

for (const mode of ["light", "dark"]) {
  test(`the five work tones read at 4.5:1 in ${mode}`, () => {
    const vars = themeVars(mode);
    for (const t of TONES) {
      for (const name of [`--tone-${t}`, `--tone-${t}-soft`, `--tone-${t}-mark`]) {
        assert.ok(vars[name], `${name} is defined for ${mode}`);
        assert.doesNotMatch(vars[name], /#[0-9a-f]{3,8}\b/i, `${name} is built from theme tokens, not a new hex`);
      }
      const ink = resolve(vars[`--tone-${t}`], vars), soft = resolve(vars[`--tone-${t}-soft`], vars), mark = resolve(vars[`--tone-${t}-mark`], vars);
      for (const bg of ["--tone-" + t + "-soft", "--theme-surface", "--theme-canvas", "--theme-surface-subtle"]) {
        const r = ratio(ink, bg.startsWith("--tone") ? soft : resolve(vars[bg], vars));
        assert.ok(r >= 4.5, `${mode} ${t}: ink ${ink} on ${bg} is ${r.toFixed(2)}:1, under 4.5`);
      }
      assert.ok(ratio(mark, resolve(vars["--theme-surface"], vars)) >= 3, `${mode} ${t}: mark under 3:1 on the surface`);
    }
  });
}

test("the action tone is not the iris", () => {
  for (const mode of ["light", "dark"]) {
    const vars = themeVars(mode);
    assert.notEqual(resolve(vars["--tone-action"], vars), resolve(vars["--theme-action"], vars));
  }
});

test("space, radius and icon steps sit on the 4 px grid; type has no step under the 12 px floor", () => {
  const vars = themeVars("light");
  const px = (name) => { const m = String(vars[name]).match(/([\d.]+)px/); assert.ok(m, `${name} has a px value`); return parseFloat(m[1]); };
  for (const n of Object.keys(vars).filter((k) => /^--ds-(space|icon)-/.test(k))) assert.equal(px(n) % 2, 0, `${n} = ${vars[n]} is off the grid`);
  for (const n of Object.keys(vars).filter((k) => /^--ds-space-/.test(k))) assert.equal(px(n) % 4, 0, `${n} = ${vars[n]} is off the 4 grid`);
  for (const n of Object.keys(vars).filter((k) => /^--ds-radius-(xs|sm|md|lg|xl)$/.test(k))) assert.equal(px(n) % 2, 0, `${n} is off the grid`);
  for (const n of Object.keys(vars).filter((k) => /^--ds-text-/.test(k))) assert.ok(px(n) >= 12, `${n} = ${vars[n]} is under the 12 px floor`);
  assert.deepEqual(Object.keys(vars).filter((k) => /^--ds-icon-/.test(k)).map(px), [14, 16, 20, 24, 32]);
});

// 3. VITALS-DESIGN-5 (owner Q4, 19 Nov 2026): Docs keep their own purple as one token pair, --theme-docs-accent (words,
//    rules, fills) and --theme-docs-accent-text (the label on a fill). Light is the docs purple; dark is the same purple
//    lightened along its own hue (oklab mix with white keeps the hue) to the first 5% step that reads at 4.5:1 as words
//    on the dark surface (and so 3:1 as a button's edge); the label reads at 4.5:1 on the fill in both themes.
const lin = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const gam = (x) => Math.max(0, Math.min(255, Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055))));
function oklab(h) {
  const [r, g, b] = rgb(h).map(lin);
  const [l, m, s] = [0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b].map(Math.cbrt);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]) {
  const [l, m, s] = [L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b, L - 0.0894841775 * a - 1.291485548 * b].map((x) => x ** 3);
  return toHex([4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(gam));
}
const hue = (h) => { const [, a, b] = oklab(h); return (Math.atan2(b, a) * 180) / Math.PI; };
const whiter = (h, share) => { const A = oklab(h), W = oklab("#ffffff"); return fromOklab(A.map((x, i) => x * share + W[i] * (1 - share))); };

test("the docs purple is one token pair that reads at AA in both themes (owner Q4)", () => {
  const light = themeVars("light"), dark = themeVars("dark");
  const purple = resolve(light["--theme-docs-accent"], light);
  assert.equal(purple, "#6b4cf0", "light is the docs purple");
  for (const [mode, vars] of [["light", light], ["dark", dark]]) {
    const fill = resolve(vars["--theme-docs-accent"], vars), label = resolve(vars["--theme-docs-accent-text"], vars), surface = resolve(vars["--theme-surface"], vars);
    assert.ok(ratio(fill, surface) >= 4.5, `${mode}: docs purple words ${ratio(fill, surface).toFixed(2)}:1 on the surface`);
    assert.ok(ratio(label, fill) >= 4.5, `${mode}: the label on the docs purple ${ratio(label, fill).toFixed(2)}:1`);
  }
  const darkFill = resolve(dark["--theme-docs-accent"], dark), darkSurface = resolve(dark["--theme-surface"], dark);
  assert.ok(Math.abs(hue(darkFill) - hue(purple)) < 1, `dark keeps the hue (${hue(darkFill).toFixed(1)}° vs ${hue(purple).toFixed(1)}°)`);
  let first = null;
  for (let p = 100; p > 0 && !first; p -= 5) { const c = whiter(purple, p / 100); if (ratio(c, darkSurface) >= 4.5) first = c; }
  const off = rgb(first).map((x, i) => Math.abs(x - rgb(darkFill)[i]));
  assert.ok(Math.max(...off) <= 1, `dark is the first passing step ${first}, not ${darkFill}`);
});

test("the docs pages use the docs token, not the undefined --theme-accent or a stray purple", () => {
  const DOCS = path.resolve(here, "../docs");
  for (const f of ["docs.module.css", "blocks.module.css", "organize.module.css", "drive/drive.module.css", "gdocs/gdocs.module.css"]) {
    const css = fs.readFileSync(path.join(DOCS, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(css, /--theme-accent\b/, `${f} reads --theme-accent, which no theme defines`);
    assert.doesNotMatch(css, /#(6b4cf0|6d4aff|8f7bff)\b/i, `${f} has a stray docs purple; use var(--theme-docs-accent)`);
  }
});

test("the sidebar's labels and the Team card's ID sit at the 12 px floor; a card name wraps before it is cut", () => {
  const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const sizes = (css, sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, s]) => s.split(",").some((x) => x.trim() === sel))
    .flatMap(([, , body]) => [...body.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1])));
  const SHELL = "../../../../packages/ui-shell/src";
  const want = [
    [`${SHELL}/shell.module.css`, [".recentsTitle", ".recentDate", ".sectionTitle"]],
    [`${SHELL}/nav.module.css`, [".pinnedTitle", ".flyoutNew"]],
    ["../people/people.module.css", [".cardHead .empId"]],
  ];
  for (const [file, sels] of want) {
    const css = read(file);
    for (const sel of sels) {
      const found = sizes(css, sel);
      assert.ok(found.length, `${file}: ${sel} sets no font size`);
      for (const px of found) assert.ok(px >= 12, `${file}: ${sel} is ${px}px, under the 12 px floor`);
    }
  }
  const people = read("../people/people.module.css");
  assert.match(people, /\.tight \.cardHead \.cardName\s*\{[^}]*-webkit-line-clamp:\s*2[^}]*white-space:\s*normal/, "a Team card's name takes two lines before its ellipsis");
});

test("the AI badge reads at the 12 px floor with a ladder icon; the avatar's AI mark is that icon, not tiny text", () => {
  const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = (css, sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.split(",").some((x) => x.trim() === sel)).map(([, , body]) => body);
  const kit = read("../kit/kit.module.css");
  for (const sel of [".aiBadge", '.aiBadge[data-size="md"]']) {
    const found = rules(kit, sel).flatMap((b) => [...b.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1])));
    assert.ok(found.length, `kit.module.css: ${sel} sets no font size`);
    for (const px of found) assert.ok(px >= 12, `kit.module.css: ${sel} is ${px}px, under the 12 px floor`);
  }
  const badge = read("../kit/ai-badge.tsx");
  const icons = [...badge.matchAll(/<Sparkles[^>]*\bsize=\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(icons.length, "ai-badge.tsx: the Sparkles icon has no size");
  for (const v of icons) for (const n of v.match(/\d+(\.\d+)?/g) ?? []) assert.ok([14, 16, 20, 24, 32].includes(Number(n)), `ai-badge.tsx: icon size ${n} is off the ladder (14 16 20 24 32)`);
  const avatar = read("../avatar.tsx");
  const mark = avatar.match(/className=\{styles\.avatarAi\}[^>]*>([\s\S]*?)<\/span>/);
  assert.ok(mark, "avatar.tsx: no AI corner mark");
  assert.match(mark[1], /^<Sparkles\b[^>]*\/>$/, `avatar.tsx: the AI mark holds ${JSON.stringify(mark[1])}, not the badge's icon alone`);
  for (const b of rules(read("../ui.module.css"), ".avatarAi")) {
    for (const m of b.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(Number(m[1]) >= 12, `ui.module.css: .avatarAi is ${m[1]}px`);
  }
});

test("the AI chip lines up by its text on the 4 px grid; the avatar's AI tile is a whole-pixel step", () => {
  // VITALS-DESIGN-8 (judge 7, People 1440): an svg first item gave the chip its bottom edge as a baseline, so the chip rode
  // 2-3 px above the name in baseline rows; a 14 px sparkle crowded 44 px avatars; gap 2 px was off the 4 px grid.
  const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = (css, sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.split(",").some((x) => x.trim() === sel)).map(([, , body]) => body);
  const kit = read("../kit/kit.module.css");
  const [chip] = rules(kit, ".aiBadge");
  assert.ok(chip, "kit.module.css: no .aiBadge rule");
  assert.match(chip, /(?:^|;)\s*align-items:\s*baseline\s*(?:;|$)/, "kit.module.css: .aiBadge must align its items by baseline, so its baseline is the \"AI\" text");
  assert.ok(rules(kit, ".aiBadge > svg").some((b) => /align-self:\s*center/.test(b)), "kit.module.css: the chip's icon centres itself (.aiBadge > svg)");
  for (const prop of ["gap", "padding"]) {
    const m = chip.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`));
    assert.ok(m, `kit.module.css: .aiBadge sets no ${prop}`);
    for (const n of m[1].match(/\d+(\.\d+)?(?=px)/g) ?? []) assert.ok(Number(n) % 4 === 0, `kit.module.css: .aiBadge ${prop} ${n}px is off the 4 px grid`);
  }
  const ui = read("../ui.module.css");
  const tiles = [...rules(ui, ".avatarAi"), ...rules(ui, '.avatarAi[data-step="m"]'), ...rules(ui, '.avatarAi[data-step="l"]')];
  for (const b of tiles) for (const m of b.matchAll(/(?:^|;)\s*(width|height):\s*([^;]+)/g)) assert.match(m[2].trim(), /^\d+px$/, `ui.module.css: the AI tile's ${m[1]} is ${m[2].trim()}, not whole pixels`);
  assert.deepEqual(tiles.map((b) => b.match(/(?:^|;)\s*width:\s*(\d+)px/)?.[1]), ["14", "15", "16"], "ui.module.css: the AI tile is 14 px, 15 px from 36 px avatars, 16 px from 48 px");
  assert.match(read("../avatar.tsx"), /className=\{styles\.avatarAi\} data-step=\{size < 36 \? undefined : size < 48 \? "m" : "l"\}/, "avatar.tsx: the AI tile steps at 36 and 48 px avatars");
});

test("chats' counts, small headings and privacy note read the 12 px xs step; no xs fallback is smaller", () => {
  // VITALS-DESIGN-9: the Readability Gate's last tiny text on home and chats was 10.5-11.5 px: the unread counts, the
  // "AI helpers you can ask" heading and the start pane's privacy note; --ds-text-xs itself was 11.5 px.
  const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = (css, sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.split(",").some((x) => x.trim() === sel)).map(([, , body]) => body);
  const vars = themeVars("light");
  const toPx = (v) => { const m = String(v).trim().match(/^([\d.]+)(px|rem)$/); return m ? Number(m[1]) * (m[2] === "rem" ? 16 : 1) : NaN; };
  // A size is a px literal or a scale step (var(--ds-text-*, fallback)); both the step and its fallback must be 12 px or more.
  const sizes = (body) => [...body.matchAll(/(?:^|;)\s*font-size:\s*([^;]+)/g)].map((m) => m[1].trim()).flatMap((v) => {
    const step = v.match(/^var\((--ds-text-[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
    return step ? [[`${v} (the step)`, toPx(vars[step[1]])], ...(step[2] ? [[`${v} (the fallback)`, toPx(step[2])]] : [])] : [[v, toPx(v)]];
  });
  assert.equal(toPx(vars["--ds-text-xs"]), 12, `--ds-text-xs is ${vars["--ds-text-xs"]}, not the 12 px floor`);
  const want = [
    ["../chats/chats.module.css", [".badge", ".mention", ".found h2", ".channels h2", ".letter", ".sections i"]],
    ["../chats/dock.module.css", [".tabs i", ".threadLast i", ".rowBottom i"]],
    ["../chats/workspace/workspace.module.css", [".recentGrid b i", ".need h4 i", ".lockNote"]],
  ];
  for (const [file, sels] of want) {
    const css = read(file);
    for (const sel of sels) {
      const found = rules(css, sel).flatMap(sizes);
      assert.ok(found.length, `${file}: ${sel} sets no font size`);
      for (const [v, px] of found) assert.ok(px >= 12, `${file}: ${sel} font-size ${v} is ${px}px, under the 12 px floor`);
    }
  }
  const roots = ["..", "../../../../packages/design-system/src", "../../../../packages/ui-shell/src"].map((r) => path.resolve(here, r));
  let seen = 0;
  for (const root of roots) {
    for (const rel of fs.readdirSync(root, { recursive: true })) {
      if (!String(rel).endsWith(".css") || String(rel).includes("node_modules")) continue;
      const css = fs.readFileSync(path.join(root, rel), "utf8");
      for (const m of css.matchAll(/var\(--ds-text-xs\s*,\s*([^)]+)\)/g)) {
        seen++;
        assert.ok(toPx(m[1]) >= 12, `${path.relative(here, path.join(root, rel))}: the xs fallback ${m[1].trim()} is under 12 px`);
      }
    }
  }
  assert.ok(seen, "no --ds-text-xs fallback found: the scan is looking in the wrong place");
});

test("every count on an icon's shoulder reads the 12 px xs step on one family of pill heights", () => {
  // VITALS-DESIGN-10: the bell, the Chat button, the rail and the phone tabs, the new dots, the notify island, the
  // workspace toggle, the scroll-to-latest button and the groups filter had their own 9.5-11 px counts on 15-18 px pills.
  // One family now: the number is var(--ds-text-xs) (so they move together) at 12 px or more, the pill is 16 px (phone,
  // Focus capsule, rail, small corners), 18 px (top bar, beside a button) or 20 px (the island's free disc), and the
  // number's line box is at least as tall as the number.
  const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = (css, sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.split(",").some((x) => x.trim() === sel)).map(([, , body]) => body);
  const vars = themeVars("light");
  const decl = (body, prop) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, "g"))].map((m) => m[1].trim());
  const SHELL = "../../../../packages/ui-shell/src";
  const want = [
    ["../inbox-bell.module.css", [".count", ":global(html:not([data-pulse-focus])) .count", ":global(html[data-pulse-focus]) .count"]],
    [`${SHELL}/shell.module.css`, [".bottomBadge", ".stripBadge"]],
    [`${SHELL}/new-dot.module.css`, [".dot[data-count]", '.dot[data-count][data-place="corner"]']],
    ["../chats/dock.module.css", [".tab i", ".tab > i"]],
    ["../notify/island.module.css", [".badge", '.island[data-home="free"] .badge']],
    ["../chats/workspace/panel.module.css", [".toggleCount"]],
    ["../chats/v3.module.css", [".newCount"]],
    ["../chats/groups/hub.module.css", [".dot"]],
  ];
  for (const [file, sels] of want) {
    const css = read(file);
    for (const sel of sels) {
      const bodies = rules(css, sel);
      assert.ok(bodies.length, `${file}: no ${sel} rule`);
      const sizes = bodies.flatMap((b) => decl(b, "font-size"));
      assert.ok(sizes.length, `${file}: ${sel} sets no font size`);
      for (const v of sizes) {
        const m = v.match(/^var\(--ds-text-xs\s*,\s*([\d.]+)px\)$/);
        assert.ok(m, `${file}: ${sel} font-size ${v} is not the xs step (var(--ds-text-xs, 12px))`);
        assert.ok(Number(m[1]) >= 12 && parseFloat(vars["--ds-text-xs"]) >= 12, `${file}: ${sel} font-size ${v} is under 12 px`);
      }
      for (const v of bodies.flatMap((b) => decl(b, "height"))) assert.ok(["16px", "18px", "20px"].includes(v), `${file}: ${sel} is ${v} tall, off the family (16, 18, 20 px)`);
      for (const v of bodies.flatMap((b) => decl(b, "line-height"))) if (v.endsWith("px")) assert.ok(parseFloat(v) >= 12, `${file}: ${sel} line-height ${v} is shorter than its 12 px number`);
    }
  }
});

test("small section labels read the 12 px xs step; the From chip's avatar keeps its 12 px initial; lens counts read at AA", () => {
  // VITALS-DESIGN-11: the Readability Gate's last tiny text on /tasks was "Needs you" and the group headings (No date,
  // Done) at 11.5 px, and the From chip's avatar initial, forced to 7 px; the person page's fact headings were 11 px and
  // its phone action labels 11.5 px; the Settings captions (You, Company, Admin tools) in the sidebar and its flyout 11 px.
  // The lens counts were muted text at 75 % opacity: 2.97:1 on the lens track (light), under AA.
  const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // A selector matches whole (".headActs :is(button, a, summary)" has commas of its own) or as one part of a list.
  const rules = (css, sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.trim() === sel || s.split(",").some((x) => x.trim() === sel)).map(([, , body]) => body);
  const decl = (body, prop) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, "g"))].map((m) => m[1].trim());
  const vars = themeVars("light");
  assert.ok(parseFloat(vars["--ds-text-xs"]) >= 12, `--ds-text-xs is ${vars["--ds-text-xs"]}, under the 12 px floor`);
  const SHELL = "../../../../packages/ui-shell/src";
  const want = [
    ["../tasks/work3.module.css", [".needs > h3", ".sectionHead"]],
    ["../people/people.module.css", [".factHead", '.headActs :is(button, a, summary)[class*="btn"]']],
    [`${SHELL}/nav.module.css`, [".clusterTitle", ".flyoutCluster"]],
  ];
  for (const [file, sels] of want) {
    const css = read(file);
    for (const sel of sels) {
      const sizes = rules(css, sel).flatMap((b) => decl(b, "font-size"));
      assert.ok(sizes.length, `${file}: ${sel} sets no font size`);
      for (const v of sizes) {
        const m = v.match(/^var\(--ds-text-xs\s*,\s*([\d.]+)px\)$/);
        assert.ok(m, `${file}: ${sel} font-size ${v} is not the xs step (var(--ds-text-xs, 12px))`);
        assert.ok(Number(m[1]) >= 12, `${file}: ${sel} font-size fallback ${m[1]}px is under 12 px`);
      }
    }
  }
  const tasks = read("../tasks/work3.module.css");
  // The From chip sets nothing under 12 px on itself or inside it: its avatar's initial is the avatar's own (12 px floor).
  for (const [, sel, body] of tasks.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!sel.includes(".fromFact")) continue;
    for (const v of decl(body, "font-size")) if (v.endsWith("px")) assert.ok(parseFloat(v) >= 12, `work3.module.css: ${sel.trim()} font-size ${v} is under 12 px`);
  }
  assert.match(read("../ui.module.css"), /\.avatar\s*\{\s*font-size:\s*max\(12px,/, "ui.module.css: the avatar's 12 px initial floor is gone");
  for (const v of rules(tasks, ".lenses > button span").flatMap((b) => decl(b, "opacity"))) assert.ok(Number(v) >= 1, `work3.module.css: the lens count's opacity ${v} fades muted text under AA`);
});

test("the kits' small chips and inline counts and the chats start pane read the 12 px xs step; nothing in their files is under 12 px", () => {
  // VITALS-DESIGN-12: the design system's tab count (11 px), the app kit's keycaps, ? help button, avatar-stack +N, list
  // and menu headings, tags and date picker (11 px), the game widgets' captions (11-11.5 px), the drawer's headings and
  // tab count, the next-step caption, processes' counts and captions, the WhatsApp group's count, Pip's menu-label
  // counts (11-11.5 px) and the chats start pane's card times, headings and due chip (11.5 px).
  const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = (css, sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.trim() === sel || s.split(",").some((x) => x.trim() === sel)).map(([, , body]) => body);
  const decl = (body, prop) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, "g"))].map((m) => m[1].trim());
  const vars = themeVars("light");
  const xs = parseFloat(vars["--ds-text-xs"]);
  assert.ok(xs >= 12, `--ds-text-xs is ${vars["--ds-text-xs"]}, under the 12 px floor`);
  // Every size a file sets: font-size, or the size in the font shorthand ("600 var(--ds-text-xs, 12px)/1 …", "700 11px/1 …").
  const SIZE = /var\(--ds-text-[\w-]+\s*,\s*[\d.]+px\)|\b[\d.]+px\b/;
  const sizesIn = (css) => [...css.matchAll(/(?:^|[;{])\s*(font-size|font):\s*([^;}]+)/g)].map(([, prop, v]) => (prop === "font" ? (v.match(new RegExp(`(${SIZE.source})\\s*(?:/|\\s)`)) || [])[1] : v.trim())).filter(Boolean);
  const px = (v) => { const step = v.match(/^var\((--ds-text-[\w-]+)\s*,\s*([\d.]+)px\)$/); return step ? Math.min(parseFloat(vars[step[1]]), Number(step[2])) : /^[\d.]+px$/.test(v) ? parseFloat(v) : NaN; };
  const SHELL_DS = "../../../../packages/design-system/src/ui";
  const files = [`${SHELL_DS}/ds.module.css`, "../kit/kit.module.css", "../kit/game/game.module.css", "../kit/drawer.module.css", "../kit/next-step.module.css",
    "../processes/processes.module.css", "../chats/native.module.css", "../notify/island.module.css", "../chats/workspace/workspace.module.css"];
  for (const file of files) {
    const found = sizesIn(read(file));
    assert.ok(found.length, `${file}: no font sizes found: the scan is reading the wrong file`);
    for (const v of found) if (!Number.isNaN(px(v))) assert.ok(px(v) >= 12, `${file}: font size ${v} is under the 12 px floor`);
  }
  // The inline counts are one family with the counts on icons (slice 6): the number is the xs step itself, a set height is
  // 16, 18 or 20 px, and a set line box is at least as tall as the number.
  const counts = [
    [`${SHELL_DS}/ds.module.css`, [".count"]],
    ["../kit/drawer.module.css", [".tabCount"]],
    ["../processes/processes.module.css", [".count", ".filterBtn em"]],
    ["../chats/native.module.css", [".count"]],
    ["../notify/island.module.css", [".menuLabel b"]],
  ];
  for (const [file, sels] of counts) {
    const css = read(file);
    for (const sel of sels) {
      const bodies = rules(css, sel);
      assert.ok(bodies.length, `${file}: no ${sel} rule`);
      const sizes = bodies.flatMap((b) => decl(b, "font-size"));
      assert.ok(sizes.length, `${file}: ${sel} sets no font size`);
      for (const v of sizes) assert.match(v, /^var\(--ds-text-xs\s*,\s*12px\)$/, `${file}: ${sel} font-size ${v} is not the xs step (var(--ds-text-xs, 12px))`);
      for (const v of bodies.flatMap((b) => decl(b, "height"))) assert.ok(["16px", "18px", "20px"].includes(v), `${file}: ${sel} is ${v} tall, off the family (16, 18, 20 px)`);
      for (const v of bodies.flatMap((b) => decl(b, "line-height"))) if (v.endsWith("px")) assert.ok(parseFloat(v) >= 12, `${file}: ${sel} line-height ${v} is shorter than its 12 px number`);
    }
  }
  // My Pulse's captions and subheads, and the avatar stack's +N (a disc the avatars' size, not a pill), read the xs step.
  // My Pulse's stat labels (.big dt, .stats dt) are not in this slice.
  for (const [file, sel] of [["../me/my-pulse.module.css", ".kudos small"], ["../me/my-pulse.module.css", ".facts dd small"], ["../me/my-pulse.module.css", ".waits small"], ["../me/my-pulse.module.css", ".subhead"], ["../kit/kit.module.css", ".stackMore"]]) {
    const sizes = rules(read(file), sel).flatMap((b) => decl(b, "font-size"));
    assert.ok(sizes.length, `${file}: ${sel} sets no font size`);
    for (const v of sizes) assert.match(v, /^var\(--ds-text-xs\s*,\s*12px\)$/, `${file}: ${sel} font-size ${v} is not the xs step`);
  }
  // The design system's tab count is an 18 px pill like the other counts beside a label.
  const dsCount = rules(read(`${SHELL_DS}/ds.module.css`), ".count").join(";");
  assert.deepEqual([decl(dsCount, "height")[0], decl(dsCount, "line-height")[0]], ["18px", "18px"], "ds.module.css: the tab count is not an 18 px pill with an 18 px line box");
});

test("chats' thread text reads the 12 px xs step; nothing in its files is under 12 px; a message's text clears its time", () => {
  // VITALS-DESIGN-13: chats.module.css (29 rules at 10.5-11.5 px: message times, file and link captions, reaction counts,
  // the day and unread chips, the task card's tag, the AI employee's meter, status, update line and Urgent pill, the
  // composer's hint, buttons and keycaps, the "/" menu's headings, keycaps and footer, the members panel's headings,
  // counts, Admin tag and Former, mail labels, the phone chat bar's status line, the list rows' kind tag) and
  // v3.module.css (4: Seen, a file's version badge, a thread reply's time, the step number).
  const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = (css, sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.trim() === sel || s.split(",").some((x) => x.trim() === sel)).map(([, , body]) => body);
  const decl = (body, prop) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, "g"))].map((m) => m[1].trim());
  const vars = themeVars("light");
  assert.ok(parseFloat(vars["--ds-text-xs"]) >= 12, `--ds-text-xs is ${vars["--ds-text-xs"]}, under the 12 px floor`);
  const SIZE = /var\(--ds-text-[\w-]+\s*,\s*[\d.]+px\)|\b[\d.]+px\b/;
  const sizesIn = (css) => [...css.matchAll(/(?:^|[;{])\s*(font-size|font):\s*([^;}]+)/g)].map(([, prop, v]) => (prop === "font" ? (v.match(new RegExp(`(${SIZE.source})\\s*(?:/|\\s)`)) || [])[1] : v.replace(/\s*!important$/, "").trim())).filter(Boolean);
  const px = (v) => { const step = v.match(/^var\((--ds-text-[\w-]+)\s*,\s*([\d.]+)px\)$/); return step ? Math.min(parseFloat(vars[step[1]]), Number(step[2])) : /^[\d.]+px$/.test(v) ? parseFloat(v) : NaN; };
  const CHATS = "../chats/chats.module.css", V3 = "../chats/v3.module.css";
  for (const file of [CHATS, V3]) {
    const found = sizesIn(read(file));
    assert.ok(found.length > 10, `${file}: only ${found.length} font sizes found: the scan is reading the wrong file`);
    for (const v of found) if (!Number.isNaN(px(v))) assert.ok(px(v) >= 12, `${file}: font size ${v} is under the 12 px floor`);
  }
  // The thread's small text is the xs step itself (not a 12 px literal that would miss a change to the scale).
  const chats = read(CHATS);
  const xsRules = [".meta", ".day span", ".unreadLine span", ".file small", ".reactions span", ".linkCard small", ".taskTop em", ".rowTop em",
    ".composeHint", ".composeHint kbd", "div.composeHint kbd", ".cmdGroup", ".cmdFoot", ".aiMeter", ".aiStatus", ".aiUpdate", ".aiUrgent", ".dept h5", ".adminTag", ".former"];
  for (const sel of xsRules) {
    const sizes = rules(chats, sel).flatMap((b) => decl(b, "font-size"));
    assert.ok(sizes.length, `${CHATS}: ${sel} sets no font size`);
    for (const v of sizes) assert.match(v, /^var\(--ds-text-xs\s*,\s*12px\)$/, `${CHATS}: ${sel} font-size ${v} is not the xs step`);
  }
  for (const sel of [".seen", ".version", ".tm header time", ".num"]) {
    const sizes = rules(read(V3), sel).flatMap((b) => decl(b, "font-size"));
    assert.ok(sizes.length, `${V3}: ${sel} sets no font size`);
    for (const v of sizes) assert.match(v, /^var\(--ds-text-xs\s*,\s*12px\)$/, `${V3}: ${sel} font-size ${v} is not the xs step`);
  }
  // Pills and keycaps stay on the family's heights (16, 18, 20 px) with a line box no shorter than their 12 px text.
  for (const sel of [".rowTop em", "div.composeHint kbd", ".aiUrgent", ".num"]) {
    const bodies = rules(sel === ".num" ? read(V3) : chats, sel);
    for (const v of bodies.flatMap((b) => decl(b, "height"))) assert.ok(["16px", "18px", "20px"].includes(v), `${sel} is ${v} tall, off the family (16, 18, 20 px)`);
    for (const v of bodies.flatMap((b) => decl(b, "line-height"))) if (v.endsWith("px")) assert.ok(parseFloat(v) >= 12, `${sel} line-height ${v} is shorter than its 12 px text`);
  }
  // A message's time (with my ticks, with "edited") sits in the bubble's corner over a spacer at the end of its text, so
  // the text can come no closer to it than (spacer - corner + 1) px. Measured on dev's build (VITALS-DESIGN-13 shots):
  // the widest corner was 45 px (theirs) and 63 px (mine) at 11 px, 51 and 69 px at 12 px: 6 px wider, about 9 with
  // "edited" (its word grows too). Each spacer grows at least as much, so no text sits closer to its time than before,
  // and stays on the 4 px grid: 62 -> 68, 80 -> 88, 104 -> 116, 122 -> 132 px.
  const spacer = (sel) => parseFloat(decl(rules(chats, sel).join(";"), "width").pop());
  const want = [[".spacer", 62 + 6], [".msg[data-mine] .spacer", 80 + 6], [".bubble[data-edited] .spacer", 104 + 9], [".msg[data-mine] .bubble[data-edited] .spacer", 122 + 9]];
  for (const [sel, min] of want) {
    const w = spacer(sel);
    assert.ok(w >= min, `${CHATS}: ${sel} is ${w} px, too narrow for the 12 px time (at least ${min} px)`);
    assert.equal(w % 4, 0, `${CHATS}: ${sel} is ${w} px, off the 4 px grid`);
  }
});

test("the rest of chats' small text reads the 12 px xs step: groups hub, WhatsApp groups, the dock, dialogs, pickers and cards", () => {
  // VITALS-DESIGN-14: 51 declarations at 10.5-11.5 px in 15 files: groups/hub (14: rail and list headings, kind, tag, AI
  // chip, the 22 px pills, KPIs, the guide's headings), whatsapp/wa (11: a message's time, media and voice captions, the
  // speed button, card, search, people, transcript, stage and KPI captions), dock (6: names, times, replies, reactions,
  // list times), v5 (4: poll voters, emoji headings, the jump box's footer and every keycap), wa-media (3), work (2: the
  // task state pill, group headings), command-card (2), workspace/panel (2), and one each in creatives, voice, v6 (the
  // emoji picker's headings), intake-card, import, history (an old version's time) and across (the unread count).
  const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = (css, sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.trim() === sel).map(([, , body]) => body);
  const decl = (body, prop) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, "g"))].map((m) => m[1].trim());
  const vars = themeVars("light");
  assert.ok(parseFloat(vars["--ds-text-xs"]) >= 12, `--ds-text-xs is ${vars["--ds-text-xs"]}, under the 12 px floor`);
  const SIZE = /var\(--ds-text-[\w-]+\s*,\s*[\d.]+px\)|\b[\d.]+px\b/;
  const sizesIn = (css) => [...css.matchAll(/(?:^|[;{])\s*(font-size|font):\s*([^;}]+)/g)].map(([, prop, v]) => (prop === "font" ? (v.match(new RegExp(`(${SIZE.source})\\s*(?:/|\\s)`)) || [])[1] : v.replace(/\s*!important$/, "").trim())).filter(Boolean);
  const px = (v) => { const step = v.match(/^var\((--ds-text-[\w-]+)\s*,\s*([\d.]+)px\)$/); return step ? Math.min(parseFloat(vars[step[1]]), Number(step[2])) : /^[\d.]+px$/.test(v) ? parseFloat(v) : NaN; };
  const C = "../chats/";
  // file -> the selectors that read the xs step (the census: each rule that was under 12 px)
  const census = {
    "groups/hub.module.css": [".railHead h2", ".listHead", ".kind", ".tag", ".aiChip", ".pill", ".waiting", ".unread", ".review", ".waTag", ".healthTag", ".runtime", ".kpis span", ".guideSide h4"],
    "whatsapp/wa.module.css": [".meta", ".mediaFoot", ".under", ".rate", ".card small, .doc small", ".hits small", ".people small, .batches li", ".transcript small", ".stages small, .signals small", ".fine", ".kpis dt"],
    "dock.module.css": [".msg small", ".msg time", ".threadTop time", ".replies", ".reacts b", ".rowTop time"],
    "v5.module.css": [".pollWho", ".emojiHead", ".jumpFoot", ".jump kbd, .keys kbd, .jumpBox kbd"],
    "wa-media.module.css": [".status", ".figures small", ".muted"],
    "work.module.css": [".rows em", ".group"],
    "command-card.module.css": [".group", ".foot kbd"],
    "workspace/panel.module.css": [".note", ".coach b"],
    "whatsapp/creatives.module.css": [".status"],
    "voice.module.css": [".textBtn"],
    "v6.module.css": [".pickerHead"],
    "intake-card.module.css": [".table td > small, .table th > small"],
    "import/import.module.css": [".facts dd small"],
    "history.module.css": [".message time"],
    "across.module.css": [".count"],
  };
  let n = 0;
  for (const [rel, sels] of Object.entries(census)) {
    const css = read(C + rel);
    const found = sizesIn(css);
    assert.ok(found.length, `${rel}: no font sizes found: the scan is reading the wrong file`);
    for (const v of found) if (!Number.isNaN(px(v))) assert.ok(px(v) >= 12, `${rel}: font size ${v} is under the 12 px floor`);
    for (const sel of sels) {
      const bodies = rules(css, sel);
      assert.ok(bodies.length, `${rel}: no ${sel} rule`);
      const sizes = bodies.flatMap((b) => decl(b, "font-size")).map((v) => v.replace(/\s*!important$/, ""));
      assert.ok(sizes.length, `${rel}: ${sel} sets no font size`);
      for (const v of sizes) assert.match(v, /^var\(--ds-text-xs\s*,\s*12px\)$/, `${rel}: ${sel} font-size ${v} is not the xs step (var(--ds-text-xs, 12px))`);
      // A set height or line box still holds the 12 px text (the hub's pills are 22 px, the unread count 20 px).
      for (const v of bodies.flatMap((b) => decl(b, "height"))) if (v.endsWith("px")) assert.ok(parseFloat(v) >= 16, `${rel}: ${sel} is ${v} tall, too short for 12 px text`);
      for (const v of bodies.flatMap((b) => decl(b, "line-height"))) if (v.endsWith("px")) assert.ok(parseFloat(v) >= 12, `${rel}: ${sel} line-height ${v} is shorter than its 12 px text`);
      n++;
    }
  }
  assert.equal(n, 51, `the census holds ${n} rules, not 51`);
  // And every CSS file under chats/ (these 15, the thread's two, and the rest) sets nothing under 12 px.
  const all = fs.readdirSync(path.resolve(here, C), { recursive: true }).filter((f) => String(f).endsWith(".css"));
  assert.ok(all.length >= 20, `only ${all.length} CSS files under chats/: the scan is reading the wrong folder`);
  for (const rel of all) for (const v of sizesIn(read(C + rel))) if (!Number.isNaN(px(v))) assert.ok(px(v) >= 12, `chats/${rel}: font size ${v} is under the 12 px floor`);
});

test("a chat dialog stays inside a phone; the top bar's review count is the 18 px count pill", () => {
  // VITALS-DESIGN-15: the jump box (Ctrl+K) was 375 px wide on a 363 px phone: chats' dialogs sit in a centring grid,
  // and a grid item's automatic minimum width is its longest line, so width: min(440px, 100%) never got its say.
  // min-width: 0 lets 100% win (331 px there; 440 px on a computer as before). Its footer's key hints then split
  // mid-hint ("all / shortcuts"): they wrap whole now, and a touch screen hides them. The review chip's count was 11 px on a
  // 20 px pill; it is the top bar's count pill now, like the bell's: 12 px xs text, 700, 18 px tall on an 18 px line.
  const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = (css, sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.trim() === sel).map(([, , body]) => body);
  const decl = (body, prop) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, "g"))].map((m) => m[1].trim());
  const chats = read("../chats/chats.module.css");
  const [backdrop] = rules(chats, ".backdrop"), [dialog] = rules(chats, ".dialog");
  assert.ok(backdrop && dialog, "chats.module.css: no .backdrop or .dialog rule");
  assert.deepEqual(decl(backdrop, "display"), ["grid"], "the backdrop is no longer a grid: re-check what sizes the dialog");
  assert.deepEqual(decl(dialog, "width"), ["min(440px, 100%)"]);
  assert.deepEqual(decl(dialog, "min-width"), ["0"], ".dialog needs min-width: 0, or its longest line widens it past a phone's edge");
  // In the narrower box the jump box's keyboard hints wrap as whole hints, and a touch screen (no keys) does not show them.
  const v5 = read("../chats/v5.module.css");
  const [foot] = rules(v5, ".jumpFoot");
  assert.deepEqual(decl(foot, "flex-wrap"), ["wrap"]);
  assert.deepEqual(decl(foot, "white-space"), ["nowrap"], "a jump-box hint splits across lines");
  assert.match(v5, /@media \(hover: none\) \{ \.jumpFoot \{ display: none; \} \}/, "the jump box shows key hints on a touch screen");
  const chip = read("../tasks/review-chip.module.css");
  const [b] = rules(chip, ".chip b");
  assert.ok(b, "review-chip.module.css: no .chip b rule");
  assert.deepEqual(decl(b, "font-size"), ["var(--ds-text-xs, 12px)"], "the review count is not the xs step");
  assert.deepEqual(decl(b, "font-weight"), ["700"]);
  assert.deepEqual(decl(b, "height"), ["18px"], "the review count is off the top bar's 18 px pill");
  assert.deepEqual(decl(b, "min-width"), ["18px"]);
  assert.deepEqual(decl(b, "line-height"), ["18px"]);
  assert.deepEqual(decl(b, "padding"), ["0 5px"]);
  for (const [, v] of chip.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(Number(v) >= 12, `review-chip.module.css: font size ${v}px is under the 12 px floor`);
});

test("the tasks views, a task's page and the projects' starter stages read the 12 px xs step; nothing in their files is under 12 px", () => {
  // VITALS-DESIGN-16: 38 declarations at 10.5-11.5 px in 6 files. views (20: the table's column heads, the calendar's
  // weekdays and "Show N more", the timeline's scale, Today tag, caps, initials, due and "No due date" notes, the phone's
  // week strip, the pool bar, the filter and saved-view headings, counts, progress and tags), life (8: the stepper's
  // numbers and its phone size, the history's day heads and times, Pulse's face, the flag chips, domain and suggestion
  // captions), board (4: the rail's open button, status and badge chips, the focus count), threads (2: the help tag, the
  // keycaps), the projects' starter stages and tag (2), and My Pulse's stat labels (2).
  const read = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = (css, sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.trim() === sel).map(([, , body]) => body);
  const decl = (body, prop) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, "g"))].map((m) => m[1].trim());
  const vars = themeVars("light");
  assert.ok(parseFloat(vars["--ds-text-xs"]) >= 12, `--ds-text-xs is ${vars["--ds-text-xs"]}, under the 12 px floor`);
  const SIZE = /var\(--ds-text-[\w-]+\s*,\s*[\d.]+px\)|\b[\d.]+px\b/;
  const sizesIn = (css) => [...css.matchAll(/(?:^|[;{])\s*(font-size|font):\s*([^;}]+)/g)].map(([, prop, v]) => (prop === "font" ? (v.match(new RegExp(`(${SIZE.source})\\s*(?:/|\\s)`)) || [])[1] : v.replace(/\s*!important$/, "").trim())).filter(Boolean);
  const px = (v) => { const step = v.match(/^var\((--ds-text-[\w-]+)\s*,\s*([\d.]+)px\)$/); return step ? Math.min(parseFloat(vars[step[1]]), Number(step[2])) : /^[\d.]+px$/.test(v) ? parseFloat(v) : NaN; };
  // file -> the selectors that read the xs step (the census: each rule that was under 12 px)
  const census = {
    "../tasks/views/views.module.css": [".badge", ".filters legend", ".optChips button small", ".savedHead", ".progress", ".tag", ".table thead th", ".wd", ".more", ".calElse button small",
      ".tlNoDate", ".tlScale .tlTrack i", ".tlDue", ".tlCap", ".tlOff", ".tlWeek small", ".tlWeek i", ".pbar span", ".tlTodayTag", ".tlWho"],
    "../tasks/life.module.css": [".stepper i", ".stepper", ".day h4", ".day li > time", ".pulseFace", ".flagChip, .ackChip", ".domainChips li small", ".suggest li small"],
    "../tasks/board.module.css": [".railOpen", ".status", ".badge", ".focusN"],
    "../tasks/threads.module.css": [".helpTag", ".empty kbd, .composerFoot kbd"],
    "../projects/stages.module.css": [".tag", ".starterStages"],
    "../me/my-pulse.module.css": [".big dt", ".stats dt"],
  };
  let n = 0;
  for (const [rel, sels] of Object.entries(census)) {
    const css = read(rel);
    const found = sizesIn(css);
    assert.ok(found.length, `${rel}: no font sizes found: the scan is reading the wrong file`);
    for (const v of found) if (!Number.isNaN(px(v))) assert.ok(px(v) >= 12, `${rel}: font size ${v} is under the 12 px floor`);
    for (const sel of sels) {
      const bodies = rules(css, sel);
      assert.ok(bodies.length, `${rel}: no ${sel} rule`);
      const sizes = bodies.flatMap((b) => decl(b, "font-size")).map((v) => v.replace(/\s*!important$/, ""));
      // A selector may also have a plain 12 px rule (the stepper's base, the rail's phone button): one of them is the step.
      assert.ok(sizes.some((v) => /^var\(--ds-text-xs\s*,\s*12px\)$/.test(v)), `${rel}: ${sel} does not read the xs step (var(--ds-text-xs, 12px)): ${sizes.join(", ") || "no font size"}`);
      // A set height or line box still holds the 12 px text (the pills and chips are 16-22 px, the Today tag's line 16 px).
      for (const prop of ["height", "min-height"]) for (const v of bodies.flatMap((b) => decl(b, prop))) if (v.endsWith("px")) assert.ok(parseFloat(v) >= 16, `${rel}: ${sel} ${prop} ${v} is too short for 12 px text`);
      for (const v of bodies.flatMap((b) => decl(b, "line-height"))) if (v.endsWith("px")) assert.ok(parseFloat(v) >= 12, `${rel}: ${sel} line-height ${v} is shorter than its 12 px text`);
      n++;
    }
  }
  assert.equal(n, 38, `the census holds ${n} rules, not 38`);
  // The timeline's Today tag at 12 px is about 104 px wide (88 at 10.5 px, when it already covered "23 Nov" by 14 px): beside
  // a label it says just "Today", and the scale leaves out a label even that would cover, so no label sits half under it.
  const tl = read("../tasks/views/timeline.tsx");
  const [, tag] = tl.match(/TODAY_TAG = (\d+)/) || [];
  assert.ok(Number(tag) >= 108, `timeline.tsx: TODAY_TAG ${tag} is narrower than the 12 px tag and its 4 px margin`);
  // Beside a label, the tag is the short "Today" (about 48 px at 12 px, with its 4 px margin).
  const [, short] = tl.match(/TODAY_SHORT = (\d+)/) || [];
  assert.ok(Number(short) >= 52, `timeline.tsx: TODAY_SHORT ${short} is narrower than the short "Today" tag and its margin`);
  assert.match(tl, /ticks\.filter\(\(t\) => [^\n]*?!underTag\(t\.day\)\)/, "timeline.tsx: the scale's labels are not filtered by the Today tag");
});
