"use client";
// ORG-PER-TAB: with two or more companies, every tab's title starts with its company's short name ("VT · Docs"), so
// tabs side by side say which company each is in; and a page a link opened in another company says so once
// ("Opened in Vitals Technology"), through the shared notices (Pip's island).
import { useEffect } from "react";
import { notify } from "@pulse/ui-shell";
import type { AccountOrg } from "../lib/api";
import { orgInitials } from "./labels";

/** A company's short name for the tab: its code when short (EA, VT), else its initials. */
export const shortName = (o: Pick<AccountOrg, "name" | "code">) => (o.code && /^[A-Za-z0-9]{1,5}$/.test(o.code) ? o.code.toUpperCase() : orgInitials(o.name));

export function TabCompany({ orgs }: { orgs: AccountOrg[] | undefined }) {
  const current = orgs?.find((o) => o.current);
  const many = (orgs?.filter((o) => !o.mine).length ?? 0) > 1;
  const prefix = current && many ? `${current.mine ? "Me" : shortName(current)} · ` : null;
  useEffect(() => {
    try {
      const opened = window.sessionStorage.getItem("pulse.tab.opened");
      if (opened) {
        window.sessionStorage.removeItem("pulse.tab.opened");
        notify({ id: "tab-opened", tone: "info", title: `Opened in ${opened}`, message: "Other tabs stay where they are.", timeout: 8000 });
      }
    } catch { /* private window */ }
  }, []);
  useEffect(() => {
    if (!prefix) return;
    const fix = () => { if (!document.title.startsWith(prefix)) document.title = prefix + document.title; };
    fix();
    // Next may put a page's <title> outside <head> while it streams: a cheap check each second as well.
    const watch = new MutationObserver(fix);
    watch.observe(document.head, { childList: true, subtree: true, characterData: true });
    const every = window.setInterval(fix, 1000);
    return () => { watch.disconnect(); window.clearInterval(every); };
  }, [prefix]);
  return null;
}
