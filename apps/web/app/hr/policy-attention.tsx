"use client";
// HR desk → Policies: the setup that is still open, as one checklist with counts. Each line links to the exact place it
// is settled; finished items drop off.

import Link from "next/link";
import { useEffect, useRef } from "react";
import { CalendarDays, ChevronRight, CircleCheck, FileText, History, MapPin, Scale, ShieldCheck, UsersRound, type LucideIcon } from "lucide-react";
import type { AttentionTask } from "./attention";
import css from "./policy-attention.module.css";

const ICON: Record<AttentionTask["key"], LucideIcon> = { draft: FileText, rules: ShieldCheck, holidays: CalendarDays, balances: Scale, pods: UsersRound, office: MapPin, history: History };

export function NeedsAttention({ tasks }: { tasks: AttentionTask[] }) {
  const box = useRef<HTMLDetailsElement>(null);
  // Folded on phones and short windows, where the open list would push the policies out of view.
  useEffect(() => { if (box.current && window.matchMedia("(max-width: 1179.98px), (max-height: 819.98px)").matches) box.current.open = false; }, []);
  if (!tasks.length) return <p className={css.clear}><CircleCheck size={16} aria-hidden="true" />Policy setup is complete: nothing needs your attention.</p>;
  return <details ref={box} className={css.card} open>
    <summary><span className={css.title}>Needs your attention</span><span className={css.total}>{tasks.length}</span><ChevronRight size={14} className={css.chevron} aria-hidden="true" /></summary>
    <ul className={css.tasks}>{tasks.map(({ key, id, title, detail, href, count }) => { const Icon = ICON[key]; return <li key={id}>
      <Link href={href} className={css.task} title={detail}>
        <Icon size={16} aria-hidden="true" />
        <span className={css.text}><b>{title}</b><small>{detail}</small></span>
        {count !== undefined ? <span className={css.count}>{count.toLocaleString("en-IN")}</span> : null}
      </Link>
    </li>; })}</ul>
  </details>;
}
