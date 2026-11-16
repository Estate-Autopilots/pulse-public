import Link from "next/link";
import { FileClock } from "lucide-react";
import { DOC_LABELS } from "@pulse/invoice-doc";
import { api } from "./lib/api";
import { keptAgo, resumeList } from "./lib/form-draft.mjs";
import { Panel } from "./ui";
import css from "./resume-drafts.module.css";

/** KAZUK-GAPS (A12; meeting backlog: "an unfinished quotation autosaves, appears at the top of the user's home and reopens
 *  where they left off"). The viewer's unfinished forms and Billing drafts, newest first, from any device. Nothing shows
 *  when there is nothing to resume. Data: GET /api/v0/drafts. */
type Drafts = { items: { key: string; title: string; href: string; updatedAt: string }[]; billing: { id: string; docType: string; number: string | null; buyer: string | null; total: number; updatedAt: string }[] };

export async function ResumeDrafts() {
  const r = await api<Drafts>("drafts");
  if (!r.data) return null;
  const labels = Object.fromEntries(Object.entries(DOC_LABELS).map(([k, v]) => [k, (v as { noun: string }).noun]));
  const rows = resumeList(r.data.items, r.data.billing, labels);
  if (!rows.length) return null;
  return <Panel title="Resume where you left off" sub="Kept as you typed, on any device">
    <ul className={css.list} aria-label="Unfinished work">{rows.map((x) => <li key={x.key}><Link href={x.href} className={css.row}>
      <FileClock size={16} aria-hidden="true" /><span className={css.main}><b>{x.title}</b><small>{x.what} · {keptAgo(x.at)}</small></span><span className={css.go}>Resume</span>
    </Link></li>)}</ul>
  </Panel>;
}
