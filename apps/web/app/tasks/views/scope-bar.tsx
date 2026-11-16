"use client";
// TASKS-4A: whose tasks Work shows. Me · My pod (the company's word for a team) · Company, or one person, or one project,
// chosen from searchable lists with photos and project kinds. Every scope keeps the view controls below it.
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { Building2, FolderKanban, UserRound, Users } from "lucide-react";
import { Combobox, SegmentedNav, personOptions, type Option } from "../../kit";
import { useWorkOptions } from "../../create";
import { KindChip, kindOf } from "../../work-kind";
import type { Place } from "./model";
import css from "./views.module.css";

export function ScopeBar({ place, me, team, myPod, person, project, keep }: { place: Place; me: string | null; team: string; myPod: string | null;
  person: { id: string; name: string; photoAt?: string | null } | null; project: { id: string; name: string; kind?: string | null } | null; /** Query kept when the scope changes (the view). */ keep?: string }) {
  const router = useRouter();
  const { data } = useWorkOptions(true);
  const tail = keep ? `&${keep}` : "";
  // RELEASE-5: until the lists arrive, the chosen person or project is the list, so the picker reads the same from the
  // first paint (it said "A project", then "A project: Northstar Heights", and on a phone the row wrapped: 0.08 shift).
  const people = useMemo<Option[]>(() => personOptions((data?.people ?? (person ? [{ ...person, photoAt: person.photoAt ?? null }] as NonNullable<typeof data>["people"] : [])).filter((p) => p.id !== me), me), [data, me, person]);
  const projects = useMemo<Option[]>(() => (data?.projects ?? (project ? [{ id: project.id, name: project.name, kind: project.kind ?? null, clientName: null, recent: false, mine: false }] as NonNullable<typeof data>["projects"] : [])).map((p) => ({ value: p.id, label: p.name, detail: p.clientName ?? undefined, keywords: p.clientName ?? "",
    icon: <KindChip kind={kindOf(p.kind)} short />, group: p.recent ? "Recent" : p.mine ? "Yours" : "All projects" })), [data, project]);
  const items = [
    ...(me ? [{ key: "me", href: `/tasks?scope=me${tail}`, label: "Me", icon: <UserRound size={15} aria-hidden="true" />, current: place === "me" }] : []),
    ...(myPod ? [{ key: "pod", href: `/tasks?scope=pod${tail}`, label: `My ${team.toLowerCase()}`, icon: <Users size={15} aria-hidden="true" />, current: place === "pod", hint: `${myPod}: everyone in your ${team.toLowerCase()}` }] : []),
    { key: "company", href: `/tasks?scope=company${tail}`, label: "Company", icon: <Building2 size={15} aria-hidden="true" />, current: place === "company", hint: "Every task you can see" },
  ];
  // EST-1199: on a phone this is one row that scrolls sideways (faded where it continues), not two wrapped rows.
  return <div className={css.scope} role="group" aria-label="Whose tasks" data-hscroll="" data-phone-filter="">
    <SegmentedNav label="Scope" size="sm" items={items} />
    <Combobox label="A person" options={people} value={place === "person" ? person?.id ?? null : null} placeholder="A person" searchable searchPlaceholder="Search people" size="sm" variant="chip"
      icon={<UserRound size={14} aria-hidden="true" />} hint={place === "person" && person ? person.name : undefined} onChange={(v) => { if (v) router.push(`/tasks?scope=person&person=${v}${tail}`); }} />
    <Combobox label="A project" options={projects} value={place === "project" ? project?.id ?? null : null} placeholder="A project" searchable searchPlaceholder="Search projects" size="sm" variant="chip"
      icon={<FolderKanban size={14} aria-hidden="true" />} hint={place === "project" && project ? project.name : undefined} onChange={(v) => { if (v) router.push(`/tasks?scope=project&project=${v}${tail}`); }}
      renderValue={(o) => <>{o.icon}<span>{o.label}</span></>} />
  </div>;
}

/** A choice kept in the URL (which pod, which type), as the kit's list instead of the browser's select. */
export function UrlSelect({ value, options, param, label, base = "/tasks" }: { value: string; options: { value: string; label: string }[]; param: string; label: string; base?: string }) {
  const router = useRouter(); const params = useSearchParams();
  return <Combobox label={label} size="sm" variant="ghost" options={options.map((o) => ({ value: o.value || "_", label: o.label }))} value={value || "_"} searchable={options.length > 8}
    onChange={(v) => { const q = new URLSearchParams(params.toString()); if (v && v !== "_") q.set(param, v); else q.delete(param); router.push(`${base}?${q}`); }} />;
}
