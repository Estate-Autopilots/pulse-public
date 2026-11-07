import type { ReactNode } from "react";
import { HqFrame } from "../hq/frame";

export const metadata = { title: "Product map" };

/** PRODUCT-MAP: for every organisation building software, on Pulse HQ's calm canvas, no module gate (like Product Story). */
export default function ProductMapLayout({ children }: { children: ReactNode }) {
  return <HqFrame>{children}</HqFrame>;
}
