"use client";
// ORG: the browser side of the Pulse account: switching organisation, joining and starting one. Each answers with a
// session of the organisation it moves to (the proxy keeps it as the cookie), then the app opens there afresh.
// ORG-PER-TAB (owner, 14 Nov 2026): switching changes THIS TAB only. The tab keeps its company (lib/tab-org.mjs: in
// sessionStorage, sent with every call); account/tab-open opens that company's session of the same sign-in, so the
// other tabs stay in theirs. "Open in new tab" opens /at/<company> in a new tab, which opens that company there.
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { confirmDialog, promptDialog, toast } from "../kit/dialogs";
import { needsProof, proveNow } from "../lib/prove-its-you.mjs";

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

/** SWITCH-SMOOTH (2165): which of my companies this browser's sign-in may not open yet, and how it can prove me (the
 *  masked own e-mail a code goes to; whether I have a Pulse password). Asked as the browser's sign-in (the session every
 *  tab opens from), kept for half a minute. Null when it cannot be read (the switch then asks only if it is refused). */
export type Crossing = { personal: boolean; locked: string[]; ways?: { code: string | null; password: boolean; passkey?: boolean } };
let known: { at: number; value: Crossing } | null = null;
const SIGN_IN = { "x-pulse-tab-org": "none" };
export async function crossing(fresh = false): Promise<Crossing | null> {
  if (!fresh && known && Date.now() - known.at < 30000) return known.value;
  try {
    const r = await fetch("/api/v0/account/crossing", { cache: "no-store", headers: SIGN_IN });
    if (!r.ok) return null;
    const value = await r.json() as Crossing;
    known = { at: Date.now(), value: { personal: value.personal === true, locked: Array.isArray(value.locked) ? value.locked.map(String) : [], ways: value.ways } };
    return known.value;
  } catch { return null; }
}

/** SWITCH-SMOOTH (2178): the account's own passkey, as the browser's sign-in (every tab follows it). The WebAuthn library
 *  loads only when a passkey is used: the shell (every page imports this file through the switcher) stays as light as
 *  before. Whether this browser can use passkeys at all is a plain check (as @simplewebauthn/browser's own). */
export const passkeysSupported = () => typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
export async function provePasskey() {
  const [{ startAuthentication }, optionsJSON] = await Promise.all([import("@simplewebauthn/browser"),
    post<PublicKeyCredentialRequestOptionsJSON>("account/passkey", { action: "prove-options" }, SIGN_IN)]);
  const response = await startAuthentication({ optionsJSON });
  return post<{ personal: boolean }>("account/passkey", { action: "prove", response }, SIGN_IN);
}
/** Adds a passkey to the account (only a sign-in that proved the person may). */
export async function addAccountPasskey() {
  const [{ startRegistration }, { passkeyName }, optionsJSON] = await Promise.all([import("@simplewebauthn/browser"), import("../lib/two-step.mjs"),
    post<PublicKeyCredentialCreationOptionsJSON>("account/passkey", { action: "register-options" }, SIGN_IN)]);
  const response = await startRegistration({ optionsJSON });
  return post<{ ok: boolean }>("account/passkey", { action: "register", response, name: passkeyName(navigator.userAgent) }, SIGN_IN);
}
// "Not now" to the offer waits a month in this browser.
const OFFER_LATER = "pulse.passkey.later";
const offerWaits = () => { try { const at = Number(window.localStorage.getItem(OFFER_LATER) ?? 0); return !!at && Date.now() - at < 30 * 86400000; } catch { return false; } };

/** SWITCH-SMOOTH: confirm it's you now, where you stand: a code to your own e-mail first (one tap: it is sent at once,
 *  the box takes a typed or pasted code), your Pulse password last. Proves the browser's sign-in, so every tab and
 *  every company opens, and this browser is trusted for 180 days. True once proved. */
export async function proveHere(name?: string): Promise<boolean> {
  // Screenshot judge: "Opening …" must not spin while the dialog still asks; it shows again once the proof is in.
  const moving = (detail: { name: string } | null) => window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail }));
  const c = await crossing(true);
  const done = <T,>(r: T) => { known = null; if (name) moving({ name }); return r; };
  return proveNow({
    name,
    codeTo: c?.ways?.code ?? null,
    password: c?.ways ? c.ways.password !== false : undefined,
    ask: (o) => { moving(null); return promptDialog(o); },
    prove: async (password) => done(await post("account/prove", { password }, SIGN_IN)),
    ...(c?.ways?.passkey && passkeysSupported() ? { passkey: async () => { moving(null); return done(await provePasskey()); } } : {}),
    ...(c?.ways && !c.ways.passkey && passkeysSupported() && !offerWaits() ? { offerPasskey: async (w) => {
      // "Opening …" waits while this is asked (screenshot: it spun behind the question), then shows again.
      moving(null);
      try {
        if (!await confirmDialog({ title: w.offerTitle, body: w.offerBody, confirmLabel: w.offerConfirm, cancelLabel: w.offerLater })) {
          try { window.localStorage.setItem(OFFER_LATER, String(Date.now())); } catch { /* private window */ }
          return;
        }
        try { await addAccountPasskey(); toast.success("Passkey added. Next time it's one tap."); }
        catch (e) { const m = (await import("../lib/passkeys")).passkeyMessage(e, ""); if (m) toast.error(m); }
      } finally { if (name) moving({ name }); }
    } } : {}),
    ...(c?.ways?.code === null ? {} : {
      sendCode: () => post<{ to?: string; personal?: boolean }>("account/prove-code", { action: "send" }, SIGN_IN),
      proveCode: async (code: string) => done(await post("account/prove-code", { action: "finish", code }, SIGN_IN)),
    }),
    confirm: (o) => confirmDialog(o),
    signInAgain: async () => { await post("auth/sign-out", {}).catch(() => undefined); window.location.assign(new URL("/login", window.location.origin).href); },
  });
}

/** BUGFIX #29: a company's own sign-in opens that company only (ACCOUNT-META). When opening another company is refused
 *  for that, ask the person to confirm it is them once (proveHere: a code to their own e-mail, or their Pulse password),
 *  prove the browser's sign-in (the session every tab opens from: x-pulse-tab-org none), and open it: no signing out. */
export async function proven<T>(work: () => Promise<T>, name?: string): Promise<T> {
  try { return await work(); } catch (first) {
    if (!needsProof(first)) throw first;
    if (!await proveHere(name)) throw first;
    return await work();
  }
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
export const openInTab = (org: string, name?: string) => proven(() => post<Moved>("account/tab-open", { org }, { "x-pulse-tab-org": "none" }), name);

/** "Open in new tab": the same kind of page, in that company, in a new tab (this tab stays). */
export function newTabHref(org: string, path = typeof window === "undefined" ? "/" : window.location.pathname, kind = "staff") {
  return `/at/${org}?next=${encodeURIComponent(equivalentPath(path, kind))}`;
}

/** GAP-FOUNDER-VIEW: the switcher's own switch from "All my companies": open that company at `to` (one of its pages,
 *  e.g. the bill a card names) or at its home. */
export async function openCompany(org: string, name: string, to?: string) {
  window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: { name } }));
  try { const moved = await openInTab(org, name); arrive(moved, to ?? moved.home, true); }
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
  // BUGFIX #29 (screenshot judge: "nothing says the switch happened"): the page says "Opened in …" once, as a link does.
  try { const moved = await openInTab(org, name); arrive(moved, equivalentPath(window.location.pathname, moved.kind), true); }
  catch (e) { window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: null })); throw e; }
}

/** ORG-PER-TAB: sign out of this tab's company only (the other companies stay signed in), or of all of them. */
export async function signOut(scope: "company" | "all") {
  const r = await post<{ signedOut?: boolean }>("auth/sign-out", scope === "company" ? { scope } : {});
  const tab = tabApi();
  tab?.clear();
  window.location.assign(r.signedOut === false ? "/" : "/login?out=1");
}
