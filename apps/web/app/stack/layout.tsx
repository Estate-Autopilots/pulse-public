import type { ReactNode } from "react";
import { HqFrame } from "../hq/frame";

export const metadata = { title: "Stack Intelligence" };

/** PULSE-HQ (owner, 23 Oct 2026): Stack Intelligence, for any organisation (0973): Pulse HQ's calm canvas, no module gate. */
export default function StackLayout({ children }: { children: ReactNode }) {
  return <HqFrame>{children}</HqFrame>;
}
