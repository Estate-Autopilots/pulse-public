// PR-PIPELINE: the pipeline screens' pure helpers (contrast, trend, words for approvals, angles and formats, numbers).

/** WCAG relative luminance of a #RRGGBB colour. */
export function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1 to 21), or null when one is not a colour. */
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Plain words for a contrast ratio: at least 4.5:1 passes for body text (WCAG AA). */
export function contrastWords(ratio) {
  if (ratio === null || ratio === undefined) return { ok: false, text: "Choose two colours" };
  const r = Math.round(ratio * 10) / 10;
  return ratio >= 4.5 ? { ok: true, text: `${r}:1, easy to read` } : { ok: false, text: `${r}:1, too faint (needs 4.5:1)` };
}

/** The score's trend against the one before: up, down or level, with the difference. */
export function trend(now, before) {
  if (before === null || before === undefined || now === null || now === undefined) return { dir: "new", text: "New" };
  const d = Number(now) - Number(before);
  if (d > 0) return { dir: "up", text: `Up ${d}` };
  if (d < 0) return { dir: "down", text: `Down ${-d}` };
  return { dir: "level", text: "Level" };
}

export const APPROVAL_WORDS = { draft: "Draft", review: "In review", approved: "Approved", posted: "Posted" };
export const ANGLE_WORDS = { social_proof: "Social proof", authority: "Authority", curiosity: "Curiosity gap", contrast: "Contrast", before_after: "Before and after" };
export const FORMAT_WORDS = { carousel: "Carousel", single: "Single post", thread: "Thread", case_study: "Case study", release_note: "Release note", customer_story: "Customer story" };
export const KIND_WORDS = { company: "Company", personal: "Personal", client: "Client" };
export const SOURCE_WORDS = { commit: "Commit", merge: "Merge", release: "Release", deploy: "Deploy", lane_report: "Report", task: "Task", delivery: "Delivery", goal: "Goal",
  meeting: "Meeting", outcome: "Client outcome", bug: "Bug fixed", career: "Career", harvest: "Highlight" };
export const INDUSTRY_WORDS = { software: "Software", real_estate: "Real estate", agency: "Agency", consulting: "Consulting", ecommerce: "Online shop", education: "Education",
  creator: "Creator", other: "Other" };

/** What the person can do next with a draft, given its approval state and whether a client must say OK. */
export function nextMoves(d) {
  if (!d) return [];
  if (d.approval === "draft") return ["review"];
  if (d.approval === "review") return ["approved", "draft"];
  if (d.approval === "approved") return [...(d.needsClientOk && !d.clientOkAt ? ["client_ok"] : []), ...(!d.needsClientOk || d.clientOkAt ? ["posted"] : []), "draft"];
  return [];
}
export const MOVE_WORDS = { review: "Send to review", approved: "Approve", draft: "Back to draft", client_ok: "Client said OK", posted: "Mark posted" };

/** Whole numbers with thousands separators (Indian grouping for INR, as the app shows money). */
export function num(n, currency) {
  const v = Math.round(Number(n) || 0);
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-GB", { maximumFractionDigits: 0 }).format(v);
}

/** A proof link shown as a link only when it is a web or in-app address; git and report references stay as text. */
export function proofHref(url) {
  const u = String(url ?? "");
  return /^https:\/\//.test(u) || /^\/[A-Za-z0-9]/.test(u) ? u : null;
}

/** The setup wizard's three steps, and whether a step's fields let it go on. */
export const STEPS = ["Brand kit", "Audiences and goals", "Work sources"];
export function stepReady(step, f) {
  if (step === 0) return Boolean(String(f.name ?? "").trim()) && (f.kind !== "client" || Boolean(f.clientId)) && (contrast(f.bg, f.fg) ?? 0) >= 4.5;
  if (step === 1) return (f.audiences ?? []).some((a) => String(a.name ?? "").trim());
  return Number(f.postsPerWeek) >= 1 && Number(f.postsPerWeek) <= 7;
}
