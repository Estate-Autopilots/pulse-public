"use client";
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { shell, type ShellInfo } from '../lib/native-shell';
import { styles } from '../ui';
import css from './devices.module.css';

export function ConnectionChecklist() {
  const [info, setInfo] = useState<ShellInfo | null>(null);
  const [online, setOnline] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      setOnline(navigator.onLine);
      const s = shell(); if (!s) return;
      void s.info().then(i => { if (active) { setInfo(i); setFailed(false); } }).catch(() => { if (active) setFailed(true); });
    };
    refresh(); window.addEventListener('online', refresh); window.addEventListener('offline', refresh); window.addEventListener('pulse:shell-status', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { active = false; window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh); window.removeEventListener('pulse:shell-status', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return <article className={css.card} aria-label="Connection and setup checklist">
    <h3>Connection &amp; setup</h3>
    <ol className={css.checklist}>
      <li><strong>{online ? 'Connection available' : 'You’re offline'}</strong><p>{online ? 'A network connection does not confirm an attendance action. Wait for Accepted by Pulse on Today.' : 'Saved taps wait on this device. Reopen Pulse with a connection to retry.'}</p></li>
      <li><strong>{info ? info.enrolled ? 'App registered' : 'App registration needs retry' : failed ? 'App status unavailable' : 'Your Pulse sign-in'}</strong><p>{info ? 'Your phone or tablet uses your normal Pulse sign-in. Revoking it or signing out ends its device credential.' : 'Use your own account. In the phone app, normal sign-in also registers this device; no pairing code is needed.'}</p>{info && !info.enrolled ? <button type="button" className={styles.btn} onClick={() => window.dispatchEvent(new Event('pulse:shell-enroll'))}>Retry app registration</button> : null}</li>
      <li><strong>Notifications · {info ? info.notifications ? 'on' : 'off' : 'optional'}</strong><p>Permission denial keeps Inbox and manual check-in available. Use This phone to change notification permission. Closed-app delivery needs a supported provider; background checks can be delayed.</p></li>
      <li><strong>Office helpers · optional</strong><p>Enable helpers only for an HR-approved office, then allow location when you tap on Today. Denied or unavailable location and Wi-Fi never prevent manual check-in. Force quit, a killed app or a reboot cannot guarantee unattended check-in; open Pulse and check manually.</p></li>
      <li><strong>Review saved attendance</strong><p>Today shows Queued, Accepted, Rejected or Needs correction, with retry IDs and server receipts. Only taps within three hours can sync automatically. The separate seven-day metadata queue does not grant attendance backdating.</p></li>
    </ol>
    <div className={css.actions}><Link className={styles.btn} href="/me">Open My desk · manual check-in</Link><Link className={styles.btn} href="/me?tab=attendance">Attendance corrections</Link></div>
  </article>;
}
