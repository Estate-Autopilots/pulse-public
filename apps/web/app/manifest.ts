import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { hostMode, requestHost } from "./lib/host-mode.mjs";

// Installed Pulse (Add to Home Screen, desktop install): the brand's app icons from packages/design-system/brand.
// UX-TENANT: named after the company whose address installed it.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  return {
    name: `Pulse · ${(await hostMode(requestHost(await headers()))).name ?? "Estate Autopilots"}`, short_name: "Pulse", start_url: "/", display: "standalone",
    background_color: "#f6f6fa", theme_color: "#5b45d6",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
