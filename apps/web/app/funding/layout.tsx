import type { ReactNode } from "react";
import { moduleLayout } from "../module-off";

export const metadata = { title: "Funding" };

/** FOCUS (owner, 7 Nov 2026): startup programmes and credits. An organisation-only module (modules.ts ORG_ONLY). */
const Gate = moduleLayout("funding");

export default function FundingLayout({ children }: { children: ReactNode }) {
  return <Gate>{children}</Gate>;
}
