import Link from "next/link";
import { FileText } from "lucide-react";
import { api } from "../../lib/api";
import { Message, Page, PageHeader, QueryTabs } from "../../ui";
import { EmptyState } from "../../kit/game";
import css from "../contracts.module.css";
import x from "./insights.module.css";

export const dynamic = "force-dynamic";

type Clause = { name: string; asks: number; agreementsAsked: number; changed: number; lastAt: string | null; words: string[] };
type Template = { id: string | null; name: string; agreements: number; asked: number; clauses: Clause[] };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const times = (n: number) => `${n} time${n === 1 ? "" : "s"}`;

/** CONTRACTS-3 (the 7 Nov meeting: "track which clauses clients ask to change, so the business learns which clauses get
 *  pushback"): per template, the clauses clients asked to change (from their change requests) and the ones changed in a
 *  new draft (from the drafts compared), most first, so the owner improves the template. Read-only; admins, leadership and
 *  Finance. The chosen concept: template tabs with counts and ranked clauses with a bar each. */
export default async function InsightsPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  const r = await api<{ templates: Template[]; agreements: number }>("contracts/insights");
  if (!r.data) return <Message text={r.error ?? "This is for admins, leadership and Finance."} />;
  const list = r.data.templates;
  const cur = list.find((x) => (x.id ?? "none") === t) ?? list[0];
  return <Page><div className={css.wrap}>
    <PageHeader title="What clients change" back={{ href: "/contracts", label: "Agreements" }}
      context={[r.data.agreements ? `From ${r.data.agreements} agreement${r.data.agreements === 1 ? "" : "s"}. Fix the top ones in your template.` : "Learn from every agreement you send"]}
      />
    {!cur ? <EmptyState art="nothing" title="Nothing to learn from yet" text="Once clients read your agreements and ask for changes, the clauses they ask about most show here." action={{ href: "/contracts/new", label: "New agreement" }} />
      : <>
        {list.length > 1 ? <QueryTabs base="/contracts/insights" param="t" current={cur.id ?? "none"} label="Templates"
          items={list.map((x) => ({ key: x.id ?? "none", label: x.name, count: x.agreements }))} /> : null}
        {/* The kit's tiles are client components: a server page passes them no icons (functions cannot cross). */}
        <p className={x.figures}><span><strong>{`${cur.asked} of ${cur.agreements}`}</strong> clients asked for a change.</span> <span>They asked <strong>{times(cur.clauses.reduce((n, k) => n + k.asks, 0))}</strong> about <strong>{cur.clauses.filter((k) => k.asks).length}</strong> parts.</span></p>
        <div className={x.next}><p>{cur.clauses.some((c) => c.agreementsAsked) ? <>Next step: rewrite <strong>{cur.clauses[0].name}</strong> in the template so clients agree to it the first time.</> : "Keep your template clear; clients will tell you where it is not."}</p>
          <Link href="/contracts/templates" className={`${css.btn} ${css.primary} ${x.solid}`}><FileText size={16} aria-hidden="true" />Open the template</Link></div>
        <section className={x.box} aria-label="Most asked changes">
          <div><h2 className={x.title}>Most asked changes</h2><p className={x.sub}>{cur.name}</p></div>
          {cur.clauses.length ? <ol className={x.rank}>{cur.clauses.map((c, i) => {
            const pct = cur.agreements ? Math.round((c.agreementsAsked / cur.agreements) * 100) : 0;
            return <li key={c.name}>
              <span className={x.no} aria-hidden="true">{i + 1}</span>
              <div className={x.what}>
                <strong>{c.name}{i === 0 && c.agreementsAsked > 0 ? <span className={x.top}>Most asked</span> : null}</strong>
                <span>{c.changed ? `You've edited it ${c.changed === 1 ? "once" : c.changed === 2 ? "twice" : `${c.changed} times`}` : "You haven't edited it yet"}{c.lastAt ? <><span className={x.sep} aria-hidden="true"> · </span><span className={`${x.nowrap} ${x.lineOnPhone}`}>{`last asked ${day(c.lastAt)}`}</span></> : null}</span>
                {c.words.length ? <blockquote>{`"${c.words[0]}"`}</blockquote> : null}
              </div>
              <div className={x.meter}>
                <span className={x.barLine}><span className={x.bar} role="img" aria-label={`${pct}% of agreements asked to change it`}><span style={{ width: `${pct}%` }} /></span>
                  <span>{c.agreementsAsked ? `asked in ${c.agreementsAsked} of ${cur.agreements}` : "not asked yet"}</span></span>
              </div>
            </li>;
          })}</ol> : <p className={css.empty}>Clients have not asked to change anything in this template yet.</p>}
        </section>
        <div className={x.tabBarRoom} aria-hidden="true" />
      </>}
  </div></Page>;
}
