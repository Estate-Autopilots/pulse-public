import Link from "next/link";
import { Fragment } from "react";
import { Users } from "lucide-react";

import { read } from "@/app/lib/api";
import { ago, compact, day, isFuture, when } from "@/app/lib/format";
import { PLAN_LABELS, words, type OrgDetail, type PersonDetail } from "@/app/lib/types";
import { FlagPanel, OrgStatus, PersonHelp, PlanForm, ViewAs } from "@/app/ui/actions";
import { Badge, Empty, Kpi, Page, PageHeader, Panel, Table, Tiles, Unavailable } from "@/app/ui/kit";
import { AuditTable, LimitMeter, StatusBadge } from "@/app/ui/parts";
import css from "@/app/ui/console.module.css";

export const metadata = { title: "Organisation · Admin console" };

// PULSE-ADMIN (1126): one organisation, for Pulse's platform admins: status, plan and limits, switches, members and
// sign-in help, usage, and what was done here. Opening it is written to the platform audit log and to the
// organisation's own Audit; a person opened with ?person= is too.
export default async function AdminOrg({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ id }, q] = await Promise.all([params, searchParams]);
  const r = await read<OrgDetail>(`platform/orgs/${encodeURIComponent(id)}`);
  if (r.error || !r.data) return <Page><PageHeader title="Organisation" back={{ href: "/organisations", label: "Organisations" }} /><Unavailable title="This organisation" reason={r.error ?? "No answer"} /></Page>;
  const o = r.data;
  const person = q.person ? await read<PersonDetail>(`platform/orgs/${encodeURIComponent(id)}/people/${encodeURIComponent(q.person)}`) : null;
  const staff = o.members.filter((m) => m.side === "staff"), clients = o.members.length - staff.length;
  return <Page wide>
    <PageHeader title={o.name} back={{ href: "/organisations", label: "Organisations" }}
      context={[o.code, o.handle ? `@${o.handle}` : null, o.domains.find((d) => d.primary)?.host ?? null, `since ${day(o.createdAt)}`].filter((x): x is string => !!x)}
      actions={<StatusBadge status={o.status} activation={o.activation} rehearsal={o.rehearsal} />} />
    <div className={css.stack}>
      <Tiles>
        <Kpi label="Seats" value={o.plan.seatLimit ? <LimitMeter used={o.limits?.seats ?? o.counts.people} limit={o.plan.seatLimit} /> : o.limits?.seats ?? o.counts.people} note={`${o.counts.clients} client seats · ${o.counts.canSignIn} with a password`} />
        <Kpi label="Signed in this week" value={o.counts.sessions7d} />
        <Kpi label="Plan" value={PLAN_LABELS[o.plan.plan] ?? o.plan.plan} tone={o.limits?.override ? "info" : undefined} note={o.limits?.override ? "Limits lifted by Pulse" : o.plan.set ? (o.plan.trialEnds ? `Trial ends ${day(o.plan.trialEnds)}` : `Set ${ago(o.plan.updatedAt)}`) : "Not set yet"} />
        <Kpi label="AI tokens this month" value={<LimitMeter used={o.ai.thisMonth} limit={o.plan.aiTokensMonth} />} note={`${compact(o.ai.last30)} in 30 days`} />
        <Kpi label="Work" value={compact(o.counts.projects)} unit=" projects" note={`${compact(o.counts.tasks)} tasks · ${compact(o.counts.chats)} chats`} />
      </Tiles>
      {person ? <Panel title={person.data ? person.data.name : "Person"} sub={person.data ? `${person.data.side === "staff" ? "Team" : words(person.data.side)} · ${person.data.roles.map(words).join(", ") || "Member"}` : undefined}
        action={{ href: `/organisations/${o.id}`, label: "Close" }}>
        {person.error || !person.data ? <Unavailable title="This person" reason={person.error ?? "No answer"} /> : <div className={css.split}>
          <div>
            <dl className={css.facts}>
              <dt>E-mail</dt><dd>{person.data.email ?? "—"}</dd>
              <dt>Username</dt><dd>{person.data.username ? `@${person.data.username}` : "—"}</dd>
              <dt>Sign-in</dt><dd>{person.data.signIn ? <>{person.data.signIn.status === "disabled" ? <Badge tone="bad">Disabled</Badge> : isFuture(person.data.signIn.lockedUntil) ? <Badge tone="warn">Locked</Badge> : <Badge tone="good">Active</Badge>} last {ago(person.data.signIn.lastLogin)}{person.data.signIn.failed ? ` · ${person.data.signIn.failed} failed tries` : ""}</> : "No Pulse password here"}</dd>
              <dt>Sessions</dt><dd>{person.data.sessions.length ? person.data.sessions.map((s) => `${s.device ?? "Browser"} (${ago(s.lastActive)})`).join(", ") : "None"}</dd>
              <dt>Other organisations</dt><dd>{person.data.account?.orgs.filter((x) => x.orgId !== o.id).map((x) => x.org).join(", ") || "None"}</dd>
            </dl>
            <ViewAs org={o.id} person={person.data.id} name={person.data.name} />
          </div>
          <PersonHelp org={o.id} person={person.data.id} disabled={person.data.signIn?.status === "disabled"} />
        </div>}
      </Panel> : null}
      <div className={css.split}>
        <Panel title="Members" sub={`${staff.length} on the team${clients ? ` · ${clients} client seats` : ""}`}>
          {!o.members.length ? <Empty icon={Users} title="Nobody here yet" /> :
            <Table label="Members">
              <thead><tr><th>Person</th><th>Roles</th><th>Sign-in</th><th>Last active</th></tr></thead>
              <tbody>{[...o.members].sort((a, b) => Number(a.side !== "staff") - Number(b.side !== "staff")).map((m) => <tr key={m.id} data-current={q.person === m.id ? "" : undefined}>
                <td><Link className={css.name} href={`/organisations/${o.id}?person=${m.id}`}>{m.name}</Link><span className={css.sub}>{[m.email, m.username ? `@${m.username}` : null, m.side !== "staff" ? words(m.side) : null].filter(Boolean).join(" · ") || "—"}</span></td>
                <td>{m.roles.length ? m.roles.map(words).join(", ") : <span className={css.muted}>Member</span>}</td>
                <td>{m.signIn === "disabled" ? <Badge tone="bad">Disabled</Badge> : m.locked ? <Badge tone="warn">Locked</Badge> : m.signIn ? <Badge tone="good">Password</Badge> : <span className={css.muted}>None</span>}</td>
                <td>{ago(m.lastActive ?? m.lastLogin)}</td>
              </tr>)}</tbody></Table>}
        </Panel>
        <div className={css.stack}>
          <Panel title={o.status === "suspended" ? "Suspended" : "Status"} sub={o.status === "suspended" ? "Nobody here can sign in" : "Active: its people sign in"}>
            <OrgStatus org={o.id} status={o.status} own={o.own} />
          </Panel>
          <Panel title="Plan and limits" sub={o.plan.updatedBy ? `Last changed by ${o.plan.updatedBy} ${ago(o.plan.updatedAt)}` : "Usage is read against these"}>
            <PlanForm org={o.id} plan={o.plan} override={!!o.limits?.override} />
            {o.licence ? <p className={css.note}>Licence {o.licence.key}: {o.licence.plan}, {o.licence.seats ?? "any"} seats, {o.licence.status}{o.licence.renewsOn ? `, renews ${day(o.licence.renewsOn)}` : ""} (Pulse HQ → Licences).</p> : null}
          </Panel>
          <Panel title="AI" sub={`${compact(o.ai.thisMonth)} tokens this month`}>
            <dl className={css.facts}>
              <dt>Last 30 days</dt><dd>{compact(o.ai.last30)} tokens</dd>
              <dt>Monthly limit</dt><dd>{o.plan.aiTokensMonth ? compact(o.plan.aiTokensMonth) : "None set"}</dd>
              {o.ai.connections.map((c, i) => <Fragment key={`${c.name}:${i}`}><dt>{c.name}</dt><dd>{c.provider} · {c.state}{c.cap ? ` · cap ${compact(c.cap)}/month` : ""}</dd></Fragment>)}
            </dl>
          </Panel>
        </div>
      </div>
      <Panel title="Switches" sub="Feature switches for this organisation">
        <FlagPanel org={o.id} company={o.companyModules} off={o.modulesDoc.off} on={o.modulesDoc.on} />
      </Panel>
      <div className={css.split}>
        <Panel title="What Pulse’s admins did here" sub="Platform audit log">
          <AuditTable rows={o.platformAudit} showOrg={false} />
        </Panel>
        <Panel title="Recent activity in the organisation" sub="Its own Audit">
          {!o.orgAudit.length ? <p className={css.note}>Nothing recorded yet.</p> :
            <ul className={css.list}>{o.orgAudit.map((a, i) => <li key={`${a.at}:${i}`} className={css.item}><div><b>{words(a.action.replaceAll(".", " "))}</b> <span className={css.muted}>{a.resource.replaceAll("_", " ")}</span><small>{a.actor ?? "Pulse"} · {when(a.at)}</small></div></li>)}</ul>}
        </Panel>
      </div>
      <Panel title="Details">
        <dl className={css.facts}>
          <dt>Short name</dt><dd>{o.slug}</dd><dt>Time zone</dt><dd>{o.timeZone}</dd><dt>Data region</dt><dd>{o.dataRegion.toUpperCase()}</dd>
          <dt>Addresses</dt><dd>{o.domains.length ? o.domains.map((d) => `${d.host}${d.primary ? " (main)" : ""} · ${d.signIn === "access" ? "company sign-in" : "Pulse passwords"}`).join(", ") : "The shared Pulse address"}</dd>
          <dt>Id</dt><dd><code className={css.code}>{o.id}</code></dd>
        </dl>
      </Panel>
    </div>
  </Page>;
}
