// COMPANY-SEARCH: a company's public profile (only what it chose to show).
import Link from "next/link";
import type { ReactNode } from "react";
import { apiV1 } from "../../../lib/api";
import type { DirectoryCompany } from "../../../lib/directory.mjs";
import { CompanyMark } from "../../../company-mark";
import { Message, Page, PageHeader } from "../../../ui";
import { VerifiedBadge } from "../../company-picker";
import css from "../../directory.module.css";

export default async function CompanyProfile({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const r = await apiV1<{ company: DirectoryCompany }>(`/v1/directory/companies/${encodeURIComponent(handle)}`);
  const back = { href: "/directory", label: "Find companies and people" };
  if (r.error || !r.data) return <Page><PageHeader title="Company" back={back} recent={false} /><Message text={r.status === 404 ? "We could not find that company. It may have left Vitals or chosen not to show up in search." : r.error ?? "Try again."} /></Page>;
  const c = r.data.company;
  const facts: [string, ReactNode][] = [
    ["Legal name", c.legalName], ["City", c.city], ["Industry", c.industry],
    ["Website", c.website ? <a href={c.website} target="_blank" rel="noreferrer nofollow">{c.website.replace(/^https?:\/\//, "")}</a> : null],
    ...c.ids.map((x): [string, ReactNode] => [x.label, <span key={x.kind}>{x.value}{(x.kind === "gstin" && c.verifiedBy === "gstin") || (x.kind === "cin" && c.verifiedBy === "cin") ? <> <VerifiedBadge by={c.verifiedBy} compact /></> : null}</span>]),
  ];
  const shown = facts.filter(([, v]) => v);
  return <Page>
    <PageHeader title={c.name} context={[`@${c.handle}`, c.city]} back={back} recent={{ title: c.name }} />
    <div className={css.profile}>
      <section className={css.card} aria-label="Company profile">
        <div className={css.cardHead}>
          <CompanyMark name={c.name} mark={c.logo} size={64} />
          <div className={css.lineText}><h2 className={css.cardName}>{c.name}<VerifiedBadge by={c.verifiedBy} /></h2><span className={css.lineSub}>@{c.handle}</span></div>
        </div>
        {shown.length ? <dl className={css.facts}>{shown.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          : <p className={css.note}>This company shows only its name, @handle and logo.</p>}
        {c.verified ? <p className={css.note}>Verified means its {c.verifiedBy === "gstin" ? "GSTIN" : "CIN"} has the right shape{c.verifiedBy === "gstin" ? " and check letter" : ""}. Vitals has not checked it with the government&apos;s records yet.</p> : null}
        <div className={css.actions}><Link className={css.primary} href={`/contracts/new?company=${encodeURIComponent(c.handle)}`} style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>Send an agreement</Link></div>
      </section>
    </div>
  </Page>;
}
