"use client";

// BILLING-SETUP (18 Oct 2026): a template in three choices, no form. 1 · Look (classic, bold band or minimal, and a
// text size), 2 · Colour (offered from the company's logo first), 3 · Print these blocks (the main six switches; the
// rest behind "More blocks"). Wording of terms, the bank block, the signature, the footer and titles wait under
// "Fine-tune". The real PDF of a sample document is beside the choices on a computer and in a sheet at the bottom of
// a phone, redrawn on every change: what you see is what is exported. Same design model and API as before.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Archive, Check, ImagePlus, Save, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { DOC_LABELS, normaliseDesign, sampleDocument, type DocType, type ShowKey } from "@pulse/invoice-doc/browser";
import { Disclosure } from "../../../kit/disclosure";
import { Drawer, DrawerFooter, useIsPhone } from "../../../kit/drawer";
import { NextStep } from "../../../kit/next-step";
import { post } from "../../../records";
import { styles } from "../../../ui";
import { LivePreview } from "../../preview";
import { TYPE_LABEL } from "../../nav";
import type { Company, Template } from "../../types";
import { logoColours } from "../logo-colour";
import t from "../templates.module.css";
import { SelectField } from "../../../kit/select-field";

const KINDS: DocType[] = ["invoice", "proforma", "quotation", "credit_note"];
const plural = (k: DocType) => `${TYPE_LABEL[k].toLowerCase()}s`;
const LOOKS = [{ style: "line", label: "Classic", sub: "A thin rule in your colour" }, { style: "band", label: "Bold band", sub: "Your colour across the top" },
  { style: "minimal", label: "Minimal", sub: "Quiet, almost no colour" }] as const;
const SIZES = [{ scale: 0.9, label: "Compact" }, { scale: 1, label: "Regular" }, { scale: 1.1, label: "Large" }];
const ACCENTS = ["#5b45d6", "#1f2a44", "#0f766e", "#2563eb", "#b45309", "#be123c", "#111827"];
const BLOCKS: Record<ShowKey, [string, string]> = {
  bank: ["Bank details", "Account, IFSC and UPI, on invoices, proformas and quotations"], taxSummary: ["HSN/SAC tax summary", "Taxable value and GST per code"],
  words: ["Amount in words", "Rupees … only, under the total"], signature: ["Signature", "For the company, authorised signatory"],
  terms: ["Terms", "The wording is under Fine-tune"], discount: ["Discount column", "A column for line discounts"],
  sac: ["SAC/HSN column", "The code on every line"], qtyRate: ["Quantity and rate", "Columns beside the amount"], lineTax: ["Tax on every line", "GST per line as well as in the total"],
  placeOfSupply: ["Place of supply", "The state the tax follows"], dueDate: ["Due date", "When payment is due"], project: ["Project", "The project the document is for"],
  contact: ["Billing contact", "The client's contact person"], notes: ["Notes", "The document's own note"], pageNumbers: ["Page numbers", "Page 1 of 2"],
  balance: ["Received and balance", "Payments so far and what is due"],
};
const MAIN: ShowKey[] = ["bank", "taxSummary", "words", "signature", "terms", "discount"];
const MORE: ShowKey[] = ["sac", "qtyRate", "lineTax", "placeOfSupply", "dueDate", "project", "contact", "notes", "pageNumbers", "balance"];
const message = (e: unknown) => (e instanceof Error ? e.message : "Could not save");

async function upload(kind: "logo" | "signature", file: File) {
  if (!["image/png", "image/jpeg"].includes(file.type)) throw new Error("Use a PNG or JPEG image");
  if (file.size > 400000) throw new Error("Images up to 400 KB");
  const data = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.onerror = () => no(new Error("Could not read the file")); r.readAsDataURL(file); });
  return (await post<{ id: string }>("erp/assets", { kind, mime: file.type, data })).id;
}

function Step({ n, title, sub, children }: { n: number; title: string; sub?: string; children: ReactNode }) {
  return <section className={t.card} aria-label={title}>
    <h3 className={t.stepHead}><span className={t.stepNo} aria-hidden="true">{n}</span>{title}{sub ? <small>{sub}</small> : null}</h3>
    {children}
  </section>;
}
function Toggle({ label, sub, on, onChange }: { label: string; sub?: string; on: boolean; onChange: (on: boolean) => void }) {
  return <label className={t.toggle}><span className={t.toggleText}>{label}{sub ? <small>{sub}</small> : null}</span>
    <input type="checkbox" role="switch" className={t.switch} checked={on} onChange={(e) => onChange(e.target.checked)} /></label>;
}

export function TemplateEditor({ template, company, orgLogo, canWrite }: { template: Template; company: Company; orgLogo: boolean; canWrite: boolean }) {
  const router = useRouter();
  const phone = useIsPhone();
  const [name, setName] = useState(template.name);
  const [design, setDesign] = useState(() => normaliseDesign(template.design));
  const [docTypes, setDocTypes] = useState<DocType[]>(template.docTypes);
  const savedDefaults = template.defaultFor ?? [];
  const [defaults, setDefaults] = useState<DocType[]>(savedDefaults);
  const [logoId, setLogoId] = useState(template.logoId), [signatureId, setSignatureId] = useState(template.signatureId);
  const [kind, setKind] = useState<DocType>(savedDefaults[0] ?? template.docTypes[0] ?? "invoice"), [inter, setInter] = useState(false);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [fromLogo, setFromLogo] = useState<string[]>([]);
  const d = <K extends keyof typeof design>(k: K, v: (typeof design)[K]) => { setDesign((x) => ({ ...x, [k]: v })); setDirty(true); };
  const show = (k: ShowKey, on: boolean) => d("show", { ...design.show, [k]: on });
  const sample = useMemo(() => sampleDocument(company.legalName ? company : null, { docType: kind, inter, number: null }), [company, kind, inter]);
  const logoSrc = logoId ? `/api/v0/erp/assets/${logoId}` : orgLogo ? "/api/v0/erp/assets/org-logo" : null;
  useEffect(() => {
    let gone = false;
    logoColours(logoSrc).then((c) => { if (!gone) setFromLogo(c.filter((x) => !ACCENTS.includes(x))); }).catch(() => undefined);
    return () => { gone = true; };
  }, [logoSrc]);
  const toggle = (list: DocType[], k: DocType) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);

  async function save(archived?: boolean) {
    setBusy(true);
    try {
      await post(`erp/templates/${template.id}`, { name, design, docTypes, logoId, signatureId, defaultFor: defaults, ...(archived !== undefined ? { archived } : {}) });
      setDirty(false); notify({ id: "erp-tpl", tone: "success", title: archived ? "Template archived" : "Template saved", timeout: 2500 });
      router.refresh(); if (archived) router.push("/erp/templates");
    } catch (e) { notify({ id: "erp-tpl", tone: "error", title: "Not saved", message: message(e) }); } finally { setBusy(false); }
  }
  async function pick(kindOf: "logo" | "signature", file?: File) {
    if (!file) return;
    try { const id = await upload(kindOf, file); if (kindOf === "logo") setLogoId(id); else setSignatureId(id); setDirty(true); }
    catch (e) { notify({ id: "erp-upload", tone: "error", title: "Not uploaded", message: message(e) }); }
  }

  const status = !docTypes.length ? "Choose at least one kind of document under Fine-tune" : dirty ? "Unsaved changes: the preview already shows them"
    : defaults.length ? `Saved · default for ${defaults.map(plural).join(", ")}` : "Saved";
  const saveButton = <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !dirty || !docTypes.length || !name.trim()} onClick={() => save()}>
    {dirty ? <Save size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{dirty ? "Save template" : "Saved"}</button>;
  const preview = <>
    <div className={t.previewBar}>
      <div className={styles.segmented} role="group" aria-label="Preview as">{KINDS.map((k) => <button key={k} type="button" className={styles.segment} aria-pressed={kind === k} onClick={() => setKind(k)}>{TYPE_LABEL[k]}</button>)}</div>
      <div className={styles.segmented} role="group" aria-label="Client"><button type="button" className={styles.segment} aria-pressed={!inter} onClick={() => setInter(false)}>Same state</button><button type="button" className={styles.segment} aria-pressed={inter} onClick={() => setInter(true)}>Other state</button></div>
    </div>
    <LivePreview label={`${name || "Template"} · ${TYPE_LABEL[kind]}`} design={design} doc={sample} logoId={logoId ?? (orgLogo ? "org-logo" : null)} signatureId={signatureId} />
  </>;

  /* eslint-disable @next/next/no-img-element -- template images served by the app */
  return <div className={t.layout}>
    <fieldset className={t.form} disabled={!canWrite}>
      <section className={t.card} aria-label="Template">
        <input className={t.name} value={name} maxLength={80} aria-label="Template name" onChange={(e) => { setName(e.target.value); setDirty(true); }} />
        <span className={t.label}>Default for</span>
        <div className={t.chips} role="group" aria-label="Default for">{docTypes.map((k) => {
          const locked = savedDefaults.includes(k);
          return <button key={k} type="button" className={t.chip} aria-pressed={defaults.includes(k)} disabled={locked}
            title={locked ? "This is the default; make another template the default to change it" : undefined}
            onClick={() => { setDefaults(toggle(defaults, k)); setDirty(true); }}>{defaults.includes(k) ? <Check size={13} aria-hidden="true" /> : null}{TYPE_LABEL[k]}</button>;
        })}</div>
      </section>

      <Step n={1} title="Look">
        <div className={t.looks} style={{ ["--accent" as string]: design.accent }}>
          {LOOKS.map((l) => <button key={l.style} type="button" className={t.look} aria-pressed={design.style === l.style} onClick={() => d("style", l.style)}>
            <span className={t.page} data-style={l.style} aria-hidden="true"><i /><i /><i /><i /></span>{l.label}<small>{l.sub}</small></button>)}
        </div>
        <div className={t.sizes}>
          <span className={t.label}>Text size</span>
          <div className={styles.segmented} role="group" aria-label="Text size">{SIZES.map((s) =>
            <button key={s.label} type="button" className={styles.segment} aria-pressed={Math.abs(design.fontScale - s.scale) < 0.001} onClick={() => d("fontScale", s.scale)}>{s.label}</button>)}</div>
        </div>
        <ul className={t.toggles}><li><Toggle label="Logo" sub={logoId ? "This template's own logo" : orgLogo ? "The company's logo" : "No logo yet: upload one under Fine-tune"} on={design.logo.show} onChange={(on) => d("logo", { ...design.logo, show: on })} /></li></ul>
      </Step>

      <Step n={2} title="Colour" sub={fromLogo.length ? "from your logo first" : undefined}>
        {fromLogo.length ? <div className={t.fromLogo}>
          {logoSrc ? <img src={logoSrc} alt="" /> : null}
          <span className={t.label}>From your logo</span>
          <div className={t.swatchRow}>{fromLogo.map((c) => <button key={c} type="button" className={t.swatch} style={{ background: c }} aria-label={`Logo colour ${c}`} aria-pressed={design.accent === c} onClick={() => d("accent", c)} />)}</div>
        </div> : null}
        <div className={t.swatchRow}>
          {ACCENTS.map((c) => <button key={c} type="button" className={t.swatch} style={{ background: c }} aria-label={c} aria-pressed={design.accent === c} onClick={() => d("accent", c)} />)}
          <input type="color" className={t.picker} value={design.accent} onChange={(e) => d("accent", e.target.value)} aria-label="Any colour" />
        </div>
      </Step>

      <Step n={3} title="Print these blocks">
        <div className={t.blockGrid}>{MAIN.map((k) => <Toggle key={k} label={BLOCKS[k][0]} sub={BLOCKS[k][1]} on={design.show[k]} onChange={(on) => show(k, on)} />)}</div>
        <Disclosure summary="More blocks" hint={`${MORE.filter((k) => design.show[k]).length} of ${MORE.length} on · SAC column, page numbers, place of supply`}>
          <div className={t.blockGrid}>{MORE.map((k) => <Toggle key={k} label={BLOCKS[k][0]} sub={BLOCKS[k][1]} on={design.show[k]} onChange={(on) => show(k, on)} />)}</div>
        </Disclosure>
      </Step>

      <section className={t.card} aria-label="Fine-tune">
        <Disclosure summary="Fine-tune" hint="terms, bank details, signature, footer, titles, logo">
          <label className={styles.field}>Terms &amp; conditions<textarea rows={4} value={design.terms} onChange={(e) => d("terms", e.target.value)} /></label>
          <p className={t.subhead}>Bank details</p>
          <div className={t.fields}>
            {([["accountName", "Account name"], ["bankName", "Bank"], ["branch", "Branch"], ["accountNumber", "Account number"], ["ifsc", "IFSC"], ["upi", "UPI ID"]] as const).map(([k, l]) =>
              <label key={k} className={styles.field}>{l}<input value={design.bank[k]} onChange={(e) => d("bank", { ...design.bank, [k]: e.target.value })} /></label>)}
          </div>
          <p className={t.subhead}>Signature</p>
          <div className={t.fields}>
            <label className={styles.field}>Label<input value={design.signature.label} onChange={(e) => d("signature", { ...design.signature, label: e.target.value })} /></label>
            <label className={styles.field}>Name<input value={design.signature.name} onChange={(e) => d("signature", { ...design.signature, name: e.target.value })} /></label>
            <label className={styles.field}>Title<input value={design.signature.title} onChange={(e) => d("signature", { ...design.signature, title: e.target.value })} /></label>
          </div>
          <div className={t.imageRow}>
            {signatureId ? <img src={`/api/v0/erp/assets/${signatureId}`} alt="Signature" /> : <span className={t.quiet}>No signature image: a line to sign on</span>}
            <label className={`${styles.btn} ${styles.btnSmall}`}><ImagePlus size={13} aria-hidden="true" />Upload signature<input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => pick("signature", e.target.files?.[0])} /></label>
            {signatureId ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => { setSignatureId(null); setDirty(true); }}><X size={13} aria-hidden="true" />Remove</button> : null}
          </div>
          {signatureId ? <ul className={t.toggles}><li><Toggle label="Print the signature image" on={design.signature.showImage} onChange={(on) => d("signature", { ...design.signature, showImage: on })} /></li></ul> : null}
          <label className={styles.field}>Footer<input value={design.footer} onChange={(e) => d("footer", e.target.value)} /></label>
          <p className={t.subhead}>Logo</p>
          <div className={t.imageRow}>
            {logoId ? <img src={`/api/v0/erp/assets/${logoId}`} alt="Template logo" /> : orgLogo ? <img src="/api/v0/erp/assets/org-logo" alt="Company logo" /> : <span className={t.quiet}>No logo yet</span>}
            <label className={`${styles.btn} ${styles.btnSmall}`}><ImagePlus size={13} aria-hidden="true" />Upload logo<input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => pick("logo", e.target.files?.[0])} /></label>
            {logoId ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => { setLogoId(null); setDirty(true); }}><X size={13} aria-hidden="true" />{orgLogo ? "Use the company's logo" : "Remove"}</button> : null}
          </div>
          <div className={t.fields}>
            <label className={styles.field}>Logo position<SelectField value={design.logo.position} onChange={(e) => d("logo", { ...design.logo, position: e.target.value as "left" | "right" })}><option value="left">Left</option><option value="right">Right</option></SelectField></label>
            <label className={styles.field}>Logo height<input type="range" min={20} max={80} value={design.logo.height} onChange={(e) => d("logo", { ...design.logo, height: Number(e.target.value) })} /></label>
            <label className={styles.field}>Text colour<input type="color" value={design.text} onChange={(e) => d("text", e.target.value)} /></label>
          </div>
          <p className={t.subhead}>Titles and use</p>
          <div className={t.fields}>{KINDS.map((k) => <label key={k} className={styles.field}>{TYPE_LABEL[k]} title<input value={design.titles[k]} placeholder={DOC_LABELS[k].title} onChange={(e) => d("titles", { ...design.titles, [k]: e.target.value })} /></label>)}</div>
          <div className={t.chips} role="group" aria-label="Used for">{KINDS.map((k) =>
            <button key={k} type="button" className={t.chip} aria-pressed={docTypes.includes(k)} disabled={savedDefaults.includes(k)}
              onClick={() => { const next = toggle(docTypes, k); setDocTypes(next); setDefaults(defaults.filter((x) => next.includes(x))); setDirty(true); }}>
              {docTypes.includes(k) ? <Check size={13} aria-hidden="true" /> : null}Used for {plural(k)}</button>)}</div>
          {canWrite ? <div><button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy || savedDefaults.length > 0} title={savedDefaults.length ? "A default template stays; make another the default first" : undefined}
            onClick={() => save(true)}><Archive size={14} aria-hidden="true" />Archive this template</button></div> : null}
        </Disclosure>
      </section>

      {canWrite && !phone ? <NextStep status={status} tone={docTypes.length ? "info" : "warning"} primary={saveButton} /> : null}
    </fieldset>
    {phone ? <Drawer persistent snap="peek" bare title="Preview" label="Template preview" context={`${TYPE_LABEL[kind]} · ${dirty ? "unsaved changes" : "as exported"}`} onClose={() => undefined}
      footer={canWrite ? <DrawerFooter status={dirty ? "Unsaved changes" : undefined} tone="info" primary={saveButton} /> : undefined}>
      <div className={t.sheetBody}>{preview}</div>
    </Drawer> : <aside className={t.side} aria-label="Preview">{preview}</aside>}
  </div>;
  /* eslint-enable @next/next/no-img-element */
}
