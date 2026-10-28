"use client";
// MAILBOX (owner, 28 Oct 2026): when this company has no mailbox connected, Pulse says so instead of silently not
// e-mailing. Two moments:
//  * Something an admin or HR just did needed an e-mail (an invitation, a sign-in link, a reset): the API answered 503
//    with code mailbox_not_connected (409). A card explains it and, for an admin, offers "Connect Google Workspace mailbox"
//    right there (HR is told to ask an admin).
//  * Mail is waiting for the mailbox: admins see one quiet line, "Mail not connected: N e-mails waiting", with Connect.
//    Dismissed, it stays away for this browser session unless more mail starts waiting.
// The install's own company sends from the server's mailbox; nothing shows for it.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MailWarning, X } from "lucide-react";
import { connectMailbox, readMailbox, waitingLine, type MailboxState } from "./settings/mailbox";
import css from "./mailbox-notice.module.css";

const EVENT = "pulse:mailbox-needed";
let watching = false;
/** Watch the app's own API answers for the mailbox refusal (409 only, so ordinary requests are never read twice). */
function watchFetch() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const original = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const r = await original(...args);
    if (r.status === 409) {
      const url = typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
      if (url.includes("/api/")) void r.clone().json().then((d: { code?: string; error?: string }) => {
        if (d?.code === "mailbox_not_connected") window.dispatchEvent(new CustomEvent(EVENT, { detail: d.error }));
      }).catch(() => {});
    }
    return r;
  };
}
const read = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* private window */ } };

export function MailboxNotice({ admin }: { admin: boolean }) {
  const [s, setS] = useState<MailboxState | null>(null), [prompt, setPrompt] = useState<string | null>(null), [hidden, setHidden] = useState(true);
  const load = useCallback(() => admin ? readMailbox().then((d) => {
    const ok = "error" in d ? null : d;
    setS(ok);
    if (ok) setHidden(read("pulse.mailbox.seen") === `${ok.waiting}/${ok.blocked}`);
  }) : Promise.resolve(), [admin]);
  useEffect(() => {
    watchFetch();
    const onNeed = (e: Event) => { setPrompt((e as CustomEvent<string>).detail || "Pulse can’t send e-mail for this company yet."); void load(); };
    window.addEventListener(EVENT, onNeed);
    const first = setTimeout(() => void load(), 0);
    return () => { clearTimeout(first); window.removeEventListener(EVENT, onNeed); };
  }, [load]);

  const waiting = s && !s.install && !s.connected ? waitingLine(s) : "";
  return <>
    {prompt ? <div className={css.card} role="alertdialog" aria-labelledby="mailbox-title" aria-describedby="mailbox-text">
      <MailWarning size={20} className={css.icon} aria-hidden="true" />
      <div className={css.body}>
        <strong id="mailbox-title">Connect your Google Workspace mailbox</strong>
        <p id="mailbox-text">{admin ? "Pulse sends invitations, sign-in links, password resets and HR notices from your company’s own address. Sign in with Google as the mailbox that should send (for example hr@org-b604f9.example); Pulse only gets permission to send." : "Pulse sends invitations, sign-in links and resets from your company’s own mailbox, and none is connected yet. Ask an organisation admin to connect it in Settings → Mail."}</p>
        <div className={css.actions}>
          {admin ? <button className={css.primary} disabled={s?.configured === false} onClick={() => void connectMailbox()}>Connect Google Workspace mailbox</button> : null}
          {admin ? <Link href="/settings?tab=mail" onClick={() => setPrompt(null)}>Mail settings</Link> : null}
          <button className={css.quiet} onClick={() => setPrompt(null)}>{admin ? "Not now" : "OK"}</button>
        </div>
        {admin && s?.configured === false ? <p className={css.note}>Google sign-in for mailboxes is not set up on this Pulse yet: the Pulse administrator adds it once.</p> : null}
      </div>
      <button className={css.close} aria-label="Close" onClick={() => setPrompt(null)}><X size={14} aria-hidden="true" /></button>
    </div> : waiting && !hidden ? <div className={css.line} role="status">
      <MailWarning size={15} aria-hidden="true" />
      <span>Mail not connected: {waiting}.</span>
      <button className={css.link} disabled={s?.configured === false} onClick={() => void connectMailbox()}>Connect Google Workspace mailbox</button>
      <button className={css.close} aria-label="Hide until more mail waits" onClick={() => { write("pulse.mailbox.seen", `${s!.waiting}/${s!.blocked}`); setHidden(true); }}><X size={13} aria-hidden="true" /></button>
    </div> : null}
  </>;
}
