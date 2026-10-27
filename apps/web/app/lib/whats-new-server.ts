// VISIBLE: the last update's items this person may open: their role's, without modules the install or the company
// switched off and screens hidden from their role (the rail's own rules, lib/nav.ts).
import { pathSwitchedOff } from "@pulse/ui-shell";
import type { Me } from "./api";
import { navFor, roleLabelFor } from "./nav";
import { underBase } from "./screens.mjs";
import { whatsNewFor, type WhatsNewItem } from "./whats-new.mjs";

export function whatsNewItems(me: Me | undefined | null): WhatsNewItem[] {
  if (!me?.person || me.side === "client" || me.role === "accountant") return [];
  const { rename, hiddenPaths } = navFor(me);
  const gone = [...(hiddenPaths ?? []), ...Object.entries(rename ?? {}).filter(([, label]) => label === null).map(([href]) => href)];
  return whatsNewFor(roleLabelFor(me), (href) => pathSwitchedOff(href, me.modules?.off) || underBase(href.split("?")[0], gone));
}
