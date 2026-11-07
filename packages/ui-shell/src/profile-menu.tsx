"use client";

import { Bell, KeyRound, LogIn, LogOut, Moon, Settings, Sun, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBackLayer } from "./back-layer";
import { useTheme } from "./theme-provider";
import type { PulseIdentity } from "./types";
import styles from "./profile-menu.module.css";

/** EST-1399: ends this Pulse session only; Google and the apps that opened Pulse stay signed in. The cookie keeps the sign-in
 *  page from signing straight back in with Google. */
async function signOut() {
  await fetch("/api/v0/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
  document.cookie = "pulse_oidc_quiet=1; Max-Age=600; Path=/; SameSite=Lax";
  window.location.assign("/login?out=1");
}

function initials(name: string) {
  // A note in parentheses ("Datup (rehearsal)") is not part of the name.
  return name.replace(/\([^)]*\)/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => Array.from(part)[0]).join("").toUpperCase() || "P";
}

/** The account menu (LAYOUT-SWEEP): the avatar alone in the top bar; the menu holds the person, `extra` (the app's own
 *  items, e.g. "Insights for this page"), their pages and the theme switch, at every window size. */
export function ProfileMenu({ identity, extra }: { identity: PulseIdentity | null; extra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { resolved, setPreference } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // FLOAT-2: back closes the menu (in the phone app it used to leave Pulse).
  useBackLayer(open, () => setOpen(false));
  const name = identity?.displayName ?? "Account";
  // eslint-disable-next-line @next/next/no-img-element -- a small photo served by the app itself
  const photo = identity?.photoUrl ? <img src={identity.photoUrl} alt="" style={{ width: "100%", height: "100%", borderRadius: "inherit", objectFit: "cover" }} /> : null;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={menu} className={styles.menu}>
      <button
        ref={trigger}
        type="button"
        className={styles.headerTrigger}
        aria-label="Open account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.avatarInitials} aria-hidden="true">{photo ?? initials(name)}</span>
      </button>
      {open ? (
        <div className={styles.popover} role="menu" aria-label="Account">
          <div className={styles.menuHeader}>
            <span className={styles.summaryAvatar} aria-hidden="true">{photo ?? initials(name)}</span>
            <div className={styles.menuHeaderCopy}>
              <strong className={styles.headerFullName}>{identity?.displayName ?? "Sign in with Cloudflare Access"}</strong>
              {identity?.email ? <span className={styles.headerEmail}>{identity.email}</span> : null}
              <span className={styles.roleLabel}>
                {identity?.isFixture ? "Local development fixture" : identity?.roleLabel ?? "No signed-in identity"}
              </span>
            </div>
          </div>
          {extra ? <><div className={styles.separator} /><div className={styles.extra} onClick={() => setOpen(false)}>{extra}</div></> : null}
          <div className={styles.separator} />
          {identity?.profileHref ? <Link href={identity.profileHref} className={styles.item} role="menuitem" onClick={() => setOpen(false)}><UserRound size={16} aria-hidden="true" />My profile</Link> : null}
          {identity?.roleLabel !== 'Accountant' ? <Link href="/notifications" className={styles.item} role="menuitem" onClick={() => setOpen(false)}><Bell size={16} aria-hidden="true" />Notifications</Link> : null}
          <Link href="/account" className={styles.item} role="menuitem" onClick={() => setOpen(false)}><KeyRound size={16} aria-hidden="true" />Account / Security</Link>
          {identity?.roleLabel !== 'Accountant' ? <Link href="/settings" className={styles.item} role="menuitem" onClick={() => setOpen(false)}><Settings size={16} aria-hidden="true" />Settings</Link> : null}
          <button type="button" className={styles.item} role="menuitem" onClick={() => { setPreference(next); setOpen(false); }}>
            {next === "dark" ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}Switch to {next} mode
          </button>
          <div className={styles.separator} />
          <Link href="/login" className={styles.item} role="menuitem" onClick={() => setOpen(false)}><LogIn size={16} aria-hidden="true" />Sign-in &amp; switch account</Link>
          {identity?.signOut ? <button type="button" className={styles.item} role="menuitem" onClick={() => { setOpen(false); void signOut(); }}><LogOut size={16} aria-hidden="true" />Sign out of Pulse</button> : null}
        </div>
      ) : null}
    </div>
  );
}
