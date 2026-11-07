"use client";
import { useRouter } from "next/navigation";
import { Combobox } from "../../kit";

/** Which map: a person's work, or a project with links (TASKS-4A: the kit's searchable list, not the browser's select). */
export function MapSwitch({ projects, current, person, me }: { projects: { id: string; name: string; links: number }[]; current: string | null; person: string | null; me: string | null }) {
  const router = useRouter();
  const options = [
    ...(person && person !== me ? [{ value: `person:${person}`, label: "This person’s work", group: "People" }] : []),
    ...(me ? [{ value: `person:${me}`, label: "My work", group: "People" }] : []),
    ...(current && !projects.some((p) => p.id === current) ? [{ value: `project:${current}`, label: "This project", group: "Projects" }] : []),
    ...projects.map((p) => ({ value: `project:${p.id}`, label: p.name, detail: `${p.links} links`, group: "Projects" })),
  ];
  return <Combobox label="Which map" options={options} value={current ? `project:${current}` : person ? `person:${person}` : null} size="sm" searchable={options.length > 8} searchPlaceholder="Search projects"
    onChange={(v) => { if (!v) return; const [kind, id] = v.split(":"); router.push(kind === "project" ? `/tasks/map?project=${id}` : `/tasks/map?person=${id}`); }} />;
}
