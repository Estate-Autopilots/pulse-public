import { Bug as BugIcon } from "lucide-react";
import Link from "next/link";

import { read } from "@/app/lib/api";
import { adminConfig } from "@/app/lib/config";
import { ago } from "@/app/lib/format";
import type { Bug } from "@/app/lib/types";
import { Badge, Empty, Kpi, Page, PageHeader, Panel, QueryTabs, Table, Tiles, Unavailable, kitStyles } from "@/app/ui/kit";
import css from "@/app/ui/console.module.css";

const STATUS: Record<string, string> = { new: "New", triaged: "Triaged", fixing: "Being fixed", fixed: "Fixed", wontfix: "Won’t fix" };
const TONE = { new: "warn", triaged: "info", fixing: "accent", fixed: "good", wontfix: "neutral" } as const;

// PULSE-ADMIN: bug reports from every organisation (BUG-REPORT's reporter: Ctrl+B, a shake, the account menu). Each
// organisation triages its own in Pulse (/bug-reports); platform admins triage any of them here (/bugs/<org>/<id>).
export default async function Bugs({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const status = Object.keys(STATUS).includes(q.status ?? "") ? q.status! : "";
  const text = (q.q ?? "").trim().slice(0, 80);
  const config = adminConfig();
  const params = new URLSearchParams({ ...(status ? { status } : {}), ...(text ? { q: text } : {}) });
  const r = await read<{ bugs: Bug[]; counts: Record<string, number> }>(`platform/bugs${params.size ? `?${params}` : ""}`);
  const counts = r.data?.counts ?? {};
  const rows = r.data?.bugs ?? [];
  return (
    <Page wide>
      <PageHeader title="Bugs" context={["Every organisation", "Reported from inside Pulse"]}
        actions={config.appUrl ? <a className={kitStyles.button} href={`${config.appUrl}/bug-reports`}>Triage in {config.product}</a> : null} />
      <Tiles>
        <Kpi label="New" value={counts.new ?? 0} tone={(counts.new ?? 0) > 0 ? "warn" : "good"} href="/bugs?status=new" />
        <Kpi label="Triaged" value={counts.triaged ?? 0} href="/bugs?status=triaged" />
        <Kpi label="Being fixed" value={counts.fixing ?? 0} href="/bugs?status=fixing" />
        <Kpi label="Fixed" value={counts.fixed ?? 0} href="/bugs?status=fixed" />
      </Tiles>
      <QueryTabs base="/bugs" param="status" current={status || "all"} keep={text ? `q=${encodeURIComponent(text)}` : undefined}
        items={[{ key: "all", label: "All" }, ...Object.entries(STATUS).map(([key, label]) => ({ key, label, count: counts[key] ?? 0 }))]} />
      <Panel title="Reports" sub={`${rows.length} shown`}>
        <form className={css.search} action="/bugs" method="get" role="search">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <input name="q" defaultValue={text} maxLength={80} placeholder="Words or page" aria-label="Search bug reports" />
          <button className={kitStyles.button}>Search</button>
        </form>
        {r.error ? <Unavailable title="Bug reports" reason={r.error} /> : !rows.length ? <Empty icon={BugIcon} title="No reports here" /> :
          <Table label="Bug reports">
            <thead><tr><th>Report</th><th>Organisation</th><th>Status</th><th>Where</th><th>Reported</th></tr></thead>
            <tbody>{rows.map((b) => <tr key={b.id}>
              <td><Link className={css.name} href={`/bugs/${b.orgId}/${b.id}`}>#{b.number}</Link> {b.words?.slice(0, 160) || <span className={css.muted}>No words</span>}<span className={css.sub}>{b.reporter ?? "Someone"}{b.blocksWork ? " · blocks their work" : ""}{b.duplicate ? " · duplicate" : ""}</span></td>
              <td><Link href={`/organisations/${b.orgId}`}>{b.org}</Link></td>
              <td><span className={css.badges}><Badge tone={TONE[b.status as keyof typeof TONE] ?? "neutral"}>{STATUS[b.status] ?? b.status}</Badge>{b.severity ? <Badge tone={b.severity === "blocker" || b.severity === "high" ? "bad" : "neutral"}>{b.severity}</Badge> : null}</span></td>
              <td><code className={css.code}>{b.route ?? "—"}</code><span className={css.sub}>{[b.platform, b.appVersion].filter(Boolean).join(" · ")}</span></td>
              <td className={css.nowrap}>{ago(b.createdAt)}</td>
            </tr>)}</tbody>
          </Table>}
      </Panel>
    </Page>
  );
}
