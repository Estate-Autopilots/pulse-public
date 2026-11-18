"use client";
// CONTRACTS-2 (owner, 8 Nov 2026): the agreements list. Groups (Needs you, Waiting for the client, Signed, Ended), chips
// to show one group, and an empty state that says the three steps. "now" comes from the server render, so the words
// ("2 hours ago") are the same on the server and in the browser.
import Link from "next/link";
import { useState } from "react";
import { useOrgZone } from "../org-code";
import { StatTile, StatTiles } from "../kit/game";
import { rupees } from "../lib/game.mjs";
import { CheckCheck, Hourglass, IndianRupee } from "lucide-react";
import { GROUPS, grouped, stageOf } from "../lib/agreements.mjs";
import { AgreementRow, ContractCard, type Contract } from "./parts";
import css from "./contracts.module.css";

export function AgreementList({ company, mine, us, canMake, canManage, now, signedThisMonth = null }: { company: Contract[]; mine: Contract[]; us: string; canMake: boolean; canManage: boolean; now: number; signedThisMonth?: number | null }) {
  const zone = useOrgZone();
  const [show, setShow] = useState<string>("all");
  const stage = (c: Contract) => stageOf(c, us, now, zone);
  const groups = grouped(company, stage);
  const count = (key: string) => groups.find((g) => g.key === key)?.items.length ?? 0;
  if (canMake && !company.length) return <>
    <section className={css.emptyBig} aria-label="No agreements yet">
      <h2>No agreements yet</h2>
      <ol className={css.steps}>
        <li><strong>Pick a quotation or invoice.</strong> The agreement fills itself with the client, the items and the price.</li>
        <li><strong>Check it and send.</strong> You get a link to share on WhatsApp or e-mail.</li>
        <li><strong>The client signs on their phone.</strong> No account needed. You see when they open and sign it.</li>
      </ol>
      <div className={css.actions}>
        <Link href="/contracts/new" className={`${css.btn} ${css.primary}`}>New agreement</Link>
        {canManage ? <Link href="/contracts/templates" className={css.btn}>Set up your agreement template</Link> : null}
      </div>
    </section>
    {mine.length ? <Mine mine={mine} /> : null}
  </>;
  return <>
    {canMake ? <>
      {/* UX-GAMIFY (owner, 9 Nov 2026: "Contracts still seems less gamified"): Codex's concept 2, the agreements home:
          the numbers that matter as tiles, then VISUAL-QA's judged group chips with counts (LAND-CAPTAIN-10). */}
      <AgreementTiles company={company} signedThisMonth={signedThisMonth} waiting={count("waiting")} />
      {/* VISUAL-QA (round 2 judge): with one group the chips only repeated its heading ("Needs you 1" twice). */}
      {GROUPS.filter((g) => count(g.key)).length > 1 ? <div className={css.chips} role="group" aria-label="Show">
        <button type="button" aria-pressed={show === "all"} onClick={() => setShow("all")}>All <span>{company.length}</span></button>
        {GROUPS.filter((g) => count(g.key)).map((g) => <button key={g.key} type="button" aria-pressed={show === g.key} onClick={() => setShow(g.key)}>
          {g.label} <span>{count(g.key)}</span></button>)}
      </div> : null}
      {groups.filter((g) => show === "all" || g.key === show).map((g) => <section key={g.key} className={css.section} aria-label={g.label}>
        {show === "all" ? <div className={css.sectionHead}><h2>{g.label}</h2><span>{g.items.length}</span></div> : <h2 className={css.srOnly ?? ""} style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{g.label}</h2>}
        <div className={css.rows}>{g.items.map((c) => <AgreementRow key={c.key} contract={c} us={us} now={now} zone={zone} />)}</div>
      </section>)}
    </> : null}
    {mine.length ? <Mine mine={mine} /> : !canMake ? <p className={css.empty}>No agreement names you yet. When a company sends you one, it shows here.</p> : null}
  </>;
}

/** Tab names short enough for a phone (the section headings keep the full words). */

/** Waiting to sign, signed this month, and the money in signed agreements (one-off lines in rupees). */
function AgreementTiles({ company, signedThisMonth, waiting }: { company: Contract[]; signedThisMonth: number | null; waiting: number }) {
  const signed = company.filter((c) => c.status === "active" && c.currency === "INR");
  // As amountOf counts an agreement: its one-off and per-deliverable lines (a monthly fee is not a total).
  const money = signed.reduce((s, c) => s + c.rates.filter((r) => r.unit === "one_off" || r.unit === "deliverable").reduce((t, r) => t + r.amountMinor, 0), 0) / 100;
  return <StatTiles label="Agreements at a glance" min={180} pair>
    <StatTile label="Waiting to sign" value={waiting} icon={Hourglass} tone={waiting ? "warn" : undefined} />
    <StatTile label="Signed this month" value={signedThisMonth ?? 0} icon={CheckCheck} tone={signedThisMonth ? "good" : undefined} />
    <StatTile label="Money in signed deals" value={rupees(money)} icon={IndianRupee} />
  </StatTiles>;
}

function Mine({ mine }: { mine: Contract[] }) {
  return <section className={css.section} aria-label="Agreements that name you">
    <div className={css.sectionHead}><h2>Agreements that name you</h2><span>{mine.length}</span></div>
    <div className={css.grid}>{mine.map((c) => <ContractCard key={c.key} contract={c} />)}</div>
  </section>;
}
