"use client";
// The AC design system's components link with Next's Link inside Pulse (owner workbench, 21 Oct 2026).
import Link from "next/link";
import type { ReactNode } from "react";
import { DsProvider } from "@pulse/design-system/ui";

export function AppDs({ children }: { children: ReactNode }) {
  return <DsProvider link={Link}>{children}</DsProvider>;
}
