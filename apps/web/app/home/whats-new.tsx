"use client";
// VISIBLE (owner, 25 Oct 2026): the last update's features on the Home, each with its way in, until the person closes
// the panel (a cookie, so the server leaves it out next time; a newer update shows again). The Home shows the first six
// (three on a phone); /whats-new keeps the whole list.
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { WHATS_NEW_COOKIE, WHATS_NEW_ID, type WhatsNewItem } from "../lib/whats-new.mjs";
import css from "./visible.module.css";

export function WhatsNewPanel({ items }: { items: WhatsNewItem[] }) {
  const [open, setOpen] = useState(true);
  if (!open || !items.length) return null;
  const close = () => { document.cookie = `${WHATS_NEW_COOKIE}=${WHATS_NEW_ID}; path=/; max-age=31536000; samesite=lax`; setOpen(false); };
  return <section className={css.news} aria-labelledby="whats-new-title" data-whats-new="">
    <header className={css.newsHead}>
      <h2 id="whats-new-title"><Sparkles size={16} aria-hidden="true" />New in Pulse</h2>
      <Link href="/whats-new" className={css.newsAll}>All {items.length}</Link>
      <button type="button" className={css.newsClose} onClick={close} aria-label="Close what's new" title="Close (it stays under Home → What's new)"><X size={16} aria-hidden="true" /></button>
    </header>
    <ul className={css.newsList}>{items.slice(0, 6).map((i) => <li key={i.id}><Link href={i.href} className={css.newsItem}>
      <b>{i.title}</b><span>{i.text}</span><em>{i.cta}<ArrowRight size={13} aria-hidden="true" /></em>
    </Link></li>)}</ul>
  </section>;
}
