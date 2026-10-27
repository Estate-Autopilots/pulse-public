// SOP-WORKFLOW part 3: sent forms as a list (who, when, for which project or run). Server-safe.
import Link from "next/link";
import { Camera, MapPin } from "lucide-react";
import { dayTime } from "../lib/format";
import { Avatar, Badge } from "../ui";
import type { SubmissionRow } from "./types";
import css from "./sops.module.css";

export function SubmissionList({ rows, showForm }: { rows: SubmissionRow[]; showForm?: boolean }) {
  if (!rows.length) return <p className={css.hint}>Nothing sent yet.</p>;
  return <ul className={css.runs}>{rows.map((s) => <li key={s.id} data-status={s.status === "void" ? "cancelled" : "done"}>
    <span className={css.runMain}><Link className={css.runTitle} href={`/sops/records/${s.id}`}>{showForm ? `${s.form} · ` : ""}{s.project ?? s.client ?? s.run ?? "No project"}</Link>
      <small>{dayTime(s.submittedAt)}{s.run && s.run !== s.project ? ` · ${s.run}` : ""}</small></span>
    <span className={css.runNow}>{s.person ? <span className={css.nowStep}><Avatar name={s.person} id={s.personId ?? undefined} photoAt={s.photoAt} size={20} /><span><b>{s.person}</b></span></span> : null}</span>
    <span className={css.runFlags}>{s.files ? <span className={css.chip}><Camera size={11} aria-hidden="true" />{s.files}</span> : null}{s.located ? <span className={css.chip}><MapPin size={11} aria-hidden="true" />Place</span> : null}
      {s.status === "void" ? <Badge tone="warning">Void</Badge> : null}</span>
  </li>)}</ul>;
}
