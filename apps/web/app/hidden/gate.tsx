"use client";
// EST-1420 P1 (review-5f9c3e76): the root layout is reused on in-app navigation, so its redirect only catches a direct
// link. This gate runs on every navigation (a Link, router.push, back, forward, a prefetched page): when the path is a
// screen hidden from this person's role, the page's content is withheld and the notice shown instead. A switched-off
// module keeps its own neutral page, and a person's own profile is never held.
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { pathSwitchedOff } from "@pulse/ui-shell";
import { hiddenRedirect, underBase } from "../lib/screens.mjs";
import { HiddenNotice } from "./notice";

const NONE: readonly string[] = [];
export function HiddenGate({ bases = NONE, person, admin, client, modulesOff, companyOff = NONE, children }: { bases?: readonly string[]; person?: string | null;
  admin: boolean; client?: string | null; modulesOff?: readonly string[]; companyOff?: readonly string[]; children: ReactNode }) {
  const path = usePathname();
  const held = bases.length > 0 && !!hiddenRedirect(path, bases, person) && !pathSwitchedOff(path, modulesOff) && !underBase(path, companyOff);
  return held ? <HiddenNotice admin={admin} client={client} /> : <>{children}</>;
}
