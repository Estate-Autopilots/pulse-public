"use client";
// ORG: the browser side of the Pulse account: switching organisation, joining and starting one. Each answers with a
// session of the organisation it moves to (the proxy keeps it as the cookie), then the app opens there afresh.

export type Moved = { org: string; name: string; handle: string | null; kind: string; home: string };

export async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "That did not work. Try again.");
  return data as T;
}

/** Remembered in this browser too: the switcher puts the organisation you were last in first. */
const LAST = "pulse.org.last";
export const lastOrg = () => { try { return window.localStorage.getItem(LAST); } catch { return null; } };

/** AUTH-UNIFY: the same kind of page in the other organisation. A record of the one left behind (an id in the address)
 *  has no twin there, so its list opens instead; a client lands on their tasks; organisation-only pages open home. */
export function equivalentPath(path: string, kind: string): string {
  if (kind === "client") return "/tasks";
  const keep: string[] = [];
  for (const part of path.split("?")[0].split("#")[0].split("/").filter(Boolean)) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part) || /^\d+$/.test(part)) break;
    keep.push(part);
  }
  if (!keep.length || ["orgs", "login", "welcome", "join", "oauth", "hq", "admin", "setup", "team-setup"].includes(keep[0])) return "/";
  return "/" + keep.slice(0, 2).join("/");
}

/** Open the app in another organisation: the shell shows "Opening …" at once, the page loads there. */
export function arrive(moved: Moved, to?: string) {
  try { window.localStorage.setItem(LAST, moved.org); } catch { /* private window */ }
  window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: { name: moved.name } }));
  window.location.assign(to ?? moved.home ?? "/dashboard");
}

export async function switchOrg(org: string, name?: string) {
  window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: { name: name ?? "the organisation" } }));
  try { const moved = await post<Moved>("account/switch", { org }); arrive(moved, equivalentPath(window.location.pathname, moved.kind)); }
  catch (e) { window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: null })); throw e; }
}
