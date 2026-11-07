// FLOW-B: one list of processes. A process is one way of working: its write-up (the SOP text), its steps and its runs.
// Until the flow API serves processes, the library reads the three old lists and joins them: a workflow made from an
// SOP is one process (the SOP is its write-up), a board is one process (its tabs are the stages), and an SOP nobody has
// turned into steps yet is a process that is written only.
import type { BoardRow } from "../sops/board-types";
import type { SopRow, WorkflowRow } from "../sops/types";
import type { ProcessSummary } from "./flow-types";

export type ProcessStatus = "written" | "drafted" | "live" | "paused";
export type ProcessCard = {
  key: string; kind: "sop" | "workflow" | "board"; id: string; href: string; name: string; line: string | null; status: ProcessStatus; updatedAt: string;
  steps: number; stages: { label: string; steps: number; slot: number }[]; roles: string[]; running: number; late: number; finished: number;
  client: string | null; fromDrive: boolean; search: string;
};

export const STATUS_WORD: Record<ProcessStatus, string> = { written: "Written only", drafted: "Steps drafted", live: "Live", paused: "Paused" };

/** Where a process opens. The old editors stay until the builder takes each kind over. */
export function processHref(kind: ProcessCard["kind"], id: string) {
  return kind === "board" ? `/sops/boards/${id}` : kind === "workflow" ? `/sops/workflows/${id}` : `/sops/${id}`;
}

type Shape = SopRow["shape"];
/** The stage strip, from what the lists carry (they leave step text out): the steps' stages in order with how many each
 *  holds; without stages, who does the steps in turn (each hand-off starts a segment); else the first step titles. */
function stagesOf(shape: Shape, roles: string[], titles: string[] = []): ProcessCard["stages"] {
  const runs = (label: (s: Shape[number]) => string | null | undefined) => {
    const out: ProcessCard["stages"] = [];
    for (const s of shape) {
      const l = label(s)?.trim() || out.at(-1)?.label || "Steps", last = out.at(-1);
      if (last?.label === l) last.steps++; else out.push({ label: l, steps: 1, slot: 0 });
    }
    return out;
  };
  const half = Math.ceil(shape.length / 2);
  if (shape.filter((s) => s.phase?.trim()).length >= half) return runs((s) => s.phase).map((x, i) => ({ ...x, slot: (i % 6) + 1 }));
  if (shape.filter((s) => s.role?.trim()).length >= half) return runs((s) => s.role).map((x) => ({ ...x, slot: (Math.max(0, roles.indexOf(x.label)) % 6) + 1 }));
  if (titles.length) return [...titles.map((t, i) => ({ label: t, steps: 1, slot: (i % 6) + 1 })), ...(shape.length > titles.length ? [{ label: `${shape.length - titles.length} more`, steps: shape.length - titles.length, slot: 0 }] : [])];
  return shape.length ? [{ label: `${shape.length} ${shape.length === 1 ? "step" : "steps"}`, steps: shape.length, slot: 0 }] : [];
}

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.map((x) => x?.trim()).filter(Boolean) as string[])];

export function processCards(sops: SopRow[], workflows: WorkflowRow[], boards: BoardRow[]): ProcessCard[] {
  const onBoard = new Set(boards.flatMap((b) => b.tabs.map((t) => t.id)));
  const written = new Map(sops.map((s) => [s.id, s]));
  const used = new Set<string>();
  const cards: ProcessCard[] = [];
  for (const b of boards.filter((x) => x.status === "active")) {
    const live = b.tabs.some((t) => t.status === "live"), roles = uniq(b.tabs.map((t) => t.tabRole ?? t.tabPerson));
    cards.push(card({ kind: "board", id: b.id, name: b.name, line: b.purpose, status: live ? "live" : "drafted", updatedAt: b.updatedAt, steps: b.tabs.reduce((n, t) => n + t.blocks, 0),
      stages: b.tabs.map((t, i) => ({ label: t.name || `Part ${i + 1}`, steps: Math.max(1, t.blocks), slot: (i % 6) + 1 })), roles,
      running: b.tabs.reduce((n, t) => n + t.running, 0), late: 0, finished: 0, client: null, fromDrive: false, extra: b.tabs.flatMap((t) => [t.name, ...t.modules]).join(" ") }));
  }
  for (const w of workflows.filter((x) => !onBoard.has(x.id) && x.status !== "archived")) {
    const sop = w.sopId ? written.get(w.sopId) : undefined;
    if (w.sopId) used.add(w.sopId);
    const roles = uniq([...w.roles, ...w.shape.map((s) => s.role)]), named = roles.length ? roles : sop?.roles ?? [];
    cards.push(card({ kind: "workflow", id: w.id, name: w.name, line: w.purpose ?? sop?.purpose ?? null, status: w.status === "live" ? "live" : w.status === "paused" ? "paused" : "drafted",
      updatedAt: w.updatedAt, steps: w.steps, stages: stagesOf(w.shape, roles, sop?.firstSteps), roles: named, running: w.running, late: w.late, finished: w.finished, client: w.clientName,
      fromDrive: sop?.source === "drive", extra: w.shape.map((s) => s.title).join(" ") }));
  }
  for (const s of sops.filter((x) => !used.has(x.id) && x.status !== "archived")) {
    cards.push(card({ kind: "sop", id: s.id, name: s.title, line: s.purpose, status: "written", updatedAt: s.updatedAt, steps: s.steps, stages: stagesOf(s.shape, s.roles, s.firstSteps), roles: s.roles,
      running: 0, late: 0, finished: 0, client: s.clientName, fromDrive: s.source === "drive", extra: s.firstSteps.join(" ") }));
  }
  const rank = (c: ProcessCard) => ({ live: 0, paused: 1, drafted: 2, written: 3 })[c.status];
  return cards.sort((a, z) => rank(a) - rank(z) || z.running - a.running || z.updatedAt.localeCompare(a.updatedAt));
}

function card(x: Omit<ProcessCard, "key" | "href" | "search"> & { extra: string }): ProcessCard {
  const { extra, ...rest } = x;
  return { ...rest, key: `${x.kind}-${x.id}`, href: processHref(x.kind, x.id), search: [x.name, x.line, x.client, ...x.roles, ...x.stages.map((s) => s.label), extra].join(" ").toLowerCase() };
}

/** The library from the flow API (every process, old or new, opens in the builder). */
export function flowCards(list: ProcessSummary[]): ProcessCard[] {
  const status = (x: ProcessSummary): ProcessStatus => x.status === "live" ? "live" : x.status === "paused" ? "paused" : x.status === "written" ? "written" : "drafted";
  const rank = (c: ProcessCard) => ({ live: 0, paused: 1, drafted: 2, written: 3 })[c.status];
  return list.filter((x) => x.status !== "archived").map((x): ProcessCard => {
    const roles = x.roles.length ? x.roles : x.people.map((p) => p.name);
    const named = x.stages.filter((g) => g.steps > 0 || x.stages.length <= 8).map((g, i) => ({ label: g.label, steps: Math.max(1, g.steps), slot: (i % 6) + 1 }));
    const stages = named.length ? named : x.steps ? [{ label: `${x.steps} ${x.steps === 1 ? "step" : "steps"}`, steps: x.steps, slot: 0 }] : [];
    return { key: x.id, kind: x.source === "board" ? "board" : x.source === "sop" ? "sop" : "workflow", id: x.id, href: `/processes/${encodeURIComponent(x.id)}${x.status === "written" ? "?tab=writeup" : ""}`, name: x.name, line: x.summary,
      status: status(x), updatedAt: x.updatedAt, steps: x.steps, stages, roles, running: x.running, late: x.late, finished: 0, client: null, fromDrive: false,
      search: [x.name, x.summary, ...roles, ...x.stages.map((g) => g.label)].join(" ").toLowerCase() };
  }).sort((a, z) => rank(a) - rank(z) || z.running - a.running || z.updatedAt.localeCompare(a.updatedAt));
}
