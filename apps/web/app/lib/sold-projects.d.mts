// KAZUK-V2 G13: types for sold-projects.mjs (a sold project, read only).
export type SoldProject = { id: string; name: string; client: string | null; clientId: string | null; status: string; pgs: string | null; category: string | null;
  renewalOn: string | null; tasks: { total: number; done: number; overdue: number }; next: { title: string; dueOn: string | null } | null;
  clientGroup: boolean; recent?: { title: string; at: string }[] | null; upcoming?: { title: string; dueOn: string | null; late: boolean }[] | null };
export type SoldProjects = { person: { id: string; self: boolean }; today: string; projects: SoldProject[] };
export function shortDay(iso: string | null | undefined): string;
export function projectFacts(p: SoldProject, today: string): { share: number; percent: number; status: string; tone: "accent" | "success" | "warning" | "neutral"; renewal: string; nextDue: string };
