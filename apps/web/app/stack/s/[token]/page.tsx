import Link from "next/link";
import type { CSSProperties } from "react";
import { ArrowLeft, Globe, Link2 } from "lucide-react";
import { Message } from "../../../ui";
import { api } from "../../../lib/api";
import hq from "../../../hq/hq.module.css";
import { CATEGORY_OF, VERDICTS, dollars, rupees, sharedSpend, usdOf, type Shared, type ViewerSpend } from "../../model";
import css from "../../stack.module.css";
import { UseStack } from "./use";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shared stack" };

const day = (d: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(d));

/** PULSE-HQ (owner, 23 Oct 2026): a stack shared by another organisation (or published to the directory), read only, as it
 *  was when shared. "Use this stack" copies it into your organisation's Stack Intelligence. */
export default async function SharedStack({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await api<{ stack: Shared; viewer?: ViewerSpend }>(`stack/shared/${encodeURIComponent(token)}`);
  if (r.error || !r.data) return <Message text={r.error ?? "This stack is not shared."} />;
  const s = r.data.stack, sp = sharedSpend(s, r.data.viewer);
  return <>
    <Link href="/stack/directory" className={hq.crumb}><ArrowLeft size={15} aria-hidden="true" />Stack directory</Link>
    <header className={css.sharedHead}>
      <div><h1 className={hq.featureTitle}>{s.name}</h1>
        <p className={css.dirFrom}>{s.public ? <Globe size={14} aria-hidden="true" style={{ verticalAlign: -2 }} /> : <Link2 size={14} aria-hidden="true" style={{ verticalAlign: -2 }} />} Shared by {s.orgName}{s.publishedBy ? ` (${s.publishedBy})` : ""} on {day(s.publishedAt)}{s.uses ? ` · used by ${s.uses}` : ""}</p></div>
      {s.mine ? <Link className={hq.secondary} href="/stack">Yours: open Stack Intelligence</Link> : <UseStack token={s.token} name={s.name} />}
    </header>
    {s.blurb ? <p className={hq.lede}>{s.blurb}</p> : null}
    <p className={css.spendHead} data-testid="new-spend"><span>New spend for {sp.org}</span><b>{rupees(sp.inr)}<small>/month</small></b>
      <small>{s.body.length} {s.body.length === 1 ? "tool" : "tools"}{sp.covered ? ` · ${sp.covered} already paid by ${sp.org} (${rupees(sp.coveredInr)}, not counted)` : ""}{sp.unknown ? ` · ${sp.unknown} without a price` : ""}</small></p>
    <div className={css.itemsWrap}><table className={css.sharedTable}>
      <thead><tr><th scope="col">Tool</th><th scope="col">Plan</th><th scope="col" className={css.num}>₹ / month</th><th scope="col" className={css.num}>$ / month</th><th scope="col">Verdict</th><th scope="col">Free tier</th><th scope="col">Note</th></tr></thead>
      <tbody>{sp.rows.map(({ t, price: inr, covered, paidElsewhere }) => { const usd = usdOf(t.inr, t.usd) ?? usdOf(t.costInr, t.costUsd); const v = VERDICTS.find((x) => x.key === t.verdict);
        return <tr key={t.name}><th scope="row">{t.name}<small>{CATEGORY_OF[t.category]?.label}{t.useCase ? ` · ${t.useCase}` : ""}</small>
            {covered ? <small className={css.paidOurs}>Already paid by {sp.org}</small> : paidElsewhere ? <small className={css.paidBy}>Paid by {s.orgName}, not by {sp.org}</small> : null}</th>
          <td>{t.plan || "—"}</td><td className={css.num}>{covered ? <><span className={hq.faint}>{rupees(inr)}</span><small className={css.newZero}>₹0 new</small></> : rupees(inr)}</td><td className={css.num}>{dollars(usd)}</td>
          <td>{v ? <span className={css.pill} style={{ "--tone": v.tone } as CSSProperties}>{v.label}</span> : null}</td><td>{t.freeTier || "—"}</td><td>{t.note || t.bestFor || "—"}</td></tr>; })}</tbody>
    </table></div>
  </>;
}
