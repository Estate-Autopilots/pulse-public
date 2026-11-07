// CHAT-SHELL (22 Oct 2026): what the chat's side panel opens for a link, a path or a file. Pure, so it is tested on its
// own. A Pulse page opens inside the panel (its own address with embed=1: no rail, no top bar); a Google Doc, Sheet,
// Slides deck or Form and a Drive file or folder open in Google's own preview where Google allows it; any other web
// address opens framed if the site allows it (the panel checks), else as a clean card with "Open in a new tab".

/** Pulse pages that never open inside the panel: the chat itself (a chat in a chat), sign-in and public pages. */
const NOT_IN_PANEL = /^\/(chats|login|accept|offer|portal|developers|apps\/[^/]+\/connect)(\/|$|\?)/;

const GOOGLE_KINDS = { document: "Google Doc", spreadsheets: "Google Sheet", presentation: "Google Slides", forms: "Google Form" };

/** The address with embed=1 added, keeping its query and hash. */
export function embedPath(path) {
  const [rest, hash = ""] = String(path).split("#");
  const [p, q = ""] = rest.split("?");
  const params = new URLSearchParams(q); params.set("embed", "1");
  return `${p}?${params.toString()}${hash ? `#${hash}` : ""}`;
}

/** The address without embed=1 (to open the full page, or to remember a tab). */
export function stripEmbed(path) {
  const [rest, hash = ""] = String(path).split("#");
  const [p, q = ""] = rest.split("?");
  const params = new URLSearchParams(q); params.delete("embed");
  const s = params.toString();
  return `${p}${s ? `?${s}` : ""}${hash ? `#${hash}` : ""}`;
}

function parse(input, origin) {
  try { return new URL(input, origin || "https://pulse.invalid"); } catch { return null; }
}

/**
 * What the panel opens for `input` (a path such as "/tasks", a full address, or a chat file id prefixed "file:").
 * `origin` is this Pulse's own origin. Returns null for anything the panel must not open (javascript:, data:, plain
 * words). `kind`: page | gdoc | drive-file | drive-folder | file | url. `src` is what is framed, `href` what "Open in a
 * new tab" opens, `embed` whether it may be framed at all (false: a card only).
 */
export function panelTarget(input, origin = "") {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("file:")) {
    const id = raw.slice(5); if (!/^[\w-]{6,80}$/.test(id)) return null;
    // WA-NATIVE: a file of history imported from WhatsApp ("wa-<sha256>") is read from the WhatsApp store.
    const base = /^wa-[0-9a-f]{64}$/.test(id) ? `/api/v0/chats/whatsapp/files/${id.slice(3)}` : `/api/v0/chats/files/${id}`;
    return { kind: "file", key: `file:${id}`, src: `${base}?inline=1`, href: base, embed: true, title: "File" };
  }
  const looksLikeAddress = raw.startsWith("/") || /^https?:\/\//i.test(raw) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(raw);
  if (!looksLikeAddress) return null;
  const url = parse(/^https?:\/\//i.test(raw) || raw.startsWith("/") ? raw : `https://${raw}`, origin);
  if (!url || !/^https?:$/.test(url.protocol)) return null;
  const own = raw.startsWith("/") || (!!origin && url.origin === new URL(origin).origin);
  if (own) {
    const path = stripEmbed(`${url.pathname}${url.search}${url.hash}`);
    if (NOT_IN_PANEL.test(url.pathname) || url.pathname.startsWith("/api/")) {
      // A stored chat file is still a file; any other API address is not a page.
      const file = url.pathname.match(/^\/api\/v0\/chats\/files\/([\w-]{6,80})$/);
      return file ? panelTarget(`file:${file[1]}`, origin) : null;
    }
    return { kind: "page", key: `page:${path}`, src: embedPath(path), href: path, embed: true, title: titleForPath(path) };
  }
  const host = url.hostname.toLowerCase();
  if (host === "docs.google.com") {
    const m = url.pathname.match(/^\/(document|spreadsheets|presentation|forms)\/d\/(e\/)?([\w-]{10,})/);
    if (m) {
      const [, kind, published, id] = m;
      const base = `https://docs.google.com/${kind}/d/${published ? "e/" : ""}${id}`;
      const src = kind === "forms" ? `${base}/viewform?embedded=true` : published ? `${base}/pubhtml?widget=true` : `${base}/preview`;
      return { kind: "gdoc", key: `gdoc:${id}`, src, href: kind === "forms" ? `${base}/viewform` : published ? `${base}/pub` : `${base}/edit`, embed: true, title: GOOGLE_KINDS[kind] };
    }
  }
  if (host === "drive.google.com") {
    const folder = url.pathname.match(/\/folders\/([\w-]{10,})/);
    if (folder) return { kind: "drive-folder", key: `drive-folder:${folder[1]}`, src: `https://drive.google.com/embeddedfolderview?id=${folder[1]}#list`, href: `https://drive.google.com/drive/folders/${folder[1]}`, embed: true, title: "Drive folder" };
    const file = url.pathname.match(/\/file\/d\/([\w-]{10,})/) ?? (url.pathname === "/open" ? [null, url.searchParams.get("id")] : null);
    if (file?.[1] && /^[\w-]{10,}$/.test(file[1])) return { kind: "drive-file", key: `drive-file:${file[1]}`, src: `https://drive.google.com/file/d/${file[1]}/preview`, href: `https://drive.google.com/file/d/${file[1]}/view`, embed: true, title: "Drive file" };
  }
  if (url.protocol !== "https:") return { kind: "url", key: `url:${url.href}`, src: url.href, href: url.href, embed: false, title: host };
  return { kind: "url", key: `url:${url.href}`, src: url.href, href: url.href, embed: true, title: host.replace(/^www\./, "") };
}

/** A name for a Pulse address before its page has loaded and said its own. */
const TITLES = [
  [/^\/tasks\/projects\//, "Project"], [/^\/tasks\/[\w-]+$/, "Task"], [/^\/tasks/, "Work"], [/^\/me\/steps/, "My steps"], [/^\/me\/pay/, "My pay"],
  [/^\/me\/work/, "My work"], [/^\/me\/approvals/, "Waiting for you"], [/^\/me\/profile/, "My profile"], [/^\/me/, "My desk"], [/^\/people\/[\w-]+/, "Profile"], [/^\/people/, "Team"],
  [/^\/projects\//, "Client project"], [/^\/projects/, "Client projects"], [/^\/clients\//, "Client"], [/^\/clients/, "Clients"], [/^\/finance/, "Finance"],
  [/^\/erp/, "Billing"], [/^\/hr/, "HR desk"], [/^\/processes/, "Processes"], [/^\/runs/, "Runs"], [/^\/settings/, "Settings"], [/^\/dashboard|^\/home/, "Dashboard"],
  [/^\/contacts/, "Contacts"], [/^\/updates/, "Updates"], [/^\/notifications/, "Notifications"], [/^\/map/, "Map"], [/^\/leadership/, "Leadership"],
];
export function titleForPath(path) {
  const p = String(path ?? "").split(/[?#]/)[0];
  return TITLES.find(([re]) => re.test(p))?.[1] ?? "Page";
}

/** Whether a site's answer headers allow it to be framed by `origin` (X-Frame-Options and CSP frame-ancestors). */
export function frameAllowed(headers, origin) {
  const get = (k) => (typeof headers?.get === "function" ? headers.get(k) : headers?.[k]) ?? "";
  const xfo = String(get("x-frame-options")).trim().toLowerCase();
  if (xfo === "deny" || xfo === "sameorigin") return false;
  const csp = String(get("content-security-policy"));
  const fa = csp.split(";").map((s) => s.trim()).find((s) => s.toLowerCase().startsWith("frame-ancestors"));
  if (!fa) return true;
  const sources = fa.split(/\s+/).slice(1).map((s) => s.toLowerCase());
  if (sources.includes("*")) return true;
  if (!sources.length || sources.includes("'none'")) return false;
  let host = ""; try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  return sources.some((s) => { const h = s.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); return h === host || (h.startsWith("*.") && host.endsWith(h.slice(1))); });
}
