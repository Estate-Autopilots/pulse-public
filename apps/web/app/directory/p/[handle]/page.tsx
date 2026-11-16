// COMPANY-SEARCH: a person's public profile (only people who chose "Let people find me"; e-mail and phone only when
// they chose to show them).
import Link from "next/link";
import type { ReactNode } from "react";
import { apiV1 } from "../../../lib/api";
import type { DirectoryPerson } from "../../../lib/directory.mjs";
import { Message, Page, PageHeader } from "../../../ui";
import { PersonAvatar } from "../../search";
import css from "../../directory.module.css";

export default async function PersonProfile({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const r = await apiV1<{ person: DirectoryPerson }>(`/v1/directory/people/${encodeURIComponent(handle)}`);
  const back = { href: "/directory?tab=people", label: "Find companies and people" };
  if (r.error || !r.data) return <Page><PageHeader title="Person" back={back} recent={false} /><Message text={r.status === 404 ? "We could not find that person. They may have chosen not to show up in search." : r.error ?? "Try again."} /></Page>;
  const p = r.data.person;
  const facts: [string, ReactNode][] = ([
    ["Works at", p.company ? <Link href={`/directory/c/${encodeURIComponent(p.company.handle)}`}>{p.company.name}</Link> : null],
    ["E-mail", p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : null],
    ["Phone", p.phone ? <a href={`tel:${p.phone.replace(/[^0-9+]/g, "")}`}>{p.phone}</a> : null],
  ] as [string, ReactNode][]).filter(([, v]) => v);
  return <Page>
    <PageHeader title={p.name} context={[`@${p.handle}`, p.company?.name]} back={back} recent={{ title: p.name }} />
    <div className={css.profile}>
      <section className={css.card} aria-label="Profile">
        <div className={css.cardHead}>
          <PersonAvatar person={p} size={72} />
          <div className={css.lineText}><h2 className={css.cardName}>{p.name}</h2><span className={css.lineSub}>@{p.handle}{p.headline ? ` · ${p.headline}` : ""}</span></div>
        </div>
        {facts.length ? <dl className={css.facts}>{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl> : null}
      </section>
    </div>
  </Page>;
}
