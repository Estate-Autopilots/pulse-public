import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { Message, Page, PageHeader } from "../../ui";
import { MapSwitch } from "./switch";
import { UnlockMap, type MapData } from "./map-view";
import css from "./map.module.css";

/** The request's moment: server components render once per request. */
const clock = () => Date.now();

type View = MapData & { scope: "project" | "person"; id: string | null; title: string; today: string | null; me: string | null; projects: { id: string; name: string; links: number }[] };

/** TASKS-P0: the unlock map of a project or a person. */
export default async function MapPage({ searchParams }: { searchParams: Promise<{ project?: string; person?: string }> }) {
  const q = await searchParams;
  const params = new URLSearchParams(); if (q.project) params.set("project", q.project); else if (q.person) params.set("person", q.person);
  const r = await api<View>(`tasks/map?${params}`);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!;
  const open = d.nodes.filter((n) => !["done", "accepted", "in_review", "cancelled"].includes(n.status));
  const people = new Set(open.map((n) => n.personId).filter(Boolean)).size;
  const waiting = open.filter((n) => d.edges.some((e) => e.from === n.id && !["done", "accepted", "in_review"].includes(d.nodes.find((x) => x.id === e.to)?.status ?? ""))).length;
  return <Page fit>
    <PageHeader title="Unlock map" back={{ href: "/tasks?view=board", label: "Work" }} recent={{ title: `Unlock map · ${d.title}` }}
      context={[d.scope === "project" ? d.title : d.id === d.me ? "Your work" : `${d.title.split(" ")[0]}’s work`, plural(waiting, "task") + " waiting", people ? plural(people, "person", "people") : null]} />
    <div className={css.bar}>
      <p className={css.stats}><span><b>{open.length}</b> open</span><span><b>{d.edges.length}</b> links</span>{d.critical.length ? <span>Critical path: <b>{plural(d.critical.length, "task")}</b></span> : null}</p>
      <MapSwitch projects={d.projects} current={d.scope === "project" ? d.id : null} person={d.scope === "person" ? d.id : null} me={d.me} />
    </div>
    <UnlockMap data={d} now={clock()} />
  </Page>;
}
