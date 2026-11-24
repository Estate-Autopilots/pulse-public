// PM-BUILD-4: lane B's judged First run screen, populated from the live project-template read.
import { api, getMe } from "../../lib/api";
import { Message } from "../../ui";
import FirstRun from "../pm/screens/first-run";
import type { FirstRunVM, TemplateCardVM } from "../pm/contract/first-run";
import css from "./first-run.module.css";

type Template = {
  key: string;
  name: string;
  stages?: { n: number }[];
  steps: number;
  clocks?: { key: string; step?: string | null }[] | null;
  list?: { id: string; from: string; end: number | null }[];
};

/** A template's "N days": on clocks, Day 0 to going live (the projects' "Day N of 21"); without clocks, the kick-off to
 *  its last step's end. */
const daysOf = (t: Template) => {
  const liveStep = t.clocks?.find((c) => c.key === "live")?.step;
  const live = t.list?.find((step) => step.id === liveStep);
  if (live?.from === "day0" && typeof live.end === "number") return live.end;
  return Math.max(0, ...(t.list ?? []).map((s) => (s.from === "start" && typeof s.end === "number" ? s.end : 0)));
};

function firstRunVM(today: string, me: NonNullable<Awaited<ReturnType<typeof getMe>>["data"]>, templates: Template[], canCreate: boolean): FirstRunVM {
  const hues = ["teal", "indigo", "sky"] as const;
  const icons = ["building", "play", "browser"] as const;
  const href = "/tasks?view=projects&newProject=1";
  const items: TemplateCardVM[] = templates.slice(0, 3).map((t, i) => ({
    id: t.key, name: t.name, hue: hues[i % hues.length], icon: icons[i % icons.length], phases: t.stages?.length ?? 0, steps: t.steps, days: daysOf(t), href,
  }));
  const role = me.role === "owner" ? "owner" : ["admin", "leadership", "hr"].includes(me.role) ? "admin" : "member";
  return {
    today,
    viewer: {
      person: { id: me.person ?? "", name: me.name, role: me.role, photoAt: me.photoAt },
      orgRole: role,
      isLead: !!me.lead,
      can: { createProject: canCreate, editPlan: canCreate, changeStepOwnerOrDue: canCreate, approveTeam: false, skip: false, seeMoney: false },
    },
    headline: "Run every client project the same, good way",
    steps: [{ key: "template", label: "Pick a template" }, { key: "dates", label: "Set your dates" }, { key: "team", label: "Add your team" }],
    start: canCreate ? { label: "Start your first project", href } : null,
    note: canCreate ? undefined : "Projects appear here when your lead starts one.",
    // A company with no template yet has no template row (no heading over an empty list).
    templates: canCreate && items.length ? { heading: "Start from a template", seeAll: { label: "See all templates", href }, items } : null,
    art: [{ hue: "teal", icon: "building" }, { hue: "indigo", icon: "play" }, { hue: "amber", icon: "megaphone" }],
  };
}

export async function LiveFirstRun({ today, canCreate }: { today: string; canCreate: boolean }) {
  const [meR, templatesR] = await Promise.all([
    getMe(),
    canCreate ? api<{ templates: Template[] }>("projects/templates?full=1") : Promise.resolve(null),
  ]);
  if (meR.error) return <Message text={meR.error} />;
  if (!meR.data) return null;
  if (templatesR?.error) return <Message text={templatesR.error} />;
  return <div className={css.mount}><FirstRun vm={firstRunVM(today, meR.data, templatesR?.data?.templates ?? [], canCreate)} /></div>;
}
