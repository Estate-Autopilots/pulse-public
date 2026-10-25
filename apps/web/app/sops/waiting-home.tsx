// WORKFLOW BUILDER: "My steps" on the home page (FLOW-B renamed it from Waiting for you). The steps that wait for this
// person, processes' steps first (late first), then older workflows' blocks; the first three with their run and due
// time, each opening in My steps. Nothing shows when nothing waits, and the server draws it, so the page does not move.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { dayTime } from "../lib/format";
import type { MyStep } from "../processes/flow-types";
import type { WaitingItem } from "./board-types";
import css from "./blocks.module.css";

type Row = { key: string; href: string; over: string; title: string; under: string; late: boolean };

export function WaitingHome({ items, steps = [] }: { items: WaitingItem[]; steps?: MyStep[] }) {
  const rows: Row[] = [
    ...[...steps].sort((a, z) => Number(z.due.late) - Number(a.due.late)).map((s) => ({ key: s.id, href: `/me/steps?step=${encodeURIComponent(s.id)}`, over: s.process, title: s.title,
      under: [s.run, s.due.text].filter(Boolean).join(" · "), late: s.due.late })),
    ...items.map((i) => ({ key: i.id, href: `/me/steps#step-${i.id}`, over: `${i.block} · ${i.workflow}`, title: i.title, under: `${i.run}${i.dueAt ? ` · due ${dayTime(i.dueAt)}` : ""}${i.late ? " · late" : ""}`, late: i.late })),
  ];
  if (!rows.length) return null;
  const late = rows.filter((r) => r.late).length;
  return <section className={`${css.vars} ${css.homeWait}`} aria-label="My steps in processes">
    <header><b>My steps</b><small>{rows.length} {rows.length === 1 ? "step" : "steps"}{late ? ` · ${late} late` : ""}</small>
      <Link href="/me/steps">{rows.length > 3 ? `All ${rows.length}` : "Open"}<ArrowRight size={14} aria-hidden="true" /></Link></header>
    <ul>{rows.slice(0, 3).map((r) => <li key={r.key} data-late={r.late ? "" : undefined}><Link href={r.href}><small>{r.over}</small><b>{r.title}</b><small>{r.under}</small></Link></li>)}</ul>
  </section>;
}
