import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getMe } from "../lib/api";
import { whatsNewItems } from "../lib/whats-new-server";
import { Message, Page, PageHeader } from "../ui";
import css from "../home/visible.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "What's new in Pulse" };

/** VISIBLE (owner, 25 Oct 2026): what the last update brought, each with its way in (the Home's panel lists the same
 *  until it is closed; this page stays under Home → What's new). */
export default async function WhatsNew() {
  const me = (await getMe()).data;
  const items = whatsNewItems(me);
  return <Page>
    <PageHeader title="What's new" context={["The update of 25 October 2026", `${items.length} things to try`]} />
    {items.length ? <section className={css.news} aria-label="New in this update" data-full="">
      <ul className={css.newsList}>{items.map((i) => <li key={i.id}><Link href={i.href} className={css.newsItem}>
        <b>{i.title}</b><span>{i.text}</span><em>{i.cta}<ArrowRight size={13} aria-hidden="true" /></em>
      </Link></li>)}</ul>
    </section> : <Message text="Nothing new for your role in this update." />}
  </Page>;
}
