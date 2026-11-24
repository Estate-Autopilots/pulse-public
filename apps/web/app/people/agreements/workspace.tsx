"use client";
// AGREEMENTS round 14 Nov (owner: "In Agreements the right side panel is just empty. It has an agreement where we can
// make an offer letter, but it does not do anything"). People → Agreements is a workspace: on the left the team's papers
// grouped by who acts next (offers from People & pay, agreements from Agreements, the company's policies); on the right the
// picked one, never empty: who it is for, where it stands (drafted → approved → sent → opened → accepted), what the person
// must do and the actions. Nothing picked: what this page is for and the next useful action. "Make an offer letter" picks
// a person (or adds someone new) and opens People & pay's own offer form: a founder approves and sends it, the person
// accepts it term by term in Pulse (agreements/offers/:id/accept) or through the link, and their pay follows.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, BadgeCheck, BriefcaseBusiness, ChevronRight, FileCheck2, FileSignature, FileText, PenLine, Plus, Send, ShieldCheck, Undo2, UserPlus } from "lucide-react";
import { Chip, ProgressRing, Stepper, gameCss, toast } from "../../kit/game";
import { useConfirm } from "../../kit";
import { useOrgZone } from "../../org-code";
import { post } from "../../records";
import { Decide, OfferForm, SendOffer } from "../pay/flows";
import type { Offer, PayRow, PersonPay } from "../pay/model";
import type { Contract } from "../../contracts/parts";
import css from "./workspace.module.css";

export type OfferRow = { id: string; personId: string; name: string; role: string; status: string; startOn: string; validUntil: string; probationDays: number; noticeDays: number | null;
  proposedAt: string | null; approvedAt: string | null; sentAt: string | null; openedAt: string | null; answeredAt: string | null; answerName: string | null; answerVia: string | null;
  letterId: string | null; signedLetterId: string | null; proposedBy: string | null; approvedBy: string | null; mine: boolean };
export type OffersData = { writer: boolean; approver: boolean; today: string; offers: OfferRow[] };
type PolicyRow = { id: string; kind: string; title: string; version: number; accepted: { id: string; name: string }[]; pending: { id: string; name: string }[] };
export type TeamPolicies = { scope: "company" | "team"; people: number; policies: PolicyRow[] };

type Group = "you" | "them" | "done" | "closed" | "policies";
type Item = { key: string; group: Group; type: "offer" | "contract" | "policy"; title: string; sub: string; state: string; tone?: "good" | "warn" | "bad" | "accent";
  offer?: OfferRow; contract?: Contract; policy?: PolicyRow };
const GROUPS: [Group, string][] = [["you", "Needs you"], ["them", "Waiting for them"], ["done", "Signed and accepted"], ["policies", "Policies"], ["closed", "Closed"]];
const CONTRACT_STATE: Record<string, [string, Group, "good" | "warn" | "bad" | "accent" | undefined]> = {
  draft: ["Draft", "you", undefined], proposed: ["Sent to sign", "them", "accent"], active: ["Signed", "done", "good"], ended: ["Ended", "closed", undefined], declined: ["Said no", "closed", "bad"] };
const KIND: Record<string, string> = { employment: "Employment agreement", nda: "NDA (confidentiality)", offer: "Offer letter", consultant: "Freelancer agreement", internship: "Internship agreement" };
const first = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Where an offer stands, in words, for whom, and which group it sits in for this viewer. */
function offerState(o: OfferRow, can: { writer: boolean; approver: boolean }, d: (iso: string) => string): { state: string; short?: string; group: Group; tone?: Item["tone"]; next: string; theirs: string } {
  const n = first(o.name);
  switch (o.status) {
    case "draft": return { state: "Draft", group: can.writer ? "you" : "them", next: "Finish it and ask a founder to approve it.", theirs: `Nothing yet: ${n} sees it once it is sent.` };
    case "proposed": return { state: "Waiting for a founder", group: can.approver && !o.mine ? "you" : "them", tone: "warn", next: "A founder approves it (or sends it back). Approving files the letter.", theirs: `Nothing yet: ${n} sees it once it is sent.` };
    case "approved": return { state: "Approved · ready to send", short: "Ready to send", group: can.approver ? "you" : "them", tone: "accent", next: "A founder sends it. It then waits for their answer in Pulse (or through a link you share).", theirs: `Nothing yet: ${n} sees it once it is sent.` };
    case "sent": return { state: o.openedAt ? "Opened · waiting for their answer" : "Sent · waiting for their answer", short: o.openedAt ? "Opened" : "Sent", group: "them", tone: "accent", next: `${n} answers it. When they accept, their pay starts from ${d(o.startOn)}.`, theirs: `${n} reads each key term, ticks it and accepts (in Pulse or through the link) by ${d(o.validUntil)}.` };
    case "accepted": return { state: "Accepted", group: "done", tone: "good", next: "Done. Their pay record follows the offer, and the signed letter is filed.", theirs: "Nothing: it is accepted." };
    case "declined": return { state: "Declined", group: "closed", tone: "bad", next: "They said no. Make a new offer if things change.", theirs: "Nothing." };
    case "withdrawn": return { state: "Withdrawn", group: "closed", next: "You withdrew it. Make a new offer if needed.", theirs: "Nothing." };
    default: return { state: "Expired", group: "closed", next: "It ran out before an answer. Make a new offer if needed.", theirs: "Nothing." };
  }
}
const OFFER_STEPS = ["Drafted", "Founder approves", "Sent", "Opened", "Their answer"];
const offerStep = (o: OfferRow) => ({ draft: 0, proposed: 1, approved: 2, sent: o.openedAt ? 4 : 3, accepted: 5 } as Record<string, number>)[o.status] ?? 0;

export function Workspace({ offers, contracts, policies, canContract, canPeople, pick: initial }: { offers: OffersData | null; contracts: Contract[]; policies: TeamPolicies | null;
  canContract: boolean; /** HR or an organisation admin may add a person (someone new). */ canPeople: boolean; pick: string | null }) {
  const router = useRouter(), zone = useOrgZone();
  const day = useMemo(() => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: zone }), [zone]);
  const d = (iso: string) => day.format(new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso));
  const [pick, setPick] = useState<string | null>(initial);
  const can = { writer: !!offers?.writer, approver: !!offers?.approver };
  const items = useMemo(() => {
    const out: Item[] = [];
    for (const o of offers?.offers ?? []) {
      const s = offerState(o, can, d);
      out.push({ key: `offer:${o.id}`, group: s.group, type: "offer", title: `Offer letter · ${o.name}`, sub: `${o.role} · starts ${d(o.startOn)}`, state: s.short ?? s.state, tone: s.tone, offer: o });
    }
    for (const c of contracts) {
      const [state, group, tone] = CONTRACT_STATE[c.status] ?? [c.status, "them" as Group, undefined];
      const who = c.parties.find((p) => p.role === "employee" || p.personId)?.name ?? c.parties.find((p) => !p.mine)?.name ?? "Not sent yet";
      out.push({ key: `contract:${c.id ?? c.key}`, group, type: "contract", title: `${KIND[c.kind] ?? c.title} · ${who}`, sub: `${c.title} · version ${c.version}`, state, tone, contract: c });
    }
    for (const p of policies?.policies ?? []) {
      const all = p.accepted.length + p.pending.length;
      out.push({ key: `policy:${p.id}`, group: "policies", type: "policy", title: p.title, sub: `Version ${p.version}`, state: p.pending.length ? `${p.accepted.length} of ${all} accepted` : "Everyone accepted",
        tone: p.pending.length ? "warn" : "good", policy: p });
    }
    return out;
  }, [offers, contracts, policies, can.writer, can.approver, day]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (key: string | null) => {
    setPick(key);
    const url = new URL(window.location.href);
    if (key) url.searchParams.set("pick", key); else url.searchParams.delete("pick");
    window.history.replaceState(window.history.state, "", url);
  };
  const picked = pick === "new" ? null : items.find((i) => i.key === pick) ?? null;
  const done = (key?: string) => { router.refresh(); if (key !== undefined) choose(key); };
  const youCount = items.filter((i) => i.group === "you").length;
  // People & pay's offer form says itself what it saved; the new offer arrives on the left with the refresh.
  const panel = pick === "new" ? <NewOffer offers={offers?.offers ?? []} canPeople={canPeople} onBack={() => choose(null)} onMade={() => { router.refresh(); choose(null); }} />
    : picked?.offer ? <OfferPanel key={picked.key} o={picked.offer} can={can} onDone={() => done()} />
    : picked?.contract ? <ContractPanel key={picked.key} c={picked.contract} />
    : picked?.policy ? <PolicyPanel key={picked.key} p={picked.policy} scope={policies?.scope ?? "team"} />
    : <StartPanel canOffer={can.writer} canContract={canContract} canTeam={!!policies} youCount={youCount} onOffer={() => choose("new")} />;
  return <div className={css.split} data-picked={pick ? "" : undefined}>
    <nav className={css.list} aria-label="The team's papers">
      <div className={css.listHead}>
        <p>{items.length ? `${items.length} ${items.length === 1 ? "paper" : "papers"}${youCount ? ` · ${youCount} ${youCount === 1 ? "needs" : "need"} you` : ""}` : "Nothing here yet"}</p>
        {can.writer ? <button type="button" className={`${gameCss.quiet} ${gameCss.small}`} onClick={() => choose("new")}><Plus size={14} aria-hidden="true" />Offer letter</button> : null}
      </div>
      {items.length ? GROUPS.map(([g, label]) => {
        const list = items.filter((i) => i.group === g);
        if (!list.length) return null;
        return <section key={g} className={css.group} aria-label={label}>
          <h2>{label} <span>{list.length}</span></h2>
          <ul>{list.map((i) => <li key={i.key}><button type="button" className={css.row} aria-current={pick === i.key ? "true" : undefined} onClick={() => choose(i.key)}>
            <span className={css.rowIcon} aria-hidden="true">{i.type === "offer" ? <BriefcaseBusiness size={18} /> : i.type === "policy" ? <ShieldCheck size={18} /> : <FileSignature size={18} />}</span>
            <span className={css.rowText}><b>{i.title}</b><small>{i.sub}</small></span>
            <span className={css.rowEnd}><Chip tone={i.tone}>{i.state}</Chip><ChevronRight size={16} aria-hidden="true" /></span>
          </button></li>)}</ul>
        </section>;
      }) : <p className={css.none}>Offer letters, agreements and policies for your team will show here.</p>}
    </nav>
    <section className={css.panel} aria-label={picked ? picked.title : pick === "new" ? "New offer letter" : "About this page"}>
      {pick ? <button type="button" className={css.back} onClick={() => choose(null)}><ArrowLeft size={16} aria-hidden="true" />All papers</button> : null}
      {panel}
    </section>
  </div>;
}

/** Nothing picked: what this page is for, and the next useful action. */
function StartPanel({ canOffer, canContract, canTeam, youCount, onOffer }: { canOffer: boolean; canContract: boolean; canTeam: boolean; youCount: number; onOffer: () => void }) {
  const papers: { icon: ReactNode; what: string; when: string; action: ReactNode }[] = [
    { icon: <BriefcaseBusiness size={20} />, what: "Offer letter", when: "Before someone joins: the role, the pay and the joining date. A founder approves it, they accept it term by term, and their pay starts from it.",
      action: canOffer ? <button type="button" className={gameCss.primary} onClick={onOffer}><PenLine size={16} aria-hidden="true" />Make an offer letter</button> : <small>HR makes offer letters.</small> },
    { icon: <FileSignature size={20} />, what: "Employment agreement or NDA", when: "When they join: duties, probation, notice, leave and confidentiality. Both sides sign it.",
      action: canContract ? <Link className={gameCss.quiet} href="/contracts/new">Make an agreement</Link> : <small>Admins, leadership and Finance make agreements.</small> },
    { icon: <ShieldCheck size={20} />, what: "Policies", when: "Pay, leave, conduct… Everyone accepts each new version term by term on their next visit.",
      action: canTeam ? <Link className={gameCss.quiet} href="/agreements?tab=team">See who has accepted</Link> : <Link className={gameCss.quiet} href="/agreements">Your policies</Link> },
  ];
  return <div className={css.start}>
    <span className={css.startIcon} aria-hidden="true"><FileCheck2 size={28} /></span>
    <h2>Your team’s papers, in one place</h2>
    <p className={css.lead}>{youCount ? `${youCount} ${youCount === 1 ? "paper needs" : "papers need"} you: open it to see what to do.` : "Open a paper to see where it stands, or start a new one."}</p>
    <ul className={css.papers}>{papers.map((p) => <li key={p.what}><span className={css.paperIcon} aria-hidden="true">{p.icon}</span>
      <span className={css.paperText}><b>{p.what}</b><span>{p.when}</span></span><span className={css.paperAction}>{p.action}</span></li>)}</ul>
    {canOffer || canContract ? <p className={css.foot}>Letter words are yours to change: {canOffer ? <Link href="/people/pay/settings">Pay policy → letters</Link> : null}{canOffer && canContract ? " · " : null}{canContract ? <Link href="/contracts/templates">Agreement templates</Link> : null}</p> : null}
  </div>;
}

/** One offer: who for, where it stands, what happens next and the actions this viewer may take. */
function OfferPanel({ o, can, onDone }: { o: OfferRow; can: { writer: boolean; approver: boolean }; onDone: () => void }) {
  const zone = useOrgZone();
  const confirm = useConfirm();
  const day = useMemo(() => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: zone }), [zone]);
  const d = (iso: string | null) => (iso ? day.format(new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)) : "");
  const s = offerState(o, can, (iso) => d(iso));
  // People & pay's own forms need the person's pay page (the offer with its figures): fetched when an action opens.
  const [pp, setPp] = useState<PersonPay | null>(null), [open, setOpen] = useState<"edit" | "approve" | "send" | null>(null), [busy, setBusy] = useState(false);
  const full: Offer | null = pp ? ((pp.offers ?? []) as Offer[]).find((x) => x.id === o.id) ?? null : null;
  async function load(next: "edit" | "approve" | "send") {
    setBusy(true);
    try { const r = await fetch(`/api/v0/comp/people/${o.personId}`, { cache: "no-store" }); const j = await r.json(); if (!r.ok) throw new Error(j.error); setPp(j); setOpen(next); }
    catch (e) { toast(e instanceof Error ? e.message : "The offer did not open", { tone: "bad" }); }
    finally { setBusy(false); }
  }
  async function act(path: string, body: unknown, said: string) {
    setBusy(true);
    try { await post(path, body); toast(said); onDone(); } catch (e) { toast(e instanceof Error ? e.message : "Not saved", { tone: "bad" }); } finally { setBusy(false); }
  }
  async function withdraw() {
    if (await confirm({ title: `Withdraw the offer to ${o.name}?`, body: "They can no longer accept it. You can make a new one later.", confirmLabel: "Withdraw offer" }))
      await act(`comp/offers/${o.id}/withdraw`, { note: "Withdrawn in Agreements" }, "Offer withdrawn");
  }
  const close = () => { setOpen(null); setPp(null); onDone(); };
  const primary = o.status === "draft" && can.writer ? <button type="button" className={gameCss.primary} disabled={busy} onClick={() => void act(`comp/offers/${o.id}/propose`, {}, "Sent to a founder to approve")}><Send size={16} aria-hidden="true" />Ask a founder</button>
    : o.status === "proposed" && can.approver && !o.mine ? <button type="button" className={gameCss.primary} disabled={busy} onClick={() => void load("approve")}><BadgeCheck size={16} aria-hidden="true" />Review and approve</button>
    : o.status === "approved" && can.approver ? <button type="button" className={gameCss.primary} disabled={busy} onClick={() => void load("send")}><Send size={16} aria-hidden="true" />Send the offer</button>
    : null;
  return <div className={css.detail}>
    <header className={css.detailHead}>
      <span className={css.detailIcon} aria-hidden="true"><BriefcaseBusiness size={22} /></span>
      <div><p className={css.eyebrow}>Offer letter</p><h2>{o.name}</h2><p className={css.meta}>{o.role} · starts {d(o.startOn)}</p></div>
      <Chip tone={s.tone}>{s.state}</Chip>
    </header>
    {["declined", "withdrawn", "expired"].includes(o.status) ? null : <><div className={css.stepper}><Stepper steps={OFFER_STEPS} current={offerStep(o)} label="Where the offer stands" /></div>
      <p className={css.stepLine}>{offerStep(o) >= OFFER_STEPS.length ? "All steps done" : `Step ${offerStep(o) + 1} of ${OFFER_STEPS.length}: ${OFFER_STEPS[offerStep(o)]}`}</p></>}
    <div className={css.next}><b>What happens next</b><p>{s.next}</p><b>What {first(o.name)} must do</b><p>{s.theirs}</p></div>
    {primary || o.status === "draft" && can.writer || ["draft", "proposed", "approved", "sent"].includes(o.status) && (can.writer || can.approver) ? <div className={css.actions}>
      {primary}
      {["draft", "proposed", "approved"].includes(o.status) && can.writer ? <button type="button" className={gameCss.quiet} disabled={busy} onClick={() => void load("edit")}><PenLine size={16} aria-hidden="true" />Edit</button> : null}
      {["draft", "proposed", "approved", "sent"].includes(o.status) && (can.writer || can.approver) ? <button type="button" className={gameCss.quiet} disabled={busy} onClick={() => void withdraw()}><Undo2 size={16} aria-hidden="true" />Withdraw</button> : null}
    </div> : null}
    <dl className={css.facts}>
      <div><dt>Role</dt><dd>{o.role}</dd></div>
      <div><dt>Starts</dt><dd>{d(o.startOn)}</dd></div>
      <div><dt>Probation</dt><dd>{o.probationDays ? `${o.probationDays} days` : "None"}</dd></div>
      {o.noticeDays !== null ? <div><dt>Notice</dt><dd>{o.noticeDays} days</dd></div> : null}
      <div><dt>Open until</dt><dd>{d(o.validUntil)}</dd></div>
      {o.proposedBy || o.approvedBy ? <div><dt>Made by</dt><dd>{[o.proposedBy && `drafted by ${o.proposedBy}`, o.approvedBy && `approved by ${o.approvedBy}`].filter(Boolean).join(" · ")}</dd></div> : null}
      {o.sentAt ? <div><dt>Sent</dt><dd>{d(o.sentAt)}{o.openedAt ? ` · opened ${d(o.openedAt)}` : o.answeredAt ? "" : " · not opened yet"}</dd></div> : null}
      {o.answeredAt ? <div><dt>Answer</dt><dd>{o.status === "accepted" ? "Accepted" : "Declined"} by {o.answerName} on {d(o.answeredAt)} ({o.answerVia === "pulse" ? "in Pulse, term by term" : "through the link"})</dd></div> : null}
    </dl>
    <p className={css.links}>
      {o.signedLetterId ? <a href={`/api/v0/comp/letters/${o.signedLetterId}/pdf`} target="_blank" rel="noreferrer"><FileText size={15} aria-hidden="true" />Signed letter (PDF)</a> : null}
      {o.letterId ? <a href={`/api/v0/comp/letters/${o.letterId}/pdf`} target="_blank" rel="noreferrer"><FileText size={15} aria-hidden="true" />Offer letter (PDF)</a> : null}
      <Link href={`/people/pay/${o.personId}`}>Their pay in People &amp; pay <ChevronRight size={14} aria-hidden="true" /></Link>
    </p>
    {open === "edit" && pp ? <OfferForm p={pp} offer={full} onClose={close} /> : null}
    {open === "send" && full ? <SendOffer offer={full} name={o.name} onClose={close} /> : null}
    {open === "approve" && full ? <Decide title={`Offer for ${o.name}`} sub="Approve it to file the letter; then a founder sends it." path={`comp/offers/${o.id}/decide`} what="Offer" onClose={close}>
      <p className={css.decideFacts}>{o.role} · starts {d(o.startOn)} · probation {o.probationDays} days · open until {d(o.validUntil)}</p></Decide> : null}
  </div>;
}

function ContractPanel({ c }: { c: Contract }) {
  const who = c.parties.find((p) => p.role === "employee" || p.personId)?.name ?? c.parties.find((p) => !p.mine)?.name ?? "Not sent yet";
  const [state, , tone] = CONTRACT_STATE[c.status] ?? [c.status, "them", undefined];
  const step = ({ draft: 0, proposed: 1, active: 3 } as Record<string, number>)[c.status] ?? 1;
  return <div className={css.detail}>
    <header className={css.detailHead}>
      <span className={css.detailIcon} aria-hidden="true"><FileSignature size={22} /></span>
      <div><p className={css.eyebrow}>{KIND[c.kind] ?? "Agreement"}</p><h2>{who}</h2><p className={css.meta}>{c.title} · version {c.version}</p></div>
      <Chip tone={tone}>{state}</Chip>
    </header>
    {["ended", "declined"].includes(c.status) ? null : <><div className={css.stepper}><Stepper steps={["Drafted", "Sent to sign", "Signed"]} current={step} label="Where the agreement stands" /></div>
      <p className={css.stepLine}>{step >= 3 ? "All steps done" : `Step ${step + 1} of 3: ${["Drafted", "Sent to sign", "Signed"][step]}`}</p></>}
    <div className={css.next}><b>What happens next</b><p>{c.status === "draft" ? "Check the words and send it to sign." : c.status === "proposed" ? `${first(who)} reads it clause by clause, asks for a change or signs.` : c.status === "active" ? "Done: both sides signed. The signed PDF has the audit page." : "It is closed."}</p></div>
    <div className={css.actions}><Link className={gameCss.primary} href={`/contracts/${c.id ?? c.key}`}>Open the agreement</Link></div>
  </div>;
}

function PolicyPanel({ p, scope }: { p: PolicyRow; scope: "company" | "team" }) {
  const all = p.accepted.length + p.pending.length;
  return <div className={css.detail}>
    <header className={css.detailHead}>
      <span className={css.detailIcon} aria-hidden="true"><ShieldCheck size={22} /></span>
      <div><p className={css.eyebrow}>Policy · version {p.version}</p><h2>{p.title}</h2><p className={css.meta}>{scope === "company" ? "Everyone in the company" : "The people you manage"}</p></div>
      <ProgressRing value={all ? p.accepted.length / all : 1} size={56} stroke={7} label={`${p.accepted.length} of ${all} accepted`} tone={p.pending.length ? undefined : "good"}><b className={css.ringNum}>{p.accepted.length}/{all}</b></ProgressRing>
    </header>
    <div className={css.next}><b>What happens next</b><p>{p.pending.length ? `Each of them accepts it term by term on their next visit to Pulse.` : "Everyone has accepted this version."}</p></div>
    {p.pending.length ? <><p className={css.subhead}>Still to accept ({p.pending.length})</p><ul className={css.names}>{p.pending.slice(0, 12).map((x) => <li key={x.id}>{x.name}</li>)}</ul></> : null}
    <div className={css.actions}><Link className={gameCss.primary} href="/agreements?tab=team">See everyone and remind</Link></div>
  </div>;
}

/** "Make an offer letter": who it is for (someone in Pulse, or someone new), then People & pay's offer form. */
function NewOffer({ offers, canPeople, onBack, onMade }: { offers: OfferRow[]; canPeople: boolean; onBack: () => void; onMade: () => void }) {
  const [people, setPeople] = useState<PayRow[] | null>(null), [error, setError] = useState("");
  const [mode, setMode] = useState<"pulse" | "new">("pulse"), [who, setWho] = useState(""), [name, setName] = useState(""), [role, setRole] = useState(""), [email, setEmail] = useState("");
  const [pp, setPp] = useState<PersonPay | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    void fetch("/api/v0/comp/people", { cache: "no-store" }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); if (!gone) setPeople(j.people); })
      .catch((e) => { if (!gone) setError(e instanceof Error ? e.message : "People did not load"); });
    return () => { gone = true; };
  }, []);
  const live = new Set(offers.filter((o) => ["draft", "proposed", "approved", "sent"].includes(o.status)).map((o) => o.personId));
  const choices = (people ?? []).filter((p) => !live.has(p.id)).sort((a, b) => Number(b.stage !== "active") - Number(a.stage !== "active") || a.name.localeCompare(b.name));
  async function next() {
    setBusy(true); setError("");
    try {
      let id = who;
      if (mode === "new") {
        if (name.trim().length < 2 || !role.trim()) throw new Error("Give their name and the role");
        id = (await post<{ id: string }>("people", { name: name.trim(), role: role.trim(), ...(email.trim() ? { email: email.trim() } : {}) })).id;
      }
      if (!id) throw new Error("Choose who the offer is for");
      const r = await fetch(`/api/v0/comp/people/${id}`, { cache: "no-store" }); const j = await r.json(); if (!r.ok) throw new Error(j.error);
      setPp(j);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not continue"); }
    finally { setBusy(false); }
  }
  return <div className={css.detail}>
    <header className={css.detailHead}>
      <span className={css.detailIcon} aria-hidden="true"><PenLine size={22} /></span>
      <div><p className={css.eyebrow}>New offer letter · step 1 of 2</p><h2>Who is it for?</h2><p className={css.meta}>Next: the role, pay, joining date, probation and notice.</p></div>
    </header>
    <div className={css.modes} role="radiogroup" aria-label="Who the offer is for">
      <button type="button" role="radio" aria-checked={mode === "pulse"} className={css.mode} onClick={() => setMode("pulse")}><BriefcaseBusiness size={18} aria-hidden="true" /><span><b>Someone in Pulse</b><small>A candidate or a person already added</small></span></button>
      <button type="button" role="radio" aria-checked={mode === "new"} className={css.mode} disabled={!canPeople} onClick={() => setMode("new")}><UserPlus size={18} aria-hidden="true" /><span><b>Someone new</b><small>{canPeople ? "Their name, the role and e-mail" : "HR adds new people"}</small></span></button>
    </div>
    {mode === "pulse" ? <label className={css.field}>Person
      <select value={who} onChange={(e) => setWho(e.target.value)} disabled={!people}>
        <option value="">{people ? (choices.length ? "Choose a person" : "Everyone already has an offer") : "Loading people…"}</option>
        {choices.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role ? ` · ${p.role}` : ""}</option>)}
      </select></label>
      : <div className={css.fields}>
        <label className={css.field}>Full name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder="As on their ID" /></label>
        <label className={css.field}>Role<input value={role} onChange={(e) => setRole(e.target.value)} autoComplete="off" placeholder="For example: Designer" /></label>
        <label className={css.field}>E-mail (optional)<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" placeholder="So they can sign in and answer in Pulse" /></label>
      </div>}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.actions}>
      <button type="button" className={gameCss.primary} disabled={busy || (mode === "pulse" && !who)} onClick={() => void next()}>{busy ? "Opening…" : "Next: the offer"}</button>
      <button type="button" className={gameCss.quiet} onClick={onBack}>Cancel</button>
    </div>
    {mode === "pulse" && !who && people ? <p className={css.hint}>Choose a person first.</p> : null}
    {pp ? <OfferForm p={pp} onClose={() => { setPp(null); onMade(); }} /> : null}
  </div>;
}

