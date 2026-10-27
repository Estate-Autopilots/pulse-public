"use client";
// The bell in the top bar opens the notification panel (UX-NOTIFY): a floating panel on a computer, a full-screen
// sheet on a phone. Its count comes from the same updates BrowserPings already polls; in the Pulse phone app it is
// also the app icon's badge. History stays in Inbox (/notifications).
import { Bell } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBackLayer } from "@pulse/ui-shell";
import { shell } from "./lib/native-shell";
import { NotificationPanel } from "./notify/panel";
import { refreshNotices } from "./notify/store";
import css from "./inbox-bell.module.css";

export function InboxBell() {
  const [count, setCount] = useState<number | null>(null);
  // QA-1024 (R014): whether the number is "needs you" (ATT) or every unread; the label says which, as the panel does.
  const [needs, setNeeds] = useState(false);
  const [news, setNews] = useState(false);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let last: number | null = null;
    const changed = (event: Event) => {
      const counts = (event as CustomEvent<{ counts?: { total?: number; important?: number } }>).detail?.counts;
      const total = counts?.total;
      if (typeof total !== "number") return;
      // ATT: the number is what needs you (urgent and needs-you, 0860); news only for your information shows as a dot.
      setCount(typeof counts?.important === "number" ? counts.important : total); setNeeds(typeof counts?.important === "number"); setNews(total > 0);
      if (last !== null && total !== last) window.dispatchEvent(new Event("pulse:notices-changed"));
      last = total;
      void shell()?.setBadge({ count: total }).catch(() => {});
    };
    const show = (event: Event) => { const focus = (event as CustomEvent<{ focus?: string }>).detail?.focus ?? null; setFocus(focus); setOpen(true); void refreshNotices(!!focus); };
    window.addEventListener("pulse:communications", changed);
    window.addEventListener("pulse:open-notices", show);
    return () => { window.removeEventListener("pulse:communications", changed); window.removeEventListener("pulse:open-notices", show); };
  }, []);
  const close = useCallback(() => setOpen(false), []);
  // FLOAT-2: back closes the panel first.
  useBackLayer(open, close);
  const label = count ? `Notifications, ${count} ${needs ? (count === 1 ? "needs you" : "need you") : "unread"}` : news ? "Notifications, new updates" : "Notifications";
  return (
    <>
      <button ref={button} type="button" className={css.bell} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? "pulse-notices" : undefined}
        data-unread={count || news ? "" : undefined} onPointerEnter={() => void refreshNotices()} onFocus={() => void refreshNotices()} onClick={() => { setFocus(null); setOpen((v) => !v); }}>
        <Bell size={18} strokeWidth={1.8} aria-hidden="true" />
        {count ? <span className={css.count} aria-hidden="true">{count > 99 ? "99+" : count}</span> : news ? <span className={css.news} aria-hidden="true" /> : null}
      </button>
      <NotificationPanel open={open} onClose={close} anchor={button} id="pulse-notices" focus={focus} />
    </>
  );
}
