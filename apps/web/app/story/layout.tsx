import type { ReactNode } from "react";
import { HqFrame } from "../hq/frame";

export const metadata = { title: "Product Story" };

/** FEATURES-1024: Product Story, for any organisation: Pulse HQ's calm canvas, no module gate (like Stack Intelligence). */
export default function StoryLayout({ children }: { children: ReactNode }) {
  return <HqFrame>{children}</HqFrame>;
}
