"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Chrome, Laptop, Monitor, Smartphone } from "lucide-react";
import { pipSvg } from "@pulse/companion";
import { post } from "../records";
import { styles } from "../ui";
import css from "./connect.module.css";

export type PairRequest = { code: string; platform: string; name: string; createdAt: string; expiresAt: string; browserPerson?:{id:string;name:string} };
const PLATFORM: Record<string, { label: string; icon: typeof Laptop }> = {
  windows: { label: "Pulse for Windows", icon: Monitor }, macos: { label: "Pulse for Mac", icon: Laptop },
  android: { label: "Pulse for Android", icon: Smartphone }, ios: { label: "Pulse for iPhone", icon: Smartphone }, chrome: { label: "Pulse for Chrome", icon: Chrome },
};

export function ConnectApproval({ initial, error, code, expected }: { expected:string|null; initial: PairRequest | null; error: string | null; code: string }) {
  const router = useRouter();
  const [state, setState] = useState<"ask" | "approved" | "denied">("ask");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(error ?? "");
  const [ackAccount,setAckAccount]=useState(false);
  const mismatch=!!expected&&expected!==initial?.browserPerson?.id;
  const [typed, setTyped] = useState(code);

  async function decide(approve: boolean) {
    if (!initial) return;
    setBusy(true); setMessage("");
    try { await post("native/pair/decide", { code: initial.code, approve }); setState(approve ? "approved" : "denied"); }
    catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }
  function lookUp(e: FormEvent) { e.preventDefault(); router.push(`/connect?code=${encodeURIComponent(typed.replace(/[^A-Za-z0-9]/g, ""))}`); }

  const p = initial ? PLATFORM[initial.platform] ?? { label: "Pulse app", icon: Laptop } : null;
  const Icon = p?.icon ?? Laptop;
  const mood = state === "approved" ? "celebrate" : state === "denied" ? "idle" : initial ? "waking" : "idle";
  return (
    <section className={css.wrap} aria-live="polite">
      <div className={css.card}>
        <div className={css.pip} dangerouslySetInnerHTML={{ __html: pipSvg({ mood, size: 96, uid: "connect" }) }} />
        {state === "approved" ? <>
          <h2>You’re connected</h2>
          <p>{p?.label} on <b>{initial?.name}</b> is signing in now. Go back to the app — it will be ready in a moment.</p>
          <p className={css.small}>You can sign this device out any time from <Link href="/settings?tab=devices">Settings → Devices</Link> or <Link href="/account">Account / Security</Link>.</p>
        </> : state === "denied" ? <>
          <h2>Not connected</h2>
          <p>Nothing was signed in. If you didn’t start this, you can ignore it — the code expires by itself.</p>
        </> : initial ? <>
          <h2>Connect {p?.label}?</h2>
          <p>Signing in as <b>{initial.browserPerson?.name??"your browser account"}</b>. <Link href="/account">Not you? Switch account</Link></p>
          {mismatch?<p role="alert" className={css.error}>This browser is signed in as someone else than the person expected by the app. Switch accounts before approving, or confirm this account below.</p>:null}
          {mismatch?<label><input type="checkbox" checked={ackAccount} onChange={e=>setAckAccount(e.target.checked)}/> I want the app signed in as {initial.browserPerson?.name}</label>:null}
          <p>Check that the app shows this code:</p>
          <p className={css.code} aria-label={`Code ${initial.code.split("").join(" ")}`}>{initial.code}</p>
          <dl className={css.facts}>
            <dt>App</dt><dd><Icon size={15} aria-hidden="true" /> {p?.label}</dd>
            <dt>Device name</dt><dd>{initial.name}</dd>
            <dt>Requested</dt><dd>{new Date(initial.createdAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })} · expires {new Date(initial.expiresAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}</dd>
          </dl>
          <p className={css.small}>The app will be able to check you in and out, show your day, your inbox and your chats, and send replies — the same as My desk. Optional activity details stay off unless you turn them on.</p>
          <div className={css.actions}>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy||(mismatch&&!ackAccount)} onClick={() => void decide(true)}>{busy ? "Connecting…" : "Approve"}</button>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => void decide(false)}>This wasn’t me</button>
          </div>
        </> : <>
          <h2>Enter the code from your app</h2>
          <p>Open Pulse on your computer, phone or in Chrome and choose <b>Sign in with your Pulse account</b>. It shows an eight-letter code.</p>
          <form className={css.form} onSubmit={lookUp}>
            <label className={css.label}>Code<input value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={9} required /></label>
            <button className={`${styles.btn} ${styles.btnPrimary}`}>Continue</button>
          </form>
        </>}
        {message ? <p role="alert" className={css.error}>{message}</p> : null}
        <p className={css.small}><Link href="/settings?tab=devices#get-the-apps">Get the apps</Link></p>
      </div>
    </section>
  );
}
