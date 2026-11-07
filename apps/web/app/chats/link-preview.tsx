"use client";
// CHAT-V4 (24 Oct 2026): a link in a message shows what it is: the page's title, its description and its site, read by
// Pulse's own address check (/api/frame-check: public https only, four seconds, the first 64 KB, never stored). One card
// per message (its first public link), asked once per address per page load; a page that does not answer shows nothing.
import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { openInPanel } from "./workspace/tabs";
import css from "./chats.module.css";

type Card = { title?: string; description?: string; site?: string };
const cards = new Map<string, Promise<Card | null>>();
const done = new Map<string, Card | null>();
function read(url: string) {
  let p = cards.get(url);
  if (!p) {
    p = fetch(`/api/frame-check?url=${encodeURIComponent(url)}`).then((r) => r.ok ? r.json() as Promise<Card> : null)
      .then((c) => c && c.title ? { title: c.title, description: c.description, site: c.site } : null).catch(() => null);
    p.then((c) => { done.set(url, c); });
    cards.set(url, p);
  }
  return p;
}

export function LinkPreview({ url }: { url: string }) {
  const [card, setCard] = useState<Card | null>(() => done.get(url) ?? null);
  useEffect(() => {
    if (done.has(url)) return;
    let live = true; void read(url).then((c) => { if (live) setCard(c); });
    return () => { live = false; };
  }, [url]);
  if (!card) return null;
  return <a className={css.linkCard} href={url} target="_blank" rel="noreferrer" data-link-preview=""
    onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; if (openInPanel({ href: url, title: card.title ?? url })) e.preventDefault(); }}>
    <b>{card.title}</b>
    {card.description ? <span>{card.description}</span> : null}
    <small><Globe size={11} aria-hidden="true" />{card.site}</small>
  </a>;
}
