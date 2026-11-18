import Link from "next/link";
import { Camera, ClipboardList, PenLine } from "lucide-react";
import { api } from "../../lib/api";
import { dayTime } from "../../lib/format";
import { Badge, Empty, Message, Page, PageHeader, styles } from "../../ui";
import { InstallTemplate, NewForm } from "../form-parts";
import { plural } from "../parts";
import type { FormList } from "../types";
import css from "../sops.module.css";

/** SOP-WORKFLOW part 3: field forms. What the viewer has to fill now (their workflow steps with a form), the company's
 *  forms, and for leadership the ready-made templates (a solar installation among them). */
export default async function FormsPage() {
  const r = await api<FormList>("forms");
  if (r.error) return <Message text={r.error} />;
  const d = r.data!;
  return <Page>
    <PageHeader title="Forms" back={{ href: "/processes", label: "Processes" }} context={[d.toFill.length ? `${plural(d.toFill.length, "form")} to fill` : null, plural(d.forms.filter((f) => f.status === "live").length, "live form")]}
      actions={d.canEdit ? <NewForm /> : undefined} />
    <div className={css.area}>
      {d.toFill.length ? <section className={css.box} aria-label="To fill now"><p className={css.sub}>To fill now</p>
        <ul className={css.runs}>{d.toFill.map((t) => <li key={t.stepId}>
          <span className={css.runMain}><Link className={css.runTitle} href={`/sops/fill/${t.stepId}`}>{t.form}: {t.title}</Link><small>{[t.workflow, t.project ?? t.run].filter(Boolean).join(" · ")}</small></span>
          <span className={css.runNow}>{t.dueAt ? <small style={t.late ? { color: "var(--theme-danger)", fontWeight: 650 } : undefined}>Due {dayTime(t.dueAt)}{t.late ? " · late" : ""}</small> : null}</span>
          <span className={css.runFlags}><Link className={`${styles.btn} ${styles.btnPrimary}`} href={`/sops/fill/${t.stepId}`}><PenLine size={14} aria-hidden="true" />Fill</Link></span>
        </li>)}</ul></section> : null}
      {d.forms.length ? <ul className={css.cards}>{d.forms.map((f) => <li key={f.id}>
        <Link className={css.card} href={`/sops/forms/${f.id}`}>
          <span className={css.cardHead}><h3>{f.name}</h3>{f.status !== "live" ? <Badge tone={f.status === "draft" ? "neutral" : "warning"}>{f.status === "draft" ? "Draft" : "Archived"}</Badge> : null}</span>
          {f.purpose ? <p>{f.purpose}</p> : null}
          <span className={css.chips}>{f.types.slice(0, 5).map((t) => <span key={t} className={css.chip}>{t}</span>)}{f.clientName ? <span className={css.chip}>For {f.clientName}</span> : null}</span>
          <span className={css.meta}><span>{plural(f.fieldCount, "field")}</span>{f.photos ? <span><Camera size={12} aria-hidden="true" />{plural(f.photos, "photo field")}</span> : null}
            <span>{f.sent ? `${plural(f.sent, "sent form")}${f.lastAt ? `, last ${dayTime(f.lastAt)}` : ""}` : "Not sent yet"}</span>{f.usedIn ? <span>In {plural(f.usedIn, "process", "processes")}</span> : null}</span>
        </Link></li>)}</ul>
        : <Empty icon={ClipboardList} first title="No forms yet" text={d.canEdit ? "Build a form for work done in the field (photos from the camera with time and place, numbers, choices, a signature), or start from a template." : "Forms your processes ask for appear here."} />}
      {d.templates.length ? <section className={css.box} aria-label="Templates"><p className={css.sub}>Templates</p>
        <ul className={css.pipList}>{d.templates.map((t) => <li key={t.key}><span><b>{t.name}</b><small>{t.purpose} {t.forms.map((f) => `${f.name} (${f.fields} fields)`).join(" · ")}{t.workflow ? " · with its workflow" : ""}</small></span>
          <InstallTemplate tkey={t.key} name={t.name} workflow={t.workflow} /></li>)}</ul></section> : null}
    </div>
  </Page>;
}
