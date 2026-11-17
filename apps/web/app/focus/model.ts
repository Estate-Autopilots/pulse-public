// FOCUS: what /api/v0/focus returns (services/api/src/focus.ts) and the small helpers the board shares.
export type Win = { usedPct: number | null; resetsAt: string | null; amount: number | null; currency: string | null; at: string; source: string };
export type Company = { key: string; name: string; weight: number; hue: number; sort: number };
export type Account = {
  key: string; name: string; kind: "ai" | "api" | "cloud"; provider: string; ownCompany: string | null; companies: string[]; urgentOnly: string[];
  tiers: string[]; cost: "sunk" | "metered"; source: string; status: "ok" | "limited" | "off"; note: string; latest: Record<string, Win> | null;
};
export type Lane = { key: string; title: string; company: string; value: number; size: string; need: string; dueOn: string | null; urgent: boolean;
  blockedBy: string | null; status: string; account: string | null; unblocks: number; updatedAt: string };
export type Plan = {
  day: string;
  weights: { key: string; name: string; base: number; today: number; why: string | null }[];
  placed: { lane: string; title: string; company: string; account: string; accountName: string; score: number; reason: string }[];
  waiting: { lane: string; title: string; company: string; until: string | null; reason: string }[];
  blocked: { blocker: string; lanes: string[]; company: string }[];
};
export type Board = {
  settings: { reserve5h: number; reserve7d: number; autoWeights: boolean; hasKey: boolean; ingestAt: string | null };
  companies: Company[]; accounts: Account[]; lanes: Lane[]; plan: Plan; burn: { company: string; hours: number[] }[];
  sent: { day: string; madeAt: string; sentAt: string | null } | null; now: string;
  /** The company's own time zone (UX-GAMIFY: "done today" is its today). */ zone?: string;
  /** SETTINGS-APPLE (T1.4.2): opened from another company (/api/v0/account/focus): that company, and which of Focus's
   *  companies it is (null when it is not one of them). */
  here?: { name: string; key: string | null };
};

const MIN = 60_000, HOUR = 60 * MIN;
/** "in 1 h 12 min" / "in 8 min"; null when the time is past or unknown. */
export function resetsIn(at: string | null | undefined, now: number) {
  const ms = at ? Date.parse(at) - now : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))} min`;
  if (ms < 48 * HOUR) { const m = Math.round(ms / MIN); return `${Math.floor(m / 60)} h ${m % 60} min`; }
  return `${Math.round(ms / (24 * HOUR))} days`;
}
/** "2 min ago"; stale after 30 minutes. */
export function age(at: string | null | undefined, now: number) {
  const ms = at ? now - Date.parse(at) : NaN;
  if (!Number.isFinite(ms)) return { text: "No reading", stale: true };
  const text = ms < MIN ? "just now" : ms < HOUR ? `${Math.round(ms / MIN)} min ago` : ms < 48 * HOUR ? `${Math.round(ms / HOUR)} h ago` : `${Math.round(ms / (24 * HOUR))} days ago`;
  return { text, stale: ms > 30 * MIN };
}
/** % used now: a window past its reset counts as empty again. */
export function used(w: Win | undefined, now: number) {
  if (!w || w.usedPct === null) return null;
  return w.resetsAt && Date.parse(w.resetsAt) <= now ? 0 : Number(w.usedPct);
}
export const SOURCE: Record<string, string> = { statusline: "Claude status line", "claude-logs": "Claude logs", "codex-logs": "Codex logs", api: "Balance API", manual: "Typed by hand" };
export const NEED: Record<string, string> = { T0: "Easy", T1: "Routine", T2: "Build", T3: "Deep" };
export async function focusPost<T = { ok: true }>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : typeof data?.message === "string" ? data.message : "That did not save. Try again.");
  return data as T;
}
