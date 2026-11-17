// PRODUCT-MAP: the repo scan. Reads a checkout of an app (Next.js app or pages router, Expo Router, React Router) and
// writes what it finds as a Product map manifest (schema "pulse-product-map/1", product-map-model.ts): one screen per
// route with its title, the buttons, tabs, links, forms and fields its own files draw, where each link goes, the
// navigation shared by every screen, and who may open a screen when the code says so. It reads files only (never runs
// them) and follows relative imports two levels deep. Self-contained (node:fs and node:path only), so the built file
// also runs on another host:  node services/api/dist/product-map-scan.js <checkout> [subdir] > manifest.json
// A checkout may add `.pulse-product-map.json` at its root: {roles:[{key,name,description}], access:{<code's word>:
// [role keys]}, entries:[routes], ignore:[route prefixes], areas:{<route prefix>: area}} for what code cannot say.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

export type ScanElement = { kind: "button" | "tab" | "link" | "form" | "field" | "menu" | "dialog"; label: string; target: string; destructive: boolean; handler: boolean; file: string };
export type ScanScreen = { key: string; route: string; title: string; area: string; access: string[]; file: string; files: string[]; elements: ScanElement[]; redirects: string[] };
export type ScanResult = {
  schema: "pulse-product-map/1"; generator: string; framework: string[]; root: string;
  roles: { key: string; name: string; description: string }[]; entries: string[];
  screens: { key: string; route: string; title: string; area: string; access: string[]; purpose: string; elements: { kind: string; label: string; target: string; destructive: boolean; handler: boolean }[]; meta: { file: string; files: number } }[];
  edges: { from: string; to: string; kind: "link" | "nav" | "redirect"; label: string }[];
  nav: { label: string; target: string; access: string[] }[];
  stats: { files: number; screens: number; elements: number; edges: number; skipped: number; ms: number };
};

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "out", ".turbo", "coverage", ".expo", "android", "ios", "__tests__", "test", "tests", "e2e", ".venv", "target"]);
const CODE = /\.(tsx|jsx|ts|js|mjs)$/;
const MAX_FILE = 400_000;
/** A heading that names a state of the page (an error, a sign-in prompt, loading), not the page. */
const STATE_TITLE = /signing you in|please wait|could ?n.t|cannot|not found|not available|sign in to|something went wrong|error|failed|loading|is closed/i;
const DESTRUCTIVE = /\b(delete|remove|erase|destroy|pay|purchase|buy|checkout|send|submit|publish|archive|revoke|disconnect|sign out|log ?out|cancel (?:plan|subscription)|refund|transfer|approve|reject|charge)\b/i;

const unbrace = (s: string) => { let t = s.replace(/\{\/\*[\s\S]*?\*\/\}/g, " "); for (let i = 0; i < 8 && /\{[^{}]*\}/.test(t); i++) t = t.replace(/\{[^{}]*\}/g, " "); return t.replace(/[{}]/g, " "); };
/** Readable words, or "" when what is left is code (a JSX expression, an arrow, a ternary). */
const words = (s: string) => /=>|&&|\|\||\?\s*:|\$\{|^[^A-Za-z]*$/.test(s) ? "" : s;
const clean = (s: string) => words(unbrace(s).replace(/<[^>]+>/g, " ").replace(/&nbsp;|&amp;|&rsquo;|&hellip;/g, (m) => ({ "&nbsp;": " ", "&amp;": "&", "&rsquo;": "’", "&hellip;": "…" })[m] ?? " ")
  .replace(/\s+/g, " ").trim().slice(0, 120));
const human = (seg: string) => seg.replace(/^:/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Home";

function walk(dir: string, out: string[], budget = { n: 0 }) {
  let list: string[];
  try { list = readdirSync(dir); } catch { return out; }
  for (const name of list) {
    if (budget.n > 40000) return out;
    if (name.startsWith(".") && name !== ".well-known") continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p, out, budget); }
    else if (CODE.test(name) && !/\.(test|spec|stories|d)\.[a-z]+$/.test(name) && st.size <= MAX_FILE) { budget.n++; out.push(p); }
  }
  return out;
}
const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };

/** "/app/(shop)/people/[id]/page.tsx" → "/people/:id"; route groups, parallel slots and private folders drop out. */
export function routeOf(segments: string[]): string | null {
  const parts: string[] = [];
  for (const s of segments) {
    if (!s || /^\(.*\)$/.test(s)) continue;
    if (s.startsWith("@") || s.startsWith("_")) return null;
    const m = s.match(/^\[\[?\.\.\.(.+?)\]\]?$/); if (m) { parts.push(`:${m[1]}*`); continue; }
    const d = s.match(/^\[(.+)\]$/); if (d) { parts.push(`:${d[1]}`); continue; }
    if (s === "index") continue;
    parts.push(s);
  }
  return "/" + parts.join("/");
}

/** An href as written ("/people/" + id, `/people/${id}?tab=ai`) → the route it names ("/people/:id"), or null when it
 *  leaves the app or cannot be told. */
export function hrefRoute(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (/^(https?:|mailto:|tel:|#|data:|blob:)/i.test(s)) return null;
  s = s.replace(/\$\{[^}]*\}/g, ":id").replace(/"\s*\+\s*[A-Za-z_$][\w$.?()[\]]*(\s*\+\s*")?/g, ":id");
  // What is left must read as an address: not a pattern, an expression, an API call, a download or a file.
  if (/[\^$\\|(){}]/.test(s) || /^\/(api|_next|static|assets|downloads?)\//i.test(s) || /\.(pdf|csv|zip|docx?|xlsx?|png|jpe?g|svg|json|txt)$/i.test(s.split("?")[0])) return null;
  s = s.split("#")[0].split("?")[0];
  if (!s.startsWith("/")) return null;
  s = s.replace(/\/+$/, "") || "/";
  s = s.split("/").map((seg) => /^:/.test(seg) || /^\[.*\]$/.test(seg) ? ":id" : /^[0-9a-f-]{16,}$/i.test(seg) ? ":id" : seg).join("/");
  return s.length <= 200 ? s : null;
}

/** Matches "/people/:id" against "/people/:personId": parameters match any parameter or value. */
export function sameRoute(a: string, b: string): boolean {
  if (a === b) return true;
  const x = a.split("/"), y = b.split("/");
  if (x.length !== y.length) return x.at(-1)?.endsWith("*") ? y.length >= x.length - 1 && x.slice(0, -1).every((s, i) => s.startsWith(":") || s === y[i]) : y.at(-1)?.endsWith("*") ? sameRoute(b, a) : false;
  return x.every((s, i) => s === y[i] || s.startsWith(":") || y[i].startsWith(":"));
}

/** The opening tags of `names` in JSX text with their attribute text and inner text (the attribute text may hold
 *  arrow functions and nested JSX: braces and quotes are tracked). */
export function jsxTags(src: string, names: string[]): { name: string; attrs: string; inner: string; at: number }[] {
  const out: { name: string; attrs: string; inner: string; at: number }[] = [];
  const re = new RegExp(`<(${names.map((n) => n.replace(/\./g, "\\.")).join("|")})(?=[\\s>/])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) && out.length < 3000) {
    let i = m.index + m[0].length, depth = 0, quote = "";
    for (; i < src.length && i - m.index < 6000; i++) {
      const ch = src[i];
      if (quote) { if (ch === quote && src[i - 1] !== "\\") quote = ""; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "{") depth++; else if (ch === "}") depth--;
      else if (ch === ">" && depth <= 0) break;
    }
    const attrs = src.slice(m.index + m[0].length, i);
    let inner = "";
    if (!attrs.trimEnd().endsWith("/")) {
      const close = src.indexOf(`</${m[1]}>`, i);
      if (close > 0 && close - i < 4000) inner = src.slice(i + 1, close);
    }
    out.push({ name: m[1], attrs, inner, at: m.index });
  }
  return out;
}
const attr = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*"([^"]*)"\\s*\\}|\\{\\s*'([^']*)'\\s*\\}|\\{\\s*\`([^\`]*)\`\\s*\\}|\\{([^{}]*(?:\\{[^{}]*\\}[^{}]*)*)\\})`));
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? (m[6] !== undefined ? `{${m[6]}}` : null);
};
const literal = (v: string | null) => { const x = v && !v.startsWith("{") ? v : v && /^\{\s*["'`]([^"'`]*)["'`]\s*\}$/.test(v) ? v.replace(/^\{\s*["'`]|["'`]\s*\}$/g, "") : null; return x && !x.includes("${") ? x : null; };

function labelOf(t: { attrs: string; inner: string }) {
  return literal(attr(t.attrs, "aria-label")) ?? (clean(t.inner) || literal(attr(t.attrs, "title")) || literal(attr(t.attrs, "placeholder")) || literal(attr(t.attrs, "name")) || "");
}

/** What one file draws: buttons, tabs, links, forms, fields, menus and dialogs, and where its links and redirects go. */
export function fileElements(src: string, file: string): { elements: ScanElement[]; redirects: string[]; titles: string[]; nav: { label: string; target: string; access: string }[] } {
  const elements: ScanElement[] = [];
  const add = (e: Omit<ScanElement, "file">) => { if (elements.length < 400) elements.push({ ...e, file }); };
  for (const t of jsxTags(src, ["button", "Button", "IconButton"])) {
    const label = labelOf(t); const role = literal(attr(t.attrs, "role"));
    // A native button with no handler, not submitting, not opening anything, in a file with no form: it may do nothing.
    const handler = t.name !== "button" || /\bon(Click|PointerDown|PointerUp|MouseDown|KeyDown|Press)\s*=|\bformAction\s*=|\bpopover[Tt]arget\s*=|\bcommandfor\s*=|\baria-haspopup|\bdisabled\b|type\s*=\s*["']submit["']|\{\s*\.\.\./.test(t.attrs)
      || /\btype\s*=\s*\{/.test(t.attrs) || /<form\b|<Form\b|onSubmit|\.addEventListener\(/.test(src);
    const submit = /type\s*=\s*["']submit["']/.test(t.attrs);
    add({ kind: role === "tab" ? "tab" : role === "menuitem" ? "menu" : "button", label, target: submit ? "submit" : "", destructive: DESTRUCTIVE.test(label), handler });
  }
  for (const t of jsxTags(src, ["a", "(?:[A-Z][A-Za-z]*)?Link"])) {
    const href = attr(t.attrs, "href") ?? attr(t.attrs, "to");
    if (href === null) continue;
    const raw = href.startsWith("{") ? href.slice(1, -1).trim().replace(/^[`"']|[`"']$/g, "") : href;
    const route = hrefRoute(raw);
    const role = literal(attr(t.attrs, "role"));
    add({ kind: role === "tab" ? "tab" : "link", label: labelOf(t), target: route ?? (/^https?:/.test(raw) ? "external" : ""), destructive: false, handler: true });
  }
  for (const t of jsxTags(src, ["form", "Form"])) {
    const btn = jsxTags(t.inner, ["button", "Button"]).find((b) => /type\s*=\s*["']submit["']/.test(b.attrs));
    add({ kind: "form", label: literal(attr(t.attrs, "aria-label")) ?? (btn ? labelOf(btn) : "Form"), target: "submit", destructive: false, handler: /\b(onSubmit|action)\s*=/.test(t.attrs) });
  }
  let fields = 0;
  for (const t of jsxTags(src, ["input", "textarea", "select", "Select", "Combobox", "DateField", "PersonSelect"])) {
    const type = literal(attr(t.attrs, "type")) ?? "";
    if (/^(hidden|submit|button)$/.test(type) || fields++ >= 40) continue;
    add({ kind: "field", label: labelOf(t) || type || t.name.toLowerCase(), target: "", destructive: false, handler: true });
  }
  for (const t of jsxTags(src, ["dialog", "Drawer", "Dialog", "Modal", "Sheet"])) {
    const l = literal(attr(t.attrs, "aria-label")) ?? literal(attr(t.attrs, "title"));
    if (l) add({ kind: "dialog", label: l, target: "", destructive: false, handler: true });
  }
  for (const t of jsxTags(src, ["Menu", "DropdownMenu"])) add({ kind: "menu", label: literal(attr(t.attrs, "label")) ?? literal(attr(t.attrs, "aria-label")) ?? "Menu", target: "", destructive: false, handler: true });
  // Tabs written as data: { key: "ai", label: "AI" } in a file that draws tabs.
  if (/Tabs|role=["']tab["']|SegmentedNav|Segmented/.test(src)) {
    for (const m of src.matchAll(/\{\s*(?:key|value|id)\s*:\s*["'`]([\w-]{1,40})["'`]\s*,\s*label\s*:\s*["'`]([^"'`]{1,60})["'`]/g)) add({ kind: "tab", label: m[2], target: `?tab=${m[1]}`, destructive: false, handler: true });
  }
  // Navigation as data: { label: "People", href: "/people", access: "work" } (menus, rails, sidebars).
  const nav: { label: string; target: string; access: string }[] = [];
  for (const m of src.matchAll(/\{[^{}]{0,400}?\blabel\s*:\s*["'`]([^"'`]{1,80})["'`][^{}]{0,400}?\bhref\s*:\s*["'`](\/[^"'`]{0,150})["'`][^{}]*\}|\{[^{}]{0,400}?\bhref\s*:\s*["'`](\/[^"'`]{0,150})["'`][^{}]{0,400}?\blabel\s*:\s*["'`]([^"'`]{1,80})["'`][^{}]*\}/g)) {
    const label = m[1] ?? m[4], href = m[2] ?? m[3], route = hrefRoute(href);
    const access = m[0].match(/\baccess\s*:\s*["'`]([\w-]{1,30})["'`]/)?.[1] ?? "";
    if (route) nav.push({ label, target: route + (href.includes("?") ? `?${href.split("?")[1]}` : ""), access });
    // { …, also: ["/activity", "/designers"] }: pages the same entry stands for (same access, no link of their own).
    for (const a of m[0].match(/also\s*:\s*\[([^\]]*)\]/)?.[1].matchAll(/["'`](\/[^"'`]{0,150})["'`]/g) ?? []) { const r = hrefRoute(a[1]); if (r) nav.push({ label: "", target: r, access }); }
  }
  const redirects: string[] = [];
  for (const m of src.matchAll(/\b(?:redirect|permanentRedirect|router\.(?:push|replace)|navigate)\(\s*(["'`])(\/[^"'`]*)\1/g)) { const r = hrefRoute(m[2]); if (r) redirects.push(r); }
  const titles: string[] = [];
  const meta = src.match(/export\s+const\s+metadata[^=]*=\s*\{[^}]*?\btitle\s*:\s*["'`]([^"'`]{1,120})["'`]/); if (meta) titles.push(meta[1]);
  for (const t of jsxTags(src, ["PageHeader", "Head", "Header"])) { const v = literal(attr(t.attrs, "title")); if (v) titles.push(v); }
  for (const t of jsxTags(src, ["h1"])) { const v = clean(t.inner); if (v) titles.push(v); }
  return { elements, redirects, titles, nav };
}

/** Relative imports of a file that resolve to code files. */
function imports(src: string, file: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
    const spec = m[1] ?? m[2]; const base = resolve(dirname(file), spec);
    for (const c of [base, ...[".tsx", ".ts", ".jsx", ".js", ".mjs"].map((x) => base + x), ...["index.tsx", "index.ts", "index.js"].map((x) => join(base, x))]) {
      if (CODE.test(c) && existsSync(c) && statSync(c).isFile()) { out.push(c); break; }
    }
  }
  return out;
}

type Config = { accessAdd?: Record<string, string[]>; navFiles?: string[]; roles?: { key: string; name?: string; description?: string }[]; access?: Record<string, string[]>; entries?: string[]; ignore?: string[]; areas?: Record<string, string> };

/** Scans `root` (or root/sub) and returns the manifest. */
export function scanRepo(root: string, sub = ""): ScanResult {
  const started = Date.now();
  const base = resolve(root, sub || ".");
  if (!base.startsWith(resolve(root))) throw new Error("The folder must be inside the checkout");
  let cfg: Config = {};
  for (const f of [join(base, ".pulse-product-map.json"), join(resolve(root), ".pulse-product-map.json")]) { if (existsSync(f)) { try { cfg = JSON.parse(read(f)) as Config; } catch { /* a broken file is ignored */ } break; } }
  const files = walk(base, []);
  const frameworks = new Set<string>();
  const pkgText = [join(base, "package.json"), join(resolve(root), "package.json")].map(read).join("\n");
  type Page = { route: string; file: string };
  const pages: Page[] = [];
  for (const f of files) {
    const rel = relative(base, f).split(sep);
    const appAt = rel.lastIndexOf("app"), pagesAt = rel.lastIndexOf("pages");
    const name = basename(f, extname(f));
    if (appAt >= 0 && name === "page") { const r = routeOf(rel.slice(appAt + 1, -1)); if (r) { pages.push({ route: r, file: f }); frameworks.add("next-app"); } continue; }
    if (appAt >= 0 && /expo-router/.test(pkgText) && !name.startsWith("_") && !name.startsWith("+") && name !== "layout") {
      const r = routeOf([...rel.slice(appAt + 1, -1), name]); if (r) { pages.push({ route: r, file: f }); frameworks.add("expo-router"); } continue;
    }
    if (pagesAt >= 0 && rel[pagesAt + 1] !== "api" && !name.startsWith("_") && /\.(tsx|jsx|js)$/.test(f) && rel.slice(0, pagesAt).every((s) => s !== "app")) {
      const r = routeOf([...rel.slice(pagesAt + 1, -1), name]); if (r) { pages.push({ route: r, file: f }); frameworks.add("next-pages"); }
    }
  }
  // React Router: <Route path="/x" element={<X />}> or { path: "/x", element: <X /> } — the component's file is found by its import.
  const reactRoutes: Page[] = [];
  for (const f of files) {
    const src = read(f);
    if (!/react-router|createBrowserRouter|<Route\b/.test(src)) continue;
    const imported = new Map<string, string>();
    for (const m of src.matchAll(/import\s+(\w+)\s+from\s*["'](\.{1,2}\/[^"']+)["']/g)) { const r = imports(`import x from "${m[2]}"`, f)[0]; if (r) imported.set(m[1], r); }
    for (const m of src.matchAll(/path\s*[:=]\s*["'`](\/?[^"'`]*)["'`][^>}]{0,200}?element\s*[:=]\s*\{?\s*<(\w+)/g)) {
      const r = hrefRoute(m[1].startsWith("/") ? m[1] : `/${m[1]}`); if (r) { reactRoutes.push({ route: r, file: imported.get(m[2]) ?? f }); frameworks.add("react-router"); }
    }
  }
  pages.push(...reactRoutes);
  const ignore = (cfg.ignore ?? []).filter((x) => typeof x === "string");
  const kept = pages.filter((p) => !ignore.some((i) => p.route === i || p.route.startsWith(i.endsWith("/") ? i : `${i}/`)));
  // Which files each page draws: its own, its folder's layout chain and relative imports two levels deep. Files many
  // screens share (the shell, the kit) are the app's frame, not the screen's: they feed the navigation instead.
  const deps = new Map<string, string[]>();
  const users = new Map<string, number>();
  for (const p of kept) {
    const seen = new Set<string>([p.file]); let level = [p.file];
    for (let d = 0; d < 2; d++) { const next: string[] = []; for (const f of level) for (const i of imports(read(f), f)) if (!seen.has(i) && seen.size < 30) { seen.add(i); next.push(i); } level = next; }
    deps.set(p.file, [...seen]); for (const f of seen) users.set(f, (users.get(f) ?? 0) + 1);
  }
  const sharedAt = Math.max(4, Math.ceil(kept.length * 0.15));
  const layoutsOf = (file: string) => { const out: string[] = []; let d = dirname(file); for (let i = 0; i < 12 && d.startsWith(base); i++) { for (const n of ["layout.tsx", "layout.jsx", "layout.ts", "layout.js", "_layout.tsx"]) { const f = join(d, n); if (existsSync(f)) out.push(f); } d = dirname(d); } return out; };
  const accessWord = (w: string) => w ? (cfg.access?.[w] ?? [w]) : [];
  const navAll: { label: string; target: string; access: string[] }[] = [];
  const navSeen = new Set<string>();
  const sharedFiles = [...users.entries()].filter(([, n]) => n >= sharedAt).map(([f]) => f);
  for (const f of new Set([...sharedFiles, ...files.filter((x) => /(shell|sidebar|nav|menu|rail|tabbar|tab-bar|layout)\.(tsx|jsx|ts|js)$/i.test(x)),
    ...(cfg.navFiles ?? []).map((f) => resolve(root, String(f))).filter((f) => f.startsWith(resolve(root)) && existsSync(f))])) {
    const fe = fileElements(read(f), relative(base, f));
    // The navigation as data, and in a shell or menu file its links drawn as JSX (<Link href="/leads">Leads</Link>).
    const drawn = /(shell|sidebar|nav|menu|rail|tabbar|tab-bar)[^/\\]*\.(tsx|jsx)$/i.test(f) ? fe.elements.filter((e) => e.kind === "link" && e.target.startsWith("/")).map((e) => ({ label: e.label || e.target, target: e.target, access: "" })) : [];
    for (const n of [...fe.nav, ...drawn]) { const k = `${n.label}|${n.target}`; if (!navSeen.has(k)) { navSeen.add(k); navAll.push({ label: n.label, target: n.target, access: accessWord(n.access) }); } }
  }
  const screens: ScanScreen[] = [];
  const byRoute = new Map<string, ScanScreen>();
  for (const p of kept.sort((a, b) => a.route.localeCompare(b.route))) {
    if (byRoute.has(p.route)) continue;
    const own = (deps.get(p.file) ?? [p.file]).filter((f) => f === p.file || (users.get(f) ?? 0) < sharedAt);
    const els: ScanElement[] = []; const redirects: string[] = []; const titles: string[] = [];
    for (const f of own) { const r = fileElements(read(f), relative(base, f)); els.push(...r.elements); redirects.push(...r.redirects); if (f === p.file || titles.length === 0) titles.push(...r.titles); }
    const layouts = layoutsOf(p.file);
    // A layout's title names the section: below it, the page's own last word is added ("Pulse HQ · Offers").
    for (const l of layouts.slice(0, 1)) for (const t of fileElements(read(l), relative(base, l)).titles) titles.push(dirname(l) === dirname(p.file) ? t : `${t} · ${human(p.route.split("/").filter((x) => x && !x.startsWith(":")).at(-1) ?? "")}`);
    const guard = [p.file, ...layouts].map(read).join("\n");
    const access = new Set<string>();
    for (const n of navAll) if (n.access.length && sameRoute(n.target.split("?")[0], p.route)) n.access.forEach((a) => access.add(a));
    // What the code's words cannot say: roles one route (and what is under it) also opens to.
    if (access.size) for (const [prefix, roles] of Object.entries(cfg.accessAdd ?? {})) if (p.route === prefix || p.route.startsWith(`${prefix}/`)) for (const r of roles) access.add(String(r));
    for (const m of guard.matchAll(/\b(?:requireRole|hasRole|allowRoles?|roles?Required|withRole)\(\s*\[?\s*((?:["'`][\w-]+["'`]\s*,?\s*)+)/g)) for (const r of m[1].matchAll(/["'`]([\w-]+)["'`]/g)) accessWord(r[1]).forEach((a) => access.add(a));
    const area = Object.entries(cfg.areas ?? {}).filter(([k]) => p.route === k || p.route.startsWith(`${k}/`)).sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? human(p.route.split("/")[1] ?? "");
    const seen = new Set<string>(); const elements = els.filter((e) => { const k = `${e.kind}|${e.label}|${e.target}`; if (seen.has(k) || (!e.label && e.kind !== "form" && !e.target.startsWith("/"))) return false; seen.add(k); return true; }).slice(0, 250);
    const segs = p.route.split("/").filter(Boolean);
    const s: ScanScreen = { key: p.route, route: p.route, title: (titles.find((t) => t.length >= 2 && !STATE_TITLE.test(t)) ?? titles.find((t) => t.length >= 2) ?? human(segs.filter((x) => !x.startsWith(":")).at(-1) ?? "")).slice(0, 160), area: area.slice(0, 80),
      access: [...access].slice(0, 30), file: relative(base, p.file), files: own.map((f) => relative(base, f)), elements, redirects: [...new Set(redirects)] };
    screens.push(s); byRoute.set(p.route, s);
  }
  // A title template every page shares ("Brand · Product · Leads") says nothing: its common parts are dropped.
  const segCount = new Map<string, number>();
  for (const s of screens) for (const seg of new Set(s.title.split(" · ").map((x) => x.trim()))) segCount.set(seg, (segCount.get(seg) ?? 0) + 1);
  const common = new Set([...segCount].filter(([, n]) => screens.length >= 6 && n >= screens.length * 0.25).map(([k]) => k));
  for (const s of screens) { const parts = s.title.split(" · ").map((x) => x.trim()); const kept = parts.filter((x) => !common.has(x)); if (kept.length && kept.length < parts.length) s.title = kept.join(" · "); }
  const find = (route: string) => screens.find((s) => s.route === route) ?? screens.find((s) => sameRoute(s.route, route));
  const edges: ScanResult["edges"] = []; const edgeSeen = new Set<string>();
  const edge = (from: string, to: string, kind: "link" | "nav" | "redirect", label: string) => { const k = `${from}|${to}|${kind}`; if (from !== to && !edgeSeen.has(k)) { edgeSeen.add(k); edges.push({ from, to, kind, label: label.slice(0, 160) }); } };
  for (const s of screens) {
    for (const e of s.elements) { if (e.kind !== "link" && e.kind !== "tab" && e.kind !== "menu" && e.kind !== "button") continue; const t = e.target.startsWith("/") ? find(e.target) : undefined; if (t) { e.target = t.key; edge(s.key, t.key, "link", e.label); }
      else if (ignore.some((i) => e.target === i || e.target.startsWith(`${i}/`))) e.target = ""; }
    for (const r of s.redirects) { const t = find(r); if (t) edge(s.key, t.key, "redirect", "redirect"); }
  }
  for (const n of navAll) { const t = n.label ? find(n.target.split("?")[0]) : undefined; if (t) edge("*", t.key, "nav", n.label); }
  const roles = (cfg.roles ?? []).filter((r) => r && typeof r.key === "string").map((r) => ({ key: r.key.slice(0, 80), name: String(r.name ?? r.key).slice(0, 120), description: String(r.description ?? "").slice(0, 600) }));
  const entries = (cfg.entries ?? []).map((e) => hrefRoute(e)).filter((e): e is string => !!e && !!find(e)).map((e) => find(e)!.key);
  if (!entries.length && find("/")) entries.push(find("/")!.key);
  return {
    schema: "pulse-product-map/1", generator: "pulse-repo-scan/1", framework: [...frameworks], root: sub || ".", roles, entries,
    screens: screens.map((s) => ({ key: s.key, route: s.route, title: s.title, area: s.area, access: s.access, purpose: "",
      elements: s.elements.map(({ kind, label, target, destructive, handler }) => ({ kind, label, target, destructive, handler })), meta: { file: s.file, files: s.files.length } })),
    edges, nav: navAll.filter((n) => n.label).slice(0, 300),
    stats: { files: files.length, screens: screens.length, elements: screens.reduce((n, s) => n + s.elements.length, 0), edges: edges.length, skipped: pages.length - kept.length, ms: Date.now() - started },
  };
}

// Run on its own: node product-map-scan.js <checkout> [subdir]
if (process.argv[1] && /product-map-scan\.(js|mjs|ts)$/.test(process.argv[1]) && process.argv[2]) {
  process.stdout.write(JSON.stringify(scanRepo(process.argv[2], process.argv[3] ?? ""), null, 1) + "\n");
}
