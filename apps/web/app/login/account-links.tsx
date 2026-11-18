'use client';
// PORTAL-2: the pages an e-mailed link opens for a Pulse account (clients, freelancers). The token is in the fragment, so
// it never reaches a server log; nothing happens until the person presses the button (mail scanners that open links
// cannot use it up). After signing in, a client lands in their space (/client).
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { post } from '../records';
import css from './login.module.css';
import { PasswordField } from './password-field';

/** The token from the address's fragment, read once and then removed from the address bar. */
function useFragment() {
  const tokenRef = useRef(''); const [ready, setReady] = useState(false);
  useEffect(() => {
    const capture = () => { if (!window.location.hash) return; tokenRef.current = window.location.hash.slice(1); window.history.replaceState(null, '', window.location.pathname); setReady(true); };
    capture(); window.addEventListener('hashchange', capture); return () => window.removeEventListener('hashchange', capture);
  }, []);
  return { tokenRef, ready };
}

function Frame({ kicker, title, onSubmit, children }: { kicker: string; title: string; onSubmit: (e: FormEvent<HTMLFormElement>) => void; children: ReactNode }) {
  return <div className={css.screen}>
    <section className={css.brand} aria-label="Pulse"><div className={css.wordmark}><b>Pulse</b></div><h2 className={css.headline}>Your work with your team, <em>in one place.</em></h2></section>
    <div className={css.side}><form className={css.form} onSubmit={onSubmit}><p className={css.kicker}>{kicker}</p><h1 className={css.title}>{title}</h1>{children}</form></div>
  </div>;
}

export function AccountLinkSignIn() {
  const router = useRouter(); const { tokenRef, ready } = useFragment();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(''); setBusy(true);
    try { const r = await post<{ home?: string }>('auth/account-link-sign-in', { token: tokenRef.current }); tokenRef.current = ''; router.replace(r.home ?? '/client'); router.refresh(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return <Frame kicker="One-time sign-in" title="Sign in to Pulse" onSubmit={submit}>
      <p className={css.sub}>{ready ? 'This private link signs you in once, within 15 minutes of being sent.' : 'Open the link from your e-mail on this device. It works once, within 15 minutes.'}</p>
      {error ? <p role="alert" className={css.status} data-tone="error">{error}</p> : null}
      <button className={css.primary} disabled={busy || !ready}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <a className={css.link} href="/login">Sign in with your password instead</a>
      <p className={css.foot}>Didn’t ask for this? Close the page. Keep the link private.</p>
  </Frame>;
}

export function AccountReset() {
  const router = useRouter(); const { tokenRef, ready } = useFragment();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [password, setPassword] = useState('');
  const bytes = new TextEncoder().encode(password).length;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(''); const data = new FormData(e.currentTarget);
    if (data.get('password') !== data.get('again')) { setError('The two passwords are not the same.'); return; }
    setBusy(true);
    try { const r = await post<{ home?: string }>('auth/account-reset', { token: tokenRef.current, password: data.get('password') }); tokenRef.current = ''; router.replace(r.home ?? '/client'); router.refresh(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return <Frame kicker="Your Pulse account" title="Choose a new password" onSubmit={submit}>
      <p className={css.sub}>{ready ? 'The link works once, within 60 minutes. Your other devices are signed out when you change it.' : 'Open the link from your e-mail on this device.'}</p>
      <PasswordField label="New password" name="password" required maxLength={72} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <PasswordField label="New password again" name="again" required maxLength={72} autoComplete="new-password" />
      <p className={css.foot}>{bytes < 10 ? 'Use at least 10 bytes; several unrelated words work well.' : bytes > 72 ? 'This password is longer than 72 bytes.' : 'Good. Avoid a password you use elsewhere.'}</p>
      {error ? <p role="alert" className={css.status} data-tone="error">{error}</p> : null}
      <button className={css.primary} disabled={busy || !ready || bytes > 72}>{busy ? 'Saving…' : 'Save and sign in'}</button>
      <a className={css.link} href="/login">Ask for a fresh link</a>
  </Frame>;
}

export function AccountConfirm() {
  const { tokenRef, ready } = useFragment();
  const [state, setState] = useState<{ tone: 'error' | 'info'; text: string } | null>(null), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setState(null);
    try { const r = await post<{ email?: string }>('auth/account-confirm', { token: tokenRef.current }); tokenRef.current = ''; setDone(true); setState({ tone: 'info', text: `Confirmed: ${r.email ?? 'your address'} is your Pulse address now.` }); }
    catch (err) { setState({ tone: 'error', text: (err as Error).message }); } finally { setBusy(false); }
  }
  return <Frame kicker="Your Pulse account" title="Confirm your e-mail" onSubmit={submit}>
      <p className={css.sub}>{ready || done ? 'Press Confirm to use this address for sign-in links and your daily summary.' : 'Open the link from your e-mail on this device. It works once, within 24 hours.'}</p>
      {state ? <p role={state.tone === 'error' ? 'alert' : 'status'} className={css.status} data-tone={state.tone}>{state.text}</p> : null}
      {done ? <a className={css.primary} href="/client">Open your space</a> : <button className={css.primary} disabled={busy || !ready}>{busy ? 'Confirming…' : 'Confirm'}</button>}
  </Frame>;
}
