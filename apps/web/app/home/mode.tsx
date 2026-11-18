"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import css from "./home.module.css";

export const MODE_COOKIE = "pulse.home.mode";
export type HomeMode = "focus" | "max";

/** OWNER-HOME: Focus (the calm home) or Max (the whole field). The choice is remembered in a cookie, so the server
 *  draws the right one on the next visit. The pill slides at once on press; the page follows when it arrives. */
export function ModeSwitch({ mode }: { mode: HomeMode }) {
  const [shown, setShown] = useState(mode);
  // Match the new server mode after navigation; the press state supplies the immediate pill response.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setShown(mode), [mode]);
  const remember = (next: HomeMode) => { setShown(next); document.cookie = `${MODE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`; };
  return (
    <div className={css.mode} role="group" aria-label="Dashboard mode" data-mode={shown}>
      <span className={css.modePill} aria-hidden="true" />
      <Link href="/dashboard?mode=focus" className={css.modeBtn} aria-current={mode === "focus" ? "page" : undefined} data-on={shown === "focus" ? "" : undefined} onClick={() => remember("focus")} title="Focus · F">Focus</Link>
      <Link href="/dashboard?mode=max" className={css.modeBtn} aria-current={mode === "max" ? "page" : undefined} data-on={shown === "max" ? "" : undefined} onClick={() => remember("max")} title="Max · F">Max</Link>
    </div>
  );
}
