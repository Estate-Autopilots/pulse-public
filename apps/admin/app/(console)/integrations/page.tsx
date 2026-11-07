import { Plug } from "lucide-react";
import Link from "next/link";

import { read } from "@/app/lib/api";
import { ago, compact, day } from "@/app/lib/format";
import type { Integrations } from "@/app/lib/types";
import { Badge, Empty, Kpi, Page, PageHeader, Panel, Table, Tiles, Unavailable } from "@/app/ui/kit";
import css from "@/app/ui/console.module.css";

// PULSE-ADMIN: integrations: apps that sign in with Pulse (OIDC clients, never their secrets), and each organisation's
// AI connections and company connectors. Changes stay where they are made (Pulse → Developers, each org's Settings).
export default async function IntegrationsPage() {
  const r = await read<Integrations>("platform/integrations");
  if (r.error || !r.data) return <Page><PageHeader title="Integrations" /><Unavailable title="Integrations" reason={r.error ?? "No answer"} /></Page>;
  const { apps, orgs } = r.data;
  return (
    <Page wide>
      <PageHeader title="Integrations" context={["Sign in with Pulse apps", "AI connections and connectors per organisation"]} />
      <Tiles>
        <Kpi label="Apps" value={apps.length} note={`${apps.filter((a) => a.status === "active").length} active · ${apps.filter((a) => a.verified).length} verified`} />
        <Kpi label="AI connections" value={orgs.reduce((n, o) => n + o.ai.length, 0)} note={`${orgs.filter((o) => o.ai.length).length} organisations`} />
        <Kpi label="Connectors" value={orgs.reduce((n, o) => n + o.connectors.length, 0)} />
      </Tiles>
      <Panel title="Apps that sign in with Pulse" sub="OIDC clients">
        {!apps.length ? <Empty icon={Plug} title="No apps registered" /> :
          <Table label="Apps that sign in with Pulse">
            <thead><tr><th>App</th><th>Status</th><th>Scopes</th><th>Registered by</th><th>Last used</th></tr></thead>
            <tbody>{apps.map((a) => <tr key={a.id}>
              <td><b>{a.name}</b><span className={css.sub}>{[a.maker, a.homeUrl, <code key="c" className={css.code}>{a.clientId}</code>].filter(Boolean).map((x, i) => <span key={i}>{i ? " · " : ""}{x}</span>)}</span></td>
              <td><span className={css.badges}><Badge tone={a.status === "active" ? "good" : "warn"}>{a.status}</Badge>{a.verified ? <Badge tone="accent">Verified</Badge> : null}{a.development ? <Badge>Development</Badge> : null}</span></td>
              <td>{(a.scopes ?? []).length} scopes<span className={css.sub}>{(a.scopes ?? []).slice(0, 4).join(", ")}{(a.scopes ?? []).length > 4 ? "…" : ""}</span></td>
              <td>{a.org ?? "—"}<span className={css.sub}>{day(a.createdAt)}</span></td>
              <td>{ago(a.lastUsedAt)}</td>
            </tr>)}</tbody>
          </Table>}
      </Panel>
      <Panel title="By organisation" sub="AI connections and company connectors">
        {!orgs.length ? <p className={css.note}>No organisation has connected anything yet.</p> :
          <Table label="Integrations by organisation">
            <thead><tr><th>Organisation</th><th>AI connections</th><th>Connectors</th></tr></thead>
            <tbody>{orgs.map((o) => <tr key={o.id}>
              <td><Link className={css.name} href={`/organisations/${o.id}`}>{o.name}</Link></td>
              <td>{o.ai.length ? o.ai.map((c, i) => <span key={i} className={css.chip}>{c.name} <small className={css.muted}>{c.provider} · {c.state}{c.cap ? ` · cap ${compact(c.cap)}` : ""}</small></span>) : <span className={css.muted}>None</span>}</td>
              <td>{o.connectors.length ? o.connectors.map((c, i) => <span key={i} className={css.chip}>{c.label} <small className={css.muted}>{c.status}{c.lastBatchAt ? ` · ${ago(c.lastBatchAt)}` : ""}</small></span>) : <span className={css.muted}>None</span>}</td>
            </tr>)}</tbody>
          </Table>}
      </Panel>
    </Page>
  );
}
