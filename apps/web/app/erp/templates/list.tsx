"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Copy, Plus } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import type { DocumentInput } from "@pulse/invoice-doc/browser";
import { post } from "../../records";
import { styles } from "../../ui";
import { PdfPages, previewPdf } from "../preview";
import { TYPE_LABEL } from "../nav";
import type { Template } from "../types";
import t from "./templates.module.css";

const ORDER = ["quotation", "proforma", "invoice", "credit_note"];

/** Every template as a small live rendering of the same sample invoice; the defaults as chips; one main action. */
export function TemplateList({ templates, sample, orgLogo, canWrite }: { templates: Template[]; sample: DocumentInput; orgLogo: boolean; canWrite: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function create(copyOf?: string) {
    setBusy(true);
    try { const r = await post<{ id: string }>("erp/templates", copyOf ? { copyOf } : {}); router.push(`/erp/templates/${r.id}`); }
    catch (e) { notify({ id: "erp-tpl", tone: "error", title: "Not created", message: e instanceof Error ? e.message : "Could not save" }); setBusy(false); }
  }
  const live = templates.filter((x) => !x.archived);
  return <>
    <div className={t.listTop}>
      <p className={t.quiet}>Pick a look, a colour and the blocks to print. Each picture is the real PDF of a sample invoice; every kind of document has its own default.</p>
      {canWrite ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => create()}><Plus size={14} aria-hidden="true" />New template</button> : null}
    </div>
    <div className={t.list}>{live.map((x) => {
      const defaults = [...(x.defaultFor ?? [])].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
      const others = x.docTypes.filter((k) => !defaults.includes(k));
      return <div key={x.id} className={t.tile}>
        <div className={t.tileHead}><Link href={`/erp/templates/${x.id}`}>{x.name}</Link>
          {canWrite ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => create(x.id)} aria-label={`Copy ${x.name}`} title="Make a copy"><Copy size={13} aria-hidden="true" /></button> : null}</div>
        <Thumb template={x} sample={sample} orgLogo={orgLogo} />
        <div className={t.tileFoot}>
          {defaults.map((k) => <span key={k} className={t.defaultChip}>Default for {TYPE_LABEL[k].toLowerCase()}s</span>)}
          {others.length ? <span className={t.usedFor}>{defaults.length ? "Also " : "For "}{others.map((k) => TYPE_LABEL[k].toLowerCase() + "s").join(", ")}</span> : null}
        </div>
      </div>;
    })}</div>
  </>;
}

function Thumb({ template, sample, orgLogo }: { template: Template; sample: DocumentInput; orgLogo: boolean }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  useEffect(() => {
    let gone = false;
    previewPdf(template.design, sample, template.logoId ?? (orgLogo ? "org-logo" : null), template.signatureId).then((r) => { if (!gone) setBytes(r.bytes); }).catch(() => undefined);
    return () => { gone = true; };
  }, [template, sample, orgLogo]);
  return <Link href={`/erp/templates/${template.id}`} aria-label={`Edit ${template.name}`}><PdfPages bytes={bytes} label={`${template.name} on a sample invoice`} /></Link>;
}
