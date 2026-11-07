"use client";
// EST-1241: All modules on the sales home: the rail's own pages for this person (the shell's list for their role, less
// switched-off modules and screens the organisation hides; lib/nav.ts), so nothing here opens a page the rail would not.
// The home itself is left out: it is where the person already is.
import Link from "next/link";
import { shellNav, type ShellRename } from "@pulse/ui-shell";
import css from "./sales-home.module.css";

export function AllModules({ roleLabel, modulesOff, rename }: { roleLabel: string; modulesOff?: readonly string[]; rename?: ShellRename }) {
  const pages = shellNav(roleLabel, modulesOff, rename).pages.filter((page) => page.href !== "/dashboard");
  return <ul className={css.modules}>{pages.map(({ href, label, Icon }) => <li key={href}>
    <Link href={href} className={css.module}><Icon size={18} aria-hidden="true" /><span>{label}</span></Link>
  </li>)}</ul>;
}
