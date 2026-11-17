import type { ReactNode } from "react";
import { moduleLayout } from "../module-off";
import { HqFrame } from "./frame";

export const metadata = { title: "Pulse HQ" };

/** PULSE-HQ (owner, 23 Oct 2026): the business of Pulse, run in Pulse. Only the Pulse organisation has the module on
 *  (organisation-only, services/api/src/modules.ts ORG_ONLY); everywhere else this shows the neutral page. */
const Gate = moduleLayout("pulse_hq");

export default function HqLayout({ children }: { children: ReactNode }) {
  return <Gate><HqFrame>{children}</HqFrame></Gate>;
}
