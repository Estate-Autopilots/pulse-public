"use client";
// ORG: the org switcher. Ctrl/⌘+Shift+O (or Alt+Shift+O) opens it anywhere; the sidebar's switcher and the rail's
// organisation tile send `pulse:orgs-open`; 1–9 jump straight to an organisation, ↑/↓ and Enter pick one. Switching
// needs no sign-in: the account opens the same person's session in the other organisation.
import { Building2, Check, KeyRound, Loader2, Lock, Mail, Plus, Settings2, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AccountOrg, AccountState } from "../lib/api";
import { post, switchOrg } from "./client";
import { accessLabel, kindLabel, orgHue, orgInitials } from "./labels";
import css from "./orgs.module.css";

/** ORG-SWITCHER-UX: an organisation's own square logo; without one (or if it fails to load) its initials on its brand
 *  colour, else on a colour of its own, the same as the sidebar's tile. */
function OrgMark({ org }: { org: AccountOrg }) {
  const [failed, setFailed] = useState<string | null>(null);
  const mark = org.mark && failed !== org.mark ? org.mark : null;
  return <span className={css.tile} data-org-tile={org.name} data-img={mark ? "" : undefined} aria-hidden="true"
    style={mark ? undefined : { background: org.accent ?? `hsl(${orgHue(org.name)} 48% 38%)`, color: "#fff" }}>
    {/* eslint-disable-next-line @next/next/no-img-element -- a small logo served by the app itself */}
    {mark ? <img src={mark} alt="" width={34} height={34} data-org-mark={org.name} decoding="async" onError={() => setFailed(mark)} /> : orgInitials(org.name)}
  </span>;
}

export function OrgSwitcher({ state }: { state: AccountState | null | undefined }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const orgs = useMemo(() => state?.orgs ?? [], [state]);
  const invites = state?.invites ?? [];
  // PERSONAL-WORKSPACE (1640): my own private workspace sits first ("My workspace"), apart from the companies; an account
  // that has none yet makes it with one tap here.
  const firstCompany = orgs.findIndex((o) => !o.mine);
  const [making, setMaking] = useState(false);
  const makeMine = useCallback(async () => {
    setMaking(true); setError(null);
    try { const r = await post<{ org: string }>("account/personal-workspace", {}); await switchOrg(r.org, "My workspace"); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not open your workspace"); setMaking(false); }
  }, []);

  const go = useCallback(async (index: number) => {
    const org = orgs[index]; if (!org) return;
    if (org.current) { setOpen(false); return; }
    setError(null);
    try { await switchOrg(org.id, org.name); } catch (e) { setError(e instanceof Error ? e.message : "Could not switch"); }
  }, [orgs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey || e.altKey) && e.shiftKey && (e.key ?? "").toLowerCase() === "o") { e.preventDefault(); setOpen((v) => !v); setActive(Math.min(1, orgs.length - 1)); }
    };
    const onOpen = () => { setOpen(true); setActive(Math.min(1, orgs.length - 1)); };
    const onMoving = (e: Event) => { const d = (e as CustomEvent<{ name: string } | null>).detail; setMoving(d?.name ?? null); if (d) setOpen(false); };
    const onSwitch = (e: Event) => { const id = (e as CustomEvent<{ org: string }>).detail?.org; const i = orgs.findIndex((o) => o.id === id); if (i >= 0) void go(i); };
    window.addEventListener("keydown", onKey); window.addEventListener("pulse:orgs-open", onOpen);
    window.addEventListener("pulse:org-moving", onMoving); window.addEventListener("pulse:org-switch", onSwitch);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pulse:orgs-open", onOpen); window.removeEventListener("pulse:org-moving", onMoving); window.removeEventListener("pulse:org-switch", onSwitch); };
  }, [orgs, go]);
  useEffect(() => { if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus(); }, [open, active]);

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(orgs.length - 1, a + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    if (/^[1-9]$/.test(e.key) && orgs[Number(e.key) - 1]) { e.preventDefault(); void go(Number(e.key) - 1); }
  };

  return <>
    {state?.unify ? <UnifyPrompt orgs={orgs.map((o) => o.name)} /> : null}
    {moving ? <div className={css.moving} role="status" aria-live="polite"><Loader2 size={18} className={css.spin} aria-hidden="true" /><span>Opening {moving}…</span></div> : null}
    {open ? <div className={css.scrim} onPointerDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label="Switch organisation" onKeyDown={onListKey}>
        <header className={css.dialogHead}>
          <span>Switch organisation</span>
          {state?.account ? <a href="/orgs/profile" className={css.handle}><UserRound size={13} aria-hidden="true" />@{state.account.handle}</a> : null}
        </header>
        <div className={css.list} ref={list} role="menu">
          {state?.account && !orgs.some((o) => o.mine) ? <button type="button" className={css.orgRow} data-mine="" disabled={making} onClick={() => void makeMine()}>
            <span className={css.tile} data-mine-tile="" aria-hidden="true">{making ? <Loader2 size={15} className={css.spin} /> : <UserRound size={15} />}</span>
            <span className={css.rowCopy}><b className={css.orgName}>My workspace</b><small><Lock size={11} aria-hidden="true" /> Private · your goals, projects and tasks</small></span>
          </button> : null}
          {orgs.map((o, i) => (<span key={o.id} style={{ display: "contents" }}>
            {i === firstCompany && firstCompany > 0 ? <p className={css.group}>Companies</p> : null}
            <button type="button" role="menuitemradio" data-mine={o.mine ? "" : undefined} aria-checked={o.current} data-index={i} tabIndex={i === active ? 0 : -1}
              className={css.orgRow} data-current={o.current ? "" : undefined} title={o.name} aria-keyshortcuts={o.current || i >= 9 ? undefined : String(i + 1)} onClick={() => void go(i)} onFocus={() => setActive(i)}>
              {o.mine ? <span className={css.tile} data-mine-tile="" aria-hidden="true"><UserRound size={15} /></span> : <OrgMark org={o} />}
              {o.mine ? <span className={css.rowCopy}><b className={css.orgName}>My workspace</b><small><Lock size={11} aria-hidden="true" /> Private · {o.name}</small></span>
                : <span className={css.rowCopy}><b className={css.orgName}>{o.name}</b><small>{[o.orgKind === "personal" ? "Personal workspace" : null, accessLabel(o.access, o.kind), o.handle ? `@${o.handle}` : null].filter(Boolean).join(" · ")}</small></span>}
              {o.current ? <Check size={16} className={css.check} aria-label="Current" /> : i < 9 ? <kbd className={css.kbd}>{i + 1}</kbd> : null}
            </button>
          </span>))}
          {invites.length ? <p className={css.group}>Invitations</p> : null}
          {invites.map((v) => <a key={v.id} href={`/orgs#invite-${v.id}`} className={css.orgRow} onClick={() => setOpen(false)}>
            <span className={css.tile} data-invite="" aria-hidden="true"><Mail size={14} /></span>
            <span className={css.rowCopy}><b>{v.org}</b><small>Invited you as {kindLabel(v.kind).toLowerCase()}{v.title ? ` · ${v.title}` : ""}</small></span>
          </a>)}
        </div>
        {error ? <p className={css.error} role="alert">{error}</p> : null}
        <footer className={css.dialogFoot}>
          <a href="/orgs/new" className={css.action}><Plus size={15} aria-hidden="true" />Start your own Pulse</a>
          <a href="/orgs" className={css.action}><Settings2 size={15} aria-hidden="true" />Organisations and invitations</a>
          <span className={css.hint}><kbd className={css.kbd}>Ctrl</kbd><kbd className={css.kbd}>Shift</kbd><kbd className={css.kbd}>O</kbd></span>
        </footer>
      </div>
    </div> : null}
  </>;
}

/** AUTH-UNIFY: asked once to someone in several workspaces with no one password yet. "Later" waits a week in this browser. */
const LATER = "pulse.unify.later";
const noSubscribe = () => () => {};
const laterPressed = () => { try { const at = Number(window.localStorage.getItem(LATER) ?? 0); return !!at && Date.now() - at < 7 * 86400000; } catch { return false; } };
function UnifyPrompt({ orgs }: { orgs: string[] }) {
  // Read in the browser only (the server renders nothing): "Later" pressed within the last week.
  const waiting = useSyncExternalStore(noSubscribe, laterPressed, () => true);
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (waiting || closed) return null;
  const setShow = (v: boolean) => setClosed(!v);
  const later = () => { try { window.localStorage.setItem(LATER, String(Date.now())); } catch { /* private window */ } setShow(false); };
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setError(null);
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    if (data.next !== data.again) { setError("The two new passwords are not the same."); return; }
    if (new TextEncoder().encode(data.next).length < 10) { setError("Use at least 10 characters."); return; }
    setBusy(true);
    try { await post("account/unify", { current: data.current, next: data.next }); setDone(true); }
    catch (err) { setError(err instanceof Error ? err.message : "That did not work. Try again."); }
    finally { setBusy(false); }
  };
  const names = orgs.join(" and ");
  return <div className={css.scrim}>
    <div className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="unify-title">
      <header className={css.dialogHead}><span id="unify-title" className={css.unifyTitle}><KeyRound size={14} aria-hidden="true" />One password for all your workspaces</span></header>
      {done ? <div className={css.unifyBody}>
        <p>Done. Sign in to {names} with this one password from now on.</p>
        <div className={css.unifyActions}><button type="button" className={css.unifyPrimary} onClick={() => setShow(false)}>Continue</button></div>
      </div> : <form className={css.unifyBody} onSubmit={submit}>
        <p>You are in {names}. Choose one password for all of them. Switching between them never asks you to sign in again.</p>
        <label className={css.unifyField}>A password you use now (any workspace)<input name="current" type="password" required autoComplete="current-password" maxLength={72} /></label>
        <label className={css.unifyField}>New password<input name="next" type="password" required autoComplete="new-password" maxLength={72} /></label>
        <label className={css.unifyField}>New password again<input name="again" type="password" required autoComplete="new-password" maxLength={72} /></label>
        {error ? <p className={css.unifyError} role="alert">{error}</p> : null}
        <div className={css.unifyActions}>
          <button type="button" className={css.unifyLater} onClick={later}>Later</button>
          <button className={css.unifyPrimary} disabled={busy}>{busy ? "Saving…" : "Use this password everywhere"}</button>
        </div>
      </form>}
    </div>
  </div>;
}

/** The account menu's entry (phones have no rail): opens the switcher. */
export function OrgsMenuItem() {
  return <button type="button" role="menuitem" onClick={() => window.dispatchEvent(new Event("pulse:orgs-open"))}><Building2 size={16} aria-hidden="true" />Switch organisation</button>;
}
