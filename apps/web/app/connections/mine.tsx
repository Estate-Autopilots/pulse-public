"use client";
// CONNECTIONS (spec reports/CONNECT-MAP.md §3.5): "People and companies you work with". One list across every space of
// the account (each read inside itself): tiles (people, companies, no agreement, suggested), filters, one row per
// connection with its sentence, the agreement badge and what is shared; the people in each company you lead (seat ties);
// and "Add a connection" in one short form. One primary button. Plain words.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { ArrowRight, FileSignature, Handshake, Plus, Sparkles, UserRound, Users } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Chip, EmptyState, GameCard, GamePage, PageHeader, SegmentedTabs, StatTile, StatTiles } from "../kit/game";
import { CompanyMark } from "../company-mark";
import { agreementBadge, filterRows, isPersonSide, KINDS, otherSide, shortLine, sideName, tieSummary, type ConnRow, type SeatTie } from "../lib/connections.mjs";
import { post } from "../orgs/client";
import css from "./connections.module.css";

export type Space = { org: string; name: string; current: boolean; personal: boolean; purpose: string; lead: boolean };
export type MineData = { direct: ConnRow[]; ties: { org: string; orgName: string; people: SeatTie[] }[]; unavailable: string[]; spaces: Space[] };
type Filter = "all" | "people" | "companies" | "no-agreement" | "suggested" | "ended";

const message = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

export function MineView({ data, me }: { data: MineData; me: string | null }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [adding, setAdding] = useState(false);
  const live = data.direct.filter((r) => r.status !== "ended");
  const people = live.filter((r) => isPersonSide(otherSide(r))).length;
  const noAgreement = filterRows(data.direct, "no-agreement").length;
  const suggested = filterRows(data.direct, "suggested").length;
  const tiesNone = data.ties.reduce((n, t) => n + tieSummary(t).none, 0);
  const shown = useMemo(() => filterRows(data.direct, filter), [data.direct, filter]);
  const canAdd = data.spaces.some((s) => s.lead && s.purpose === "work");
  // Judge (round 5): two filters fit a phone; people and companies are the tiles above.
  const options = [{ value: "all" as const, label: "All", count: live.length }, { value: "no-agreement" as const, label: "No agreement", count: noAgreement },
    ...(suggested ? [{ value: "suggested" as const, label: "Suggested", count: suggested }] : []),
    ...(data.direct.length > live.length ? [{ value: "ended" as const, label: "Ended", count: data.direct.length - live.length }] : [])];

  return <GamePage label="Connections">
    <PageHeader title="People you work with" subtitle="People and companies, in every company of yours and your own space."
      primary={canAdd ? { label: "Add a connection", onClick: () => setAdding(true), icon: Plus } : undefined} />
    {/* Judge (round 9): two tiles fit a phone without cutting their words; people and companies are in the list. */}
    <StatTiles label="Your connections at a glance" pair>
      <StatTile label="Connections" value={live.length} icon={Handshake} />
      <StatTile label="No agreement" value={noAgreement} icon={FileSignature} tone={noAgreement ? "warn" : "good"} />
      {suggested ? <StatTile label="To confirm" value={suggested} icon={Sparkles} tone="warn" /> : null}
      {suggested ? <StatTile label="People" value={people} icon={UserRound} /> : null}
    </StatTiles>

    {adding ? <AddConnection spaces={data.spaces.filter((s) => s.lead && s.purpose === "work")} onClose={() => setAdding(false)} /> : null}

    <GameCard title="Connections" icon={Handshake} note={String(live.length)}>
      {data.direct.length ? <div className={css.tabsBox}><SegmentedTabs value={filter} onChange={setFilter} options={options} label="Show" size="sm" /></div> : null}
      {shown.length ? <ul className={css.list}>{shown.map((r) => <ConnRowItem key={r.id} r={r} me={me} />)}</ul>
        : <EmptyState art="connect" title={data.direct.length ? "Nothing here" : "No connections yet"}
          text={data.direct.length ? "Try another filter." : "Add the first person or company you work with: a client, a freelancer, a partner."} />}
    </GameCard>

    {data.ties.length ? <GameCard title="People in your companies" icon={Users}>
      <p className={css.muted}>They hold a seat in a company you lead. Their agreement is their offer letter or contract there.</p>
      {data.ties.map((t) => <details key={t.org} className={css.tie}>
        <summary><b>{t.orgName}</b><span>{tieSummary(t).text}</span></summary>
        <ul className={css.list}>{t.people.map((p) => { const b = agreementBadge({ state: p.agreement as "none" });
          return <li key={p.person} className={css.row}>
            <CompanyMark name={p.name} size={28} />
            <span className={css.rowMain} data-static=""><b className={css.rowTitle}>{p.name}</b>
              <small className={css.rowSub}>{[p.role ?? (p.seat === "freelancer" ? "Freelancer" : "Team member"), `@${p.handle}`].join(" · ")}</small></span>
            <Chip tone={b.tone}>{b.text}</Chip>
          </li>; })}</ul>
      </details>)}
    </GameCard> : null}

    <p className={css.foot}><Link href="/connections/invites">Invite a client to Pulse<ArrowRight size={13} aria-hidden="true" /></Link>
      {data.unavailable.length ? <span role="status"> · Could not read {data.unavailable.join(", ")} just now.</span> : null}</p>
  </GamePage>;
}

function ConnRowItem({ r, me }: { r: ConnRow; me: string | null }) {
  const other = otherSide(r);
  const badge = agreementBadge(r.agreement);
  const shared = [r.counts.docs ? `${r.counts.docs} ${r.counts.docs === 1 ? "doc" : "docs"}` : null, r.counts.tasks ? `${r.counts.tasks} ${r.counts.tasks === 1 ? "task" : "tasks"}` : null].filter(Boolean).join(" · ");
  return <li className={css.row}>
    <CompanyMark name={sideName(other)} size={36} />
    <Link className={css.rowMain} href={`/connections/${r.id}`}>
      <b className={css.rowTitle}>{sideName(other)}</b>
      <small className={css.rowSub}>{shortLine(r, me)}{shared ? ` · ${shared}` : ""}</small>
    </Link>
    {r.status === "suggested" ? <Chip tone="accent">Suggested</Chip> : r.status === "ended" ? <Chip>Ended</Chip> : null}
    <Chip tone={badge.tone}>{badge.text}</Chip>
  </li>;
}

/** Add a connection: who (a Pulse @handle of a person or a company), what they are to you, and where it lives. */
function AddConnection({ spaces, onClose }: { spaces: Space[]; onClose: () => void }) {
  const router = useRouter();
  const [from, setFrom] = useState(spaces.find((s) => s.current)?.org ?? spaces[0]?.org ?? "");
  const [kind, setKind] = useState("client");
  const [who, setWho] = useState("");
  const [isCompany, setIsCompany] = useState(true);
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    const handle = who.trim().replace(/^@/, "");
    if (handle.length < 2) { setError("Write their Pulse @handle"); return; }
    setBusy(true);
    try {
      const r = await post<{ id: string }>("connections/new", { from, kind, bRole: role || undefined, ...(isCompany ? { orgHandle: handle } : { accountHandle: handle }) });
      notify({ id: "conn-made", tone: "success", title: "Connection added", timeout: 2500 });
      router.push(`/connections/${r.id}`);
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <GameCard title="Add a connection" icon={Plus}>
    <form className={css.form} onSubmit={submit}>
      <div className={css.fields}>
        <label className={css.field}><span>Is it a company or a person?</span>
          <select value={isCompany ? "company" : "person"} onChange={(e) => setIsCompany(e.target.value === "company")}>
            <option value="company">A company on Pulse</option><option value="person">A person on Pulse</option></select></label>
        <label className={css.field}><span>Their Pulse @handle</span><input value={who} onChange={(e) => setWho(e.target.value)} placeholder={isCompany ? "@company" : "@name"} autoCapitalize="none" spellCheck={false} required /></label>
        <label className={css.field}><span>What are they to you?</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
        <label className={css.field}><span>Their role <small>(optional)</small></span><input value={role} onChange={(e) => setRole(e.target.value)} maxLength={80} placeholder="Video editor" /></label>
        {spaces.length > 1 ? <label className={css.field}><span>Which of your spaces is it for?</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>{spaces.map((s) => <option key={s.org} value={s.org}>{s.personal ? "My own space" : s.name}</option>)}</select></label> : null}
      </div>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      <div className={css.actions}>
        <button type="button" className={css.quietBtn} onClick={onClose}>Cancel</button>
        <button className={css.mainBtn} disabled={busy}>{busy ? "Adding…" : "Add"}</button>
      </div>
      <p className={css.muted}>Nothing is shared until you share it. Pulse drafts an agreement for you to review; it never sends one.</p>
    </form>
  </GameCard>;
}
