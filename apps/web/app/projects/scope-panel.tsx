import Link from "next/link";
import { Package } from "lucide-react";
import { api } from "../lib/api";
import css from "./overview.module.css";

/** KAZUK (Kazuk's project screen): sold against delivered, from the accepted quotations of the project (Billing), and the
 *  work outside the quote with a way to raise an add-on quotation. Shown only when the project has a sold quotation. */
type Scope = { quotes: { id: string; number: string | null; status: string }[]; lines: { id: string; description: string; qty: number | null; unit: string | null; quote: string | null; tasks: number; done: number; doing: number }[]; outside: number };

export async function ScopePanel({ projectId, className, headClassName }: { projectId: string; className: string; headClassName: string }) {
  const s = (await api<Scope>(`projects/${encodeURIComponent(projectId)}/scope`)).data;
  if (!s?.lines.length) return null;
  return <section className={className} aria-label="Sold against delivered" data-fixed="">
    <div className={headClassName}><h3><Package size={14} aria-hidden="true" /> Sold vs delivered</h3><small>{s.quotes.map((q) => q.number).filter(Boolean).join(", ")}</small></div>
    <ul className={css.scope}>{s.lines.map((l) => <li key={l.id}>
      <span>{l.description}</span>
      <b>{l.done} of {l.tasks || Math.max(1, Math.round(l.qty ?? 1))}{l.doing ? <small> · {l.doing} in progress</small> : null}</b>
    </li>)}</ul>
    {s.outside ? <div className={css.outside}><b>Outside the quote</b><span>{s.outside} open {s.outside === 1 ? "task was" : "tasks were"} not on the signed quotation.</span>
      <Link href={`/erp/new?project=${projectId}&type=quotation`}>Raise an add-on quote</Link></div> : null}
  </section>;
}
