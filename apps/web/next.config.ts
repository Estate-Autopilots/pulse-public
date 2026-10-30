import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  experimental: { cpus: 2 },
  transpilePackages: ["@pulse/ui-shell", "@pulse/design-system", "@pulse/companion", "@pulse/invoice-doc", "@pulse/chat-export"],
  // pulse-dev serves `next dev` behind Cloudflare Access. Without this the dev client is refused its own
  // resources on that host and the page never hydrates: Recents, the period switcher and every form stay dead.
  allowedDevOrigins: process.env.PULSE_DEV_ORIGIN?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? ["pulse-dev.*.*"],
  // The dev badge sits in the bottom-left corner, on top of the rail's Settings button.
  devIndicators: false,
  // Old addresses answer with a real redirect, before any page renders: "/" is app/page.tsx (CHAT-SHELL: the chat on a desktop), Editors is Team → Tracking,
  // the pod pages are Leadership → Pods and the Team directory. The query string (the period) is carried over.
  // Android App Links for the Pulse phone app (app/assetlinks.json/route.ts).
  // OWNER-WORKBENCH: pulse-dev sits behind Cloudflare, which keeps .js/.css at its edge and ignores a browser's hard
  // reload; the dev server reuses chunk names, so the owner saw stale code. Development only: never store anything.
  // DEV-SPEED (28 Oct 2026): pulse-dev now serves a production build (~/pulse-dev/bin/pulse-dev-build); it builds with
  // PULSE_CDN_NO_STORE=1 so its pages keep these headers too. Production never sets it.
  headers: async () => process.env.NODE_ENV === "development" || process.env.PULSE_CDN_NO_STORE === "1"
    ? [{ source: "/:path*", headers: [{ key: "Cloudflare-CDN-Cache-Control", value: "no-store" }, { key: "CDN-Cache-Control", value: "no-store" }] }]
    : [],
  rewrites: async () => [{ source: "/.well-known/assetlinks.json", destination: "/assetlinks.json" },
    // PULSE-ID: Sign in with Pulse's discovery document.
    { source: "/.well-known/openid-configuration", destination: "/oauth/discovery" },
    // EST-2811: OAuth discovery for the remote MCP server (app/oauth/metadata, app/oauth/resource); its endpoints live under /oauth/mcp/*.
    ...["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"].map(source => ({ source, destination: "/oauth/metadata" })),
    ...["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].map(source => ({ source, destination: "/oauth/resource" }))],
  redirects: async () => [
    // BILLING (18 Oct 2026): ERP is called Billing; its pages stay under /erp, and /billing leads there.
    { source: "/billing", destination: "/erp", permanent: false },
    { source: "/billing/:path*", destination: "/erp/:path*", permanent: false },
    { source: "/editors", destination: "/people?tab=tracking&view=accounts", permanent: false },
    { source: "/editors/:account", destination: "/people/accounts/:account", permanent: false },
    { source: "/pod", destination: "/leadership?tab=pods", permanent: false },
    { source: "/pods/:pod", destination: "/people?pod=:pod", permanent: false },
    { source: "/attendance", destination: "/me?tab=attendance", permanent: false },
    { source: "/leave", destination: "/me?tab=leave", permanent: false },
    // HR desk → Policies has one row of views: Leave types and Holidays are "Leave & holidays", and the old Work
    // calendar tab is "Patterns & shifts". The destination's tab/view replace the old ones; other values carry over.
    { source: "/hr", has: [{ type: "query", key: "tab", value: "policies" }, { type: "query", key: "view", value: "(?:types|holidays)" }], destination: "/hr?tab=policies&view=leave", permanent: false },
    { source: "/hr", has: [{ type: "query", key: "tab", value: "work-calendar" }], destination: "/hr?tab=policies&view=patterns", permanent: false },
    // FLOW-B (21 Oct 2026): SOPs, Workflows and boards are one list, Processes; runs have their own place; what waits
    // for a person is My steps on My desk. One SOP, workflow, board, form and Import from Drive keep their addresses.
    { source: "/sops", destination: "/processes", permanent: false },
    { source: "/sops/workflows", destination: "/processes", permanent: false },
    { source: "/sops/runs", destination: "/runs", permanent: false },
    { source: "/sops/runs/:id", destination: "/runs/:id", permanent: false },
    { source: "/sops/waiting", destination: "/me/steps", permanent: false },
    // The flow engine's notifications and task notes link a run as /processes/runs/<id>.
    { source: "/processes/runs", destination: "/runs", permanent: false },
    { source: "/processes/runs/:id", destination: "/runs/:id", permanent: false },
  ],
};

export default nextConfig;
