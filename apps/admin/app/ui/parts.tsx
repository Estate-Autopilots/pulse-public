import { ScrollText } from "lucide-react";
import Link from "next/link";

import { compact, when } from "../lib/format";
import { ACTION_LABELS, type AuditRow } from "../lib/types";
import css from "./console.module.css";
import { Badge, Empty, Table } from "./kit";

// PULSE-ADMIN: pieces the console's sections share.
export function StatusBadge({ status, activation, rehearsal }: { status: string; activation?: string; rehearsal?: boolean }) {
  const main = status === "active" ? (activation === "trial" ? <Badge tone="accent">Trial</Badge> : <Badge tone="good">Active</Badge>)
    : status === "suspended" ? <Badge tone="bad">Suspended</Badge> : status === "setup" ? <Badge tone="warn">Being set up</Badge> : <Badge>{status}</Badge>;
  return <span className={css.badges}>{main}{rehearsal ? <Badge>Rehearsal</Badge> : null}</span>;
}

export function LimitMeter({ used, limit }: { used: number; limit: number | null }) {
  if (!limit) return <span>{compact(used)}</span>;
  const share = Math.min(1, used / limit);
  return <span className={css.meter} data-over={used >= limit ? "" : undefined} data-near={used >= limit * 0.8 && used < limit ? "" : undefined} title={`${used.toLocaleString("en-IN")} of ${limit.toLocaleString("en-IN")}`}>
    <span>{compact(used)} <small>of {compact(limit)}</small></span><span className={css.track}><i style={{ width: `${Math.round(share * 100)}%` }} /></span></span>;
}

export function AuditTable({ rows, showOrg = true }: { rows: AuditRow[]; showOrg?: boolean }) {
  if (!rows.length) return <Empty icon={ScrollText} title="Nothing recorded yet" />;
  return <Table label="Platform audit log">
    <thead><tr><th>When</th><th>Who</th><th>What</th>{showOrg ? <th>Organisation</th> : null}<th>About</th><th>Why</th></tr></thead>
    <tbody>{rows.map((a, i) => <tr key={a.id ?? `${a.at}:${i}`}>
      <td className={css.nowrap}>{when(a.at)}</td><td>{a.actor}</td>
      <td>{ACTION_LABELS[a.action] ?? a.action}</td>
      {showOrg ? <td>{a.orgId ? <Link href={`/organisations/${a.orgId}`}>{a.org ?? "Organisation"}</Link> : <span className={css.muted}>Platform</span>}</td> : null}
      <td>{a.label ?? "—"}</td><td>{a.reason ?? <span className={css.muted}>—</span>}</td>
    </tr>)}</tbody>
  </Table>;
}
