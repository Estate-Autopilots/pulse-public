import Link from "next/link";
import { Building2 } from "lucide-react";
import { api, type Me } from "../lib/api";
import { Badge, Empty, Message, Page, PageHeader, Panel } from "../ui";
import { NewCompany } from "./new-company";
import css from "./companies.module.css";
import type { CompanyRow } from "./types";

// UX-TENANT (ADR-0032): every company on this Pulse. Only an admin of the install's own company (the platform
// operator) sees this; other companies' rows are counts only. R53: an open company is in trial until it is activated.
export default async function Companies() {
  const me = await api<Me>("me");
  if (me.error || !me.data) return <Message text={me.error ?? "Sign in to Pulse"} />;
  if (!me.data.operator) return <Message text="Companies are set up by an admin of this install's own company." />;
  const r = await api<{ companies: CompanyRow[] }>("tenants");
  const rows = r.data?.companies ?? [];
  const status = (c: CompanyRow) => c.status === "draft" ? <Badge>Draft</Badge> : c.status === "setup" ? <Badge tone="warning">Being set up</Badge> : c.status === "active" ? c.activation === "trial" ? <Badge tone="accent">Trial</Badge> : <Badge tone="success">Open</Badge> : <Badge tone="danger">{c.status}</Badge>;
  return <Page fit>
    <PageHeader title="Companies" context={["On this Pulse", `${rows.length} ${rows.length === 1 ? "company" : "companies"}`]} back={{ href: "/settings?tab=organisation", label: "Settings" }} />
    <div className={css.list} data-grow="">
      <Panel title="Set up a company" sub="Its own address, brand, people and switches">
        <NewCompany />
        <p className={css.note}>Each company is separate: its people sign in at its own address and never see another company&apos;s data. Nothing is sent until you press Send on its admin&apos;s invitation.</p>
      </Panel>
      <Panel title="Companies on this Pulse">
        {r.error ? <p className={css.error} style={{ paddingTop: 12 }}>{r.error}</p> : !rows.length ? <Empty icon={Building2} compact title="No companies yet" /> :
          <div className={css.tableWrap}><table className={css.table}><thead><tr><th>Company</th><th>Status</th><th>Address</th><th>People</th><th>Signed in</th><th>Modules</th></tr></thead>
            <tbody>{rows.map((c) => <tr key={c.setupId ?? "own"}>
              <td>{c.setupId ? <Link href={`/companies/${c.setupId}`}><b>{c.name}</b></Link> : <b>{c.name}</b>}<small>{c.own ? "This install's own company" : c.code ? `Code ${c.code}` : "Not created yet"}{c.rehearsal ? " · rehearsal" : ""}</small></td>
              <td>{status(c)}</td><td>{c.host ?? (c.own ? <small>Its usual addresses</small> : "—")}</td><td>{c.people ?? "—"}</td><td>{c.own ? "—" : c.signedIn ?? "—"}</td>
              <td>{c.modules ? Object.entries(c.modules).filter(([, on]) => on).map(([k]) => k).join(", ") || "None" : c.own ? <small>All it uses</small> : "—"}</td></tr>)}</tbody></table></div>}
      </Panel>
    </div>
  </Page>;
}
