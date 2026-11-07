"use client";
// CONNECTORS-CONTRACTS: a contract's page. Terms (managers edit them: after sending, a change is a new version every party
// accepts again), parties and who accepted which version, Accept for the viewer's own side, money under the contract
// (billed, paid, owed; managers record and mark paid), versions, and this company's own side (notes and links).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState, type FormEvent } from "react";
import { CheckCircle2, Circle, FolderKanban, ListChecks, ReceiptText } from "lucide-react";
import { post } from "../../orgs/client";
import { useOrgZone, useWords } from "../../org-code";
import { acceptanceWords, datesWords, KIND_WORDS, money, rateWords, ROLE_WORDS, SCHEDULE_WORDS, totalsWords, TXN_WORDS } from "../../lib/contracts.mjs";
import { PageHeader } from "../../ui";
import { StatusBadge, type ContractDetail } from "../parts";
import css from "../contracts.module.css";
import { DateField } from "../../kit/date-field";

const say = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const W = (m: Record<string, string>, k: string) => m[k] ?? k;
const stamp = (iso: string | null, timeZone: string) => iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone }) : "";

export function ContractView({ initial }: { initial: ContractDetail }) {
  const words = useWords();
  const zone = useOrgZone();
  const when = (iso: string | null) => stamp(iso, zone);
  const router = useRouter();
  const d = initial, c = d.contract;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const base = `contracts/${c.id ?? c.key}`;
  const live = c.status === "proposed" || c.status === "active";
  const manage = c.canManage && c.here;

  async function act(key: string, path: string, body: unknown = {}) {
    setBusy(key); setError(null);
    try { await post(path, body); router.refresh(); return true; } catch (e) { setError(say(e)); return false; } finally { setBusy(null); }
  }
  function saveTerms(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    const rates = text("rates").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [label, amount, unit] = l.split("|").map((s) => s.trim());
      return { label, amountMinor: Math.round(Number(amount || 0) * 100), unit: unit || "one_off" };
    });
    void act("terms", base, { title: text("title"), scope: text("scope"), deliverables: text("deliverables").split("\n").map((s) => s.trim()).filter(Boolean), rates,
      startsOn: text("startsOn") || null, endsOn: text("endsOn") || null, noticeDays: text("noticeDays") ? Number(text("noticeDays")) : null, schedule: text("schedule"),
      notes: text("notes") || null }).then((ok) => { if (ok) setEditing(false); });
  }
  function addTxn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    void act("txn", `${base}/transactions`, { kind: text("kind"), payerKey: text("payer"), payeeKey: text("payee"), label: text("label"),
      amountMinor: Math.round(Number(text("amount")) * 100), dueOn: text("dueOn") || undefined, status: text("paid") ? "paid" : "billed" });
  }

  const party = (key: string) => c.parties.find((p) => p.key === key)?.name ?? "—";
  return <div className={css.wrap}>
    <PageHeader title={c.title} back={{ href: "/contracts", label: "Contracts" }}
      context={[W(KIND_WORDS, c.kind), `Version ${c.version}`, c.heldBy && !c.here ? `Held by ${c.heldBy}` : null].filter(Boolean) as string[]} />
    <section className={css.panel} aria-label="Status">
      <div className={css.actions}><StatusBadge status={c.status} /><span className={css.hint}>{live ? acceptanceWords(c.parties) : datesWords(c)}</span></div>
      <div className={css.actions}>
        {c.canAccept ? <button type="button" className={`${css.btn} ${css.primary}`} disabled={!!busy} onClick={() => act("accept", `${base}/accept`)}>{`Accept version ${c.version}`}</button> : null}
        {manage && c.status === "draft" ? <button type="button" className={`${css.btn} ${css.primary}`} disabled={!!busy} onClick={() => act("send", `${base}/send`)}>Send for acceptance</button> : null}
        {manage && c.status !== "ended" && c.status !== "cancelled" ? <button type="button" className={css.btn} disabled={!!busy} onClick={() => setEditing(!editing)}>{editing ? "Stop changing" : "Change the terms"}</button> : null}
        {manage && live ? <button type="button" className={`${css.btn} ${css.quiet}`} disabled={!!busy} onClick={() => act("end", `${base}/end`, {})}>{c.status === "active" ? "End this contract" : "Cancel this contract"}</button> : null}
      </div>
      {manage && c.status !== "draft" && editing ? <p className={css.hint}>A change makes version {c.version + 1}: the parties accept it again.</p> : null}
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </section>

    {editing ? <form className={`${css.panel} ${css.form}`} onSubmit={saveTerms} aria-label="Change the terms">
      <label className={css.field}>Name<input name="title" defaultValue={c.title} required maxLength={160} /></label>
      <label className={css.field}>Scope<textarea name="scope" defaultValue={c.scope} maxLength={20000} /></label>
      <label className={css.field}>Deliverables <span className={css.hint}>One a line.</span><textarea name="deliverables" defaultValue={c.deliverables.join("\n")} /></label>
      <label className={css.field}>Rates <span className={css.hint}>One a line: label | amount in {c.currency} | month, hour, deliverable, one_off or percent</span>
        <textarea name="rates" defaultValue={c.rates.map((r) => `${r.label} | ${r.amountMinor / 100} | ${r.unit}`).join("\n")} /></label>
      <div className={css.row}>
        <label className={css.field}>Starts on<DateField name="startsOn" defaultValue={c.startsOn ?? ""}/></label>
        <label className={css.field}>Ends on<DateField name="endsOn" defaultValue={c.endsOn ?? ""}/></label>
        <label className={css.field}>Notice (days)<input name="noticeDays" type="number" min={0} max={3650} defaultValue={c.noticeDays ?? ""} /></label>
      </div>
      <label className={css.field}>Invoiced
        <select name="schedule" defaultValue={c.schedule}>{Object.entries(SCHEDULE_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </label>
      <label className={css.field}>Notes <span className={css.hint}>Only your company sees these.</span><textarea name="notes" defaultValue={c.side?.notes ?? ""} maxLength={5000} /></label>
      <div className={css.actions}><button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy === "terms"}>{busy === "terms" ? "Saving…" : "Save"}</button></div>
    </form> : <section className={css.panel} aria-label="Terms">
      <h2>Terms</h2>
      <dl className={css.facts}>
        <dt>Dates</dt><dd>{datesWords(c)}</dd>
        <dt>Invoiced</dt><dd>{W(SCHEDULE_WORDS, c.schedule)}</dd>
        {c.rates.map((r, i) => <Fragment key={i}><dt>{r.label}</dt><dd>{rateWords(r, c.currency)}</dd></Fragment>)}
      </dl>
      {c.scope ? <p className={css.terms}>{c.scope}</p> : <p className={css.hint}>No scope written yet.</p>}
      {c.deliverables.length ? <ul className={css.list}>{c.deliverables.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
    </section>}

    <section className={css.section} aria-label="Parties">
      <div className={css.sectionHead}><h2>Parties</h2></div>
      <ul className={css.list}>{c.parties.map((p) => <li key={p.key}>
        {p.current ? <CheckCircle2 size={18} aria-label="Accepted" /> : <Circle size={18} aria-label="Not accepted yet" />}
        <span className={css.itemText}>
          <strong>{p.name}{p.mine ? " (you)" : ""}</strong>
          <span>{[W(ROLE_WORDS, p.role), p.kind === "company" ? "Company" : "Person", p.onPulse ? null : "Off Vitals OS",
            p.acceptedAt ? `Accepted version ${p.acceptedVersion} on ${when(p.acceptedAt)}${p.acceptedBy ? ` by ${p.acceptedBy}` : ""}${p.acceptedNote ? ` (${p.acceptedNote})` : ""}` : "Not accepted yet"]
            .filter(Boolean).join(" · ")}</span>
        </span>
        {manage && live && !p.onPulse && !p.current ? <button type="button" className={css.btn} disabled={!!busy}
          onClick={() => { const note = window.prompt(`How did ${p.name} accept? (for example: signed PDF, 4 Nov)`); if (note) void act(`acc-${p.key}`, `${base}/accept`, { partyId: p.id, note }); }}>Record their acceptance</button> : null}
      </li>)}</ul>
    </section>

    <section className={css.section} aria-label="Money under this contract">
      <div className={css.sectionHead}><h2>Money</h2><span>{totalsWords(c.totals)}</span></div>
      {c.transactions.length ? <ul className={css.list}>{c.transactions.map((t) => <li key={t.key}>
        <ReceiptText size={16} aria-hidden="true" />
        <span className={css.itemText}>
          <strong>{`${t.label} · ${money(t.amountMinor, t.currency)}`}</strong>
          <span>{[W(TXN_WORDS, t.kind), `${party(t.payer)} pays ${party(t.payee)}`, t.status === "paid" ? `Paid ${t.paidOn ?? ""}` : t.status === "void" ? "Void" : t.dueOn ? `Due ${t.dueOn}` : "Billed"].join(" · ")}</span>
        </span>
        {manage && t.id && t.status === "billed" ? <button type="button" className={css.btn} disabled={!!busy} onClick={() => act(`paid-${t.key}`, `${base}/transactions/${t.id}`, { status: "paid" })}>Mark paid</button> : null}
      </li>)}</ul> : <p className={css.empty}>Nothing billed or paid under this contract yet.</p>}
      {manage && c.status !== "draft" ? <form className={`${css.panel} ${css.form}`} onSubmit={addTxn} aria-label="Record money">
        <div className={css.row}>
          <label className={css.field}>What<select name="kind">{Object.entries(TXN_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className={css.field}>Who pays<select name="payer">{c.parties.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select></label>
          <label className={css.field}>Who is paid<select name="payee" defaultValue={c.parties[0]?.key}>{c.parties.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select></label>
        </div>
        <div className={css.row}>
          <label className={css.field}>For<input name="label" required maxLength={160} placeholder="December retainer" /></label>
          <label className={css.field}>{`Amount (${c.currency})`}<input name="amount" type="number" min="0.01" step="0.01" required /></label>
          <label className={css.field}>Due on<DateField name="dueOn"/></label>
        </div>
        <label className={css.hint}><input type="checkbox" name="paid" value="1" /> Already paid</label>
        <div className={css.actions}><button type="submit" className={css.btn} disabled={busy === "txn"}>{busy === "txn" ? "Saving…" : "Record"}</button></div>
      </form> : null}
    </section>

    {manage ? <section className={css.section} aria-label="Linked work">
      <div className={css.sectionHead}><h2>{`Linked ${words.projects.toLowerCase()}, tasks, invoices and goals`}</h2><span>Only your company sees these</span></div>
      {d.links.length ? <ul className={css.list}>{d.links.map((l) => <li key={l.id}>
        {l.kind === "project" ? <FolderKanban size={16} aria-label={words.project} /> : l.kind === "task" ? <ListChecks size={16} aria-label="Task" /> : <ReceiptText size={16} aria-label="Invoice" />}
        <span className={css.itemText}>
          <Link href={l.kind === "project" ? `/projects/${l.refId}` : l.kind === "task" ? `/tasks/${l.refId}` : l.kind === "goal" ? `/goals/${l.refId}` : "/erp"}>{l.title}</Link>
          <span>{l.status ?? ""}</span>
        </span>
        <button type="button" className={`${css.btn} ${css.quiet}`} disabled={!!busy} onClick={() => act(`rm-${l.id}`, `${base}/links/${l.id}/remove`)}>Take off</button>
      </li>)}</ul> : <p className={css.empty}>{`Nothing linked yet. Link a ${words.project.toLowerCase()} from its page, or through the API (link_contract_work).`}</p>}
    </section> : null}

    {d.versions.length ? <section className={css.section} aria-label="Earlier versions">
      <div className={css.sectionHead}><h2>Earlier versions</h2></div>
      <ul className={css.list}>{d.versions.map((v) => <li key={v.version}>
        <span className={css.itemText}>
          <strong>{`Version ${v.version}`}</strong>
          <span>{`Changed ${when(v.changedAt)}${v.changedBy ? ` by ${v.changedBy}` : ""} · ${String((v.terms as { title?: string }).title ?? "")}`}</span>
        </span>
      </li>)}</ul>
    </section> : null}
  </div>;
}
