"use client";
import { useEffect } from "react";

/** SIGNED-OUT-SHELL (phone QA, 4 Nov 2026): a page reached by moving inside Pulse after the session ended showed an
 *  in-page "Sign in to continue" card, where a direct load of the same address goes to the sign-in page (layout.tsx).
 *  This takes the person there too, with the page they wanted as the place to return to. The card stays as the
 *  fallback while the sign-in page loads. */
export function SignInRedirect() {
  useEffect(() => {
    const here = window.location.pathname + window.location.search;
    if (window.location.pathname.startsWith("/login")) return;
    window.location.replace(here === "/" || here === "/dashboard" ? "/login" : `/login?${new URLSearchParams({ next: here })}`);
  }, []);
  return null;
}
