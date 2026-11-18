import Link from "next/link";
import { ArrowRight, Download, MessageCircle } from "lucide-react";
import { api, getMe, vocabulary } from "../lib/api";
import { whatsNewItems } from "../lib/whats-new-server";
import { noteGroups, noteLine, releasedAtText, shareFor, whatsAppLink, type WhatsNewData } from "../lib/release-notes.mjs";
import { Message, Page, PageHeader } from "../ui";
import { NewDot } from "@pulse/ui-shell";
import { unseenHeading, unseenLines, type NewDotsState } from "../lib/new-dots.mjs";
import anchors from "../lib/new-anchors.json";
import { anchorEntry, trailWords, type AnchorRegistry } from "../lib/new-trail.mjs";
import { MarkAllSeen } from "./mark-all";
import { ShowMe } from "./show-me";
import { SeenRelease } from "./seen";
import visible from "../home/visible.module.css";
import css from "./whats-new.module.css";

export const dynamic = "force-dynamic";
const registry = anchors as AnchorRegistry;
/** A page's name from its address, for a change to a whole page ("/chats" → "Chats", "/erp/documents" → "Documents"). */
const pageName = (route: string) => { const last = route.split("/").filter(Boolean).pop() ?? ""; return last ? last[0].toUpperCase() + last.slice(1).replace(/-/g, " ") : "Home"; };
export const metadata = { title: "What's new" };

/** RELEASE-COMMS (owner, 7 Nov 2026): every release of the product, newest first, with the parts for this person (their
 *  roles decide: services/api/src/whats-new.ts), what to check, known issues and a card to send on WhatsApp. Below them,
 *  VISIBLE's list of the 25 October update (the Home's panel lists the same until it is closed).
 *  NEW-DOTS (owner, 8 Nov 2026): first, what is still new for this person (each changed page they can open and have not
 *  looked at yet, with its red dot), then Mark all as seen. Opening one clears it (new-dots-host.tsx).
 *  NEW-DOTS-2 (owner, 10 Nov 2026): a change to one thing on a page says where it is ("More in Work › The pool") and
 *  Show me takes the person there, to the very button (the spotlight, new-trail.tsx). */
export default async function WhatsNew() {
  const [res, words, me, fresh] = await Promise.all([api<WhatsNewData>("whats-new"), vocabulary(), getMe(), api<NewDotsState>("whats-new/unseen")]);
  const unseen = unseenLines(fresh.data?.items);
  // NEW-DOTS-2: how many updates the new things come from ("3 new things for you, from 1 update").
  const fromUpdates = new Set((fresh.data?.items ?? []).map((i) => i.note)).size;
  const dotsOn = fresh.data?.on !== false;
  // NEW-DOTS-2: what is still new is listed once, in the card at the top (with its dots); the release lines below do not
  // repeat the dots.
  const data = res.data;
  const notes = data?.notes ?? [];
  const audiences = data?.audiences ?? ["everyone"];
  const main = data?.main ?? "everyone";
  const earlier = whatsNewItems(me.data);
  return <Page>
    <PageHeader title="What's new" context={[notes.length ? `${notes.length} ${notes.length === 1 ? "update" : "updates"}` : "Updates", "Newest first"]} />
    {notes.length ? <SeenRelease newest={notes[0].id} /> : null}
    {unseen.length ? <section className={css.unseen} aria-labelledby="whats-new-unseen">
      <h2 id="whats-new-unseen">{unseenHeading(unseen.length)}{fromUpdates > 1 ? `, from ${fromUpdates} updates` : ""}</h2>
      <ul className={css.unseenList}>{unseen.map((l) => { const known = !!(l.anchor && anchorEntry(registry, l.anchor)); const where = known ? trailWords(registry, l.anchor) : [pageName(l.route)];
        return <li key={`${l.route} ${l.anchor}`}><ShowMe route={l.route} anchor={known ? l.anchor : ""} href={known ? anchorEntry(registry, l.anchor)!.href : l.route} text={l.text}>
        {/* The red dot leads the row: still new. Show me follows the words, so they read as one line. */}
        <span className={css.unseenDot}>{dotsOn ? <NewDot on /> : null}</span>
        <span className={css.unseenText}><b>{l.text}</b>
          {/* Show me, then where it is, under the words: the Show me buttons line up down the card, each next to its line. */}
          <span className={css.whereRow}>
            <span className={css.showMe}>Show me<ArrowRight size={14} aria-hidden="true" /></span>
            {where.length ? <span className={css.where} aria-label={`Where: ${where.join(", then ")}`}><span>{where.join(" › ")}</span></span> : null}
          </span>
          {/* Which update it came from: only when they come from more than one (the heading names the one). */}
          {fromUpdates > 1 ? <small>{l.releases > 1 ? `${l.headline} and ${l.releases - 1} more ${l.releases === 2 ? "update" : "updates"}` : l.headline}</small> : null}</span>
      </ShowMe></li>; })}</ul>
      <MarkAllSeen />
      {dotsOn ? null : <p className={css.dotsOff}>Red dots are off for you. <Link href="/settings?tab=notifications">Turn them on in Settings</Link>.</p>}
    </section> : null}
    {res.error ? <Message notice={res.error} /> : !notes.length && !unseen.length ? <p className={css.quiet}>No updates to show yet. When the app is updated, what changed for you shows here.</p> : null}
    {notes.length ? <ol className={css.releases} aria-label="Updates, newest first">{notes.map((n) => {
      const groups = noteGroups(n.items, main, words);
      const check = (n.pleaseCheck ?? []).map(noteLine).filter((l) => l !== null);
      const card = shareFor(n.share ?? {}, audiences);
      return <li key={n.id}><article className={css.release} aria-labelledby={`release-${n.id}`}>
        <div className={css.main}>
          <p className={css.when}><time dateTime={n.releasedAt}>{releasedAtText(n.releasedAt)}</time>{n.version ? <span>{n.version}</span> : null}</p>
          <h2 id={`release-${n.id}`}>{n.headline}</h2>
          {groups.map((g) => <section key={g.audience} className={css.part} aria-label={g.heading}>
            <h3>{g.heading}</h3>
            <ul>{g.lines.map((l, i) => <li key={i}>{l.href ? <Link href={l.href}>{l.text}<ArrowRight size={13} aria-hidden="true" /></Link> : l.text}</li>)}</ul>
          </section>)}
          {check.length ? <section className={`${css.part} ${css.check}`} aria-label="Please check">
            <h3>Please check</h3>
            <ul>{check.map((l, i) => <li key={i}>{l.href ? <Link href={l.href}>{l.text}<ArrowRight size={13} aria-hidden="true" /></Link> : l.text}</li>)}</ul>
          </section> : null}
          {n.knownIssues?.length ? <section className={`${css.part} ${css.issues}`} aria-label="Known issues">
            <h3>Known issues</h3>
            <ul>{n.knownIssues.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </section> : null}
        </div>
        {card ? <figure className={css.card}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the release's own card, served by the app */}
          {card.imageUrl ? <img src={card.imageUrl} alt={n.headline} loading="lazy" decoding="async" width={1080} height={1350} /> : null}
          <figcaption className={css.share}>
            {card.text ? <a className={css.wa} href={whatsAppLink(card.text)} target="_blank" rel="noopener noreferrer"><MessageCircle size={16} aria-hidden="true" />Send on WhatsApp</a> : null}
            {card.imageUrl ? <a className={css.save} href={card.imageUrl} download={`update-${n.id}.jpg`}><Download size={14} aria-hidden="true" />Save image</a> : null}
          </figcaption>
        </figure> : null}
      </article></li>;
    })}</ol> : null}
    {earlier.length ? <section className={`${visible.news} ${css.earlier}`} aria-label="Earlier: the update of 25 October 2026" data-full="">
      <h2 className={css.earlierTitle}>Earlier: the update of 25 October 2026</h2>
      <ul className={visible.newsList}>{earlier.map((i) => <li key={i.id}><Link href={i.href} className={visible.newsItem}>
        <b>{i.title}</b><span>{i.text}</span><em>{i.cta}<ArrowRight size={13} aria-hidden="true" /></em>
      </Link></li>)}</ul>
    </section> : null}
  </Page>;
}
