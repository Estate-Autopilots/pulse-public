// GROWTH-LOOP slice 2 (owner, 8 Nov 2026): the "What is Vitals?" card's plain words and its small rules. A client-side
// person or a guest who meets Vitals through another company sees "Powered by <company> · Vitals", a 60-second
// explainer and "Start free for your business", which opens their own company pre-filled. Where they came from is
// kept in this browser until the company exists, then reported once (POST /api/v0/growth/started).

export const SOURCES = ["chat", "quote", "contract", "portal"];
export const REF_KEY = "vitals.growth.ref";
export const VISITOR_KEY = "vitals.growth.visitor";
export const DISMISS_KEY = "vitals.growth.dismissed";
/** How long a closed card stays closed, and how long a "Start free" press waits for the new company. */
export const DISMISS_DAYS = 30;
export const REF_HOURS = 2;

/** "Powered by EA · Vitals" (the company that brought them first, Vitals after it). */
export const poweredBy = (company) => {
  const name = String(company ?? "").trim();
  return name ? `Powered by ${name} · Vitals` : "Powered by Vitals";
};

/** The card's one sentence. */
export const pitch = (company) => {
  const name = String(company ?? "").trim();
  return name ? `${name} runs its work on Vitals. Your business can too, free.` : "Run your business on Vitals: chat, quotes, agreements and tasks in one place. Free to start.";
};

/** A company's @handle as the card carries it ("@EA" → "ea"); anything else → null. */
export function cleanVia(x) {
  const h = String(x ?? "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,39}$/.test(h) ? h : null;
}

/** Where "Start free for your business" goes: the signed-in "start a space" page, or sign-up, pre-filled. */
export function startHref({ signedIn, via, source, name }) {
  const q = new URLSearchParams({ from: "growth" });
  const v = cleanVia(via); if (v) q.set("via", v);
  if (SOURCES.includes(source)) q.set("source", source);
  const n = String(name ?? "").trim().slice(0, 80); if (n.length >= 2) q.set("name", n);
  return `${signedIn ? "/start/space" : "/signup"}?${q}`;
}

/** The pre-fill a start page reads from its address (?from=growth&via=…&source=…&name=…), or null. */
export function readStart(search) {
  const q = new URLSearchParams(search ?? "");
  if (q.get("from") !== "growth") return null;
  const source = SOURCES.includes(q.get("source") ?? "") ? q.get("source") : null;
  const name = (q.get("name") ?? "").trim().slice(0, 80);
  return { via: cleanVia(q.get("via")), source, name: name.length >= 2 ? name : "" };
}

/** The referral this browser keeps between "Start free" and the new company (null when missing, broken or too old). */
export function readRef(raw, now = Date.now()) {
  try {
    const r = JSON.parse(raw ?? "");
    const via = cleanVia(r?.via), at = Number(r?.at);
    if (!via || !SOURCES.includes(r?.source) || !Number.isFinite(at) || now - at > REF_HOURS * 3600_000 || at > now + 60_000) return null;
    return { via, source: r.source, at };
  } catch { return null; }
}

/** Whether a card closed at `at` (ms) is still closed. */
export const stillDismissed = (at, now = Date.now()) => Number.isFinite(Number(at)) && now - Number(at) < DISMISS_DAYS * 86400_000;

/** A new anonymous browser id: 32 letters and digits (never anything about the person). */
export function newVisitorId(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(random(32), (b) => abc[b % abc.length]).join("");
}

/** The explainer slot: a video the owner sets (PULSE_EXPLAINER_VIDEO_URL) plays here; otherwise the poster and a note. */
export function explainer(url) {
  const u = String(url ?? "").trim();
  if (!/^https:\/\/[^\s"'<>]{4,400}$/.test(u)) return { kind: "none", url: null };
  if (/\.(mp4|webm)(\?|$)/i.test(u)) return { kind: "file", url: u };
  const yt = /^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{6,20})/.exec(u);
  if (yt) return { kind: "embed", url: `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1&rel=0` };
  return { kind: "link", url: u };
}
