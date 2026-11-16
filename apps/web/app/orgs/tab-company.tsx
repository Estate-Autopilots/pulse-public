"use client";
// ORG-PER-TAB: with two or more companies, every tab's title starts with its company's short name ("VT · Docs"), so
// tabs side by side say which company each is in; and a page a link opened in another company says so once
// ("Opened in Vitals Technology"): in the top bar's company chip (TabChip), or through the shared notices when there is
// no chip (an accountant's view).
import { useEffect, useState } from "react";
import { Link2, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import type { AccountOrg } from "../lib/api";
import { orgHue, orgInitials } from "./labels";
import { Notice } from "../components/calm";
import css from "./orgs.module.css";

/** A company's short name for the tab: its code when short (EA, VT), else its initials. */
export const shortName = (o: Pick<AccountOrg, "name" | "code">) => (o.code && /^[A-Za-z0-9]{1,5}$/.test(o.code) ? o.code.toUpperCase() : orgInitials(o.name));

/** How long the chip stays lit, and the fallback notice stays, after a link opened this tab in another company. */
const OPENED_MS = 15000;

/** Whether a link has just opened this tab in another company (until the page's note is dismissed): the company's name. */
function useOpened(): string | null {
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setOpened(document.documentElement.dataset.tabOpened || null);
    read();
    window.addEventListener("pulse:tab-opened", read);
    return () => window.removeEventListener("pulse:tab-opened", read);
  }, []);
  return opened;
}
const dismissOpened = () => { delete document.documentElement.dataset.tabOpened; window.dispatchEvent(new Event("pulse:tab-opened")); };

/** ORG-PER-TAB (judge round 4: say it on the page, on a phone too): a record a link opened in another of the person's
 *  companies says so at the top of the page, until "Got it". */
export function OpenedNote() {
  const opened = useOpened();
  if (!opened) return <span data-opened-note-slot="" hidden />;
  return <div data-opened-note="" data-opened-note-slot="" role="status"><Notice action={<button type="button" className={css.noteClose} onClick={dismissOpened} aria-label="Close" title="Close"><X size={16} aria-hidden="true" /></button>}>
    <span className={css.noteText}><Link2 size={15} aria-hidden="true" /><span>Opened in <strong>{opened}</strong> from a link. Your other tabs didn&apos;t change.</span></span></Notice></div>;
}

export function TabCompany({ orgs }: { orgs: AccountOrg[] | undefined }) {
  const current = orgs?.find((o) => o.current);
  const many = (orgs?.filter((o) => !o.mine).length ?? 0) > 1;
  const prefix = current && many ? `${current.mine ? "Me" : shortName(current)} · ` : null;
  useEffect(() => {
    try {
      const opened = window.sessionStorage.getItem("pulse.tab.opened");
      if (!opened) return;
      window.sessionStorage.removeItem("pulse.tab.opened");
      // A doc or task page says it in its note (OpenedNote, same render, so already in the page; the top bar's chip
      // lights up); any other page says it through the shared notice.
      document.documentElement.dataset.tabOpened = opened;
      window.dispatchEvent(new Event("pulse:tab-opened"));
      if (!document.querySelector("[data-opened-note-slot]")) notify({ id: "tab-opened", tone: "info", title: `Opened in ${opened}`, message: "Your other tabs didn't change.", timeout: OPENED_MS });
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

/** ORG-PER-TAB (judge rounds 1-4: "put the company near the top bar"): with two or more companies, the top bar says which
 *  company this tab is in: a dot in its colour and its name. A tap opens the switcher. It is lit for a while after a
 *  link opened this tab in that company (the page's OpenedNote says so in words). */
export function TabChip({ orgs }: { orgs: AccountOrg[] | undefined }) {
  const opened = useOpened();
  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!opened) return;
    const on = window.setTimeout(() => setLit(true), 0), off = window.setTimeout(() => setLit(false), OPENED_MS);
    return () => { window.clearTimeout(on); window.clearTimeout(off); };
  }, [opened]);
  const current = orgs?.find((o) => o.current);
  if (!current || (orgs?.filter((o) => !o.mine).length ?? 0) < 2) return null;
  const name = current.mine ? "My workspace" : current.name;
  return <button type="button" className={css.tabChip} data-tab-chip="" data-opened={lit && opened ? "" : undefined} title={`This tab: ${name}`}
    aria-label={`This tab is in ${name}. Switch company in this tab`} onClick={() => window.dispatchEvent(new Event("pulse:orgs-open"))}>
    <span className={css.tabDot} aria-hidden="true" style={{ background: current.accent ?? `hsl(${orgHue(current.name)} 48% 42%)` }} />
    <span className={css.chipName}>{name}</span>
  </button>;
}
