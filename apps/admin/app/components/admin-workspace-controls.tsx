"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const preferenceKey = "pulse:admin-sidebar-collapsed";
const preferenceEvent = "pulse:admin-sidebar-preference";
function subscribePreference(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(preferenceEvent, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(preferenceEvent, callback);
  };
}
function readPreference() {
  try {
    return localStorage.getItem(preferenceKey) === "true";
  } catch {
    return false;
  }
}

export function useAdminWorkspaceControls() {
  const storedCollapsed = useSyncExternalStore(
    subscribePreference,
    readPreference,
    () => false,
  );
  const [temporaryCollapsed, setTemporaryCollapsed] = useState<boolean | null>(
    null,
  );
  const collapsed = temporaryCollapsed ?? storedCollapsed;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const sidebarRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const signOutPending = useRef(false);
  function toggleCollapsed() {
    const next = !collapsed;
    try {
      localStorage.setItem(preferenceKey, String(next));
      window.dispatchEvent(new Event(preferenceEvent));
      setTemporaryCollapsed(null);
    } catch {
      setTemporaryCollapsed(next);
    }
  }
  function closeMobile() {
    setMobileOpen(false);
  }
  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    const trigger = triggerRef.current;
    document.body.style.overflow = "hidden";
    const controls = () =>
      Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          "a[href], button:not(:disabled)",
        ) ?? [],
      ).filter((node) => node.getClientRects().length > 0);
    controls()[0]?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keyDown);
      // The committed closed state removes inert before focus returns.
      trigger?.focus();
    };
  }, [mobileOpen]);
  async function signOut() {
    if (signOutPending.current) return;
    signOutPending.current = true;
    setSigningOut(true);
    setSignOutError("");
    try {
      const response = await fetch("/auth/sign-out", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
      });
      if (!response.ok) throw new Error();
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Discard privileged route caches after confirmed sign-out.
      window.location.assign("/login");
    } catch {
      signOutPending.current = false;
      setSigningOut(false);
      setSignOutError("Sign-out could not be confirmed. Try again.");
    }
  }
  function requestSignOut() {
    const request = new CustomEvent("pulse:admin-before-leave", {
      cancelable: true,
      detail: { proceed: () => void signOut() },
    });
    if (document.dispatchEvent(request)) void signOut();
  }
  return {
    collapsed,
    toggleCollapsed,
    mobileOpen,
    openMobile: () => setMobileOpen(true),
    closeMobile,
    sidebarRef,
    triggerRef,
    signingOut,
    signOutError,
    requestSignOut,
  };
}
