import type { ReactNode } from "react";
import { moduleLayout } from "../module-off";
import { HqFrame } from "../hq/frame";

export const metadata = { title: "Product map" };

/** PRODUCT-MAP, on Pulse HQ's calm canvas. FIX-SHELL (owner, 10 Nov 2026: "it's an internal tool; it shouldn't appear
 *  for Estate Autopilots"): organisation-only (module product_map, 1947), on in the platform's own organisations; anyone
 *  else who has it in another of their companies gets a link there instead (module-off.tsx). */
const Gate = moduleLayout("product_map");

export default function ProductMapLayout({ children }: { children: ReactNode }) {
  return <Gate><HqFrame>{children}</HqFrame></Gate>;
}
