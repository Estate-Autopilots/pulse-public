"use client";
// CONTRACTS-PRO (owner, 15 Nov 2026): "editing like Google Docs". One page: the words on the left as clause cards
// (clause-editor.tsx: Point, Bold, a field, a standard clause; move, take out), the parties and the deal's fields beside
// them, and on the right the document exactly as the PDF will print it, redrawn as you type. Numbers are never typed:
// "Clause" adds a heading and the document numbers it (1, 1.1, (a)), so moving a clause renumbers everything.
// Saving after sending makes a new draft (the old one is kept and compared word by word in Drafts).
import { useMemo, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { CONTRACT_TYPES, contractType, DEAL_FIELDS, emptyFields, fieldLabel, PARTY_TYPES, readSource, starterText, tidyMeta, writeSource,
  type ContractMeta, type ContractPartyFacts } from "@pulse/invoice-doc/browser";
import { post } from "../../orgs/client";
import type { Party } from "../parts";
import { ClauseEditor } from "./clause-editor";
import { LivePaper } from "./document-pane";
import css from "../contracts.module.css";
import pro from "./pro.module.css";

const say = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const KIND_TYPE: Record<string, string> = { retainer: "service", services: "service", employment: "offer", equity: "founders", revenue_share: "service" };
const ROLE_DEFINED: Record<string, string> = { provider: "Provider", client: "Client", employer: "Company", employee: "Employee", partner: "Party" };

/** The facts of an older agreement (no first line yet), from its signing rows. */
function metaFrom(kind: string, parties: Party[]): ContractMeta {
  return tidyMeta({ type: KIND_TYPE[kind] ?? "service", parties: parties.map((p) => ({ key: p.key, name: p.name, type: p.kind === "person" ? "individual" : "private_limited",
    defined: ROLE_DEFINED[p.role] ?? "Party", role: p.role, signatory: p.signer ?? "" })), deal: {} });
}

export type ClauseNote = { id: string; clause: string | null; body: string; by: string; at: string };
export function ContractEditor({ id, base, title, body, kind, parties, sent, notes = [], onDone, onCancel }: { id: string; base: string; title: string; body: string; kind: string; parties: Party[];
  notes?: ClauseNote[];
  sent: boolean; onDone: () => void; onCancel: () => void }) {
  const first = useMemo(() => readSource(body), [body]);
  const [t, setT] = useState(title);
  const [meta, setMeta] = useState<ContractMeta>(() => first.meta ?? metaFrom(kind, parties));
  const [text, setText] = useState(first.text);
  const [tab, setTab] = useState<"words" | "parties" | "details">("words");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = useMemo(() => writeSource(meta, text), [meta, text]);
  const gaps = useMemo(() => emptyFields(source), [source]);
  const type = contractType(meta.type);

  const setParty = (i: number, patch: Partial<ContractPartyFacts>) => setMeta((m) => ({ ...m, parties: m.parties.map((p, k) => (k === i ? { ...p, ...patch } : p)) }));
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { await post(`${base}/words`, { title: t, body: source }); onDone(); } catch (x) { setError(say(x)); setBusy(false); }
  }

  return <form className={pro.editor} onSubmit={save} aria-label="Edit the agreement">
    <div className={pro.editPane}>
      <div className={pro.editHead}>
        <div className={pro.editTop}>
          <h2>Edit the agreement</h2>
          <a href="#live-preview" className={pro.toPreview}>See the preview</a>
          <span className={pro.editButtons}>
            <button type="button" className={`${css.btn} ${css.quiet} ${pro.outline}`} onClick={onCancel}>Cancel</button>
            <button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy}>{busy ? "Saving…" : sent ? "Save as a new draft" : "Save"}</button>
          </span>
        </div>
        <label className={css.field}>Name<input value={t} onChange={(e) => setT(e.target.value)} maxLength={160} required /></label>
        <div className={pro.tabs} role="tablist" aria-label="What to edit">
          {([["words", "Words"], ["parties", `Parties (${meta.parties.length})`], ["details", "Deal"]] as const).map(([k, l]) =>
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      </div>

      {tab === "words" ? <>
        {text.trim() ? <ClauseEditor text={text} meta={meta} onChange={setText} notes={notes} base={base} />
          : <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => setText(starterText(meta.type))}>{`Start from a standard ${type.short.toLowerCase()}`}</button>}
        <p className={css.hint}>Numbers are added for you. Points become (a), (b). The preview shows the agreement exactly as it will print.</p>
      </> : null}

      {tab === "parties" ? <div className={pro.partyList}>
        <p className={css.hint}>Each party once, with its full legal name. Its short name (“the Company”) is used in the words.</p>
        <label className={pro.check}><input type="checkbox" checked={!!meta.ordered} onChange={(e) => setMeta((m) => ({ ...m, ordered: e.target.checked }))} />
          Sign one after another, in this order (each party can sign only after the ones above it)</label>
        {meta.parties.map((p, i) => <fieldset key={i} className={pro.partyCard}>
          <legend>{`Party ${i + 1}${p.defined ? `: the ${p.defined.replace(/^the\s+/i, "")}` : ""}${meta.ordered ? ` · signs ${["first", "second", "third", "fourth", "fifth"][i] ?? `${i + 1}th`}` : ""}`}</legend>
          <label className={css.field}>Full legal name<input value={p.name} onChange={(e) => setParty(i, { name: e.target.value })} maxLength={160} placeholder="Harbor Builders LLP" /></label>
          <div className={css.row}>
            <label className={css.field}>What it is<select value={p.type} onChange={(e) => setParty(i, { type: e.target.value })}>{PARTY_TYPES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></label>
            <label className={css.field}>Short name in the words<input value={p.defined} onChange={(e) => setParty(i, { defined: e.target.value })} maxLength={40} placeholder="Client" /></label>
          </div>
          <label className={css.field}>{p.type === "individual" ? "Lives at" : "Registered office"}<input value={p.address ?? ""} onChange={(e) => setParty(i, { address: e.target.value })} maxLength={300} /></label>
          <div className={css.row}>
            <label className={css.field}>{PARTY_TYPES.find((x) => x.key === p.type)?.reg || "Registration no."}<input value={p.reg ?? ""} onChange={(e) => setParty(i, { reg: e.target.value })} maxLength={40} /></label>
            <label className={css.field}>Who signs<input value={p.signatory ?? ""} onChange={(e) => setParty(i, { signatory: e.target.value })} maxLength={120} placeholder="Full name" /></label>
            <label className={css.field}>{p.type === "individual" ? "Role" : "Their title"}<input value={p.title ?? ""} onChange={(e) => setParty(i, { title: e.target.value })} maxLength={80} placeholder={p.type === "individual" ? "Founder" : "Director"} /></label>
          </div>
          {meta.parties.length > 1 ? <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setMeta((m) => ({ ...m, parties: m.parties.filter((_, k) => k !== i) }))}><Trash2 size={16} aria-hidden="true" />Take this party out</button> : null}
        </fieldset>)}
        <button type="button" className={css.btn} onClick={() => setMeta((m) => ({ ...m, parties: [...m.parties, { name: "", type: "private_limited", defined: `Party ${m.parties.length + 1}` }] }))}><Plus size={16} aria-hidden="true" />Add a party</button>
      </div> : null}

      {tab === "details" ? <div className={pro.partyList}>
        <div className={css.row}>
          <label className={css.field}>Kind of agreement<select value={meta.type} onChange={(e) => setMeta((m) => ({ ...m, type: e.target.value }))}>{CONTRACT_TYPES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></label>
        </div>
        <div className={css.row}>
          <label className={css.field}>Made on (leave empty: the day the last party signs)<input value={meta.date ?? ""} onChange={(e) => setMeta((m) => ({ ...m, date: e.target.value }))} placeholder="2026-11-15" maxLength={40} /></label>
          <label className={css.field}>At (city)<input value={meta.place ?? ""} onChange={(e) => setMeta((m) => ({ ...m, place: e.target.value }))} placeholder="Pune" maxLength={80} /></label>
        </div>
        <h3 className={pro.subhead}>The deal</h3>
        {[...new Set([...type.fields, ...Object.keys(meta.deal)])].map((k) => <label key={k} className={css.field}>{DEAL_FIELDS[k]?.label ?? fieldLabel(`deal.${k}`, meta)}
          <input value={meta.deal[k] ?? ""} onChange={(e) => setMeta((m) => ({ ...m, deal: { ...m.deal, [k]: e.target.value } }))} placeholder={DEAL_FIELDS[k]?.hint ?? ""} maxLength={400} /></label>)}
      </div> : null}

      {gaps.length ? <p className={pro.gaps}>{`Still to fill before sending: ${gaps.map((g) => fieldLabel(g, meta)).join(", ")}.`}</p> : null}
      {sent ? <p className={css.hint}>Saving makes a new draft. Everyone signs the new draft again; the old one is kept.</p> : null}
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </div>
    <LivePaper id={id} title={t} body={source} />
  </form>;
}
