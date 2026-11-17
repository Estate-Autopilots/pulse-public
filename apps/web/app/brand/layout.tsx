import type { ReactNode } from "react";
import { moduleLayout } from "../module-off";

/** VISUAL-QA (D126, 13 Nov 2026): the Pulse brand sheet (the Pulse mark, Pip, app icons) is Pulse HQ's. D9 put /brand in
 *  pulse_hq's paths, which took it out of the menu and Ctrl+K, but the page still opened by its address in every
 *  company (a member of Estate Autopilots saw "Dev preview: the owner approves before anything ships"). */
const Gate = moduleLayout("pulse_hq");

export default function BrandLayout({ children }: { children: ReactNode }) {
  return <Gate>{children}</Gate>;
}
