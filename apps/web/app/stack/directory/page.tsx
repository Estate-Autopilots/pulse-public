import Link from "next/link";
import type { CSSProperties } from "react";
import { ArrowLeft, Boxes, Globe } from "lucide-react";
import { Message } from "../../ui";
import { api } from "../../lib/api";
import hq from "../../hq/hq.module.css";
import { CATEGORY_OF, rupees, sharedSpend, type Shared, type ViewerSpend } from "../model";
import css from "../stack.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pulse stack directory" };

const day = (d: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(d));

/** PULSE-HQ (owner, 23 Oct 2026): the Pulse stack directory: every stack an organisation published, for anyone signed in
 *  to Pulse, read only; open one to see its tools and use it in your own organisation. */
export default async function StackDirectory() {
  const r = await api<{ stacks: Shared[]; viewer?: ViewerSpend }>("stack/directory");
  if (r.error || !r.data) return <Message text={r.error ?? "The stack directory is unavailable."} />;
  const { stacks, viewer } = r.data;
  return <>
    <Link href="/stack" className={hq.crumb}><ArrowLeft size={15} aria-hidden="true" />Stack Intelligence</Link>
    <header className={hq.pageHead}><div><h1>Pulse stack directory</h1><p>Stacks of tools that organisations on Pulse chose and published, with what each costs a month. Open one to use it in your organisation.</p></div></header>
    {stacks.length ? <ul className={css.dirGrid}>{stacks.map((s) => {
      const cats = [...new Set(s.body.map((t) => t.category))], sp = sharedSpend(s, viewer);
      return <li key={s.token}><Link href={`/stack/s/${s.token}`} className={css.dirCard}>
        <span className={css.stackTop}><Boxes size={18} aria-hidden="true" /><b>{s.name}</b>{s.mine ? <span className={css.badge}>Yours</span> : null}</span>
        <span className={css.dirFrom}>{s.orgName}{s.publishedBy ? ` · ${s.publishedBy}` : ""} · {day(s.publishedAt)}</span>
        {s.blurb ? <span className={css.stackBlurb}>{s.blurb}</span> : null}
        <span className={css.stackCost}>{rupees(sp.inr)}<small>/month</small></span>
        <span className={css.costNote}>New spend for {sp.org} · {s.body.length} {s.body.length === 1 ? "tool" : "tools"}{sp.covered ? ` · ${sp.covered} already paid` : ""}</span>
        <span className={css.stackCats}>{cats.slice(0, 6).map((k) => <i key={k} style={{ "--hue": CATEGORY_OF[k]?.hue ?? 0 } as CSSProperties}>{CATEGORY_OF[k]?.label}</i>)}</span>
        {s.uses ? <span className={hq.faint}>Used by {s.uses} {s.uses === 1 ? "organisation" : "organisations"}</span> : null}
      </Link></li>; })}</ul>
      : <p className={css.empty}><Globe size={22} aria-hidden="true" />No stack is published yet. Open a stack in Stack Intelligence and list it in the directory.</p>}
  </>;
}
