import Link from "next/link";
import { PenLine } from "lucide-react";
import { api } from "../../../lib/api";
import { day } from "../../../lib/format";
import { Badge, Message, Page, PageHeader, styles } from "../../../ui";
import { FormBuilder } from "../../form-builder";
import { FormFill } from "../../fill";
import { SubmissionList } from "../../submission-list";
import type { FormDetail } from "../../types";
import css from "../../sops.module.css";

/** SOP-WORKFLOW part 3: one form. Leadership builds it here beside the phone's view; everyone sees the workflows that
 *  use it and the sent forms they may read. */
export default async function FormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<FormDetail>(`forms/${id}`);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!, form = d.form;
  return <Page>
    <PageHeader title={form.name} back={{ href: "/sops/forms", label: "Forms" }} recent={{ title: form.name }}
      context={[`${form.fields.length} fields`, `version ${form.version} · ${day(form.updatedAt)}`, form.clientName ? `for ${form.clientName}` : null]}
      meta={<Badge tone={form.status === "live" ? "success" : form.status === "draft" ? "neutral" : "warning"}>{form.status === "live" ? "Live" : form.status === "draft" ? "Draft" : "Archived"}</Badge>}
      actions={form.status === "live" ? <Link className={styles.btn} href={`/sops/forms/${id}/fill`}><PenLine size={14} aria-hidden="true" />Fill it</Link> : undefined} />
    <div className={css.area}>
      {d.canEdit ? <FormBuilder data={d} /> : <div style={{ maxWidth: 640 }}><FormFill form={{ id: form.id, name: form.name, purpose: form.purpose, fields: form.fields, live: form.status === "live" }} preview /></div>}
      <section className={css.box} aria-label="Used in"><p className={css.sub}>Used in</p>
        {d.usedIn.length ? <ul className={css.flowLinks}>{d.usedIn.map((w) => <li key={w.id}><Link href={`/sops/workflows/${w.id}`} style={{ textDecoration: "none" }}><b style={{ color: "var(--theme-action)" }}>{w.name}</b>{" "}
          <small style={{ color: "var(--theme-text-muted)" }}>{[w.starts ? "starts it" : null, w.steps.length ? `step${w.steps.length === 1 ? "" : "s"}: ${w.steps.join(", ")}` : null].filter(Boolean).join(" · ")}</small></Link></li>)}</ul>
          : <p className={css.hint}>No workflow uses it yet. Choose it as a step’s form in a workflow, or as the form that starts one.</p>}</section>
      <section className={css.box} aria-label="Sent"><p className={css.sub}>Sent</p><SubmissionList rows={d.submissions} /></section>
    </div>
  </Page>;
}
