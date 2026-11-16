"use client";
// PERSONAL-WORKSPACE (1640): a project's type, said and changed in one place: client delivery (it delivers a client's
// package, and the client-delivery panels show), internal (the organisation's own work) or personal (your own). A
// personal workspace keeps personal projects only.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../../records";
import { SelectField } from "../../../kit/select-field";
import css from "../../tasks.module.css";

type ProjectType = "client_delivery" | "internal" | "personal";
const TYPES: { value: ProjectType; label: string; hint: string }[] = [
  { value: "client_delivery", label: "Client delivery", hint: "Delivers a client's package: its plan, scope and handover show here" },
  { value: "internal", label: "Internal", hint: "The organisation's own work: no client, no package" },
  { value: "personal", label: "Personal", hint: "Your own project: no client, no package" },
];

export function ProjectTypePick({ projectId, value, personalOrg }: { projectId: string; value: ProjectType; personalOrg: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  if (personalOrg) return <p className={css.note}>Personal project · this workspace keeps your own projects</p>;
  async function change(next: ProjectType) {
    if (next === value) return;
    setBusy(true);
    try {
      await post(`work/projects/${projectId}`, { projectType: next });
      notify({ id: `ptype:${projectId}`, tone: "success", title: `Now ${TYPES.find((t) => t.value === next)?.label.toLowerCase()}`, timeout: 3000 });
      router.refresh();
    } catch (e) { notify({ id: `ptype:${projectId}`, tone: "error", title: "Not changed", message: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); }
  }
  return <label className={css.visibilityField}><span>Project type</span>
    <SelectField size="sm" value={value} disabled={busy} aria-label="Project type" onChange={(e) => change(e.target.value as ProjectType)}>
      {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
    </SelectField>
    <small>{TYPES.find((t) => t.value === value)?.hint}</small>
  </label>;
}
