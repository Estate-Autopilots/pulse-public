"use client";
// CONTRACTS-2: pick the quotation or invoice the client accepted; the agreement is made from it with the company's
// template (the client's own variant when there is one). One main button. A blank agreement is the quiet second way.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, CheckCircle2 } from "lucide-react";
import { STARTER_AGREEMENT } from "@pulse/invoice-doc/browser";
import { post } from "../../orgs/client";
import { money } from "../../lib/contracts.mjs";
import { moneyFlow } from "../../lib/agreements.mjs";
import { WhoPays } from "../who-pays";
import { EmptyState } from "../../kit/game";
import { SelectField } from "../../kit/select-field";
import { getJson } from "../fetch";
import { NewContract } from "../new-contract";
import type { Choices } from "../parts";
import css from "../contracts.module.css";
import d3 from "../[id]/drafts.module.css";

export type DocChoice = { id: string; number: string | null; docType: string; status: string; date: string; dueDate?: string | null; total: number; client: string | null; project: string | null; agreementId: string | null };
export type TemplateChoice = { id: string; name: string; clientId: string | null; client: string | null; isDefault: boolean };
const DOC = { quotation: "Quotation", proforma: "Proforma", invoice: "Invoice" } as Record<string, string>;
const STATUS = { accepted: "Accepted by the client", issued: "Issued", sent: "Sent", part_paid: "Part paid", paid: "Paid", converted: "Turned into an invoice" } as Record<string, string>;
const day = (s: string) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

export function NewAgreement({ documents, templates, canManage, choices, docsError }: { documents: DocChoice[]; templates: TemplateChoice[]; canManage: boolean; choices: Choices; docsError: string | null }) {
  const router = useRouter();
  const [doc, setDoc] = useState<string | null>(documents.find((d) => !d.agreementId)?.id ?? null);
  const [template, setTemplate] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // CONTRACTS-3: /contracts/new?company=<handle> opens the blank agreement with that company picked.
  const company = useSearchParams().get("company");
  const [blank, setBlank] = useState((documents.length === 0 && !docsError) || !!company);
  const picked = documents.find((d) => d.id === doc) ?? null;
  // CONTRACTS-3: once one is picked, step 1 shows just that one ("Pick another" opens the list again).
  const [showAll, setShowAll] = useState(false);
  // What the client gets, in the quotation's own words (its first items), for "In return".
  const [items, setItems] = useState<{ id: string; text: string; rates: { label: string; amountMinor: number; unit: string }[] } | null>(null);
  const [changeTemplate, setChangeTemplate] = useState(false);
  useEffect(() => {
    if (!picked || picked.agreementId) return;
    let live = true;
    void getJson<{ values: Record<string, string> }>(`contracts/fill?documentId=${picked.id}`).then((r) => {
      // The quotation's own lines ("• Design (2 × ₹500): ₹1,000"): their names for "In return", their amounts as the parts.
      const lines = String(r.values.items ?? "").split("\n").map((l) => /^•\s*(.+?)(?:\s*\(.*\))?:\s*₹([\d,]+(?:\.\d{1,2})?)\s*$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m);
      const names = lines.map((m) => m[1].trim());
      const rates = lines.map((m) => ({ label: m[1].trim(), amountMinor: Math.round(Number(m[2].replace(/,/g, "")) * 100), unit: "one_off" }));
      if (live && names.length) setItems({ id: picked.id, rates, text: names.slice(0, 2).join(", ") + (names.length > 2 ? ` and ${names.length - 2} more` : "") });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [picked]);
  // Who pays whom for the picked document: the client pays us its total (the agreement shows the parts once made).
  const flow = useMemo(() => picked && !picked.agreementId ? moneyFlow({ kind: "services", schedule: "milestones", currency: "INR", rates: items?.id === picked.id ? items.rates : [], transactions: [],
    parties: [{ key: "us", role: "provider", name: choices.us.name }, { key: "them", role: "client", name: picked.client ?? "The client" }] },
  { total: Number(picked.total), dueDate: picked.dueDate ? String(picked.dueDate).slice(0, 10) : null, documentNumber: picked.number, documentType: picked.docType, documentId: picked.id }, "2000-01-01") : null, [picked, choices.us.name, items]);

  async function make() {
    if (!picked) { setError("Pick a quotation or invoice first."); return; }
    if (picked.agreementId) { router.push(`/contracts/${picked.agreementId}`); return; }
    setBusy(true); setError(null);
    try {
      // A company with no template yet starts with the simple standard one (it can change it later in Templates).
      if (!templates.length && canManage) await post("contracts/templates", { name: "Standard agreement", body: STARTER_AGREEMENT, source: "starter", isDefault: true });
      const r = await post<{ id: string }>("contracts/from-document", { documentId: picked.id, templateId: template || undefined });
      router.push(`/contracts/${r.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "That did not work. Try again."); setBusy(false); }
  }

  // CONTRACTS-3: one way at a time: a blank agreement replaces the quotation steps (one main button on the screen).
  if (blank && canManage) return <section className={`${css.section} ${d3.blankWrap}`} aria-label="Blank agreement">
    <NewContract choices={choices} startOpen onQuotation={documents.length ? () => setBlank(false) : undefined} />
    <div className={d3.fabRoom} aria-hidden="true" />
  </section>;
  return <>
    <section className={css.panel} aria-label="Start from a quotation or invoice">
      <h2>1. Which quotation or invoice is it for?</h2>
      {docsError ? <p className={css.error} role="alert">{docsError}</p> : null}
      {documents.length ? <div className={`${css.pickList}${picked && !showAll ? ` ${d3.oneCol}` : ""}`} role="radiogroup" aria-label="Quotations and invoices">
        {documents.filter((d) => showAll || !picked || d.id === picked.id).map((d) => <button key={d.id} type="button" role="radio" aria-checked={doc === d.id} className={`${css.pick} ${d3.pickPhone}`} onClick={() => { setDoc(d.id); setError(null); setShowAll(false); }}>
          <span className={css.pickTop}><strong>{d.client ?? "Client"}</strong><span>{money(Number(d.total), "INR")}</span></span>
          <span className={css.pickMeta}>{[`${DOC[d.docType] ?? d.docType} ${d.number ?? ""}`.trim(), d.project, day(d.date)].filter(Boolean).join(" · ")}</span>
          {d.agreementId ? <span className={d3.pickStatus}><span className={css.pill} data-tone="wait">Has an agreement · open it →</span></span>
            : <span className={d3.pickStatus}><span className={css.pill} data-tone={d.status === "accepted" ? "good" : undefined}>{STATUS[d.status] ?? d.status}</span></span>}
          {doc === d.id ? <CheckCircle2 className={css.pickTick} size={20} aria-hidden="true" /> : null}
        </button>)}
      </div> : null}
      {picked && !showAll && documents.length > 1 ? <button type="button" className={`${d3.linkBtn} ${d3.switchBtn}`} onClick={() => setShowAll(true)}><ArrowLeftRight size={15} aria-hidden="true" />{documents.length > 2 ? `Use a different quotation (${documents.length - 1} more)` : "Use a different quotation"}</button> : null}
      {documents.length ? null : !docsError ? <p className={css.empty}>No issued quotation or invoice yet. Make one in Billing, or start from a blank agreement below.</p> : null}
    </section>
    {/* CONTRACTS-3: nothing left to make one from: one clear way on (no dead end). */}
    {documents.length && !picked && documents.every((d) => d.agreementId) ? <EmptyState art="done" title="Every quotation here has its agreement"
      text="Pick one above to open its agreement. A new agreement starts from a new quotation."
      action={canManage ? { label: "Start a blank agreement", onClick: () => setBlank(true) } : { label: "Make a quotation", href: "/erp/new?type=quotation" }} /> : null}
    {documents.length && (picked || documents.some((d) => !d.agreementId)) ? <section className={css.panel} aria-label="Template">
      {picked?.agreementId ? <h2>This quotation has its agreement</h2> : <h2>{templates.length > 1 ? "2. Which agreement?" : "2. Check the agreement"}</h2>}
      {flow ? <WhoPays bare noDoc flow={flow} us={(k) => k === "us"} gets={items?.id === picked?.id ? items?.text : picked?.project ? `The work for ${picked.project}` : "The work in the quotation"} /> : null}
      {picked && !picked.agreementId ? <dl className={`${css.facts} ${d3.summaryFacts}`}>
        <dt>Quotation</dt><dd>{`${picked.number ?? ""}`.trim() || (DOC[picked.docType] ?? "Document")}</dd>
        <dt>Template</dt><dd>{templates.find((x) => x.id === template)?.name ?? (templates.find((x) => x.isDefault) ?? templates[0])?.name ?? "The simple standard one"}
          {templates.length > 1 && !changeTemplate ? <button type="button" className={d3.linkBtn} onClick={() => setChangeTemplate(true)}>Change</button>
            : templates.length <= 1 && canManage ? <Link className={d3.linkBtn} href="/contracts/templates">Change</Link> : null}</dd>
      </dl> : null}
      {picked?.agreementId ? <p className={css.hint}>Open it to see where it is, or pick another quotation above.</p> : templates.length > 1 && changeTemplate ? <label className={css.field}>Agreement template
        <SelectField value={template} onChange={(e) => setTemplate(e.target.value)}>
          <option value="">{"Client's own or the standard"}</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.client ? `${t.name} (for ${t.client})` : t.name}{t.isDefault ? " · standard" : ""}</option>)}
        </SelectField>
      </label> : templates.length ? null : canManage ? <p className={css.hint}>You have no template yet. We will use a simple standard agreement; you can change it any time in <Link href="/contracts/templates">Templates</Link>.</p>
        : <p className={css.error}>Your company has no agreement template yet. Ask an admin to add one in Agreements → Templates.</p>}
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      <div className={css.actions}>
        <button type="button" className={`${css.btn} ${css.primary} ${d3.fullOnPhone}`} disabled={busy || !picked || (!templates.length && !canManage)} onClick={make}>
          {busy ? "Making it…" : picked?.agreementId ? "Open its agreement" : "Make the agreement"}</button>
        {picked?.agreementId ? null : <span className={d3.sendNote}>Nothing is sent yet. You check it first.</span>}
      </div>
    </section> : null}
    {canManage ? <section className={css.section} aria-label="Blank agreement">
      <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setBlank(true)}>Or start from a blank agreement</button>
    </section> : null}
    <div className={d3.fabRoom} aria-hidden="true" />
  </>;
}
