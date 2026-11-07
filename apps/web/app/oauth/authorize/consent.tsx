"use client";
import { useState } from "react";
import { BadgeCheck, Building2, Check, CircleAlert, ShieldAlert } from "lucide-react";
import { scopeSentence, SCOPES, shownScopes } from "../scopes";
import css from "./authorize.module.css";

export type AppShown = { name: string; maker: string | null; verified: boolean; homeUrl: string | null; development: boolean; logo: string | null };
export type ConsentState = { kind: "personal" | "org"; scopes: string[]; admin: boolean; emailChecked: boolean;
  person: { id: string; name: string; handle: string | null; photo: boolean }; org: { id: string; name: string; handle: string | null };
  grant: { id: string; scopes: string[] } | null; orgs: { id: string; name: string; handle: string | null; current: boolean }[] };

/** PULSE-ID: the consent screen. Who is allowing, in which organisation, and what the app may do, in plain words; an
 *  admin linking the organisation switches each data scope on or off (money starts off). Allow and Cancel both go back
 *  to the app through Pulse's API, which checks the request again. */
export function Consent({ app, state, query, scopes, kind, self }: { app: AppShown; state: ConsentState; query: Record<string, string>; scopes: string[]; kind: "personal" | "org"; self: string }) {
  const [off, setOff] = useState<string[]>(scopes.filter((s) => SCOPES[s]?.startsOff));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const org = kind === "org", blocked = org && !state.admin;
  const send = async (path: string, body: object) => {
    setBusy(true); setProblem(null);
    try {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => null);
      if (!r.ok || typeof data?.redirect !== "string") throw new Error(typeof data?.error === "string" ? data.error : "Pulse couldn’t finish this. Try again.");
      window.location.assign(data.redirect);
    } catch (e) { setProblem((e as Error).message); setBusy(false); }
  };
  // Another of their organisations: Pulse's own switch (ORG), then this screen again in that organisation.
  const switchTo = async (to: string) => {
    setBusy(true); setProblem(null);
    const r = await fetch("/api/v0/account/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ org: to }) }).catch(() => null);
    if (r?.ok) window.location.assign(self); else { setProblem("Pulse couldn’t switch organisation. Try again."); setBusy(false); }
  };
  const shown = shownScopes(scopes);
  return <div className={css.screen}>
    <section className={css.card} aria-labelledby="oidc-title">
      <div className={css.apps} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element -- the app's logo, served by Pulse (re-encoded at upload) */}
        <span className={css.appMark}>{app.logo ? <img src={app.logo} alt="" width={44} height={44} /> : app.name.slice(0, 1)}</span>
        <span className={css.link} />
        <span className={css.pulseMark}>P</span>
      </div>
      <p className={css.kicker}>Sign in with Pulse</p>
      <h1 id="oidc-title" className={css.title}>{org ? `Link ${state.org.name} to ${app.name}` : `Continue to ${app.name}`}</h1>
      <p className={css.verified} data-verified={app.verified || undefined}>
        {app.verified ? <><BadgeCheck size={15} aria-hidden="true" /> Verified by Pulse{app.maker ? ` · ${app.maker}` : ""}</>
          : <><ShieldAlert size={15} aria-hidden="true" /> Pulse has not verified this app{app.maker ? ` (${app.maker})` : ""}</>}
      </p>
      <dl className={css.who}>
        <dt>Signed in as</dt><dd><strong>{state.person.name}</strong>{state.person.handle ? <span className={css.muted}> @{state.person.handle}</span> : null}</dd>
        <dt>{org ? "Organisation" : "From"}</dt><dd><Building2 size={14} aria-hidden="true" />
          {state.orgs.length > 1 ? <select className={css.orgPick} aria-label="Organisation" value={state.org.id} disabled={busy}
            onChange={(e) => void switchTo(e.target.value)}>{state.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select> : state.org.name}</dd>
      </dl>
      {blocked ? <p className={css.status} data-tone="error" role="alert"><CircleAlert size={15} aria-hidden="true" /> Only an admin of {state.org.name} can link it to {app.name}. Ask an admin, or switch to an organisation you run.</p> : null}
      <fieldset className={css.scopes} disabled={busy || blocked}>
        <legend>{org ? `${app.name} will be able to` : `${app.name} will see`}</legend>
        {shown.map((s) => {
          const data = org && SCOPES[s]?.data, on = !off.includes(s);
          return <label key={s} className={css.scope} data-off={!on || undefined}>
            {data ? <input type="checkbox" checked={on} onChange={() => setOff(on ? [...off, s] : off.filter((x) => x !== s))} aria-describedby={`scope-${s}`} />
              : <Check size={16} aria-hidden="true" className={css.tick} />}
            <span id={`scope-${s}`}>{scopeSentence(s, kind, state.org.name)}</span>
          </label>;
        })}
      </fieldset>
      {scopes.includes("email") && !state.emailChecked ? <p className={css.status} data-tone="info">Pulse hasn’t confirmed your e-mail yet, and {app.name} may ask for a confirmed one. Confirm it in <a href="/account">Account → Security</a>, then come back.</p> : null}
      {problem ? <p className={css.status} data-tone="error" role="alert">{problem}</p> : null}
      <div className={css.actions}>
        <button type="button" className={css.secondary} disabled={busy} onClick={() => void send("/api/v0/oidc/authorize/refuse", { query, error: "access_denied" })}>Cancel</button>
        <button type="button" className={css.primary} disabled={busy || blocked} onClick={() => void send("/api/v0/oidc/authorize/allow", { query, off })}>{busy ? "Opening…" : org ? "Link organisation" : "Allow"}</button>
      </div>
      <p className={css.foot}>{org ? `Any admin of ${state.org.name} can change or end this in Settings → Connected apps.` : "You can remove it any time in Settings → Connected apps."}
        {app.homeUrl ? <> <a href={app.homeUrl} rel="noreferrer" target="_blank">About {app.name}</a></> : null}</p>
    </section>
  </div>;
}
