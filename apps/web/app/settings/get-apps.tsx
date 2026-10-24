'use client';
import { useState, useSyncExternalStore } from 'react';
import { Apple, Check, Chrome, Copy, Download, Monitor, Smartphone } from 'lucide-react';
import { pipSvg } from '@pulse/companion';
import { Badge, styles } from '../ui';
import { IslandToggle } from '../notify/island';
import type { AppDownloads, AppFile } from './downloads';
import css from './get-apps.module.css';
import { GUIDES, guideSteps, phoneHint } from './app-guides';
import { SendFeedback } from './send-feedback';

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const CHECKS = [
  'Phone: sign in with your Pulse username and password. Computers and Chrome: choose “Sign in with your Pulse account” and approve the code in your browser.',
  'Check in from the app. My desk shows the same check-in, with the same time and late mark.',
  'Take a break, come back, then check out. The timer stops during the break.',
  'Phone: turn on notifications in Settings → Devices → This phone. New messages and requests appear in Inbox, and permitted pings appear as Android notifications.',
  'Phone: enable office check-in helpers in Settings → Devices → This phone, then tap Check location on Today and allow location “While using”. Pulse reads one position on that tap.',
  'Phone: join the registered office Wi-Fi and tap Check office Wi-Fi on Today. This check does not check you in automatically.',
  'Phone: turn on airplane mode and reopen Pulse. The offline screen offers Retry; turn airplane mode off to return.',
  'Revoke the device in Settings → Devices (or Account / Security): the app signs itself out.',
  'Tell us what felt slow, confusing or delightful with Send feedback below.',
];
const ICONS = { windows: Monitor, macos: Apple, android: Smartphone, ios: Smartphone, chrome: Chrome } as const;

const LIST = 'pulse-apps-checklist', LIST_CHANGED = 'pulse:apps-checklist';
const subscribe = (done: () => void) => { window.addEventListener('storage', done); window.addEventListener(LIST_CHANGED, done); return () => { window.removeEventListener('storage', done); window.removeEventListener(LIST_CHANGED, done); }; };
function Checklist() {
  const raw = useSyncExternalStore(subscribe, () => { try { return localStorage.getItem(LIST) ?? '[]'; } catch { return '[]'; } }, () => '[]');
  let done: number[] = []; try { done = JSON.parse(raw); } catch { /* fresh list */ }
  const toggle = (i: number) => { const next = done.includes(i) ? done.filter((x) => x !== i) : [...done, i]; try { localStorage.setItem(LIST, JSON.stringify(next)); window.dispatchEvent(new Event(LIST_CHANGED)); } catch { /* private mode */ } };
  return <ol className={css.checks}>{CHECKS.map((c, i) => <li key={i}><label><input type="checkbox" checked={done.includes(i)} onChange={() => toggle(i)} /><span>{c}</span></label></li>)}</ol>;
}

function Hash({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className={css.hash} title="Copy the SHA-256 checksum" onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }); }}>
    {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}SHA-256 {value.slice(0, 10)}…{value.slice(-6)}</button>;
}

export function GetApps({ downloads, origin = null }: { downloads: AppDownloads | null; origin?: string | null }) {
  const built = downloads ? new Date(downloads.builtAt) : null;
  return (
    <section id="get-the-apps" className={css.apps} aria-labelledby="get-apps-title">
      <header className={css.head}>
        <span className={css.pip} dangerouslySetInnerHTML={{ __html: pipSvg({ mood: 'waking', size: 56, uid: 'apps' }) }} />
        <div>
          <h2 id="get-apps-title">Get the apps</h2>
          <p>Check in, take a break and check out in one click — from the corner of your screen, your phone or Chrome. Same rules as My desk.</p>
        </div>
        {downloads ? <Badge tone="success">{`v${downloads.version} · ${built?.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}`}</Badge> : <Badge tone="warning">Builds on the way</Badge>}
      </header>
      {downloads?.notes ? <p className={css.note}>{`What's new: ${downloads.notes}`}</p> : null}
      {downloads?.updaterSigned ? <p className={css.note}>Install this updater-enabled version once: use Windows Setup (.exe), or drag Pulse from the Mac disk image into a writable Applications folder. Pip then offers verified updates with Install and restart / Later. Android asks you to confirm updates in its system installer.</p> : null}
      {downloads?.updaterSigned ? <p className={css.note}>From Pulse 1.0 the Mac app is signed with the publisher’s identity, so updates keep you signed in with no Keychain password prompts. Coming from a test version before 1.0, Pulse asks you to sign in once more.</p> : null}
      {downloads && !downloads.signed ? <p className={css.note}>These are test builds and Windows, Mac and iPhone distribution signing is still pending, so Windows and macOS will warn you the first time. The install steps say exactly what to click.</p> : null}
      <div className={css.grid}>
        {GUIDES.map((p) => {
          const files = (downloads?.files ?? []).filter((f) => f.platform === p.key);
          const Icon = ICONS[p.key];
          return <article key={p.key} className={css.card}>
            <div className={css.cardHead}><Icon size={22} aria-hidden="true" /><div><h3>Pulse for {p.title}</h3><small>{p.what}</small></div></div>
            <div className={css.buttons}>
              {p.key === 'android' && !files.length ? <p className={css.note}>{phoneHint(origin)}</p> : p.kinds.map(({ kind, label }) => { const f = files.find((x) => x.kind === kind || x.name.endsWith('.' + kind)); return f
                ? <a key={kind} className={`${styles.btn} ${p.kinds[0].kind === kind ? styles.btnPrimary : ''}`} href={f.url ?? `/api/downloads/${f.name}`} download><Download size={14} aria-hidden="true" />{label} · {mb(f.size)}</a>
                : <span key={kind} className={`${styles.btn} ${css.disabled}`} aria-disabled="true">{label} · not built yet</span>; })}
              {p.pending ? <Badge tone="warning">{p.pending}</Badge> : null}
            </div>
            <details className={css.steps}><summary>How to install</summary><ol>{guideSteps(p, origin).map((s) => <li key={s}>{s}</li>)}</ol><a className={css.guideLink} href={`/apps/${p.slug}`}>{`Full guide for ${p.title} with screenshots →`}</a></details>
            {files.map((f) => <Hash key={f.name} value={f.sha256} />)}
          </article>;
        })}
      </div>
      <article className={`${css.card} ${css.testing}`}>
        <div className={css.cardHead}><Check size={22} aria-hidden="true" /><div><h3>How to test</h3><small>Tick as you go — the list stays in this browser.</small></div></div>
        <Checklist />
        <IslandToggle />
      </article>
      <SendFeedback />
    </section>
  );
}
