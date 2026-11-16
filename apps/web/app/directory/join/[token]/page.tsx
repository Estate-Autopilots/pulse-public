// COMPANY-SEARCH: where an invite link lands after sign-up (/signup?next=/directory/join/<token>). The invite is marked
// joined with the new company, so whoever waits on it (a contract) can go on; then a short "start here".
import Link from "next/link";
import { apiPost } from "../../../lib/api";
import { Message, Page, PageHeader } from "../../../ui";
import css from "../../directory.module.css";

type Claim = { invite: { status: string; companyName: string; purpose: string; from: { name: string; handle: string }; mine: boolean } };

export default async function Join({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await apiPost<Claim>("directory/invites/claim", { token });
  if (r.error || !r.data) return <Page><PageHeader title="Your invite" recent={false} /><Message text={r.error ?? "This invite link is not right. Ask for a new one."} /></Page>;
  const i = r.data.invite;
  return <Page>
    <PageHeader title="You are on Vitals" recent={false} />
    <div className={css.profile}>
      <section className={css.card}>
        <h2 className={css.cardName}>Welcome, {i.companyName}</h2>
        <p className={css.note}>{i.from.name} invited you{i.purpose === "contract" ? " to sign an agreement. It is waiting for you in Agreements." : "."}</p>
        <div className={css.actions}>
          {i.purpose === "contract" ? <Link className={css.primary} href="/contracts" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>Open the agreement</Link>
            : <Link className={css.primary} href="/" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>Start here</Link>}
          <Link className={css.quiet} href={`/directory/c/${encodeURIComponent(i.from.handle)}`} style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>See {i.from.name}</Link>
        </div>
      </section>
    </div>
  </Page>;
}
