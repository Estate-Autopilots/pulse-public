// PORTAL-2: small pure helpers for the client space (paying, deliverables). Amounts are paise everywhere but on screen.

/** "₹1,50,000" from paise (Indian grouping, no paise shown when whole). */
export function inr(paise) {
  const rupees = Number(paise ?? 0) / 100;
  return `₹${rupees.toLocaleString("en-IN", { maximumFractionDigits: Number.isInteger(rupees) ? 0 : 2, minimumFractionDigits: 0 })}`;
}

/** What a person typed ("1,50,000", "₹ 2500.50") as paise, or null when it is not an amount. */
export function rupeesToPaise(text) {
  const clean = String(text ?? "").replace(/[₹,\s]/g, "");
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, frac = ""] = clean.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

/** A UPI payment link (opens Google Pay, PhonePe, Paytm… on a phone), or null without a valid UPI ID. */
export function upiLink({ upi, payee, paise, note }) {
  if (!/^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,64}$/.test(String(upi ?? ""))) return null;
  const q = new URLSearchParams({ pa: upi, pn: String(payee ?? "").slice(0, 60), cu: "INR" });
  if (Number.isInteger(paise) && paise > 0) q.set("am", (paise / 100).toFixed(2));
  if (note) q.set("tn", String(note).slice(0, 60));
  return `upi://pay?${q.toString().replace(/\+/g, "%20")}`;
}

/** 75.4 → "1:15"; 3725 → "1:02:05". */
export function moment(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** A link a page can show inside a frame: YouTube, Vimeo, Google Drive files and Docs, Figma; null for any other. */
export function embedUrl(url) {
  let u; try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./, "");
  if (host === "youtu.be" && /^\/[\w-]{6,}$/.test(u.pathname)) return `https://www.youtube-nocookie.com/embed${u.pathname}`;
  if (host === "youtube.com" && u.searchParams.get("v")) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(u.searchParams.get("v"))}`;
  if (host === "youtube.com" && /^\/shorts\/[\w-]{6,}$/.test(u.pathname)) return `https://www.youtube-nocookie.com/embed/${u.pathname.split("/")[2]}`;
  if (host === "vimeo.com" && /^\/\d+$/.test(u.pathname)) return `https://player.vimeo.com/video${u.pathname}`;
  const drive = host === "drive.google.com" && u.pathname.match(/^\/file\/d\/([\w-]{10,})/);
  if (drive) return `https://drive.google.com/file/d/${drive[1]}/preview`;
  const doc = host === "docs.google.com" && u.pathname.match(/^\/(document|presentation|spreadsheets)\/d\/([\w-]{10,})/);
  if (doc) return `https://docs.google.com/${doc[1]}/d/${doc[2]}/preview`;
  if (host === "figma.com" && /^\/(file|design|proto)\//.test(u.pathname)) return `https://www.figma.com/embed?embed_host=pulse&url=${encodeURIComponent(u.href)}`;
  return null;
}

/** Bytes as people say them: 820 KB, 14.2 MB. */
export function size(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)} MB`;
}
