"use client";
// PERSONAL-WORKSPACE (owner's design target, 7 Nov 2026: "Portfolio + detail"): every project beside the one open, split
// into Client work and Personal (or the organisation's own, Internal), each with a ring of its tasks done. A personal
// project carries a lock: only you see it. The list scrolls inside its own pane; a search narrows it.
import Link from "next/link";
import { useMemo, useState } from "react";
import { Briefcase, Layers, Lock, Search } from "lucide-react";
import pp from "./project-page.module.css";

export type PortfolioRow = { id: string; name: string; kind: string; projectType?: string | null; clientName: string | null; total: number; finished: number; status: string };

function Ring({ pct }: { pct: number }) {
  return <span className={pp.miniRing} style={{ ["--pct" as string]: `${pct}` }} aria-hidden="true"><b>{pct}%</b></span>;
}

export function Portfolio({ rows, current, personalOrg }: { rows: PortfolioRow[]; current: string; personalOrg: boolean }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = rows.filter((r) => !needle || `${r.name} ${r.clientName ?? ""}`.toLowerCase().includes(needle));
    const typeOf = (r: PortfolioRow) => r.projectType ?? (r.kind === "fulfilment" ? "client_delivery" : "internal");
    return [
      { key: "client_delivery", label: "Client work", Icon: Briefcase, list: personalOrg ? [] : shown.filter((r) => typeOf(r) === "client_delivery") },
      { key: "internal", label: "Internal", Icon: Layers, list: personalOrg ? [] : shown.filter((r) => typeOf(r) === "internal") },
      { key: "personal", label: "Personal", Icon: Lock, list: shown.filter((r) => personalOrg || typeOf(r) === "personal") },
    ].filter((g) => g.list.length);
  }, [rows, q, personalOrg]);
  return <nav className={pp.portfolio} aria-label="Projects">
    <label className={pp.portSearch}><Search size={14} aria-hidden="true" /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects" aria-label="Search projects" /></label>
    <div className={pp.portList}>
      {groups.map((g) => <section key={g.key} aria-label={g.label}>
        <h3 className={pp.portHead}><g.Icon size={14} aria-hidden="true" />{g.label}<small>{g.list.length}</small></h3>
        <ul>{g.list.map((r) => { const pct = r.total ? Math.round((100 * r.finished) / r.total) : 0;
          return <li key={r.id}><Link href={`/tasks/projects/${r.id}`} className={pp.portItem} aria-current={r.id === current ? "page" : undefined}>
            <Ring pct={pct} /><span className={pp.portName}><b>{r.name}</b><small>{r.clientName ?? (g.key === "personal" ? "Only you" : `${r.finished} of ${r.total} done`)}</small></span>
            {g.key === "personal" && !personalOrg ? <Lock size={13} aria-label="Only you" /> : null}
          </Link></li>; })}</ul>
      </section>)}
      {!groups.length ? <p className={pp.portEmpty}>No project matches “{q}”.</p> : null}
    </div>
  </nav>;
}
