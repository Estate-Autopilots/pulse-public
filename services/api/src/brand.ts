// LAYOUT-SWEEP (owner, 11 Oct 2026): the organisation's own logo (pulse.org_brand, migration 0164). Reading it needs
// no sign-in: the sign-in page shows it, and e-mails and printed copies carry it. Changing it is for an individual
// organisation admin (Settings → Organisation); every change is a pulse.record_change row.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { admin, fail, type Open, type Tx } from "./routes.js";
import { hostCompany } from "./tenant-context.js";

type Body = Record<string, unknown>;
/** URL name → [column, mime column]. The e-mail raster is always a PNG. */
const KINDS: Record<string, [string, string | null]> = { mark: ["mark", "mark_mime"], logo: ["logo", "logo_mime"], "logo-dark": ["logo_dark", "logo_dark_mime"], "logo-png": ["logo_png", null] };
const MIMES = ["image/svg+xml", "image/png", "image/webp", "image/jpeg"];
export const BRAND_MAX_BYTES = 512 * 1024;

/** An uploaded SVG may not run script, embed another document or load anything from elsewhere. */
export function safeSvg(text: string): boolean {
  if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return false;
  if (/<\s*(script|foreignObject|iframe|object|embed|audio|video|animate|set)\b/i.test(text)) return false;
  if (/\son[a-z]+\s*=/i.test(text) || /javascript:/i.test(text) || /<!ENTITY/i.test(text)) return false;
  // References stay inside the drawing (#id) or are small inline images.
  for (const m of text.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) if (!m[1].startsWith("#") && !/^data:image\/(png|jpeg|webp);base64,/i.test(m[1])) return false;
  if (/url\(\s*["']?\s*(?!#)/i.test(text)) return false;
  return true;
}
/** The bytes are what the type says: PNG, JPEG and WebP by their signatures, SVG by `safeSvg`. */
export function brandBytesOk(bytes: Buffer, mime: string): boolean {
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/webp") return bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  if (mime === "image/svg+xml") return safeSvg(bytes.toString("utf8"));
  return false;
}

/** What the organisation has set, for the shell and the sign-in page. */
export async function brandInfo(c: PoolClient) {
  const r = (await c.query(`select o.name,o.code,o.time_zone "timeZone",coalesce(b.version,0) version,b.mark is not null mark,b.logo is not null logo,b.logo_dark is not null "logoDark",b.logo_png is not null "logoPng",b.accent
    from pulse.org o left join pulse.org_brand b on b.org_id=o.id where o.id=pulse.current_org()`)).rows[0];
  return { name: (r?.name as string | undefined) ?? null, version: Number(r?.version ?? 0), mark: !!r?.mark, logo: !!r?.logo, logoDark: !!r?.logoDark, logoPng: !!r?.logoPng, accent: (r?.accent as string | null | undefined) ?? null, code: (r?.code as string | undefined) ?? null,
    // R51: the company's calendar for the web's days and due times (pulse.org.time_zone).
    timeZone: (r?.timeZone as string | undefined) ?? null };
}

/** The e-mail logo (PNG) and the organisation's name, for tools/google-bridge.py `send` (null when none is set). */
export async function mailBrand(c: PoolClient): Promise<{ name: string; png: string } | null> {
  const r = (await c.query("select o.name,b.logo_png from pulse.org o join pulse.org_brand b on b.org_id=o.id where o.id=pulse.current_org() and b.logo_png is not null")).rows[0];
  return r ? { name: String(r.name), png: (r.logo_png as Buffer).toString("base64") } : null;
}

// E-mails go out after the request that caused them (no transaction at hand): the logo is read through the tenant
// connection the routes register, and kept for five minutes per company (cleared when an admin changes it).
let mailReader: (() => Promise<{ name: string; png: string } | null>) | null = null;
const mailCache = new Map<string, { at: number; value: { name: string; png: string } | null }>();
export async function currentMailBrand() {
  if (!mailReader) return null;
  const key = hostCompany()?.org ?? "install";
  const hit = mailCache.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.value;
  try { const value = await mailReader(); mailCache.set(key, { at: Date.now(), value }); return value; } catch { return null; }
}

export function registerBrandRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  mailReader = () => open((c) => mailBrand(c));
  app.get("/api/v0/brand", () => open((c) => brandInfo(c)));
  app.get<{ Params: { kind: string } }>("/api/v0/brand/:kind", async (req, reply) => {
    const kind = KINDS[req.params.kind]; if (!kind) fail(404, "Unknown picture");
    const row = await open(async (c) => (await c.query(`select ${kind[0]} bytes,${kind[1] ?? "'image/png'"} mime,version from pulse.org_brand where org_id=pulse.current_org()`)).rows[0]);
    if (!row?.bytes) fail(404, "No logo is set");
    const tag = `"brand-${row.version}-${req.params.kind}"`;
    reply.header("cache-control", "public, max-age=300, stale-while-revalidate=86400").header("etag", tag)
      .header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    if (req.headers["if-none-match"] === tag) return reply.code(304).send();
    return reply.type(String(row.mime)).send(row.bytes);
  });
  // { kind: mark | logo | logo-dark | logo-png, mime, data: base64 } sets one picture; { kind, remove: true } clears it.
  app.post<{ Body: Body }>("/api/v0/settings/brand", { schema: { body: { type: "object" } }, bodyLimit: Math.ceil(BRAND_MAX_BYTES * 1.4) + 4096 }, (req) => tx(req, async (c, v) => {
    if (!admin(v) || !v.person) fail(403, "An individual organisation admin changes the logo");
    const kind = KINDS[String(req.body.kind ?? "")]; if (!kind) fail(400, "Choose which picture: mark, logo, logo-dark or logo-png");
    mailCache.clear();
    if (req.body.remove === true) { await c.query("select pulse.org_brand_save($1,null,null) v", [kind[0]]); return brandInfo(c); }
    const mime = String(req.body.mime ?? "");
    if (!MIMES.includes(mime) || (kind[0] === "logo_png" && mime !== "image/png")) fail(400, kind[0] === "logo_png" ? "The e-mail logo is a PNG" : "Choose an SVG, PNG, WebP or JPEG");
    const bytes = typeof req.body.data === "string" ? Buffer.from(req.body.data, "base64") : Buffer.alloc(0);
    if (!bytes.length || bytes.length > BRAND_MAX_BYTES) fail(400, "Choose a picture under 512 KB");
    if (!brandBytesOk(bytes, mime)) fail(400, mime === "image/svg+xml" ? "This SVG has scripts or links to other files; export a plain SVG" : "The file is not the picture type it says");
    await c.query("select pulse.org_brand_save($1,$2,$3) v", [kind[0], bytes, mime]);
    return brandInfo(c);
  }));
}
