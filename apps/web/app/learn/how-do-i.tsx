"use client";
// XRAY-LINK (Learn): the quiet "How do I…" button (HR-PEOPLE: no longer in the top bar; LearnMenuItem below carries it). It shows only on a page some tutorial is about
// (lib/learn.mjs `pages`) and lists those tutorials, then "All tutorials". One component for every page: the pages
// themselves are not changed.
import { CircleHelp, GraduationCap, PlayCircle } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, type MenuItem } from "../kit";
import { tutorialsFor } from "../lib/learn.mjs";
import bell from "../inbox-bell.module.css";

export function HowDoI() {
  const pathname = usePathname();
  const list = tutorialsFor(pathname ?? "");
  if (!list.length || pathname?.startsWith("/learn")) return null;
  const items: MenuItem[] = [
    ...list.map((t, i): MenuItem => ({ key: t.id, label: t.title, text: t.title, hint: `${t.who} · about ${t.minutes} min`, href: `/learn/${t.id}`,
      heading: i === 0 ? "How do I…" : undefined, icon: <PlayCircle size={16} aria-hidden="true" /> })),
    { key: "all", label: "All tutorials", text: "All tutorials", href: "/learn", separator: true, icon: <GraduationCap size={16} aria-hidden="true" /> },
  ];
  return <Menu label="How do I" items={items} className={bell.bell} buttonLabel="How do I… (tutorials for this page)" title="How do I…">
    <CircleHelp size={18} strokeWidth={1.75} aria-hidden="true" />
  </Menu>;
}

/** The account menu's way into Learn. HR-PEOPLE (owner, 13 Nov 2026, T1.1.9: the top bar's "How do I…" did not fit
 *  there): help lives here, with this page's own tutorials first ("How do I…"), then every tutorial. */
export function LearnMenuItem() {
  const pathname = usePathname();
  const here = pathname?.startsWith("/learn") ? [] : tutorialsFor(pathname ?? "").slice(0, 2);
  return <>
    {here.map((t) => <Link key={t.id} href={`/learn/${t.id}`} role="menuitem" title={`${t.who} · about ${t.minutes} min`}><CircleHelp size={16} aria-hidden="true" />Help: {t.title}</Link>)}
    <Link href="/learn" role="menuitem"><GraduationCap size={16} aria-hidden="true" />{here.length ? "All tutorials" : "Learn Pulse: tutorials"}</Link>
  </>;
}
