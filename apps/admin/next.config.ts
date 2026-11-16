import type { NextConfig } from "next";

// PULSE-ADMIN: the Pulse admin site (company back office), its own Next app. In production it runs inside the Pulse
// container on 127.0.0.1:8083 and Pulse's web forwards its own host to it (apps/web/proxy.ts, PULSE_ADMIN_HOSTS);
// in development `next dev` serves pulse-admin-dev behind Cloudflare Access.
const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  experimental: { cpus: 2 },
  poweredByHeader: false,
  devIndicators: false,
  allowedDevOrigins: process.env.PULSE_ADMIN_DEV_ORIGIN?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? ["pulse-admin-dev.*.*"],
  headers: async () => [{
    source: "/:path*",
    headers: [
      { key: "x-frame-options", value: "DENY" },
      { key: "content-security-policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
      { key: "x-content-type-options", value: "nosniff" },
      { key: "referrer-policy", value: "no-referrer" },
      { key: "strict-transport-security", value: "max-age=31536000; includeSubDomains" },
      { key: "x-robots-tag", value: "noindex, nofollow" },
      ...(process.env.NODE_ENV === "development" ? [{ key: "Cloudflare-CDN-Cache-Control", value: "no-store" }, { key: "CDN-Cache-Control", value: "no-store" }] : []),
    ],
  }],
};

export default nextConfig;
