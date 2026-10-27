import Link from "next/link";
import { Building2, Bug, Megaphone, Search, Users } from "lucide-react";
import { api, getMe } from "../lib/api";
import { Badge, Empty, Kpi, Message, Page, PageHeader, Panel, QueryTabs, Tiles } from "../ui";
import { AnnouncementForm, EndAnnouncement } from "./actions";
import { Fragment } from "react";
import { ago, bytes, compact, day, duration, when } from "./format";
import { AuditTable, Meter, StatusBadge } from "./parts";
import { PLAN_LABELS, words, type AccountHit, type Announcement, type AuditRow, type Health, type OrgRow, type PersonHit, type PlatformConfig, type UsageRow } from "./types";
import css from "./admin.module.css";

export const metadata = { title: "Admin console" };

// PULSE-ADMIN (owner, 27 Oct 2026): Pulse's back office, for its platform admins only (the owner), apart from each
// organisation's own Settings: organisations, people across them, usage and AI tokens, the platform audit log, system
// health, announcements and the bug inbox. Every read and change is checked again in the API and in the database (1140).
const TABS = [
  { key: "orgs", label: "Organisations" }, { key: "people", label: "People" }, { key: "usage", label: "Usage" },
  { key: "audit", label: "Audit log" }, { key: "health", label: "System health" }, { key: "announcements", label: "Announcements" }, { key: "bugs", label: "Bug reports" },
];

export default async function AdminConsole({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const me = await getMe();
  if (me.error || !me.data) return <Message text={me.error ?? "Sign in to Pulse"} />;
  if (!me.data.platformAdmin) return <Message notice="The admin console is for Pulse’s platform admins. Your organisation’s own settings are under Settings." />;
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab! : "orgs";
  const config = (await api<PlatformConfig>("platform/config")).data ?? null;
  return <Page fit>
    <PageHeader title="Admin console" context={[`${config?.product ?? "Pulse"} platform`, config?.company ?? null, config?.domain ?? null].filter((x): x is string => !!x)}
      actions={<Link className={css.headerLink} href="/companies">Set up a company</Link>} />
    <QueryTabs base="/admin" current={tab} items={TABS} label="Admin console" />
    <div className={css.stack} data-grow="">
      {tab === "orgs" ? await Orgs({ filter: q.status }) : tab === "people" ? await People({ q: q.q ?? "" }) : tab === "usage" ? await Usage({ days: q.days })
        : tab === "audit" ? await Audit({ action: q.action }) : tab === "health" ? await HealthTab() : tab === "announcements" ? await Announcements()
        : <Bugs config={config} />}
    </div>
  </Page>;
}

async function Orgs({ filter }: { filter?: string }) {
  const r = await api<{ orgs: OrgRow[] }>("platform/orgs");
  if (r.error || !r.data) return <Panel title="Organisations"><p className={css.error}>{r.error ?? "Unavailable"}</p></Panel>;
  const all = r.data.orgs;
  const shown = all.filter((o) => !filter || filter === "all" ? true : filter === "suspended" ? o.status === "suspended" : filter === "trial" ? o.status === "active" && (o.activation === "trial" || o.plan === "trial") : filter === "rehearsal" ? o.rehearsal : o.status === filter)
    .sort((a, b) => Number(b.own) - Number(a.own) || (a.status === b.status ? 0 : a.status === "active" ? -1 : b.status === "active" ? 1 : 0) || Date.parse(b.lastActive ?? "1970-01-01") - Date.parse(a.lastActive ?? "1970-01-01"));
  const active = all.filter((o) => o.status === "active");
  return <>
    <Tiles count={5} dense>
      <Kpi label="Active organisations" value={active.length} note={`${all.length} in all`} />
      <Kpi label="Suspended" value={all.filter((o) => o.status === "suspended").length} tone={all.some((o) => o.status === "suspended") ? "warning" : undefined} />
      <Kpi label="People" value={compact(active.reduce((n, o) => n + o.people, 0))} note={`${compact(active.reduce((n, o) => n + o.clients, 0))} client seats`} />
      <Kpi label="Active this week" value={compact(all.reduce((n, o) => n + o.active7d, 0))} note="Signed-in people, 7 days" />
      <Kpi label="AI tokens this month" value={compact(all.reduce((n, o) => n + o.aiTokensThisMonth, 0))} />
    </Tiles>
    <Panel title="Organisations" sub={`${shown.length} shown`} tools={<QueryTabs base="/admin" keep="tab=orgs" param="status" sub current={filter ?? "all"} label="Filter organisations"
      items={[{ key: "all", label: "All" }, { key: "active", label: "Active" }, { key: "trial", label: "Trial" }, { key: "suspended", label: "Suspended" }, { key: "rehearsal", label: "Rehearsal" }]} />}>
      {!shown.length ? <Empty icon={Building2} compact title="No organisations here" /> :
        <div className={css.tableWrap}><table className={css.table} aria-label="Organisations">
          <thead><tr><th>Organisation</th><th>Status</th><th>Plan</th><th className={css.num}>People</th><th className={css.num}>Active (7 d)</th><th>Last active</th><th>AI tokens this month</th></tr></thead>
          <tbody>{shown.map((o) => <tr key={o.id}>
            <td><Link className={css.name} href={`/admin/orgs/${o.id}`}>{o.name}</Link><small>{[o.code, o.handle ? `@${o.handle}` : null, o.host, o.own ? "Tenant · hosts the platform admins" : null].filter(Boolean).join(" · ")}</small></td>
            <td><StatusBadge status={o.status} activation={o.activation} rehearsal={o.rehearsal} /></td>
            <td>{PLAN_LABELS[o.plan] ?? o.plan}{o.planSet ? null : <small>Not set</small>}{o.trialEnds ? <small>Trial ends {day(o.trialEnds)}</small> : null}</td>
            <td className={css.num}>{o.seatLimit ? <Meter used={o.people} limit={o.seatLimit} /> : o.people}</td>
            <td className={css.num}>{o.active7d}</td>
            <td>{ago(o.lastActive)}</td>
            <td><Meter used={o.aiTokensThisMonth} limit={o.aiTokensMonth} /></td>
          </tr>)}</tbody></table></div>}
    </Panel>
  </>;
}

async function People({ q }: { q: string }) {
  const r = q.trim().length >= 2 ? await api<{ people: PersonHit[]; more: boolean }>(`platform/people?${new URLSearchParams({ q })}`) : null;
  const acc = q.trim().length >= 2 ? await api<{ accounts: AccountHit[] }>(`platform/accounts?${new URLSearchParams({ q })}`) : null;
  return <>{acc?.data?.accounts.length ? <Panel title="Pulse accounts" sub="One account per person, across every organisation they belong to">
    <div className={css.tableWrap}><table className={css.table} aria-label="Pulse accounts">
      <thead><tr><th>Account</th><th>Organisations</th><th>E-mail</th><th>Since</th></tr></thead>
      <tbody>{acc.data.accounts.map((a) => <tr key={a.id}>
        <td><b>{a.name}</b><small>@{a.handle}{a.locked ? " · locked" : ""}</small></td>
        <td>{a.orgs.length ? a.orgs.map((m) => <span key={m.orgId} className={css.chip}><Link href={`/admin/orgs/${m.orgId}?person=${m.personId}`}>{m.org}</Link> <small>{m.kind === "staff" ? "team" : m.kind}{m.orgStatus !== "active" ? ` · ${m.orgStatus}` : ""}</small></span>) : <span className={css.muted}>No organisation yet</span>}</td>
        <td>{a.email ?? "—"}{a.email ? <small>{a.confirmed ? "Confirmed" : "Not confirmed"}</small> : null}</td>
        <td>{day(a.created)}</td>
      </tr>)}</tbody></table></div>
  </Panel> : null}
  <Panel title="People in organisations" sub="Every organisation: by name, e-mail or username">
    <form className={css.search} action="/admin" method="get" role="search">
      <input type="hidden" name="tab" value="people" />
      <label className={css.searchField}><Search size={15} aria-hidden="true" /><input name="q" defaultValue={q} minLength={2} maxLength={80} placeholder="Name, e-mail or username" aria-label="Search people" autoComplete="off" /></label>
      <button className={css.button}>Search</button>
    </form>
    {!r ? <Empty icon={Users} compact title="Find a person" text="Type at least two letters. Each search is written to the platform audit log." />
      : r.error || !r.data ? <p className={css.error}>{r.error}</p>
      : !r.data.people.length ? <Empty icon={Users} compact title="Nobody matches" />
      : <div className={css.tableWrap}><table className={css.table} aria-label="People found">
        <thead><tr><th>Person</th><th>Organisation</th><th>Roles</th><th>Sign-in</th><th>Last sign-in</th></tr></thead>
        <tbody>{r.data.people.map((p) => <tr key={`${p.orgId}:${p.id}`}>
          <td><Link className={css.name} href={`/admin/orgs/${p.orgId}?person=${p.id}`}>{p.name}</Link><small>{[p.email, p.username ? `@${p.username}` : null].filter(Boolean).join(" · ") || "No e-mail"}</small></td>
          <td><Link href={`/admin/orgs/${p.orgId}`}>{p.org}</Link><small>{p.side === "staff" ? "Team" : p.side}{p.status !== "active" ? ` · ${p.status}` : ""}{p.orgStatus !== "active" ? ` · organisation ${p.orgStatus}` : ""}</small></td>
          <td>{p.roles.length ? p.roles.map((x) => words(x)).join(", ") : <span className={css.muted}>Member</span>}</td>
          <td>{p.signIn === "disabled" ? <Badge tone="danger">Disabled</Badge> : p.locked ? <Badge tone="warning">Locked</Badge> : p.signIn ? <Badge tone="success">Password</Badge> : <span className={css.muted}>None here</span>}</td>
          <td>{ago(p.lastLogin)}</td>
        </tr>)}</tbody></table>{r.data.more ? <p className={css.note}>The first 100 matches. Type more to narrow it down.</p> : null}</div>}
  </Panel></>;
}

async function Usage({ days }: { days?: string }) {
  const d = ["7", "30", "90"].includes(days ?? "") ? days! : "30";
  const r = await api<{ days: number; orgs: UsageRow[] }>(`platform/usage?days=${d}`);
  if (r.error || !r.data) return <Panel title="Usage"><p className={css.error}>{r.error ?? "Unavailable"}</p></Panel>;
  const rows = [...r.data.orgs].sort((a, b) => b.aiTokens - a.aiTokens || b.activePeople - a.activePeople);
  const total = (k: keyof UsageRow) => rows.reduce((n, x) => n + (Number(x[k]) || 0), 0);
  return <>
    <Tiles count={4} dense>
      <Kpi label={`AI tokens, ${d} days`} value={compact(total("aiTokens"))} note={`${compact(total("aiRuns"))} AI employee runs`} />
      <Kpi label="AI tokens this month" value={compact(total("aiTokensThisMonth"))} />
      <Kpi label="Signed-in people" value={compact(total("activePeople"))} note={`of ${compact(total("people"))} on teams`} />
      <Kpi label="Tasks and messages" value={compact(total("tasksCreated") + total("messages"))} note={`${compact(total("tasksCreated"))} tasks · ${compact(total("messages"))} messages`} />
    </Tiles>
    <Panel title="Usage by organisation" sub="AI tokens: AI employees, group summaries and product map reads"
      tools={<QueryTabs base="/admin" keep="tab=usage" param="days" sub current={d} label="Period" items={[{ key: "7", label: "7 days" }, { key: "30", label: "30 days" }, { key: "90", label: "90 days" }]} />}>
      <div className={css.tableWrap}><table className={css.table} aria-label="Usage by organisation">
        <thead><tr><th>Organisation</th><th className={css.num}>People</th><th className={css.num}>Signed in</th><th className={css.num}>AI tokens ({d} d)</th><th>This month vs limit</th><th className={css.num}>AI runs</th><th className={css.num}>Tasks</th><th className={css.num}>Messages</th></tr></thead>
        <tbody>{rows.map((o) => <tr key={o.id} data-quiet={o.status !== "active" ? "" : undefined}>
          <td><Link className={css.name} href={`/admin/orgs/${o.id}`}>{o.name}</Link><small>{PLAN_LABELS[o.plan ?? ""] ?? "Plan not set"}{o.status !== "active" ? ` · ${o.status}` : ""}</small></td>
          <td className={css.num}>{o.seatLimit ? <Meter used={o.people} limit={o.seatLimit} /> : o.people}</td>
          <td className={css.num}>{o.activePeople}</td>
          <td className={css.num}>{compact(o.aiTokens)}</td>
          <td><Meter used={o.aiTokensThisMonth} limit={o.aiTokensMonth} /></td>
          <td className={css.num}>{compact(o.aiRuns)}</td>
          <td className={css.num}>{compact(o.tasksCreated)}</td>
          <td className={css.num}>{compact(o.messages)}</td>
        </tr>)}</tbody></table></div>
    </Panel>
  </>;
}

async function Audit({ action }: { action?: string }) {
  const a = ["org", "person", "flag", "announcement", "people"].includes(action ?? "") ? action! : "";
  const r = await api<{ entries: AuditRow[] }>(`platform/audit${a ? `?action=${a}.` : ""}`);
  return <Panel title="Platform audit log" sub="Every look into an organisation and every change, with who and why. Append-only."
    tools={<QueryTabs base="/admin" keep="tab=audit" param="action" sub current={a || "all"} label="Filter the log"
      items={[{ key: "all", label: "All" }, { key: "org", label: "Organisations" }, { key: "person", label: "People" }, { key: "flag", label: "Switches" }, { key: "announcement", label: "Announcements" }]} />}>
    {r.error || !r.data ? <p className={css.error}>{r.error}</p> : <AuditTable rows={r.data.entries} />}
  </Panel>;
}

async function HealthTab() {
  const r = await api<Health>("platform/health");
  if (r.error || !r.data) return <Panel title="System health"><p className={css.error}>{r.error ?? "Unavailable"}</p></Panel>;
  const h = r.data;
  return <>
    <Tiles count={5} dense>
      <Kpi label="Release" value={<code className={css.code}>{h.api.release.slice(0, 12)}</code>} note={`${h.api.environment ?? "—"} · Node ${h.api.node}`} />
      <Kpi label="API up for" value={duration(h.api.uptimeSeconds)} note={`Memory ${bytes(h.api.rssBytes)}`} />
      <Kpi label="Database" value={bytes(h.database.bytes)} note={`Migration ${h.database.migration ?? "—"} · ${h.database.connections} connections`} />
      <Kpi label="Background jobs" value={h.jobs.aiRuns + h.jobs.groupJobs + h.jobs.mapJobs} note={h.jobs.stuck ? `${h.jobs.stuck} waiting over an hour` : "Nothing stuck"} tone={h.jobs.stuck ? "warning" : "success"} />
      <Kpi label="Password sessions, 24 h" value={h.sessions24h} note={`${h.orgs.active} active organisations`} />
    </Tiles>
    <div className={css.split}>
      <Panel title="Queues" sub="Unfinished work, every organisation">
        <dl className={css.facts}>
          <dt>AI employee runs</dt><dd>{h.jobs.aiRuns}</dd>
          <dt>Group summaries</dt><dd>{h.jobs.groupJobs}</dd>
          <dt>Product map reads</dt><dd>{h.jobs.mapJobs}</dd>
          <dt>Waiting over an hour</dt><dd>{h.jobs.stuck ? <Badge tone="warning">{h.jobs.stuck}</Badge> : <Badge tone="success">None</Badge>}</dd>
          <dt>API started</dt><dd>{when(h.api.startedAt)}</dd>
          <dt>Organisations</dt><dd>{h.orgs.active} active · {h.orgs.suspended} suspended · {h.orgs.setup} being set up</dd>
        </dl>
      </Panel>
      <Panel title="Largest tables">
        <dl className={css.facts}>{h.database.largest.map((t) => <Fragment key={t.table}><dt><code className={css.code}>{t.table}</code></dt><dd>{bytes(t.bytes)}</dd></Fragment>)}</dl>
      </Panel>
    </div>
  </>;
}

async function Announcements() {
  const r = await api<{ announcements: Announcement[] }>("platform/announcements");
  const rows = r.data?.announcements ?? [];
  return <div className={css.split}>
    <Panel title="New announcement" sub="Shown to signed-in people of every organisation until it ends">
      <AnnouncementForm />
    </Panel>
    <Panel title="Announcements" sub={`${rows.filter((a) => a.live).length} live`}>
      {r.error ? <p className={css.error}>{r.error}</p> : !rows.length ? <Empty icon={Megaphone} compact title="Nothing announced yet" /> :
        <ul className={css.list}>{rows.map((a) => <li key={a.id} className={css.item}>
          <div><b>{a.title}</b> {a.live ? <Badge tone="success">Live</Badge> : <Badge>Ended</Badge>} <Badge tone={a.tone === "warning" ? "warning" : a.tone === "success" ? "success" : "neutral"}>{a.tone}</Badge>
            {a.body ? <p>{a.body}</p> : null}
            <small>{a.audience === "admins" ? "Organisation admins" : "Everyone"} · from {when(a.startsAt)}{a.endsAt ? ` to ${when(a.endsAt)}` : ""} · {a.createdBy}{a.endedAt ? ` · ended ${when(a.endedAt)}` : ""}</small></div>
          {a.live ? <EndAnnouncement id={a.id} /> : null}
        </li>)}</ul>}
    </Panel>
  </div>;
}

function Bugs({ config }: { config: PlatformConfig | null }) {
  const path = config?.bugTriagePath ?? "/bug-reports";
  return <Panel title="Bug reports" sub="Reports from people and testers in every organisation">
    <Empty icon={Bug} title="Bug reports are triaged in their own inbox" text="People send reports from any page (the reporter). Triage, assign and mark them fixed in the bug inbox; it is not repeated here."
      action={{ href: path, label: "Open the bug inbox" }} />
    {config?.supportEmail ? <p className={css.note}>Support address people see: <a href={`mailto:${config.supportEmail}`}>{config.supportEmail}</a></p>
      : <p className={css.note}>No support address is set for this Pulse yet (PULSE_SUPPORT_EMAIL).</p>}
  </Panel>;
}
