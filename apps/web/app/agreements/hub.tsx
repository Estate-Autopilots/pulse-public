"use client";
// AGREEMENTS: the Agreements page (page.tsx). Mine: the current version of each policy (waiting ones first, "Read and
// accept" opens the acceptance view), what was accepted before, and the agreements naming the person. Team: per policy a
// ring of who accepted its current version, and the people still waiting (HR reminds them in Pulse; at most once a day).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { BellRing, Check, ChevronDown, ChevronRight, FileCheck2, FileSignature, PartyPopper } from "lucide-react";
import { Avatar } from "../kit";
import { Chip, EmptyState, GameCard, GamePage, PageHeader, ProgressRing, SegmentedTabLinks, celebrate, gameCss, toast } from "../kit/game";
import { useOrgZone } from "../org-code";
import { contractHref, type Contract } from "../contracts/parts";
import { openAcceptance, type MyPolicies } from "./accept-view";
import { PolicyIcon, policyIcon } from "./kinds";
import css from "./hub.module.css";

type Who = { id: string; name: string; at?: string; via?: string; remindedAt?: string | null };
export type TeamStatus = { scope: "company" | "team"; people: number;
  policies: { id: string; kind: string; title: string; version: number; publishedAt: string | null; accepted: Who[]; pending: Who[] }[] };

const DAY = 86_400_000;
const STATUS: Record<string, { text: string; tone?: "good" | "warn" | "bad" | "accent" }> = {
  active: { text: "Signed", tone: "good" }, proposed: { text: "Waiting to sign", tone: "warn" }, draft: { text: "Draft" }, ended: { text: "Ended" }, declined: { text: "Said no", tone: "bad" } };
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

export function AgreementsHub({ initial, error, contracts, team: firstTeam, tab }: { initial: MyPolicies | null; error: string | null; contracts: Contract[]; team: TeamStatus | null; tab: "mine" | "team" }) {
  const zone = useOrgZone();
  const day = useMemo(() => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: zone }), [zone]);
  const [mine, setMine] = useState(initial), [team, setTeam] = useState(firstTeam);
  const reload = useCallback(async () => {
    const [m, t] = await Promise.all([fetch("/api/v0/agreements/policies", { cache: "no-store" }), initial?.team ? fetch("/api/v0/agreements/team", { cache: "no-store" }) : null]);
    if (m.ok) setMine(await m.json());
    if (t?.ok) setTeam(await t.json());
  }, [initial?.team]);
  useEffect(() => { const on = () => void reload(); window.addEventListener("pulse:data-changed", on); return () => window.removeEventListener("pulse:data-changed", on); }, [reload]);

  const company = team?.scope === "company";
  const tabs = mine?.team ? <SegmentedTabLinks size="lg" label="Whose agreements" items={[{ key: "mine", href: "/agreements", label: "Mine", current: tab === "mine", count: mine.due.length || undefined },
    { key: "team", href: "/agreements?tab=team", label: company ? "Everyone" : "My team", current: tab === "team" }]} /> : null;
  const subtitle = tab === "team" ? (company ? "Who has accepted the latest version of each policy." : `Who of the ${people(team?.people ?? 0)} you manage has accepted the latest version of each policy.`)
    : "Your company’s policies, and the agreements you signed.";
  return <GamePage label="Agreements">
    <PageHeader title="Agreements" subtitle={subtitle} />
    {tabs ? <div className={css.tabs}>{tabs}</div> : null}
    {!mine ? <GameCard><EmptyState art="connect" title="Agreements did not load" text={error ?? "Try again in a moment."} action={{ label: "Try again", onClick: () => void reload() }} /></GameCard>
      : tab === "team" ? <Team team={team} day={day} onChanged={reload} />
      : <Mine mine={mine} contracts={contracts} day={day} />}
    <span className={css.endSpace} aria-hidden="true" />
  </GamePage>;
}

function Mine({ mine, contracts, day }: { mine: MyPolicies; contracts: Contract[]; day: Intl.DateTimeFormat }) {
  const current = mine.accepted.filter((a) => a.current), earlier = mine.accepted.filter((a) => !a.current);
  const total = mine.due.length + current.length, all = !mine.due.length;
  const signed = contracts.filter((c) => c.status !== "draft");
  const ring = useRef<HTMLSpanElement>(null), versions = current.map((a) => a.documentId).sort().join(",");
  // Everything accepted: a small burst, once per browser for this set of versions.
  useEffect(() => { if (all && total) celebrate(ring.current, { id: `agreements-all:${versions}` }); }, [all, total, versions]);
  return <>
    <GameCard title="Your policies" icon={FileCheck2}>
      {total ? <div className={css.summary}>
        <span ref={ring} className={css.summaryRing}><ProgressRing value={current.length / total} size={56} stroke={7} label={`${current.length} of ${total} accepted`} tone={all ? "good" : undefined}>
          {all ? <span className={css.ringIcon}><Check size={24} strokeWidth={2.5} aria-hidden="true" /></span> : <b className={css.ringNum}>{current.length}/{total}</b>}</ProgressRing></span>
        <p>{all ? <b className={css.allDone}><PartyPopper size={18} aria-hidden="true" />You are all set</b> : <b>{mine.due.length === 1 ? "1 policy waits" : `${mine.due.length} policies wait`} for you</b>}
          <span>{all ? `All ${total} policies accepted. If HR updates one, it will show up here.` : `${current.length} of ${total} done · about 2 min`}</span></p>
      </div> : null}
      {total ? <ul className={css.prows} aria-label="Policies">
        {mine.due.map((d, i) => <li key={d.id}><Row due kind={d.kind} title={d.title}
          sub={`Version ${d.version}${d.publishedAt ? ` · new on ${day.format(new Date(d.publishedAt))}` : ""}`}
          end={<button type="button" className={i === 0 ? gameCss.primary : `${gameCss.quiet} ${gameCss.small}`} onClick={() => openAcceptance(d.id)}>Read and accept</button>} /></li>)}
        {current.map((a) => <li key={a.documentId}><Row kind={a.kind} title={a.title} sub={`Version ${a.version} · accepted ${day.format(new Date(a.at))}`}
          end={<span className={css.okMark} title="Accepted"><Check size={14} strokeWidth={3} aria-hidden="true" /><span className={gameCss.srOnly}>Accepted</span></span>} /></li>)}
      </ul> : <EmptyState art="nothing" title="No policies yet" text="When HR publishes a policy, you read and accept it here." />}
      {earlier.length ? <details className={css.history}><summary><ChevronDown size={16} aria-hidden="true" />Earlier versions you accepted ({earlier.length})</summary>
        <ul>{earlier.map((a) => <li key={a.documentId}><span>{a.title} · version {a.version}</span><small>Accepted {day.format(new Date(a.at))} · {a.via === "steps" ? `${a.terms} terms ticked` : "with one button"}</small></li>)}</ul>
      </details> : null}
    </GameCard>
    <GameCard title="Agreements you are part of" icon={FileSignature}>
      {signed.length ? <ul className={css.prows} aria-label="Agreements">{signed.map((c) => <li key={c.key}><Row title={c.title} href={contractHref(c)}
        sub={c.signedAt ? `Signed ${day.format(new Date(c.signedAt))}` : `Version ${c.version}`}
        end={<Chip tone={(STATUS[c.status] ?? { tone: undefined }).tone}>{c.canAccept ? "Waiting for you" : STATUS[c.status]?.text ?? c.status}</Chip>} /></li>)}</ul>
        : <p className={css.none}>None yet. Signed agreements will show here.</p>}
    </GameCard>
  </>;
}

function Team({ team, day, onChanged }: { team: TeamStatus | null; day: Intl.DateTimeFormat; onChanged: () => Promise<void> }) {
  // Most people waiting first: the chosen one leads the row (on a phone the row scrolls sideways).
  const policies = useMemo(() => [...(team?.policies ?? [])].sort((a, b) => b.pending.length - a.pending.length), [team]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [now] = useState(() => Date.now());
  const pick = policies.find((p) => p.id === chosen) ?? policies[0];
  if (!team) return <GameCard><EmptyState art="connect" title="Your team’s policies did not load" text="Try again in a moment." /></GameCard>;
  if (!team.people) return <GameCard><EmptyState art="nothing" title="Nobody reports to you yet" text="When people report to you, you see here who still has to accept a policy." /></GameCard>;
  if (!policies.length) return <GameCard><EmptyState art="nothing" title="No policies published yet" text="When HR publishes a policy, you see here who has accepted it." /></GameCard>;
  const hr = team.scope === "company";
  async function remind(id: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/v0/hr/policies/${id}/remind`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast(d.reminded ? `Reminded ${people(d.reminded)} in Pulse` : "Everyone was reminded today already");
      await onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : "No reminder sent", { tone: "bad" }); }
    finally { setBusy(false); }
  }
  const since = (p: { publishedAt: string | null }) => {
    if (!p.publishedAt) return "";
    const d = Math.floor((now - new Date(p.publishedAt).getTime()) / DAY);
    return `Published ${day.format(new Date(p.publishedAt))}${d < 1 ? ", today" : `, ${d} ${d === 1 ? "day" : "days"} ago`}.`;
  };
  return <>
    <div className={css.tiles} role="list" aria-label="Policies">{policies.map((p) => {
      const all = p.accepted.length + p.pending.length;
      return <div role="listitem" key={p.id}><button type="button" className={css.tile} aria-pressed={p.id === pick?.id} onClick={() => setChosen(p.id)}>
        <ProgressRing value={all ? p.accepted.length / all : 1} size={64} stroke={7} label={`${p.accepted.length} of ${all} accepted`} tone={p.pending.length ? undefined : "good"}>
          {p.pending.length ? <b className={css.ringNum}>{p.accepted.length}/{all}</b> : <span className={css.ringIcon}><Check size={24} strokeWidth={2.5} aria-hidden="true" /></span>}</ProgressRing>
        <span className={css.tileText}><b>{p.title}</b><small>Version {p.version} · {p.pending.length ? `${p.accepted.length} of ${all} accepted` : "everyone accepted"}</small>
          <small className={css.tileCount}>{p.accepted.length} of {all} accepted</small></span>
        <ChevronRight className={css.tileGo} size={18} aria-hidden="true" />
        <span className={css.tileBar} data-full={p.pending.length ? undefined : ""} aria-hidden="true"><i style={{ width: `${all ? Math.round((p.accepted.length / all) * 100) : 100}%` }} /></span>
      </button></div>;
    })}</div>
    {pick ? <GameCard title={`${pick.title} · version ${pick.version}`} icon={policyIcon(pick.kind)}>
      <div className={css.pickHead}>
        <p><b>{pick.pending.length ? `${people(pick.pending.length)} still ${pick.pending.length === 1 ? "needs" : "need"} to accept.` : "Everyone has accepted this version."}</b>
          <small>{since(pick)}</small></p>
        {hr && pick.pending.length ? <button type="button" className={gameCss.primary} disabled={busy} onClick={() => void remind(pick.id)}><BellRing size={16} aria-hidden="true" />{busy ? "Reminding…" : `Remind ${people(pick.pending.length)}`}</button> : null}
      </div>
      {pick.pending.length ? <ul className={css.people} aria-label="Still to accept">{pick.pending.map((w) => <li key={w.id}>
        <Avatar name={w.name} id={w.id} photoAt={null} size={36} /><span className={css.who}><b>{w.name}</b>
        </span>{w.remindedAt ? <small className={css.reminded}>Reminded {day.format(new Date(w.remindedAt))}</small> : <span />}
      </li>)}</ul> : <EmptyState art="done" title="All done" text="Nobody is waiting on this one." />}
      {pick.accepted.length ? <details className={css.history}><summary><ChevronDown size={16} aria-hidden="true" />Accepted ({pick.accepted.length})</summary>
        <ul>{pick.accepted.map((w) => <li key={w.id}><span>{w.name}</span><small>{w.at ? `Accepted ${day.format(new Date(w.at))}` : ""}{w.via === "steps" ? " · term by term" : ""}</small></li>)}</ul>
      </details> : null}
      {hr ? <p className={css.foot}>Reminders go to each person in Pulse, at most once a day. <Link href="/hr?tab=policies">Edit policies on the HR desk</Link></p> : null}
    </GameCard> : null}
  </>;
}

/** A row that keeps the name readable on a phone: the state and the button move under it when there is no room. */
function Row({ kind, title, sub, end, href, due }: { kind?: string; title: string; sub: string; end: ReactNode; href?: string; due?: boolean }) {
  const inner = <><span className={css.kind} aria-hidden="true">{kind ? <PolicyIcon kind={kind} size={18} /> : <FileSignature size={18} />}</span><span className={css.prowText}><b>{title}</b><small>{sub}</small></span><span className={css.prowEnd}>{end}</span></>;
  return href ? <Link className={css.prow} href={href}>{inner}</Link> : <div className={css.prow} data-due={due ? "" : undefined}>{inner}</div>;
}
