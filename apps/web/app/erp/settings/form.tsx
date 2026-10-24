"use client";

// BILLING-SETUP (18 Oct 2026, EST-1361): Billing settings in sections with one main button. Company, numbering, taxes
// and defaults save through /erp/settings as before; the industry pack and the field list through /erp/setup
// (services/api/src/billing-setup.ts). Choosing a pack opens a sheet that lists exactly what it changes; the switches
// below it then override the pack. Without /erp/setup (an API that has not been updated yet) the pack and fields show
// today's screens and cannot be changed.
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Check, Download, Save } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { DOC_LABELS, financialYear, formatDocNumber, numberProblem, STATES, stateFromGstin, validGstin, type DocType } from "@pulse/invoice-doc/browser";
import { Drawer, DrawerFooter, DrawerSection } from "../../kit/drawer";
import { ChainBar, NextStep } from "../../kit/next-step";
import { post } from "../../records";
import { Badge, styles } from "../../ui";
import type { Company } from "../types";
import { BILLING_FIELDS, BILLING_PACKS, UNAVAILABLE_FIELDS, effectiveFields, FIELD_GROUPS, packOf, type BillingPack, type BillingSetup, type FieldKey, type PackId } from "./fields";
import s from "./settings.module.css";

export type Series = { docType: DocType; fy: string; pattern: string; nextNo: number; lastDate: string | null };
const DEFAULTS: Record<DocType, string> = { invoice: "INV/{FY}/{N:4}", proforma: "PI/{FY}/{N:4}", quotation: "QT/{FY}/{N:4}", credit_note: "CN/{FY}/{N:4}" };
const KINDS: DocType[] = ["quotation", "proforma", "invoice", "credit_note"];
const STATE_OPTIONS = Object.entries(STATES).filter(([c]) => c !== "96").sort((a, b) => a[1].name.localeCompare(b[1].name));
const KIND_WORD: Record<string, string> = { product: "products", service: "services", consumable: "consumables", package: "packages" };
const message = (e: unknown) => (e instanceof Error ? e.message : "Could not save");
export const SECTIONS = [["company", "Company"], ["numbering", "Numbering"], ["taxes", "Taxes & defaults"], ["pack", "Industry pack"], ["fields", "Fields"], ["exports", "Exports"]] as const;

function Toggle({ label, sub, on, onChange, mark, disabled }: { label: string; sub?: string; on: boolean; onChange: (on: boolean) => void; mark?: string; disabled?: boolean }) {
  return <label className={s.toggle}><span className={s.toggleText}>{label}{sub ? <small>{sub}</small> : null}</span>{mark ? <span className={s.mark}>{mark}</span> : null}
    <input type="checkbox" role="switch" className={s.switch} checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /></label>;
}
function Section({ id, title, sub, children }: { id: string; title: string; sub?: string; children: ReactNode }) {
  return <section className={s.card} id={id} aria-labelledby={`${id}-h`}><div className={s.head}><h2 id={`${id}-h`}>{title}</h2>{sub ? <small>{sub}</small> : null}</div>{children}</section>;
}

/** What a pack changes against the switches and stock as they are now. */
function packChanges(pack: BillingPack | null, fields: Record<FieldKey, boolean>, inventory: boolean) {
  const next = effectiveFields(pack?.id ?? null, {});
  const on = BILLING_FIELDS.filter((f) => !UNAVAILABLE_FIELDS.includes(f.key) && next[f.key] && !fields[f.key]).map((f) => f.label);
  const off = BILLING_FIELDS.filter((f) => !UNAVAILABLE_FIELDS.includes(f.key) && !next[f.key] && fields[f.key]).map((f) => f.label);
  const stock = pack && pack.inventory !== inventory ? pack.inventory : null;
  return { next, on, off, stock };
}

export function BillingSettings({ company, inventoryEnabled, dueDays, roundTotal, series, fy, today, canWrite, setup }: {
  company: Company; inventoryEnabled: boolean; dueDays: number; roundTotal: boolean; series: Series[]; fy: string; today: string; canWrite: boolean; setup: BillingSetup | null;
}) {
  const router = useRouter();
  const first = { legalName: company.legalName ?? "", tradeName: company.tradeName ?? "", gstin: company.gstin ?? "", stateCode: company.stateCode ?? "27", address: (company.address ?? []).join("\n"),
    email: company.email ?? "", phone: company.phone ?? "", website: company.website ?? "" };
  const [co, setCo] = useState(first);
  const [inv, setInv] = useState(inventoryEnabled), [days, setDays] = useState(dueDays), [round, setRound] = useState(roundTotal);
  const current = Object.fromEntries(KINDS.map((k) => [k, series.find((x) => x.docType === k && x.fy === fy)])) as Record<DocType, Series | undefined>;
  const firstPatterns = Object.fromEntries(KINDS.map((k) => [k, current[k]?.pattern ?? DEFAULTS[k]])) as Record<DocType, string>;
  const [patterns, setPatterns] = useState(firstPatterns);
  const firstPack = (setup?.pack ?? null) as PackId | null, firstFields = setup?.fields ?? effectiveFields(null, {});
  const [pack, setPack] = useState<PackId | null>(firstPack), [fields, setFields] = useState<Record<FieldKey, boolean>>(firstFields);
  const [asking, setAsking] = useState<BillingPack | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const year = financialYear(today);
  const gstinBad = !!co.gstin && !validGstin(co.gstin);
  const settingsChanged = JSON.stringify([co, inv, days, round, patterns]) !== JSON.stringify([first, inventoryEnabled, dueDays, roundTotal, firstPatterns]);
  const setupChanged = !!setup && JSON.stringify([pack, fields]) !== JSON.stringify([firstPack, firstFields]);
  const changes = (settingsChanged ? 1 : 0) + (setupChanged ? 1 : 0);
  const chosen = packOf(pack);
  const base = effectiveFields(pack, {});
  const state = STATES[co.stateCode]?.name ?? "your state";
  const blocker = !co.legalName.trim() ? "Fill in the company's legal name" : gstinBad ? "Fix the GSTIN" : KINDS.map((k) => numberProblem(patterns[k], year)).find(Boolean) ?? null;

  async function save() {
    setBusy(true);
    try {
      if (settingsChanged) {
        const changed = Object.fromEntries(KINDS.filter((k) => patterns[k] !== firstPatterns[k] || !current[k]).filter((k) => (current[k]?.nextNo ?? 1) === 1).map((k) => [k, patterns[k]]));
        await post("erp/settings", { company: { ...co, address: co.address.split("\n") }, inventoryEnabled: inv, dueDays: days, roundTotal: round, patterns: changed });
      }
      if (setupChanged) await post("erp/setup", { pack, fields });
      notify({ id: "erp-settings", tone: "success", title: "Settings saved", timeout: 2500 }); router.refresh();
    } catch (e) { notify({ id: "erp-settings", tone: "error", title: "Not saved", message: message(e) }); } finally { setBusy(false); }
  }
  function applyPack(p: BillingPack | null) {
    const c = packChanges(p, fields, inv);
    setPack(p?.id ?? null); setFields(c.next);
    if (c.stock !== null) setInv(c.stock);
    setAsking(undefined);
  }
  const ask = asking === undefined ? null : packChanges(asking, fields, inv);

  return <div className={s.page}>
    <nav className={s.jump} aria-label="Settings sections">{SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
    <fieldset disabled={!canWrite} style={{ display: "contents" }}>
      <Section id="company" title="Company" sub="Printed on every document">
        <div className={s.fields}>
          <label className={`${styles.field} ${s.wide}`}>Legal name<input value={co.legalName} onChange={(e) => setCo({ ...co, legalName: e.target.value })} /></label>
          <label className={styles.field}>Trade name<input value={co.tradeName} onChange={(e) => setCo({ ...co, tradeName: e.target.value })} /></label>
          <label className={styles.field}>GSTIN<input value={co.gstin} maxLength={15} autoCapitalize="characters" onChange={(e) => { const g = e.target.value.toUpperCase(); setCo({ ...co, gstin: g, stateCode: validGstin(g) ? stateFromGstin(g)! : co.stateCode }); }} />
            <span className={`${s.hint} ${gstinBad ? s.bad : co.gstin ? s.good : ""}`}>{gstinBad ? "Not a valid GSTIN" : co.gstin ? `Valid · PAN ${co.gstin.slice(2, 12)}` : "Needed for a tax invoice"}</span></label>
          <label className={styles.field}>State<select value={co.stateCode} disabled={!!co.gstin && !gstinBad} onChange={(e) => setCo({ ...co, stateCode: e.target.value })}>{STATE_OPTIONS.map(([c, x]) => <option key={c} value={c}>{x.name} ({c})</option>)}</select></label>
          <label className={`${styles.field} ${s.wide}`}>Address<textarea rows={2} value={co.address} onChange={(e) => setCo({ ...co, address: e.target.value })} /></label>
          <label className={styles.field}>Billing e-mail<input type="email" inputMode="email" value={co.email} onChange={(e) => setCo({ ...co, email: e.target.value })} /></label>
          <label className={styles.field}>Phone<input type="tel" inputMode="tel" value={co.phone} onChange={(e) => setCo({ ...co, phone: e.target.value })} /></label>
          <label className={styles.field}>Website<input value={co.website} onChange={(e) => setCo({ ...co, website: e.target.value })} /></label>
        </div>
      </Section>

      <Section id="numbering" title="Numbering" sub={`FY ${fy} · {FY} = ${year.short}, {N:4} = 0001; up to 16 characters`}>
        <div className={s.fields}>{KINDS.map((k) => {
          const x = current[k], problem = numberProblem(patterns[k], year), started = (x?.nextNo ?? 1) > 1;
          return <label key={k} className={styles.field}>{DOC_LABELS[k].title}<input value={patterns[k]} disabled={started} onChange={(e) => setPatterns({ ...patterns, [k]: e.target.value })} />
            <span className={`${s.hint} ${problem ? s.bad : ""}`}>{problem ?? (started ? `Next: ${formatDocNumber(x!.pattern, year, x!.nextNo)} · last dated ${x!.lastDate}` : `First: ${formatDocNumber(patterns[k], year, 1)}`)}</span></label>;
        })}</div>
        <p className={s.quiet}>A document gets its number when it is issued, in order, never reused. Each kind has its own series per financial year (April to March); a started series keeps its pattern until next April.</p>
      </Section>

      <Section id="taxes" title="Taxes & defaults">
        <p className={s.quiet}>GST is worked out from the company&apos;s state: <b>CGST + SGST</b> for a client in {state}, <b>IGST</b> for a client in another state.</p>
        <div className={s.fields}><label className={styles.field}>Payment due after (days)<input type="number" inputMode="numeric" min={0} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label></div>
        <div className={s.toggles}>
          <Toggle label="Round totals to the rupee" sub="A round-off line of up to 50 paise" on={round} onChange={setRound} />
          <Toggle label="Keep stock" sub="Products and consumables count in and out; an issued invoice moves its stock out" on={inv} onChange={setInv} />
          {inv ? <Toggle label="Refuse an invoice when stock is short" sub={setup ? "Off: the invoice goes out and stock shows below zero until it is recorded in" : "Arrives with the next Pulse update"}
            on={fields.blockShortStock} disabled={!setup} onChange={(on) => setFields({ ...fields, blockShortStock: on })} /> : null}
        </div>
      </Section>

      <Section id="pack" title="Industry pack" sub="The starting shape of documents and the catalogue">
        {!setup ? <p className={s.warn}>Industry packs arrive with the next Pulse update. Until then every screen stays as it is today.</p> : null}
        <div className={s.packs}>
          {BILLING_PACKS.map((p) => <button key={p.id} type="button" className={s.pack} aria-pressed={pack === p.id} disabled={!setup || !p.ready || !canWrite}
            onClick={() => (pack === p.id ? undefined : setAsking(p))}>
            <span className={s.packTop}>{p.name}{p.ready ? (pack === p.id ? <Check size={16} aria-hidden="true" /> : null) : <Badge>Coming</Badge>}</span>
            <small>{p.example}</small>
            <span className={s.line}>{p.chain.map((c) => c.label).join(" → ")}</span>
            <small>A line shows {p.line.charAt(0).toLowerCase() + p.line.slice(1)}</small>
          </button>)}
        </div>
        {chosen ? <div className={s.chosen}>
          <ChainBar steps={chosen.chain.map((c) => ({ key: c.step, label: c.label }))} current="" label={`${chosen.name} documents`} />
          <p className={s.quiet}>New items start as {KIND_WORD[chosen.defaultKind]}. Unavailable pack fields are listed below.
            {setup?.packBy && pack === firstPack ? ` Chosen by ${setup.packBy}.` : ""}</p>
          {canWrite && setup ? <div><button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setAsking(null)}>Use no pack</button></div> : null}
        </div> : <p className={s.quiet}>No pack chosen: every field shows as it does today. A pack is only the starting point; the switches below override it.</p>}
      </Section>

      <Section id="fields" title="Fields" sub="Hiding a field keeps its saved value. Unavailable fields cannot be switched on yet.">
        {FIELD_GROUPS.map((g) => {
          const list = BILLING_FIELDS.filter((f) => f.group === g.key && f.key !== "blockShortStock");   // under Keep stock instead
          return <div key={g.key} className={s.group}>
            <p className={s.groupHead}>{g.label}<span>{list.filter((f) => !UNAVAILABLE_FIELDS.includes(f.key) && fields[f.key]).length} of {list.filter((f) => !UNAVAILABLE_FIELDS.includes(f.key)).length} on</span></p>
            <div className={s.toggles}>{list.map((f) => <Toggle key={f.key} label={f.label} sub={UNAVAILABLE_FIELDS.includes(f.key) ? "Unavailable in the composer and catalogue" : `${f.shows} · ${f.hint}`} on={!UNAVAILABLE_FIELDS.includes(f.key) && fields[f.key]} disabled={!setup || UNAVAILABLE_FIELDS.includes(f.key)}
              mark={setup && !UNAVAILABLE_FIELDS.includes(f.key) && fields[f.key] !== base[f.key] ? "Your choice" : undefined} onChange={(on) => setFields({ ...fields, [f.key]: on })} />)}</div>
          </div>;
        })}
      </Section>
    </fieldset>

    {canWrite ? <NextStep status={blocker ?? (changes ? "Unsaved changes" : "Everything is saved")} tone={blocker ? "warning" : "info"}
      primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !changes || !!blocker} onClick={save}>
        {changes ? <Save size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{changes ? "Save settings" : "Saved"}</button>} /> : null}

    {asking !== undefined && ask ? <Drawer title={asking ? `Use the ${asking.name} pack?` : "Use no pack?"} context={asking ? asking.example : "Every field as today"} onClose={() => setAsking(undefined)} snap="half"
      footer={<DrawerFooter tone="info" status="Nothing is saved until you press Save settings" primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => applyPack(asking)}>{asking ? "Use this pack" : "Use no pack"}</button>}>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setAsking(undefined)}>Cancel</button></DrawerFooter>}>
      {asking ? <DrawerSection title="Documents"><ChainBar steps={asking.chain.map((c) => ({ key: c.step, label: c.label }))} current="" /></DrawerSection> : null}
      <DrawerSection title="Turns on">{ask.on.length ? <ul className={s.list}>{ask.on.map((x) => <li key={x}>{x}</li>)}</ul> : <p className={s.quiet}>Nothing new</p>}</DrawerSection>
      <DrawerSection title="Turns off">{ask.off.length ? <ul className={s.list}>{ask.off.map((x) => <li key={x}>{x}</li>)}</ul> : <p className={s.quiet}>Nothing</p>}</DrawerSection>
      {asking ? <DrawerSection title="Catalogue and stock"><p className={s.quiet}>New items start as {KIND_WORD[asking.defaultKind]}.{ask.stock === true ? " Stock is kept from now on." : ask.stock === false ? " Stock stops being kept." : ""}</p></DrawerSection> : null}
      <p className={s.quiet}>Your own switches go back to the pack&apos;s starting set; you can change any of them afterwards.</p>
    </Drawer> : null}
  </div>;
}

export function Exports({ fy }: { fy: { start: string; end: string } }) {
  const [from, setFrom] = useState(fy.start), [to, setTo] = useState(fy.end);
  const q = `?from=${from}&to=${to}`;
  return <section className={s.card} id="exports" aria-labelledby="exports-h">
    <div className={s.head}><h2 id="exports-h">Exports for the books</h2><small>Issued invoices and credit notes</small></div>
    <div className={s.fields}>
      <label className={styles.field}>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className={styles.field}>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
    </div>
    <div className={s.actions}>
      <a className={styles.btn} href={`/api/v0/erp/exports/sales-register${q}`}><Download size={14} aria-hidden="true" />Sales register (CSV)</a>
      <a className={styles.btn} href={`/api/v0/erp/exports/zoho-books${q}`}><Download size={14} aria-hidden="true" />Zoho Books invoices (CSV)</a>
      <a className={styles.btn} href={`/api/v0/erp/exports/tally${q}`}><Download size={14} aria-hidden="true" />Tally vouchers (XML)</a>
    </div>
    <p className={s.quiet}>Tally: Gateway → Import → Vouchers. Ledgers used: the client&apos;s name, <b>Sales - Services</b>, <b>Output CGST/SGST/IGST</b> and <b>Round Off</b>; create them in Tally first or rename them there. Zoho Books: Sales → Invoices → Import, with tax names GST18/IGST18.</p>
  </section>;
}
