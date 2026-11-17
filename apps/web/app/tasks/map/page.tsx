import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { readyNow } from "../../lib/dep-graph.mjs";
import { Message, Page, PageHeader } from "../../ui";
import { MapSwitch } from "./switch";
import { DependencyGraph, LinkWork, type DepGraphData } from "./graph";
import css from "./graph.module.css";

/** BLOCKERS-MAP: the dependency map of a project, a goal, a person's work or the whole company. Tasks, projects and
 *  goals can each wait on any other; ?focus=kind:id&mode=up shows what is blocking one of them. */
export default async function MapPage({ searchParams }: { searchParams: Promise<{ project?: string; goal?: string; person?: string; all?: string; focus?: string; mode?: string }> }) {
  const q = await searchParams;
  const params = new URLSearchParams();
  if (q.project) params.set("project", q.project); else if (q.goal) params.set("goal", q.goal); else if (q.all === "1") params.set("all", "1"); else if (q.person) params.set("person", q.person);
  const r = await api<DepGraphData>(`dependencies/graph?${params}`);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!;
  const open = d.nodes.filter((n) => n.state !== "done");
  const blocked = open.filter((n) => n.state === "blocked").length;
  const ready = readyNow(d.nodes, d.edges).length;
  const links = d.edges.filter((e) => e.type === "blocks").length;
  const where = d.scope === "project" || d.scope === "goal" ? d.title : d.scope === "all" ? "Whole company" : d.id === d.me ? "Your work" : `${d.title.split(" ")[0]}’s work`;
  const mode = q.mode === "down" || q.mode === "both" ? q.mode : "up";
  return <Page fit>
    <PageHeader title="Dependency map" back={{ href: "/tasks?view=board", label: "Work" }} recent={{ title: `Dependency map · ${d.title}` }}
      context={[where, `${open.length} open`, plural(blocked, "blocked item"), ready ? `${ready} ready to start` : null, plural(links, "link")]} actions={<LinkWork data={d} />} />
    <div className={css.bar}>
      {/* UX-GAMIFY: the counts say once, in the header line above; the map gets the room. */}
      <MapSwitch projects={d.projects} goals={d.goals} scope={d.scope} current={d.id} me={d.me} />
    </div>
    <DependencyGraph key={`${d.scope}:${d.id ?? ""}`} data={d} initialFocus={q.focus ?? null} initialMode={mode} />
  </Page>;
}
