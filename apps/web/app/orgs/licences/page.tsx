import Link from "next/link";
import type { CSSProperties } from "react";
import { ArrowUpRight, Building2, CheckCircle2, CircleAlert, Cloud, KeyRound, Server } from "lucide-react";
import { api } from "../../lib/api";
import { Message, Page, PageHeader, styles } from "../../ui";
import css from "./licences.module.css";

type Live = { online: boolean; release: string | null; ms: number | null; checkedAt: string } | null;
type Licence = { key: string; name: string; handle: string; orgId: string | null; hosting: "central" | "self-hosted"; address: string | null; plan: string;
  seats: number | null; status: "active" | "pending" | "suspended" | "ended"; issuedOn: string; renewsOn: string | null; note: string | null; people: number | null; live: Live; current: boolean };
const STATUS = { active: "Active", pending: "Being set up", suspended: "Suspended", ended: "Ended" } as const;
type Referral = { id: string; at: string; referrer: string; referrerHandle: string | null; referred: string | null; referredHandle: string | null; individual: boolean; newOrg: boolean; newAccount: boolean; connected: boolean };
const day = (d: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(d));

export const dynamic = "force-dynamic";

/** LICENCES (owner, 23 Oct 2026): every organisation licensed to run Pulse, from the original Pulse. Each has one global
 *  handle, a licence key and its organisation ID; its data stays where it is hosted. Installs are checked live. */
export default async function Licences() {
  const [r, refs] = await Promise.all([api<{ licences: Licence[]; release: string | null }>("licences"), api<{ referrals: Referral[] }>("licences/referrals")]);
  const referrals = refs.data?.referrals ?? [];
  if (r.error || !r.data) return <Message text={r.error ?? "Licences are unavailable."} />;
  const { licences, release } = r.data;
  const self = licences.filter((l) => l.hosting === "self-hosted").length, online = licences.filter((l) => l.live?.online).length;
  const addressed = licences.filter((l) => l.address), current = addressed.filter((l) => l.current).length;
  return <Page>
    <PageHeader title="Licences" context={["Every organisation running Pulse, registered on this Pulse", release ? `Release ${release.slice(0, 7)}` : null]}
      actions={<Link className={styles.btn} href="/orgs">Organisations</Link>} />
    <section className={css.kpis} aria-label="At a glance">
      <Kpi label="Licensed organisations" value={String(licences.length)} sub={`${licences.filter((l) => l.status === "active").length} active`} i={0} />
      <Kpi label="Self-hosted" value={String(self)} sub="their data stays on their server" i={1} />
      <Kpi label="Online now" value={`${online} / ${addressed.length}`} sub="checked live just now" i={2} tone={online === addressed.length ? "good" : "warn"} />
      <Kpi label="On the latest release" value={`${current} / ${addressed.length}`} sub={release ? `release ${release.slice(0, 7)}` : "release unknown"} i={3} tone={current === addressed.length ? "good" : "warn"} />
    </section>
    <ul className={css.grid}>{licences.map((l, i) => <li key={l.key} style={{ "--i": i } as CSSProperties}><Card l={l} /></li>)}</ul>
    {referrals.length ? <Referrals list={referrals} /> : null}
    <p className={css.foot}><KeyRound size={14} aria-hidden="true" />One identity everywhere: each organisation&apos;s handle and ID are unique across every Pulse, so people, freelancers and clients
      move between them with one account. Data never leaves the install that holds it.</p>
  </Page>;
}

/** FEATURES-1024 / CONNECT 2: referral credit: every organisation or person a client request brought to Pulse, by whom. */
function Referrals({ list }: { list: Referral[] }) {
  const by = new Map<string, number>(); for (const x of list) by.set(x.referrer, (by.get(x.referrer) ?? 0) + 1);
  const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} ${c}`).join(" · ");
  return <section aria-labelledby="referrals-h" style={{ marginTop: 18 }}>
    <h2 id="referrals-h" style={{ margin: "0 0 4px", fontSize: 16 }}>Referrals</h2>
    <p className={styles.muted} style={{ margin: "0 0 10px", fontSize: 13 }}>{list.length} brought to Pulse by client requests · {list.filter((x) => x.newOrg).length} new organisations · {list.filter((x) => x.connected).length} still connected{top ? ` · most: ${top}` : ""}</p>
    <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr><th scope="col">When</th><th scope="col">Referred by</th><th scope="col">Who joined</th><th scope="col">What was made</th><th scope="col">Now</th></tr></thead>
      <tbody>{list.map((x) => <tr key={x.id}><td>{day(x.at)}</td><td>{x.referrer}{x.referrerHandle ? <small className={styles.muted}> @{x.referrerHandle}</small> : null}</td>
        <td>{x.referred ?? "—"}{x.referredHandle ? <small className={styles.muted}> @{x.referredHandle}</small> : null}{x.individual ? <small className={styles.muted}> · person</small> : null}</td>
        <td>{[x.newOrg ? "New organisation" : null, x.newAccount ? "New account" : null].filter(Boolean).join(" + ") || "Already on Pulse"}</td>
        <td>{x.connected ? "Connected" : "Not connected"}</td></tr>)}</tbody>
    </table></div>
  </section>;
}

function Kpi({ label, value, sub, i, tone }: { label: string; value: string; sub: string; i: number; tone?: "good" | "warn" }) {
  return <div className={css.kpi} style={{ "--i": i } as CSSProperties}><span className={css.label}>{label}</span><b data-tone={tone}>{value}</b><small>{sub}</small></div>;
}

function Card({ l }: { l: Licence }) {
  const Host = l.hosting === "self-hosted" ? Server : Cloud;
  return <article className={css.card} data-status={l.status}>
    <header className={css.head}>
      <span className={css.mark} aria-hidden="true">{l.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
      <span className={css.title}><b>{l.name}</b><small>@{l.handle}</small></span>
      <span className={css.status} data-status={l.status}><i />{STATUS[l.status]}</span>
    </header>
    <span className={css.host} data-hosting={l.hosting}><Host size={14} aria-hidden="true" />{l.hosting === "self-hosted" ? "Self-hosted · data on their own server" : l.handle === "pulsehq" ? "Platform owner · hosted here" : l.handle === "estateautopilots" ? "Founding customer · hosted here" : "Hosted on this Pulse"}</span>
    <dl className={css.facts}>
      <div><dt>Licence</dt><dd className={css.mono}>{l.key}</dd></div>
      <div><dt>Organisation ID</dt><dd className={css.mono} title={l.orgId ?? undefined}>{l.orgId ? `${l.orgId.slice(0, 8)}…${l.orgId.slice(-4)}` : "Given when it opens"}</dd></div>
      <div><dt>Plan</dt><dd>{l.plan}{l.seats ? ` · ${l.seats} seats` : ""}</dd></div>
      <div><dt>People</dt><dd>{l.people !== null ? `${l.people} active` : l.hosting === "self-hosted" ? "Counted on their server" : "—"}</dd></div>
      <div><dt>Since</dt><dd>{day(l.issuedOn)}{l.renewsOn ? ` · renews ${day(l.renewsOn)}` : ""}</dd></div>
      <div><dt>Status</dt><dd>{l.live ? <span className={css.live} data-on={l.live.online ? "" : undefined}><i />{l.live.online ? `Online${l.live.ms !== null ? ` · ${l.live.ms} ms` : ""}` : "Not answering"}</span> : "No address yet"}</dd></div>
      <div><dt>Release</dt><dd>{l.live?.release ? <span className={css.rel} data-current={l.current ? "" : undefined}>{l.current ? <CheckCircle2 size={13} aria-hidden="true" /> : <CircleAlert size={13} aria-hidden="true" />}{l.live.release.slice(0, 7)} · {l.current ? "up to date" : "update waiting"}</span> : "—"}</dd></div>
    </dl>
    {l.note ? <p className={css.note}>{l.note}</p> : null}
    {l.address ? <a className={css.open} href={l.address} target="_blank" rel="noreferrer"><Building2 size={14} aria-hidden="true" />{l.address.replace("https://", "")}<ArrowUpRight size={14} aria-hidden="true" /></a> : null}
  </article>;
}
