import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { hostMode, requestHost } from "./lib/host-mode.mjs";
import { platformBrand } from "./lib/host-families.mjs";

// Installed Pulse (Add to Home Screen, desktop install): the brand's app icons from packages/design-system/brand.
// UX-TENANT: named after the company whose address installed it.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const host = requestHost(await headers());
  // LOGIN-OTP / LOGIN-VITALS: the platform's own addresses (every listed family: app., staging., dev.vitalsos.ai) install
  // as "Vitals OS" with its icon.
  const vitals = platformBrand(host);
  return {
    name: vitals ? vitals.product : `Pulse · ${(await hostMode(host)).name ?? "Estate Autopilots"}`, short_name: vitals ? vitals.product : "Pulse", start_url: "/", display: "standalone",
    background_color: "#f6f6fa", theme_color: "#5b45d6",
    // PULSE-APPS: the shared address installs with the Vitals OS icon; company addresses keep their own.
    icons: vitals ? [
      { src: vitals.icon, sizes: "192x192", type: "image/png" },
      { src: vitals.icon512, sizes: "512x512", type: "image/png" },
      { src: vitals.maskable, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ] : [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
