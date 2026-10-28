"use client";
import { ArrowRight, Check, KeyRound, LogIn, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import css from "./how.module.css";

/** The one way in, as a picture: company Google account, Continue with Google, you are in. */
export function GetInPicture() {
  return <ol className={css.picture} aria-label="The one way into Pulse">
    <li><span className={css.icon} aria-hidden="true"><UserRound size={22} /></span><b>Your company Google account</b><small>name@company: the same as your work e-mail</small></li>
    <li aria-hidden="true" className={css.arrow}><ArrowRight size={18} /></li>
    <li><span className={css.icon} aria-hidden="true"><LogIn size={22} /></span><b>Continue with Google</b><small>on Pulse&apos;s Sign in page</small></li>
    <li aria-hidden="true" className={css.arrow}><ArrowRight size={18} /></li>
    <li><span className={css.icon} data-done="" aria-hidden="true"><Check size={22} /></span><b>You are in</b><small>no second password</small></li>
  </ol>;
}

export function HowYouGetIn() {
  // Whether Continue with Google is switched on here yet (public; no answer reads as off).
  const [google, setGoogle] = useState<boolean | null>(null);
  useEffect(() => { let live = true; void fetch("/api/v0/auth/branding", { cache: "no-store" }).then((r) => r.ok ? r.json() as Promise<{ google?: unknown }> : null).then((b) => { if (live) setGoogle(b?.google === true); }).catch(() => { if (live) setGoogle(false); }); return () => { live = false; }; }, []);
  return <div className={css.wrap}><article className={css.card}>
    <p className={css.kicker}>Pulse</p>
    <h1>How you get into Pulse</h1>
    <p className={css.lede}>One rule: <b>your company Google account is your Pulse login.</b></p>
    <GetInPicture />
    <ul className={css.lines}>
      <li><b>Have a company Google account?</b> On Sign in, press <b>Continue with Google</b> and choose it. That is all.</li>
      <li><b>Invited by e-mail?</b> Open the link and press <b>Continue with Google</b>. The first time links your Google account to your Pulse profile.</li>
      <li><b>New, or no company Google account yet?</b> Fill in <a href="/team-setup">Team setup</a> with the team code from the team&apos;s WhatsApp group. The admin makes your account and sends its first password on WhatsApp; Google asks you to change it the first time. Then the same button.</li>
      <li><b>Forgot your password?</b> It is your Google password: reset it at Google, or ask the admin. If you use a Pulse password, use <b>Forgot your password?</b> on Sign in.</li>
      <li><b>Already use a Pulse password?</b> Keep it, or link Google once in <b>Account / Security</b>, then use the button.</li>
    </ul>
    {google === false ? <p className={css.note} role="status"><KeyRound size={14} aria-hidden="true" />Continue with Google is not switched on here yet. Until it is, sign in with your Pulse username and password.</p> : null}
    <a className={css.cta} href="/login">Go to Sign in<ArrowRight size={16} aria-hidden="true" /></a>
  </article></div>;
}
