"use client";
// SETTINGS-APPLE (T1.3.1): where a section sits (Settings › area › section › part), with Back and Forward beside it, as
// a computer's settings window has them. Both walk this tab's own history (soft navigations, no reload). On a phone the
// first button says "‹ Settings" (or the part's parent) and pops the stack.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { usePop } from "./frame";
import css from "./crumbs.module.css";

export type Crumb = { label: string; href?: string };
type Nav = EventTarget & { canGoBack?: boolean; canGoForward?: boolean };

export function Crumbs({ trail }: { trail: Crumb[] }) {
  const router = useRouter();
  const pop = usePop();
  // The Navigation API (Chromium, Edge, the desktop app) says whether there is a page to go back or forward to.
  const [can, setCan] = useState<{ back: boolean; forward: boolean }>({ back: true, forward: false });
  useEffect(() => {
    const nav = (window as unknown as { navigation?: Nav }).navigation;
    const read = () => setCan({ back: nav?.canGoBack ?? window.history.length > 1, forward: nav?.canGoForward ?? true });
    read();
    nav?.addEventListener?.("currententrychange", read);
    return () => nav?.removeEventListener?.("currententrychange", read);
  }, []);
  const parent = [...trail].reverse().find((c, i) => i > 0 && c.href) ?? { label: "Settings", href: "/settings" };
  return <nav className={css.crumbs} aria-label="Where you are in Settings">
    <button type="button" className={css.up} onClick={() => pop(parent.href ?? "/settings")}><ChevronLeft size={18} aria-hidden="true" />{parent.label}</button>
    <span className={css.history}>
      <button type="button" className={css.step} aria-label="Back" title="Back" disabled={!can.back} onClick={() => router.back()}><ChevronLeft size={16} aria-hidden="true" /></button>
      <button type="button" className={css.step} aria-label="Forward" title="Forward" disabled={!can.forward} onClick={() => router.forward()}><ChevronRight size={16} aria-hidden="true" /></button>
    </span>
    <ol className={css.trail}>{trail.map((c, i) => {
      const last = i === trail.length - 1;
      return <li key={`${i}:${c.label}`}>{!last && c.href ? <Link href={c.href} scroll={false}>{c.label}</Link> : <span aria-current={last ? "page" : undefined}>{c.label}</span>}</li>;
    })}</ol>
  </nav>;
}
