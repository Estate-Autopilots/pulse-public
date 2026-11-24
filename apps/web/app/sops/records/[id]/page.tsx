import Link from "next/link";
import { ExternalLink, MapPin } from "lucide-react";
import { api } from "../../../lib/api";
import { dayTime } from "../../../lib/format";
import { Avatar, Badge, Message, Page, PageHeader } from "../../../ui";
import { VoidSubmission } from "../../form-parts";
import type { SubmissionDetail } from "../../types";
import f from "../../forms.module.css";
import css from "../../sops.module.css";

const EVENT: Record<string, string> = { submitted: "Sent", viewed: "Opened", file_viewed: "Opened a photo", voided: "Voided", started_run: "Started the workflow" };
const map = (lat: number, lng: number) => `https://maps.google.com/?q=${lat},${lng}`;

/** SOP-WORKFLOW part 3: a sent form, as it was sent: the answers against the form of that version, the photos with when
 *  and where they were taken, the signatures, where it was sent from, and its record (who sent, opened or voided it). */
export default async function RecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<SubmissionDetail>(`forms/submissions/${id}`);
  if (r.error) return <Message text={r.error} />;
  const { submission: s, files, events, canVoid } = r.data!;
  const show = (v: unknown, type: string) => v === undefined || v === null || v === "" ? <span style={{ color: "var(--theme-text-muted)" }}>Not answered</span>
    : Array.isArray(v) ? <ul>{v.map((x, i) => <li key={i}>{String(x)}</li>)}</ul> : type === "yesno" ? (v ? "Yes" : "No")
    : type === "location" && typeof v === "object" ? <a className={css.linkBtn} href={map((v as { lat: number }).lat, (v as { lng: number }).lng)} target="_blank" rel="noreferrer"><MapPin size={13} aria-hidden="true" />{(v as { lat: number }).lat.toFixed(5)}, {(v as { lng: number }).lng.toFixed(5)}</a> : String(v);
  return <Page>
    <PageHeader title={s.form} back={s.runId ? { href: `/runs/${s.runId}`, label: "The run" } : { href: `/sops/forms/${s.formId}`, label: "The form" }} recent={{ title: `${s.form} · ${s.project ?? ""}` }}
      context={[s.project ?? s.client, s.person ? `sent by ${s.person}` : null, dayTime(s.submittedAt)]} meta={s.status === "void" ? <Badge tone="warning">Void</Badge> : undefined} />
    <div className={f.record}>
      <div className={css.area}>
        {s.status === "void" ? <p className={css.flag} data-level="warn">Voided by {s.voidedBy} {s.voidedAt ? dayTime(s.voidedAt) : ""}: {s.voidReason}</p> : null}
        <section className={css.box} aria-label="Answers"><p className={css.sub}>Answers</p>
          <dl className={f.answers}>{s.fields.filter((x) => x.type !== "photo" && x.type !== "signature").map((x) => <div key={x.key} style={{ display: "contents" }}><dt>{x.label}</dt><dd>{show(s.answers[x.key], x.type)}{x.unit && s.answers[x.key] !== undefined ? ` ${x.unit}` : ""}</dd></div>)}</dl></section>
        {s.fields.filter((x) => x.type === "photo" || x.type === "signature").map((x) => { const mine = files.filter((p) => p.field === x.key);
          return <section key={x.key} className={css.box} aria-label={x.label}><p className={css.sub}>{x.label} · {mine.length}</p>
            {mine.length ? <div className={f.gallery}>{mine.map((p) => <figure key={p.id} data-kind={x.type}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a photo sent with the form, served by Pulse to those who may see it */}
              <a className={f.shot} href={`/api/v0/forms/files/${p.id}`} target="_blank" rel="noreferrer"><img src={`/api/v0/forms/files/${p.id}`} alt={`${x.label}${p.capturedAt ? `, taken ${dayTime(p.capturedAt)}` : ""}`} loading="lazy" /></a>
              <figcaption>{x.type === "signature" ? "Signed" : p.source === "camera" ? "Camera" : "Uploaded"}{p.capturedAt ? ` · ${dayTime(p.capturedAt)}` : ""}{p.lat != null && p.lng != null ? <> · <a className={css.linkBtn} href={map(p.lat, p.lng)} target="_blank" rel="noreferrer">{p.lat.toFixed(4)}, {p.lng.toFixed(4)}</a></> : ""}</figcaption>
            </figure>)}</div> : <p className={css.hint}>None.</p>}</section>; })}
      </div>
      <aside className={css.side}><div className={css.panel}>
        <div className={css.panelHead}><div><h3>About it</h3><small>Version {s.version} of the form</small></div></div>
        <dl className={css.facts}>
          {s.person ? <><dt>Sent by</dt><dd><Avatar name={s.person} id={s.personId ?? undefined} photoAt={s.photoAt} size={20} />{s.person}</dd></> : null}
          <dt>When</dt><dd>{dayTime(s.submittedAt)}</dd>
          {s.project ? <><dt>Project</dt><dd><Link className={css.linkBtn} href={`/tasks/projects/${s.projectId}`}>{s.project}</Link></dd></> : null}
          {s.client ? <><dt>Client</dt><dd>{s.clientId ? <Link className={css.linkBtn} href={`/clients/${s.clientId}`}>{s.client}</Link> : s.client}</dd></> : null}
          {s.run ? <><dt>Run</dt><dd><Link className={css.linkBtn} href={`/runs/${s.runId}`}>{s.workflow} · {s.run}</Link>{s.step ? <small>{s.step}</small> : null}</dd></> : null}
          {s.location ? <><dt>Sent from</dt><dd><a className={css.linkBtn} href={map(s.location.lat, s.location.lng)} target="_blank" rel="noreferrer"><MapPin size={13} aria-hidden="true" />{s.location.lat.toFixed(5)}, {s.location.lng.toFixed(5)}<ExternalLink size={11} aria-hidden="true" /></a>{s.location.accuracy ? <small>±{Math.round(s.location.accuracy)} m</small> : null}</dd></> : null}
          {s.device ? <><dt>Using</dt><dd>{s.device}</dd></> : null}
          {s.taskId ? <><dt>Task</dt><dd><Link className={css.linkBtn} href={`/tasks/${s.taskId}`}>Open</Link></dd></> : null}
        </dl>
        <section aria-label="Record"><p className={css.sub}>Record</p><ul className={f.trail}>{events.map((e, i) => <li key={i}><span>{EVENT[e.kind] ?? e.kind}{e.who ? ` · ${e.who}` : ""}{e.note && e.kind !== "file_viewed" ? `: ${e.note}` : ""}</span><small>{dayTime(e.at)}</small></li>)}</ul></section>
        <p className={css.hint}>A sent form is never changed; leadership can void it with a reason.</p>
        {canVoid ? <VoidSubmission id={s.id} /> : null}
      </div></aside>
    </div>
  </Page>;
}
