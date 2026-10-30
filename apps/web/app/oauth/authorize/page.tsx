import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { apiPost, getMe } from "../../lib/api";
import { hostHeader } from "../../lib/host-mode.mjs";
import { Consent, type AppShown, type ConsentState } from "./consent";
import css from "./authorize.module.css";

export const metadata = { title: "Sign in with Pulse" };

type Check = { fatal?: "unknown_app" | "bad_redirect"; redirect?: string; app: AppShown | null; kind?: "personal" | "org"; scopes?: string[]; prompt?: string | null };

/** PULSE-ID: Pulse's consent screen for "Sign in with Pulse" (docs/architecture/PULSE_IDENTITY_AND_DATA_API.md §6.2).
 *  The API checks the request first: an unknown app or an unregistered return address gets this page's own message and
 *  never a redirect. Signed out: the sign-in page (with "Create your account"), then back here. A personal connection
 *  that already covers the request goes straight back to the app; otherwise the person allows or cancels. */
export default async function Authorize({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string" || Array.isArray(v)) query[k] = String(Array.isArray(v) ? v[0] : v).slice(0, 2048);
  const self = `/oauth/authorize?${new URLSearchParams(query)}`;
  const check = await checkRequest(query);
  if (!check) return <Problem title="Pulse can’t answer this sign-in just now" text="Try again in a minute. If it keeps happening, tell the app’s team that Pulse sign-in is unavailable." />;
  if (check.fatal === "unknown_app") return <Problem title="This app isn’t registered with Pulse" text="The sign-in link names an app Pulse doesn’t know, or one that has been switched off. Nothing was shared." />;
  if (check.fatal === "bad_redirect") return <Problem title="This sign-in link doesn’t match the app" text={`${check.app?.name ?? "The app"} asked Pulse to send you to an address it never registered, so Pulse stopped here. Nothing was shared.`} />;
  if (check.redirect) redirect(check.redirect);
  const refuse = async (error: string) => {
    const r = await fetchApi("/api/v0/oidc/authorize/refuse", { query, error });
    return r?.redirect ? redirect(r.redirect) : <Problem title="Pulse can’t answer this sign-in just now" text="Try again in a minute." />;
  };
  const me = await getMe();
  if (!me.data) {
    if (check.prompt === "none") return refuse("login_required");
    redirect(`/login?${new URLSearchParams({ next: self })}`);
  }
  const state = await apiPost<ConsentState>("oidc/authorize/state", { query });
  if (!state.data) return <Problem title="Pulse can’t ask you about this app" text={state.error ?? "Try again in a minute."} />;
  const covered = state.data.kind === "personal" && !!state.data.grant && (check.scopes ?? []).every((s) => state.data!.grant!.scopes.includes(s));
  if (covered && check.prompt !== "consent" && check.prompt !== "login") {
    const allowed = await apiPost<{ redirect: string }>("oidc/authorize/allow", { query });
    if (allowed.data?.redirect) redirect(allowed.data.redirect);
  }
  if (check.prompt === "none") return refuse("consent_required");
  return <Consent app={check.app!} state={state.data} query={query} scopes={check.scopes ?? []} kind={check.kind ?? "personal"} self={self} />;
}

/** The request's check needs no sign-in, so it is asked directly (the page may be signed out). */
async function fetchApi(path: string, body?: unknown) {
  const h = await headers();
  try {
    const r = await fetch(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}${path}`, { method: body ? "POST" : "GET", cache: "no-store", signal: AbortSignal.timeout(10000),
      headers: { ...hostHeader(h), "x-pulse-client-ip": h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "oauth-page", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
const checkRequest = (query: Record<string, string>) => fetchApi(`/api/v0/oidc/authorize/check?${new URLSearchParams(query)}`) as Promise<Check | null>;

function Problem({ title, text }: { title: string; text: string }) {
  return <div className={css.screen}><section className={css.card} aria-labelledby="oidc-problem">
    <p className={css.kicker}>Sign in with Pulse</p>
    <div className={css.problem}><CircleAlert size={20} aria-hidden="true" /><div><h1 id="oidc-problem" className={css.title}>{title}</h1><p className={css.sub}>{text}</p></div></div>
    <Link className={css.secondary} href="/">Open Pulse</Link>
  </section></div>;
}
