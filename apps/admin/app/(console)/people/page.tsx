import { Users } from "lucide-react";
import Link from "next/link";

import { read } from "@/app/lib/api";
import { ago, day } from "@/app/lib/format";
import { words, type AccountHit, type PersonHit } from "@/app/lib/types";
import { Badge, Empty, Page, PageHeader, Panel, Table, Unavailable, kitStyles } from "@/app/ui/kit";
import css from "@/app/ui/console.module.css";

// PULSE-ADMIN: people across every organisation. Pulse accounts (one per human; AUTH-UNIFY owns that schema) with their
// memberships, and each organisation's people. Every search is written to the platform audit log.
export default async function People({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = ((await searchParams).q ?? "").trim().slice(0, 80);
  const searching = q.length >= 2;
  const [accounts, people] = searching
    ? await Promise.all([read<{ accounts: AccountHit[] }>(`platform/accounts?${new URLSearchParams({ q })}`), read<{ people: PersonHit[]; more: boolean }>(`platform/people?${new URLSearchParams({ q })}`)])
    : [null, null];
  return (
    <Page wide>
      <PageHeader title="People" context={["Every organisation", "Accounts and memberships"]} />
      <Panel title="Find a person">
        <form className={css.search} action="/people" method="get" role="search">
          <input name="q" defaultValue={q} minLength={2} maxLength={80} placeholder="Name, e-mail, username or @handle" aria-label="Search people" autoComplete="off" />
          <button className={kitStyles.button} data-variant="primary">Search</button>
        </form>
        {!searching ? <Empty icon={Users} title="Type at least two letters" text="Each search is written to the platform audit log." /> : null}
      </Panel>
      {accounts ? (
        <Panel title="Pulse accounts" sub="One account per person, across every organisation they belong to">
          {accounts.error || !accounts.data ? <Unavailable title="Pulse accounts" reason={accounts.error ?? "No answer"} /> : !accounts.data.accounts.length ? <p className={css.note}>No account matches.</p> :
            <Table label="Pulse accounts">
              <thead><tr><th>Account</th><th>Organisations</th><th>E-mail</th><th>Since</th></tr></thead>
              <tbody>{accounts.data.accounts.map((a) => <tr key={a.id}>
                <td><b>{a.name}</b><span className={css.sub}>@{a.handle}{a.locked ? " · locked" : ""}</span></td>
                <td>{a.orgs.length ? a.orgs.map((m) => <span key={m.orgId} className={css.chip}><Link href={`/organisations/${m.orgId}?person=${m.personId}`}>{m.org}</Link> <small className={css.muted}>{m.kind === "staff" ? "team" : m.kind}{m.orgStatus !== "active" ? ` · ${m.orgStatus}` : ""}</small></span>) : <span className={css.muted}>No organisation yet</span>}</td>
                <td>{a.email ?? "—"}{a.email ? <span className={css.sub}>{a.confirmed ? "Confirmed" : "Not confirmed"}</span> : null}</td>
                <td>{day(a.created)}</td>
              </tr>)}</tbody>
            </Table>}
        </Panel>
      ) : null}
      {people ? (
        <Panel title="People in organisations" sub={people.data?.more ? "The first 100 matches" : undefined}>
          {people.error || !people.data ? <Unavailable title="People" reason={people.error ?? "No answer"} /> : !people.data.people.length ? <p className={css.note}>Nobody matches.</p> :
            <Table label="People found">
              <thead><tr><th>Person</th><th>Organisation</th><th>Roles</th><th>Sign-in</th><th>Last sign-in</th></tr></thead>
              <tbody>{people.data.people.map((p) => <tr key={`${p.orgId}:${p.id}`}>
                <td><Link className={css.name} href={`/organisations/${p.orgId}?person=${p.id}`}>{p.name}</Link><span className={css.sub}>{[p.email, p.username ? `@${p.username}` : null].filter(Boolean).join(" · ") || "No e-mail"}</span></td>
                <td><Link href={`/organisations/${p.orgId}`}>{p.org}</Link><span className={css.sub}>{p.side === "staff" ? "Team" : p.side}{p.status !== "active" ? ` · ${p.status}` : ""}</span></td>
                <td>{p.roles.length ? p.roles.map(words).join(", ") : <span className={css.muted}>Member</span>}</td>
                <td>{p.signIn === "disabled" ? <Badge tone="bad">Disabled</Badge> : p.locked ? <Badge tone="warn">Locked</Badge> : p.signIn ? <Badge tone="good">Password</Badge> : <span className={css.muted}>None here</span>}</td>
                <td>{ago(p.lastLogin)}</td>
              </tr>)}</tbody>
            </Table>}
        </Panel>
      ) : null}
    </Page>
  );
}
