import Link from "next/link";

import { read } from "@/app/lib/api";
import { ago, when } from "@/app/lib/format";
import type { BugDetail } from "@/app/lib/types";
import { BugTriage } from "@/app/ui/bug-triage";
import { Badge, Page, PageHeader, Panel, Unavailable } from "@/app/ui/kit";
import css from "@/app/ui/console.module.css";

const STATUS: Record<string, string> = { new: "New", triaged: "Triaged", fixing: "Being fixed", fixed: "Fixed", wontfix: "Won’t fix" };
const EVENT: Record<string, string> = { status: "Status", severity: "Severity", assignee: "Assignee", duplicate: "Duplicate of", task: "Task", note: "Note" };

// PULSE-ADMIN: one bug report from any organisation, and its triage (status, severity, a note). Opening it and every
// change are in the platform audit log; changes are also in the report's own history, which the organisation sees.
export default async function BugPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const r = await read<BugDetail>(`platform/orgs/${encodeURIComponent(org)}/bugs/${encodeURIComponent(id)}`);
  if (r.error || !r.data) return <Page><PageHeader title="Bug report" back={{ href: "/bugs", label: "Bugs" }} /><Unavailable title="This bug report" reason={r.error ?? "No answer"} /></Page>;
  const b = r.data;
  return (
    <Page wide>
      <PageHeader title={`#${b.number} · ${b.org}`} back={{ href: "/bugs", label: "Bugs" }}
        context={[STATUS[b.status] ?? b.status, b.severity ?? "No severity", `reported ${ago(b.createdAt)}`]}
        actions={<span className={css.badges}>{b.blocksWork ? <Badge tone="bad">Blocks their work</Badge> : null}{b.duplicateOf ? <Badge>Duplicate of #{b.duplicateOf}</Badge> : null}</span>} />
      <div className={css.split}>
        <div className={css.stack}>
          <Panel title="What they said">
            <p className={css.note} style={{ color: "var(--sx-ink)", whiteSpace: "pre-wrap" }}>{b.words || "No words"}</p>
            <dl className={css.facts}>
              <dt>Who</dt><dd>{b.reporter ?? "Someone"}{b.signedOut ? " (signed out)" : ""}</dd>
              <dt>Where</dt><dd><code className={css.code}>{b.route ?? "—"}</code></dd>
              <dt>App</dt><dd>{[b.platform, b.appVersion].filter(Boolean).join(" · ") || "—"}</dd>
              <dt>Organisation</dt><dd><Link href={`/organisations/${b.orgId}`}>{b.org}</Link></dd>
              <dt>Assignee</dt><dd>{b.assignee ?? "Nobody yet"}</dd>
              <dt>Attached</dt><dd>{b.files.length ? b.files.map((f) => `${f.kind}${f.seconds ? ` (${f.seconds} s)` : ""}`).join(", ") : "Nothing"}{b.files.length ? <span className={css.sub}>Opened in the organisation’s own Pulse (Bug reports)</span> : null}</dd>
            </dl>
          </Panel>
          {b.errors.length ? <Panel title="Errors on the page"><ul className={css.list}>{b.errors.map((e, i) => <li key={i} className={css.item}><code className={css.code}>{e}</code></li>)}</ul></Panel> : null}
          {b.trail.length ? <Panel title="What they did before"><ol className={css.list}>{b.trail.map((t, i) => <li key={i} className={css.item}>{t}</li>)}</ol></Panel> : null}
        </div>
        <div className={css.stack}>
          <Panel title="Triage" sub="Status, severity, a note: the organisation sees them in the report’s history">
            <BugTriage org={b.orgId} id={b.id} status={b.status} severity={b.severity} />
          </Panel>
          <Panel title="History">
            {!b.events.length ? <p className={css.note}>Nothing yet.</p> :
              <ul className={css.list}>{b.events.map((e, i) => <li key={i} className={css.item}><div><b>{EVENT[e.kind] ?? e.kind}</b>{e.value ? ` · ${STATUS[e.value] ?? e.value}` : ""}{e.note ? <p>{e.note}</p> : null}<small>{e.actor} · {when(e.at)}</small></div></li>)}</ul>}
          </Panel>
        </div>
      </div>
    </Page>
  );
}
