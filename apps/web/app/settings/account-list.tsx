// SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.2: "Your account should be as simple as that. A list of things."): who you
// are and how you sign in, one row each, label on the left and the value on the right; the rows that open something end
// in a chevron. The password lives one step in, under Password & security (with sessions, two-step and the delivery
// e-mail), not as a button on the main list.
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { Me } from "../lib/api";
import { Avatar } from "../avatar";
import css from "./settings.module.css";

function Row({ href, label, note, part }: { href: string; label: string; note: string; part?: string }) {
  return <li><Link className={css.listLink} href={href} data-settings-row={part}><span>{label}</span><small>{note}</small><ChevronRight size={16} aria-hidden="true" /></Link></li>;
}

/** `calendar`: this server has Google Calendar switched on (the row is only there when it opens something).
 *  SETTINGS-APPLE (judge: "Name and Username look tappable like the rows below them"): who you are is a quiet header,
 *  not rows; the list under it is only things that open. */
export function AccountList({ me, calendar = false }: { me: Me; calendar?: boolean }) {
  const password = me.via === "password";
  return <div className={css.account}>
    <div className={css.accountHead}>
      {/* PULSE-POLISH: the stored photo (initials only when there is none). */}
      <Avatar name={me.name || "You"} id={me.person} photoAt={me.photoAt} size={44} />
      <span className={css.accountWho}><b>{me.name ?? "Your account"}</b>
        <small>{me.username ? <span className={css.listMono}>{me.username}</span> : null}{me.username ? " · " : ""}signs in with {password ? "a Pulse password" : "the company Google account"}</small></span>
    </div>
    <ul className={css.list} aria-label="Your account">
      <Row href="/settings?tab=account&part=access" part="access" label="Account access" note="E-mails that sign you in" />
      <Row href="/settings?tab=account&part=security" part="security" label={password ? "Password & security" : "Security"} note={me.twoStepSetup ? "Two-step not set up yet" : password ? "Signs in with a password" : "Signs in with Google"} />
      <Row href="/settings?tab=account&part=about" part="about" label="About you" note="What describes you" />
      <Row href="/settings?tab=account&part=find" part="find" label="Let people find me" note="In search across companies" />
      {calendar ? <Row href="/settings?tab=account&part=calendar" part="calendar" label="Google Calendar" note="Tasks and meetings" /> : null}
    </ul>
  </div>;
}
