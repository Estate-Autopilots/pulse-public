/** SOP-WORKFLOW: the SOP document model shared by the library, the Drive importer and the workflow builder. Steps keep
 *  their order; `next: null` means "then the following step", an explicit list draws branches (decisions, approvals,
 *  "send back"). Everything that comes in (the editor, a parse, an import) goes through `normalizeDoc`, which keeps the
 *  limits and drops connections to steps that do not exist. Pure: no database. */

export const STEP_KINDS = ['task', 'decision', 'approval', 'wait', 'end'] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export type SopLink = { label: string; url: string };
export type SopNext = { to: string; label: string | null };
export type SopStep = {
  id: string; title: string; detail: string | null; kind: StepKind;
  role: string | null; personId: string | null; involves: string[]; phase: string | null;
  inputs: string[]; outputs: string[]; kpis: string[];
  minutes: number | null; slaHours: number | null; links: SopLink[]; next: SopNext[] | null;
};
export type SopDoc = { steps: SopStep[]; phases: string[]; roles: string[]; outputs: string[]; watch: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT = { steps: 150, title: 200, detail: 3000, list: 24, item: 300, roles: 40, phases: 30, links: 8 };
type Raw = Record<string, unknown>;

export const clean = (x: unknown, max = LIMIT.item) => typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const block = (x: unknown, max = LIMIT.detail) => typeof x === 'string' ? x.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) || null : null;
const list = (x: unknown, max = LIMIT.list) => Array.isArray(x) ? [...new Set(x.map((v) => clean(v)).filter(Boolean))].slice(0, max) : [];
const num = (x: unknown, lo: number, hi: number) => { const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : NaN; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : null; };

/** The normalised document, or an error message for the person editing it. */
export function normalizeDoc(input: unknown): { doc: SopDoc } | { error: string } {
  const d = (input && typeof input === 'object' ? input : {}) as Raw;
  const raw = Array.isArray(d.steps) ? d.steps as Raw[] : [];
  if (raw.length > LIMIT.steps) return { error: `Keep an SOP to ${LIMIT.steps} steps: split it into two` };
  const ids = new Set<string>(); let n = 0;
  const steps: SopStep[] = raw.map((s0) => {
    const s = (s0 && typeof s0 === 'object' ? s0 : {}) as Raw;
    let id = clean(s.id, 40).replace(/[^A-Za-z0-9_-]/g, '');
    while (!id || ids.has(id)) id = `s${++n}`;
    ids.add(id);
    const kind = (STEP_KINDS as readonly string[]).includes(String(s.kind)) ? s.kind as StepKind : 'task';
    const links = Array.isArray(s.links) ? (s.links as Raw[]).map((l) => ({ label: clean(l?.label, 80), url: clean(l?.url, 500) }))
      .filter((l) => /^(https:\/\/|\/[^/])/.test(l.url)).map((l) => ({ label: l.label || l.url, url: l.url })).slice(0, LIMIT.links) : [];
    return {
      id, title: clean(s.title, LIMIT.title), detail: block(s.detail), kind,
      role: clean(s.role, 80) || null, personId: UUID.test(String(s.personId)) ? String(s.personId) : null,
      involves: list(s.involves, 8).map((r) => r.slice(0, 80)), phase: clean(s.phase, 120) || null,
      inputs: list(s.inputs), outputs: list(s.outputs), kpis: list(s.kpis),
      minutes: num(s.minutes, 1, 60 * 24 * 60), slaHours: num(s.slaHours, 0.25, 24 * 180), links,
      next: Array.isArray(s.next) ? (s.next as Raw[]).map((x) => ({ to: clean(x?.to, 40), label: clean(x?.label, 60) || null })) : null,
    };
  });
  const empty = steps.findIndex((s) => !s.title);
  if (empty >= 0) return { error: `Step ${empty + 1} needs a name` };
  for (const s of steps) if (s.next) s.next = s.next.filter((x, i, all) => x.to !== s.id && ids.has(x.to) && all.findIndex((y) => y.to === x.to && y.label === x.label) === i).slice(0, 6);
  const phases = list(d.phases, LIMIT.phases).filter(Boolean);
  for (const s of steps) if (s.phase && !phases.includes(s.phase) && phases.length < LIMIT.phases) phases.push(s.phase);
  const roles = list(d.roles, LIMIT.roles);
  for (const s of steps) for (const r of [s.role, ...s.involves]) if (r && !roles.some((x) => x.toLowerCase() === r.toLowerCase()) && roles.length < LIMIT.roles) roles.push(r);
  return { doc: { steps, phases, roles, outputs: list(d.outputs), watch: list(d.watch) } };
}

/** The connections the diagram draws: explicit ones, else on to the next step (an end step stops). */
export function edges(doc: Pick<SopDoc, 'steps'>): { from: string; to: string; label: string | null }[] {
  const out: { from: string; to: string; label: string | null }[] = [];
  doc.steps.forEach((s, i) => {
    if (s.next) for (const x of s.next) out.push({ from: s.id, to: x.to, label: x.label });
    else if (s.kind !== 'end' && i + 1 < doc.steps.length) out.push({ from: s.id, to: doc.steps[i + 1].id, label: null });
  });
  return out;
}

/** Where the work changes hands: a connection between steps owned by different roles (or people). */
export function handoffs(doc: Pick<SopDoc, 'steps'>) {
  const by = new Map(doc.steps.map((s) => [s.id, s]));
  return edges(doc).filter((e) => { const a = by.get(e.from), b = by.get(e.to); const wa = a?.personId ?? a?.role?.toLowerCase() ?? null, wb = b?.personId ?? b?.role?.toLowerCase() ?? null; return !!(wa && wb && wa !== wb); });
}

/** Total typical time and the longest SLA path (hours), for the SOP's summary line. */
export function timing(doc: Pick<SopDoc, 'steps'>) {
  const minutes = doc.steps.reduce((t, s) => t + (s.minutes ?? 0), 0);
  const sla = doc.steps.reduce((t, s) => t + (s.slaHours ?? 0), 0);
  return { minutes: minutes || null, slaHours: sla || null, timed: doc.steps.filter((s) => s.minutes || s.slaHours).length };
}
