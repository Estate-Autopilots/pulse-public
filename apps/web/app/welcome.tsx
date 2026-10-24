"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import { Camera, Check, FolderKanban, LogIn, MessagesSquare, ScrollText, X } from "lucide-react";
import css from "./welcome.module.css";
import { WELCOME_COOKIE } from "./welcome-cookie";

const CHANGED = "pulse:welcome";
const subscribe = (done: () => void) => { window.addEventListener("storage", done); window.addEventListener(CHANGED, done); return () => { window.removeEventListener("storage", done); window.removeEventListener(CHANGED, done); }; };

type Step = { key: string; title: string; text: string; href: string; Icon: typeof Check; done?: boolean };

/** First days in Pulse: a short checklist on the personal home. Steps tick themselves off from the record where Pulse
 *  can tell (checked in, photo), or once opened; the person can put it away at any time. */
export function Welcome({ person, first, checkedIn, photo, attendanceEnabled, initial }: { person: string; first: string; checkedIn: boolean; photo: boolean; attendanceEnabled?: boolean;
  /** UX-5A: the state from the request's cookie, so the server draws the same list the browser will (no pop-in). */ initial?: string | null }) {
  const key = `pulse.welcome.${person}`;
  // The list's state lives in this browser (localStorage, mirrored into a cookie the server reads).
  const fromCookie = (() => { try { const c = initial ? JSON.parse(decodeURIComponent(initial)) : null; return c?.person === person ? JSON.stringify({ hidden: !!c.hidden, seen: c.seen ?? [] }) : ""; } catch { return ""; } })();
  const raw = useSyncExternalStore(subscribe, () => { try { return localStorage.getItem(key) ?? fromCookie; } catch { return fromCookie; } }, () => fromCookie);
  let state: { hidden: boolean; seen: string[] } | null = null;
  try { state = raw ? JSON.parse(raw) : { hidden: false, seen: [] }; } catch { state = { hidden: false, seen: [] }; }
  const mirror = (next: { hidden: boolean; seen: string[] }) => { document.cookie = `${WELCOME_COOKIE}=${encodeURIComponent(JSON.stringify({ person, ...next }))}; path=/; max-age=31536000; samesite=lax`; };
  // An older browser kept the state only in localStorage: copy it into the cookie once.
  useEffect(() => { try { const v = localStorage.getItem(key); if (v && !document.cookie.includes(`${WELCOME_COOKIE}=`)) mirror(JSON.parse(v)); } catch { /* private mode */ } });
  const save = (next: { hidden: boolean; seen: string[] }) => { try { localStorage.setItem(key, JSON.stringify(next)); mirror(next); window.dispatchEvent(new Event(CHANGED)); } catch {} };
  if (!state || state.hidden) return null;
  const steps: Step[] = [
    { key: "checkin", title: "Check in for the day", text: "Office, home or on duty outside. Your month builds from your first check-in.", href: "/me", Icon: LogIn, done: checkedIn },
    { key: "profile", title: "Add your photo and skills", text: "So your pod knows who you are and the right work finds you.", href: `/people/${person}`, Icon: Camera, done: photo },
    { key: "chats", title: "Say hello to your team", text: "Your team and pod chats are ready in Chats.", href: "/chats", Icon: MessagesSquare },
    { key: "projects", title: "Find your projects", text: "Search every project; open one to see its files and upload.", href: "/projects?scope=all", Icon: FolderKanban },
    { key: "policies", title: "Read the company policies", text: attendanceEnabled === true ? "Leave, work from home and attendance rules, in My desk." : "Leave, work from home and company policies, in My desk.", href: "/me?tab=policies", Icon: ScrollText },
  ].filter((s) => attendanceEnabled === true || s.key !== "checkin").map((s) => ({ ...s, done: s.done || state.seen.includes(s.key) }));
  const done = steps.filter((s) => s.done).length;
  return (
    <section className={css.welcome} aria-label="Getting started">
      <div className={css.head}>
        <div>
          <h3 className={css.title}>Welcome to Pulse, {first}</h3>
          <p className={css.sub}>{done === steps.length ? "You are all set. Put this away whenever you like." : `${done} of ${steps.length} done. Five small steps for your first day.`}</p>
        </div>
        <button type="button" className={css.close} onClick={() => save({ ...state!, hidden: true })} aria-label="Put the getting started list away" title="Put away"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className={css.bar} aria-hidden="true"><i style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol className={css.steps}>
        {steps.map(({ key: k, title, text, href, Icon, done: ok }) => (
          <li key={k} data-done={ok ? "" : undefined}>
            <Link href={href} className={css.step} onClick={() => save({ ...state!, seen: [...new Set([...state!.seen, k])] })}>
              <span className={css.icon}>{ok ? <Check size={15} aria-hidden="true" /> : <Icon size={15} aria-hidden="true" />}</span>
              <span className={css.text}><b>{title}</b><small>{text}</small></span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
