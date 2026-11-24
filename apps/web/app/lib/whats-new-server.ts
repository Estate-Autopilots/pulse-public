// VISIBLE: the last update's items this person may open: their role's, without modules the install or the company
// switched off and screens hidden from their role (the rail's own rules, lib/nav.ts).
import { pathSwitchedOff } from "@pulse/ui-shell";
import type { Me } from "./api";
import { navFor, roleLabelFor } from "./nav";
import { underBase } from "./screens.mjs";
import { namedFor, whatsNewFor, type WhatsNewItem } from "./whats-new.mjs";

/** `product`: the name the address wears (Vitals OS on the platform's addresses); the items say it instead of Pulse. */
export function whatsNewItems(me: Me | undefined | null, product?: string | null): WhatsNewItem[] {
  if (!me?.person || me.side === "client" || me.role === "accountant") return [];
  const { rename, hiddenPaths } = navFor(me);
  const gone = [...(hiddenPaths ?? []), ...Object.entries(rename ?? {}).filter(([, label]) => label === null).map(([href]) => href)];
  return whatsNewFor(roleLabelFor(me), (href) => pathSwitchedOff(href, me.modules?.off) || underBase(href.split("?")[0], gone)).map(namedFor(product));
}
