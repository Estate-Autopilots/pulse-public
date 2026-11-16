"use client";
import { useRouter } from "next/navigation";
import { Combobox } from "../../kit";
import { useWords } from "../../org-code";

/** Which map: a project, a goal, a person's work or the whole company (TASKS-4A: the kit's searchable list). */
export function MapSwitch({ projects, goals, scope, current, me }: { projects: { id: string; title: string; links: number }[]; goals: { id: string; title: string }[]; scope: string; current: string | null; me: string | null }) {
  const router = useRouter();
  const words = useWords();
  const options = [
    ...(me ? [{ value: `person:${me}`, label: "My work", group: "People" }] : []),
    ...(scope === "person" && current && current !== me ? [{ value: `person:${current}`, label: "This person’s work", group: "People" }] : []),
    { value: "all:1", label: "Whole company", group: "People" },
    ...(scope === "project" && current && !projects.some((p) => p.id === current) ? [{ value: `project:${current}`, label: `This ${words.project.toLowerCase()}`, group: words.projects }] : []),
    ...projects.map((p) => ({ value: `project:${p.id}`, label: p.title, detail: p.links ? `${p.links} links` : undefined, group: words.projects })),
    ...(scope === "goal" && current && !goals.some((g) => g.id === current) ? [{ value: `goal:${current}`, label: "This goal", group: "Goals" }] : []),
    ...goals.map((g) => ({ value: `goal:${g.id}`, label: g.title, group: "Goals" })),
  ];
  const value = scope === "all" ? "all:1" : current ? `${scope}:${current}` : null;
  return <Combobox label="Which map" options={options} value={value} size="sm" searchable={options.length > 8} searchPlaceholder="Search"
    onChange={(v) => { if (!v) return; const [kind, id] = v.split(":"); router.push(kind === "all" ? "/tasks/map?all=1" : `/tasks/map?${kind}=${id}`); }} />;
}
