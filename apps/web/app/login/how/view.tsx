"use client";
import { ArrowRight, Check, KeyRound, LogIn, Mail, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import css from "./how.module.css";
import { ReportProblemLink } from "../../bug-report/report-link";

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

type Branding = { google: boolean; signup: boolean };

/** SIGNED-OUT-SHELL (phone QA, 4 Nov 2026): the ways in that this install really has, from its public branding. The page
 *  used to say "your company Google account is your Pulse login" on installs where Google sign-in is off and Sign in
 *  has no Google button. Continue with Google shows only where it is switched on; until the answer comes, nothing that
 *  might be wrong is shown. */
export function HowYouGetIn() {
  const [brand, setBrand] = useState<Branding | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/v0/auth/branding", { cache: "no-store" }).then((r) => r.ok ? r.json() as Promise<{ google?: unknown; signup?: unknown }> : null)
      .then((b) => { if (live) setBrand({ google: b?.google === true, signup: b?.signup === true }); })
      .catch(() => { if (live) setBrand({ google: false, signup: false }); });
    return () => { live = false; };
  }, []);
  const ways = [
    ...(brand?.google ? [{ key: "google", Icon: LogIn, title: "Continue with Google", text: <>Press <b>Continue with Google</b> on Sign in and choose the Google account whose e-mail Pulse has for you. No second password.</> }] : []),
    { key: "password", Icon: KeyRound, title: "Username or @handle, and your password", text: <>Team members type their Pulse username, like <b>firstname.lastname</b> (not your e-mail). Joined with an invitation as a freelancer or client? Type your @handle or e-mail and the password you chose.</> },
    { key: "code", Icon: Mail, title: "A code by e-mail", text: <>Press <b>E-mail me a sign-in code</b>, type your username, @handle or e-mail, then type the 6 digits we send you. No password needed, and it works when your password is locked.</> },
  ];
  return <div className={css.wrap}><article className={css.card}>
    <p className={css.kicker}>Pulse</p>
    <h1>How you get into Pulse</h1>
    <p className={css.lede}>{brand === null ? "Checking how this Pulse signs people in…" : `${["", "One way", "Two ways", "Three ways"][ways.length] ?? `${ways.length} ways`} in. Use whichever suits you: they all open the same account.`}</p>
    {brand === null ? <div className={css.ways} aria-busy="true" aria-label="Loading the ways in">{[0, 1, 2].map((i) => <span key={i} className={css.waySkeleton} />)}</div>
      : <ol className={css.ways} aria-label="Ways into Pulse">{ways.map(({ key, Icon, title, text }) => <li key={key} className={css.way}>
        <span className={css.icon} aria-hidden="true"><Icon size={20} /></span>
        <span className={css.wayText}><b>{title}</b><span>{text}</span></span>
      </li>)}</ol>}
    <section className={css.help} aria-labelledby="how-stuck">
      <h2 id="how-stuck">Stuck?</h2>
      <ul className={css.lines}>
        <li><b>Forgot your username?</b> Choose <b>Forgot your username?</b> on Sign in and we e-mail it to you.</li>
        <li><b>Forgot your password?</b> Choose <b>Forgot your password?</b> on Sign in for a reset link, or sign in with a code by e-mail instead.</li>
        <li><b>Joining a team?</b> Open the invitation link your admin sent you. No invitation yet? Ask your admin to add you.</li>
        {brand?.signup ? <li><b>New to Pulse?</b> <a href="/signup">Create your account</a>. You can name your company there too.</li> : null}
      </ul>
    </section>
    <div className={css.actions}>
      <a className={css.cta} href="/login">Go to Sign in<ArrowRight size={16} aria-hidden="true" /></a>
    </div>
    <ReportProblemLink title="How you get into Pulse" className={css.problem} />
  </article></div>;
}
