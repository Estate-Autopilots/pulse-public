/** SOP-WORKFLOW part 2: a workflow definition is an SOP document whose steps also say who does them (a rule), what kind
 *  of work they are, which form they carry, how they join, how long a wait lasts, and on which condition a branch is
 *  taken. The engine reads it in the database (0241); this module keeps it within limits. Pure. */
import { normalizeDoc, type SopDoc, type SopStep } from './sop-model.js';
import { BLOCK, portProblem } from './workflow-blocks.js';

export const ASSIGN_BY = ['role', 'person', 'domain', 'starter', 'project_owner', 'pool'] as const;
export const CONDITION_OPS = ['filled', 'empty', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
export const TRIGGERS = ['manual', 'package', 'milestone', 'schedule', 'form'] as const;
export type Assign = { by: (typeof ASSIGN_BY)[number]; role?: string | null; personId?: string | null; category?: string | null; scope?: 'company' | 'pod' };
export type Condition = { field: string; op: (typeof CONDITION_OPS)[number]; value?: string | number | null };
export type WorkflowStep = Omit<SopStep, 'next'> & {
  assign: Assign; category: string | null; formId: string | null; join: 'any' | 'all'; waitHours: number | null;
  next: { to: string; label: string | null; when?: Condition | null; port?: string | null; in?: string | null }[] | null;
  /** The builder's block (workflow-blocks.ts), its place on the canvas, and where a Hand-off block passes the work. */
  module?: string | null; pos?: { x: number; y: number } | null; handoff?: { workflowId: string } | null;
};
export type WorkflowDef = Omit<SopDoc, 'steps'> & { steps: WorkflowStep[] };
export type Trigger = { kind: (typeof TRIGGERS)[number]; imported?: boolean; category?: string; projectStatus?: string; every?: 'day' | 'week' | 'month'; at?: string; weekday?: number; day?: number;
  projectId?: string | null; formId?: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Raw = Record<string, unknown>;
const text = (x: unknown, max: number) => typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const num = (x: unknown, lo: number, hi: number) => { const n = Number(x); return x !== null && x !== '' && x !== undefined && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };

function assignOf(raw: unknown, role: string | null, personId: string | null): Assign {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  const by = (ASSIGN_BY as readonly string[]).includes(String(a.by)) ? a.by as Assign['by'] : personId ? 'person' : role ? 'role' : 'starter';
  const out: Assign = { by };
  if (by === 'role') out.role = text(a.role, 80) || role;
  if (by === 'person') out.personId = UUID.test(String(a.personId)) ? String(a.personId) : personId;
  if (by === 'domain') out.category = text(a.category, 40) || null;
  if (by === 'pool') out.scope = a.scope === 'pod' ? 'pod' : 'company';
  return out;
}
function conditionOf(raw: unknown): Condition | null {
  const c = (raw && typeof raw === 'object' ? raw : null) as Raw | null;
  if (!c || !text(c.field, 80) || !(CONDITION_OPS as readonly string[]).includes(String(c.op))) return null;
  const value = typeof c.value === 'number' ? c.value : text(c.value, 120);
  return { field: text(c.field, 80), op: c.op as Condition['op'], ...(['filled', 'empty'].includes(String(c.op)) ? {} : { value }) };
}

/** The normalised definition, or an error for the person designing it. */
export function normalizeWorkflow(input: unknown): { def: WorkflowDef } | { error: string } {
  const base = normalizeDoc(input);
  if ('error' in base) return base;
  const raw = (((input && typeof input === 'object' ? input : {}) as Raw).steps ?? []) as Raw[];
  const steps: WorkflowStep[] = base.doc.steps.map((s, i) => {
    const r = (raw[i] && typeof raw[i] === 'object' ? raw[i] : {}) as Raw;
    const nextRaw = Array.isArray(r.next) ? r.next as Raw[] : null;
    const module = BLOCK.has(String(r.module)) ? String(r.module) : null;
    const ports = module ? BLOCK.get(module)! : null;
    const pos = r.pos && typeof r.pos === 'object' ? { x: Math.round(num((r.pos as Raw).x, 0, 8000) ?? 0), y: Math.round(num((r.pos as Raw).y, 0, 8000) ?? 0) } : null;
    const handoff = module === 'handoff' && r.handoff && typeof r.handoff === 'object' && UUID.test(String((r.handoff as Raw).workflowId)) ? { workflowId: String((r.handoff as Raw).workflowId) } : null;
    const key = (x: unknown) => { const k = text(x, 24); return /^[a-z_]+$/.test(k) ? k : null; };
    return {
      ...s, assign: assignOf(r.assign, s.role, s.personId), category: text(r.category, 40) || null,
      formId: UUID.test(String(r.formId)) ? String(r.formId) : null, join: r.join === 'all' ? 'all' : 'any',
      waitHours: s.kind === 'wait' ? num(r.waitHours, 0.25, 24 * 90) ?? 24 : null,
      next: s.next ? s.next.map((n) => {
        const x = nextRaw?.find((y) => text(y?.to, 40) === n.to && (text(y?.label, 60) || null) === n.label);
        const port = ports ? (ports.outputs.some((o) => o.key === key(x?.port)) ? key(x?.port) : null) : null;
        // An approval's or a decision's ports are its answers: the wire carries the port's word as its label.
        const label = n.label ?? (port && (s.kind === 'approval' || s.kind === 'decision') ? ports!.outputs.find((o) => o.key === port)!.label : null);
        return { ...n, label, when: conditionOf(x?.when), ...(port ? { port } : {}), ...(key(x?.in) ? { in: key(x?.in) } : {}) };
      }) : null,
      ...(module ? { module } : {}), ...(pos ? { pos } : {}), ...(handoff ? { handoff } : {}),
    };
  });
  const wrong = steps.findIndex((s) => s.module && BLOCK.get(s.module)!.kind !== s.kind);
  if (wrong >= 0) return { error: `Step ${wrong + 1} is a ${BLOCK.get(steps[wrong].module!)!.label} block: keep its kind` };
  const problem = portProblem(steps);
  if (problem) return { error: problem };
  const bad = steps.findIndex((s) => s.kind === 'decision' && (!s.next || s.next.length < 2));
  if (bad >= 0) return { error: `Step ${bad + 1} is a decision: give it at least two ways to go` };
  // Blocks only: an SOP step without wires goes on to the next one in the list, so its order is its meaning.
  return { def: { ...base.doc, steps: steps.some((s) => s.module) ? wireOrder(steps) : steps } };
}

/** Steps in the order their wires run (stable: an order that already fits is kept). The engine (0241) counts a wire
 *  into a step only when it comes from an earlier step, so a block wired in later on the canvas must come after its
 *  source. Send back wires are left out; where a loop remains, the earliest step in the list goes first. */
export function wireOrder<T extends { id: string; next: { to: string; port?: string | null }[] | null }>(steps: T[]): T[] {
  const index = new Map(steps.map((s, i) => [s.id, i]));
  const ins = new Map(steps.map((s) => [s.id, 0]));
  const fwd = (s: T) => (s.next ?? []).filter((n) => n.port !== 'back' && index.has(n.to) && n.to !== s.id);
  for (const s of steps) for (const n of fwd(s)) ins.set(n.to, ins.get(n.to)! + 1);
  const out: T[] = []; const left = new Set(steps.map((s) => s.id));
  while (left.size) {
    const pick = steps.find((s) => left.has(s.id) && ins.get(s.id) === 0) ?? steps.find((s) => left.has(s.id))!;
    left.delete(pick.id); out.push(pick);
    for (const n of fwd(pick)) if (left.has(n.to)) ins.set(n.to, ins.get(n.to)! - 1);
  }
  return out;
}

export function normalizeTrigger(input: unknown): Trigger | { error: string } {
  const t = (input && typeof input === 'object' ? input : {}) as Raw;
  const kind = (TRIGGERS as readonly string[]).includes(String(t.kind)) ? t.kind as Trigger['kind'] : 'manual';
  if (kind === 'package') return { kind, imported: t.imported === true };
  if (kind === 'milestone') {
    const category = text(t.category, 40), projectStatus = ['planned', 'active', 'paused', 'done', 'cancelled'].includes(String(t.projectStatus)) ? String(t.projectStatus) : '';
    if (!category && !projectStatus) return { error: 'Choose the milestone: a kind of work finished, or the project\'s status' };
    return category ? { kind, category } : { kind, projectStatus };
  }
  if (kind === 'schedule') {
    const every = ['day', 'week', 'month'].includes(String(t.every)) ? t.every as Trigger['every'] : 'week';
    const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t.at)) ? String(t.at) : '09:00';
    return { kind, every, at, ...(every === 'week' ? { weekday: num(t.weekday, 1, 7) ?? 1 } : {}), ...(every === 'month' ? { day: num(t.day, 1, 28) ?? 1 } : {}),
      projectId: UUID.test(String(t.projectId)) ? String(t.projectId) : null };
  }
  if (kind === 'form') return UUID.test(String(t.formId)) ? { kind, formId: String(t.formId) } : { error: 'Choose the form that starts it' };
  return { kind: 'manual' };
}

/** A new workflow from an SOP: every step keeps its owner (by role, or the named person). */
export function fromSop(doc: SopDoc): WorkflowDef {
  const r = normalizeWorkflow({ ...doc, steps: doc.steps.map((s) => ({ ...s, assign: s.personId ? { by: 'person', personId: s.personId } : s.role ? { by: 'role', role: s.role } : { by: 'starter' } })) });
  if ('error' in r) return { ...doc, steps: doc.steps.map((s) => ({ ...s, assign: { by: 'starter' }, category: null, formId: null, join: 'any', waitHours: null, next: s.kind === 'decision' ? null : s.next })) } as WorkflowDef;
  return r.def;
}

/** What a trigger says, in words. */
export function triggerWords(t: Trigger, labels: { category?: (k: string) => string | null; form?: string | null } = {}) {
  const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  switch (t.kind) {
    case 'package': return `When a new client package is made${t.imported ? ' (or imported from Drive)' : ' in Pulse'}`;
    case 'milestone': return t.category ? `When ${labels.category?.(t.category) ?? t.category} work is finished on a project` : `When a project becomes ${t.projectStatus}`;
    case 'schedule': return t.every === 'day' ? `Every day at ${t.at}` : t.every === 'month' ? `On day ${t.day} of every month at ${t.at}` : `Every ${DAYS[t.weekday ?? 1]} at ${t.at}`;
    case 'form': return `When ${labels.form ? `“${labels.form}”` : 'its form'} is sent`;
    default: return 'Started by hand';
  }
}
