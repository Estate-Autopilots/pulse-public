// PRODUCT-MAP: the live crawl. Started by product-map.ts in its own low-priority process; reads {config, account} on
// stdin (the test account never travels in arguments, the environment or a log) and writes a Product map manifest
// with screenshots on stdout. It opens pages of the app's own address only, within the page budget, reads what each
// page shows (title, buttons, tabs, links, forms, fields) and takes one screenshot per screen. It never clicks or
// submits anything: links are followed by address, so nothing is deleted, paid, sent or submitted.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any;
type Config = { baseUrl?: string; startPaths?: string[]; pageBudget?: number; signIn?: { url?: string; userField?: string; passField?: string } | null };
type Seen = { kind: string; label: string; target: string; destructive: boolean };
const DESTRUCTIVE = /\b(delete|remove|erase|destroy|pay|purchase|buy|checkout|send|submit|publish|archive|revoke|disconnect|sign ?out|log ?out|refund|transfer|approve|reject|charge)\b/i;
const SKIP_HREF = /(logout|log-out|signout|sign-out|delete|remove|unsubscribe|download|export|\.pdf$|\.zip$|\.csv$)/i;

const template = (path: string) => (path.split("?")[0].replace(/\/+$/, "") || "/").split("/").map((s) => /^[0-9a-f-]{16,}$/i.test(s) || /^\d+$/.test(s) || (/\d/.test(s) && s.length >= 12) ? ":id" : s).join("/");

async function main() {
  const chunks: Buffer[] = []; for await (const c of process.stdin) chunks.push(c as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { config: Config; account: { user?: string; pass?: string } | null };
  const cfg = input.config ?? {}; const base = new URL(String(cfg.baseUrl ?? "")).origin;
  const budget = Math.max(1, Math.min(80, Number(cfg.pageBudget) || 30));
  const pw = await import(String(process.env.PULSE_PLAYWRIGHT)) as { chromium: { launch: (o: unknown) => Promise<any> } };
  const browser = await pw.chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const started = Date.now();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", acceptDownloads: false });
    const page = await ctx.newPage(); page.setDefaultTimeout(30_000);
    // Never leave the app's own address with a request that changes something.
    await page.route("**/*", (route: any) => { const r = route.request(); const u = new URL(r.url());
      if (u.origin !== base && r.resourceType() === "document") return route.abort(); return route.continue(); });
    let signedIn = false;
    if (input.account?.user && cfg.signIn?.url) {
      await page.goto(new URL(cfg.signIn.url, base).toString(), { waitUntil: "domcontentloaded" });
      const user = cfg.signIn.userField ? page.locator(cfg.signIn.userField) : page.locator("input[type=email], input[name*=user i], input[name*=email i], input[autocomplete=username], input[type=text]").first();
      const pass = cfg.signIn.passField ? page.locator(cfg.signIn.passField) : page.locator("input[type=password]").first();
      await user.fill(input.account.user); await pass.fill(String(input.account.pass ?? "")); await pass.press("Enter");
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      signedIn = !(await page.locator("input[type=password]").count().catch(() => 0));
    }
    const queue: { path: string; from: string | null; label: string }[] = (cfg.startPaths?.length ? cfg.startPaths : ["/"]).map((p) => ({ path: p, from: null, label: "" }));
    const seen = new Set<string>(); const screens: { key: string; route: string; title: string; elements: Seen[] }[] = [];
    const edges: { from: string; to: string; kind: string; label: string }[] = []; const shots: { key: string; jpeg: string; width: number; height: number }[] = [];
    while (queue.length && screens.length < budget && Date.now() - started < 10 * 60_000) {
      const next = queue.shift()!; const key = template(next.path);
      if (next.from && next.from !== key && !edges.some((e) => e.from === next.from && e.to === key)) edges.push({ from: next.from, to: key, kind: "link", label: next.label });
      if (seen.has(key)) continue; seen.add(key);
      const res = await page.goto(new URL(next.path, base).toString(), { waitUntil: "domcontentloaded" }).catch(() => null);
      if (!res || new URL(page.url()).origin !== base) continue;
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      const landed = template(new URL(page.url()).pathname);
      if (landed !== key && seen.has(landed)) continue;
      const found = await page.evaluate(() => {
        const vis = (e: any) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const name = (e: any) => (e.getAttribute("aria-label") || e.innerText || e.getAttribute("title") || e.getAttribute("placeholder") || e.getAttribute("name") || "").replace(/\s+/g, " ").trim().slice(0, 120);
        const out: { kind: string; label: string; href: string }[] = [];
        document.querySelectorAll("button, [role=button], [role=tab], [role=menuitem], a[href], form, input, textarea, select").forEach((e: any) => {
          if (!vis(e) || out.length > 300) return;
          const tag = e.tagName.toLowerCase(), role = e.getAttribute("role");
          const kind = role === "tab" ? "tab" : role === "menuitem" ? "menu" : tag === "a" ? "link" : tag === "form" ? "form" : ["input", "textarea", "select"].includes(tag) ? "field" : "button";
          if (kind === "field" && ["hidden", "submit", "button", "password"].includes(e.type)) return;
          out.push({ kind, label: name(e) || (kind === "form" ? "Form" : ""), href: tag === "a" ? e.href : "" });
        });
        const h1 = document.querySelector("h1") as any;
        return { title: (h1?.innerText || document.title || "").trim().slice(0, 160), els: out };
      });
      const elements: Seen[] = []; const keys = new Set<string>();
      for (const e of found.els) {
        let target = "";
        if (e.href) { try { const u = new URL(e.href); if (u.origin === base) { target = template(u.pathname); if (!SKIP_HREF.test(u.pathname)) queue.push({ path: u.pathname, from: landed, label: e.label }); } else target = "external"; } catch { /* not an address */ } }
        const k = `${e.kind}|${e.label}|${target}`; if (keys.has(k) || (!e.label && e.kind !== "form")) continue; keys.add(k);
        elements.push({ kind: e.kind, label: e.label, target, destructive: DESTRUCTIVE.test(e.label) });
      }
      screens.push({ key: landed, route: landed, title: found.title, elements: elements.slice(0, 250) });
      const jpeg = await page.screenshot({ type: "jpeg", quality: 55 }).catch(() => null) as Buffer | null;
      if (jpeg && jpeg.length < 1_400_000) shots.push({ key: landed, jpeg: jpeg.toString("base64"), width: 1280, height: 800 });
      if (landed !== key) edges.push({ from: key, to: landed, kind: "redirect", label: "redirect" });
    }
    process.stdout.write(JSON.stringify({ manifest: { schema: "pulse-product-map/1", app: { baseUrl: base }, entries: [template(cfg.startPaths?.[0] ?? "/")], screens, edges: edges.filter((e) => seen.has(e.to)) },
      shots, stats: { pages: screens.length, budget, signedIn, ms: Date.now() - started } }));
  } finally { await browser.close(); }
}
main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message.split("\n")[0] : "crawl failed"}\n`); process.exit(1); });
