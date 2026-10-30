"use client";
// MAILBOX (owner, 28 Oct 2026): Settings → Mail. The organisation's admin connects the company's own Google Workspace
// mailbox (e.g. hr@company.com) so sign-in links, invitations, password resets and HR notices go out from the company's
// own address. Connect signs in with Google as that mailbox (permission to send only); Pulse keeps the sign-in sealed and
// never shows it. Send a test, disconnect, and see how much mail is waiting for the mailbox.
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Mail, MailCheck, Send, Unplug } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { Empty, Panel, Skeleton, styles } from "../ui";
import { useOrgZone } from "../org-code";

export type MailboxState = {
  install: boolean; connected: boolean; address: string | null; client: string | null; connectedAt: string | null; connectedBy: string | null;
  lastSentAt: string | null; lastError: string | null; lastErrorAt: string | null; waiting: number; blocked: number;
  configured: boolean; clientKind: "platform" | "company" | null; redirectUri: string; installSender?: string | null;
};

/** In the company's own time zone (Settings → Organisation). */
const when = (iso: string | null, zone: string) => iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: zone }) : "—";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Settings → Mail's state, or why it did not load. */
export async function readMailbox(): Promise<MailboxState | { error: string }> {
  try {
    const r = await fetch("/api/v0/mailbox", { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    return r.ok ? d as MailboxState : { error: d.error ?? "Mail settings did not load" };
  } catch { return { error: "Mail settings did not load" }; }
}

/** Start Google sign-in for the company mailbox: the API answers with Google's address, the browser goes there. */
export async function connectMailbox() {
  try {
    const r = await post<{ url: string }>("mailbox/google/start", {});
    window.location.assign(r.url);
  } catch (e) { notify({ id: "mailbox", tone: "error", title: "Could not start Google sign-in", message: e instanceof Error ? e.message : "Try again" }); }
}

/** What is waiting for the mailbox, in one sentence (the banner and the Settings card say the same). */
export function waitingLine(s: Pick<MailboxState, "waiting" | "blocked">) {
  const parts = [s.waiting ? `${plural(s.waiting, "e-mail is", "e-mails are")} waiting to be sent` : "",
    s.blocked ? `${plural(s.blocked, "sign-in or invitation e-mail", "sign-in or invitation e-mails")} could not go out` : ""].filter(Boolean);
  return parts.join(", and ");
}

export function MailboxSettings() {
  const zone = useOrgZone();
  const [s, setS] = useState<MailboxState | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const load = useCallback(() => readMailbox().then((d) => { if ("error" in d) setError(d.error); else { setS(d); setError(""); } }), []);
  useEffect(() => {
    void readMailbox().then((d) => { if ("error" in d) setError(d.error); else setS(d); });
    // Back from Google: say how it went once, then drop the marker from the address.
    const q = new URLSearchParams(window.location.search);
    if (q.get("mailbox") === "connected") {
      notify({ id: "mailbox", tone: "success", title: "Mailbox connected", message: "Pulse now sends this company's mail from it." });
      q.delete("mailbox"); window.history.replaceState(null, "", `${window.location.pathname}?${q}`);
    }
  }, []);
  async function act(kind: "test" | "disconnect") {
    if (kind === "disconnect" && !window.confirm("Disconnect the company mailbox? Pulse stops sending this company's e-mail until a mailbox is connected again.")) return;
    setBusy(kind);
    try {
      if (kind === "test") { const r = await post<{ to: string }>("mailbox/test", {}); notify({ id: "mailbox", tone: "success", title: "Test e-mail sent", message: `Check the inbox of ${r.to}.` }); }
      else { setS(await post<MailboxState>("mailbox/disconnect", {})); notify({ id: "mailbox", tone: "success", title: "Mailbox disconnected", timeout: 2500 }); }
    } catch (e) { notify({ id: "mailbox", tone: "error", title: kind === "test" ? "The test e-mail did not go out" : "Not disconnected", message: e instanceof Error ? e.message : "Try again" }); }
    finally { setBusy(""); void load(); }
  }

  if (error && !s) return <Panel title="Mail"><Empty icon={CircleAlert} title="Mail settings did not load" text={error}><button className={styles.btn} onClick={() => void load()}>Try again</button></Empty></Panel>;
  if (!s) return <Panel title="Mail" sub="The company's own mailbox"><div style={{ padding: 16, display: "grid", gap: 10 }} aria-busy="true"><Skeleton width="60%" /><Skeleton width="40%" /></div></Panel>;
  if (s.install) return <Panel title="Mail" sub="How Pulse e-mails your people">
    <dl className={styles.facts} style={{ padding: "12px 16px" }}>
      <dt>Sends from</dt><dd className={styles.mono}>{s.installSender ?? "Not set up on this server"}</dd>
      <dt>Set up by</dt><dd>This Pulse server (the platform&apos;s own mailbox)</dd>
    </dl>
    <p className={styles.panelFoot}><span>Sign-in links, invitations, password resets and HR notices go out from the server&apos;s mailbox. Nothing to connect here.</span></p>
  </Panel>;

  const waiting = waitingLine(s);
  return <div style={{ display: "grid", gap: 16, alignContent: "start" }} data-grow="">
    <Panel title="Mail" sub={s.connected ? "Connected: your company's own mailbox" : "Not connected"}>
      {s.connected ? <>
        <dl className={styles.facts} style={{ padding: "12px 16px" }}>
          <dt>Sends from</dt><dd className={styles.mono}>{s.address}</dd>
          <dt>Connected</dt><dd>{when(s.connectedAt, zone)}{s.connectedBy ? ` by ${s.connectedBy}` : ""}</dd>
          <dt>Last sent</dt><dd>{when(s.lastSentAt, zone)}</dd>
          {s.lastError ? <><dt>Problem</dt><dd role="alert"><CircleAlert size={13} aria-hidden="true" /> {s.lastError} <span className={styles.muted}>({when(s.lastErrorAt, zone)})</span></dd></> : null}
          {waiting ? <><dt>Waiting</dt><dd>{waiting}</dd></> : null}
        </dl>
        <p className={styles.panelFoot}>
          <span>Sign-in links, invitations, password resets and HR notices go out from this address. Pulse can send from it, never read it.</span>
          <button className={styles.btn} disabled={!!busy} onClick={() => void act("test")}><Send size={13} aria-hidden="true" />{busy === "test" ? "Sending…" : "Send a test"}</button>
          {s.lastError ? <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy || !s.configured} onClick={() => void connectMailbox()}><Mail size={13} aria-hidden="true" />Connect again</button> : null}
          <button className={styles.btn} disabled={!!busy} onClick={() => void act("disconnect")}><Unplug size={13} aria-hidden="true" />{busy === "disconnect" ? "Disconnecting…" : "Disconnect"}</button>
        </p>
      </> : <>
        <div style={{ padding: "14px 16px", display: "grid", gap: 10 }}>
          {waiting ? <p role="status" style={{ margin: 0, fontWeight: 600 }}><CircleAlert size={14} aria-hidden="true" /> Mail not connected: {waiting}.</p> : null}
          <p style={{ margin: 0 }}>Connect your company&apos;s Google Workspace mailbox, for example <span className={styles.mono}>hr@org-b604f9.example</span>, so Pulse sends sign-in links, invitations, password resets and HR notices from your own address. Until then they are not e-mailed.</p>
          <p className={styles.muted} style={{ margin: 0 }}>You sign in with Google as the mailbox that should send. Pulse asks only for permission to send e-mail from it; it never reads the mailbox.</p>
          {!s.configured ? <p className={styles.muted} style={{ margin: 0 }} role="note">Google sign-in for mailboxes is not set up on this Pulse yet. Ask the Pulse administrator to add the Google OAuth client; this button works as soon as they have.</p> : null}
        </div>
        <p className={styles.panelFoot}>
          <span />
          <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={!s.configured} onClick={() => void connectMailbox()}><MailCheck size={14} aria-hidden="true" />Connect Google Workspace mailbox</button>
        </p>
      </>}
    </Panel>
  </div>;
}
