"use client";

import dynamic from "next/dynamic";

// These hosts draw nothing on the server. Load their code and styles after hydration so the page's
// controls do not wait for screen automation and the policy reader on every first visit.
// Keep this boundary in a Client Component: dynamic imports in a Server Component are not code split.
export const ScreenHost = dynamic(() => import("./agent-ui/host").then((m) => m.ScreenHost), { ssr: false });
// A newly published policy version still opens for acceptance on the next visit (staff seats).
export const PolicyAcceptHost = dynamic(() => import("./agreements/accept-view").then((m) => m.PolicyAcceptHost), { ssr: false });
