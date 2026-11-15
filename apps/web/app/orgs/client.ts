"use client";
// ORG: the browser side of the Pulse account: switching organisation, joining and starting one. Each answers with a
// session of the organisation it moves to (the proxy keeps it as the cookie), then the app opens there afresh.
// ORG-PER-TAB (owner, 14 Nov 2026): switching changes THIS TAB only. The tab keeps its company (lib/tab-org.mjs: in
// sessionStorage, sent with every call); account/tab-open opens that company's session of the same sign-in, so the
// other tabs stay in theirs. "Open in new tab" opens /at/<company> in a new tab, which opens that company there.
import { confirmDialog, promptDialog } from "../kit/dialogs";
import { withProof } from "../lib/prove-its-you.mjs";

export type Moved = { org: string; name: string; handle: string | null; kind: string; home: string; tab?: boolean };

type TabApi = { get(): string; set(org: string): void; clear(): void; nav(): void };
const tabApi = (): TabApi | null => (typeof window === "undefined" ? null : ((window as unknown as { __pulseTab?: TabApi }).__pulseTab ?? null));

export async function post<T>(path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  // BUGFIX #29: the refusal keeps its status and reason (personal_sign_in: confirm it's you first).
  if (!r.ok) throw Object.assign(new Error(typeof data?.error === "string" ? data.error : "That did not work. Try again."), { status: r.status, code: typeof data?.code === "string" ? data.code : undefined });
  return data as T;
}

/** BUGFIX #29: a company's own sign-in opens that company only (ACCOUNT-META). When opening another company is refused
 *  for that, ask the person for their own Pulse password once (the app's dialog), prove the browser's sign-in (the
 *  session every tab opens from: x-pulse-tab-org none), and open it: no signing out. */
export function proven<T>(work: () => Promise<T>): Promise<T> {
  return withProof(work, {
    ask: (o) => promptDialog(o),
    prove: (password) => post("account/prove", { password }, { "x-pulse-tab-org": "none" }),
    confirm: (o) => confirmDialog(o),
    signInAgain: async () => { await post("auth/sign-out", {}).catch(() => undefined); window.location.assign(new URL("/login", window.location.origin).href); },
  });
}

/** Remembered in this browser too: the switcher puts the organisation you were last in first. */
const LAST = "pulse.org.last";
export const lastOrg = () => { try { return window.localStorage.getItem(LAST); } catch { return null; } };

/** The company this tab is in (null before the page script ran). */
export const tabOrg = () => tabApi()?.get() || null;

/** AUTH-UNIFY: the same kind of page in the other organisation. A record of the one left behind (an id in the address)
 *  has no twin there, so its list opens instead; a client lands on their tasks; organisation-only pages open home. */
export function equivalentPath(path: string, kind: string): string {
  if (kind === "client") return "/tasks";
  const keep: string[] = [];
  for (const part of path.split("?")[0].split("#")[0].split("/").filter(Boolean)) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part) || /^\d+$/.test(part)) break;
    keep.push(part);
  }
  if (!keep.length || ["orgs", "login", "welcome", "join", "oauth", "hq", "admin", "setup", "team-setup", "at"].includes(keep[0])) return "/";
  return "/" + keep.slice(0, 2).join("/");
}

/** ORG-PER-TAB: open a company in this tab only (the browser's sign-in itself, not this tab's company, asks). */
export const openInTab = (org: string) => proven(() => post<Moved>("account/tab-open", { org }, { "x-pulse-tab-org": "none" }));

/** "Open in new tab": the same kind of page, in that company, in a new tab (this tab stays). */
export function newTabHref(org: string, path = typeof window === "undefined" ? "/" : window.location.pathname, kind = "staff") {
  return `/at/${org}?next=${encodeURIComponent(equivalentPath(path, kind))}`;
}

/** GAP-FOUNDER-VIEW: the switcher's own switch from "All my companies": open that company at `to` (one of its pages,
 *  e.g. the bill a card names) or at its home. */
export async function openCompany(org: string, name: string, to?: string) {
  window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: { name } }));
  try { const moved = await openInTab(org); arrive(moved, to ?? moved.home); }
  catch (e) { window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: null })); throw e; }
}

/** Open the app in another organisation: the shell shows "Opening …" at once, the page loads there (in this tab).
 *  `opened`: a link brought the person here (a record of that company): the page says "Opened in …" once. */
export function arrive(moved: Moved, to?: string, opened = false) {
  try { window.localStorage.setItem(LAST, moved.org); } catch { /* private window */ }
  const tab = tabApi();
  tab?.set(moved.org); tab?.nav();
  if (opened) { try { window.sessionStorage.setItem("pulse.tab.opened", moved.name); } catch { /* private window */ } }
  window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: { name: moved.name } }));
  window.location.assign(to ?? moved.home ?? "/dashboard");
}

export async function switchOrg(org: string, name?: string) {
  window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: { name: name ?? "the organisation" } }));
  try { const moved = await openInTab(org); arrive(moved, equivalentPath(window.location.pathname, moved.kind)); }
  catch (e) { window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: null })); throw e; }
}

/** ORG-PER-TAB: sign out of this tab's company only (the other companies stay signed in), or of all of them. */
export async function signOut(scope: "company" | "all") {
  const r = await post<{ signedOut?: boolean }>("auth/sign-out", scope === "company" ? { scope } : {});
  const tab = tabApi();
  tab?.clear();
  window.location.assign(r.signedOut === false ? "/" : "/login?out=1");
}
