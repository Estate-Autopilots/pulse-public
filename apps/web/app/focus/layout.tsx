import type { ReactNode } from "react";
import { getMe } from "../lib/api";
import { moduleElsewhere, moduleLayout } from "../module-off";

export const metadata = { title: "Focus" };

/** FOCUS (owner, 7 Nov 2026): the owner's private board of AI capacity and today's plan. An organisation-only module
 *  (services/api/src/modules.ts ORG_ONLY), on only in his own workspace.
 *  SETTINGS-APPLE (owner, 13 Nov 2026, T1.4.2: "Focus just redirected me to my Savuzo HQ ... the back and forth, 'This page
 *  is in Savuzo HQ'"): in every other company the person works in, the same Focus opens in place, on that company's part
 *  (focus/page.tsx); no company switch and no "This page is in …" card. Anyone without a Focus gets the neutral page. */
const Gate = moduleLayout("focus");

export default async function FocusLayout({ children }: { children: ReactNode }) {
  const me = (await getMe()).data;
  if (me?.modules?.off?.includes("focus") && moduleElsewhere(me, "focus")) return children;
  return <Gate>{children}</Gate>;
}
