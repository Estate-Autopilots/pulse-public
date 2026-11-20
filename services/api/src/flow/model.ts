/** FLOW-A: a process definition kept within limits (normalizeFlow), checked in words (problems: kinds that do not fit,
 *  with the converters that would fit; needs nobody gives; loops that would wait forever), compiled for the engine
 *  (compile: each step's ports with what is required, how it finishes; the engine in 0800 reads only this), and the
 *  older SOPs, workflows and boards read as processes so nothing is lost. Pure. */
import { MODULE, MODULES, moduleOf } from './registry.js';
import { ancestors, gates, isBlock, MAKER, nearestMaker, PRIMITIVE, stepPorts } from './blocks.js';
import { ALERT_WHEN, ASSIGN_BY, CONDITION_OPS, KIND_LABELS, kindFits, OLD_KINDS, STEP_STATES,
  type AlertRule, type Assign, type Condition, type DirectInput, type DueRule, type FlowDef, type FlowStep, type FlowWire, type Kind,
  type ModuleManifest, type Port, type Problem, type RoleDef, type ScoreMetric, type Stage, type VariantField, type WriteupSection } from './types.js';

type Raw = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT = { steps: 200, wires: 600, fields: 30, roles: 40, stages: 30, rules: 60, checklist: 60, item: 400, title: 200, settings: 60000 };
const obj = (x: unknown): Raw => (x && typeof x === 'object' && !Array.isArray(x) ? x : {}) as Raw;
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const text = (x: unknown, max: number) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, max) : typeof x === 'number' ? String(x) : '');
const key = (x: unknown, max = 40) => { const k = text(x, max).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''); return /^[a-z]/.test(k) ? k : k ? `k_${k}`.slice(0, max) : ''; };
const stepId = (x: unknown) => text(x, 40).replace(/[^A-Za-z0-9._-]/g, '');
const num = (x: unknown, lo: number, hi: number) => { const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : NaN; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : null; };
export const slug = (x: string) => x.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'role';

export function normalizeAssign(raw: unknown): Assign {
  const a = obj(raw);
  const by = (ASSIGN_BY as readonly string[]).includes(String(a.by)) ? a.by as Assign['by'] : a.personId ? 'person' : a.role ? 'role' : 'starter';
  const out: Assign = { by };
  if (by === 'role') out.role = key(a.role) || null;
  if (by === 'person') out.personId = UUID.test(String(a.personId)) ? String(a.personId) : null;
  if (by === 'domain') out.category = text(a.category, 40) || null;
  return out;
}
export function normalizeConditions(raw: unknown): Condition[] {
  return arr(raw).slice(0, 8).map(obj).filter((c) => key(c.field) && (CONDITION_OPS as readonly string[]).includes(String(c.op))).map((c) => {
    const op = c.op as Condition['op'];
    if (op === 'in' || op === 'notin') return { field: key(c.field), op, values: arr(c.values).map((v) => text(v, 80)).filter(Boolean).slice(0, 20) };
    if (op === 'filled' || op === 'empty') return { field: key(c.field), op };
    return { field: key(c.field), op, value: typeof c.value === 'number' || typeof c.value === 'boolean' ? c.value : text(c.value, 120) };
  });
}
function normalizeDue(raw: unknown, fields: VariantField[]): DueRule | null {
  const d = obj(raw); if (!Object.keys(d).length) return null;
  const from = String(d.from ?? 'start');
  const okFrom = from === 'start' || from === 'day1' || /^step:[A-Za-z0-9._-]{1,40}$/.test(from) || /^field:[a-z][a-z0-9_]{0,39}$/.test(from);
  let days: DueRule['days'] | null = null;
  if (typeof d.days === 'number' || typeof d.days === 'string') days = num(d.days, 0, 3650);
  else if (d.days && typeof d.days === 'object') {
    const m: Record<string, number> = {}; for (const [k, v] of Object.entries(obj(d.days)).slice(0, 30)) { const n = num(v, 0, 3650); if (n !== null) m[text(k, 60)] = n; }
    days = Object.keys(m).length ? m : null;
  }
  if (days === null) return null;
  const variant = fields.find((f) => f.variant) ?? fields.find((f) => f.type === 'choice');
  const field = typeof days === 'object' ? (fields.some((f) => f.key === d.field) ? String(d.field) : variant?.key) : undefined;
  return { from: (okFrom ? from : 'start') as DueRule['from'], days, ...(field ? { field } : {}), workdays: d.workdays !== false };
}
function normalizeHours(raw: unknown): FlowStep['hours'] {
  if (typeof raw === 'number' || typeof raw === 'string') return num(raw, 0, 2000);
  if (raw && typeof raw === 'object') { const m: Record<string, number> = {}; for (const [k, v] of Object.entries(obj(raw)).slice(0, 30)) { const n = num(v, 0, 2000); if (n !== null) m[text(k, 60)] = n; } return Object.keys(m).length ? m : null; }
  return null;
}
const lines = (x: unknown, max = LIMIT.checklist) => arr(x).map((l) => text(l, LIMIT.item)).filter(Boolean).slice(0, max);

/** The definition kept within limits. Unknown modules are kept (a problem says so); wires to ports that do not exist are dropped. */
export function normalizeFlow(input: unknown): FlowDef {
  const d = obj(input);
  const fields: VariantField[] = [];
  for (const f0 of arr(d.fields).slice(0, LIMIT.fields).map(obj)) {
    const k = key(f0.key ?? f0.label); if (!k || fields.some((x) => x.key === k)) continue;
    const type = (['choice', 'boolean', 'text', 'date', 'number', 'person'] as const).find((t) => t === f0.type) ?? 'text';
    const options = type === 'choice' ? arr(f0.options).map(obj).map((o) => ({ value: key(o.value ?? o.label), label: text(o.label ?? o.value, 80) })).filter((o) => o.value && o.label).slice(0, 30) : undefined;
    fields.push({ key: k, label: text(f0.label, 80) || k, type, ...(options ? { options } : {}), ...(f0.required ? { required: true } : {}), ...(f0.variant ? { variant: true } : {}), ...(text(f0.help, 300) ? { help: text(f0.help, 300) } : {}) });
  }
  const roles: RoleDef[] = [];
  for (const r0 of arr(d.roles).slice(0, LIMIT.roles).map(obj)) { const k = key(r0.key ?? r0.label); if (k && !roles.some((x) => x.key === k)) roles.push({ key: k, label: text(r0.label, 80) || k, ...(text(r0.note, 300) ? { note: text(r0.note, 300) } : {}) }); }
  const stages: Stage[] = [];
  for (const s0 of arr(d.stages).slice(0, LIMIT.stages).map(obj)) { const k = text(s0.key ?? s0.label, 40).replace(/[^A-Za-z0-9._-]/g, ''); if (k && !stages.some((x) => x.key === k)) stages.push({ key: k, label: text(s0.label, 120) || k, ...(text(s0.note, 300) ? { note: text(s0.note, 300) } : {}) }); }
  const ids = new Set<string>(); let n = 0;
  const steps: FlowStep[] = arr(d.steps).slice(0, LIMIT.steps).map(obj).map((s0, i) => {
    let id = stepId(s0.id); while (!id || ids.has(id)) id = `s${++n}`; ids.add(id);
    const block = isBlock(s0.block) ? s0.block : null;
    const module = text(s0.module, 40) || (block ? PRIMITIVE.get(block)!.kinds[0].module : 'checklist');
    const settings = obj(s0.settings);
    const pos = obj(s0.pos);
    const sop = obj(s0.sop);
    const inputs: DirectInput[] = arr(s0.inputs).map(obj).filter((x) => text(x.port, 40)).slice(0, 12).map((x) => ({ port: text(x.port, 40), owner: normalizeAssign(x.owner), ...(text(x.label, 120) ? { label: text(x.label, 120) } : {}) }));
    const step: FlowStep = {
      id, module, title: text(s0.title, LIMIT.title) || MODULE.get(module)?.name || `Step ${i + 1}`,
      stage: stages.some((x) => x.key === s0.stage) ? String(s0.stage) : null,
      who: normalizeAssign(s0.who), settings: JSON.stringify(settings).length <= LIMIT.settings ? settings : {},
      due: normalizeDue(s0.due, fields), when: normalizeConditions(s0.when),
      sop: Object.keys(sop).length ? { processId: UUID.test(String(sop.processId)) ? String(sop.processId) : null, section: text(sop.section, 80) || null } : null,
      pos: { x: Math.round(num(pos.x, -20000, 20000) ?? (i % 6) * 280), y: Math.round(num(pos.y, -20000, 20000) ?? Math.floor(i / 6) * 180) },
      checklist: lines(s0.checklist), qualityTest: lines(s0.qualityTest), hours: normalizeHours(s0.hours), inputs,
      note: text(s0.note, 2000) || null,
      ...(block ? { block } : {}), ...(text(s0.preset, 60) ? { preset: text(s0.preset, 60) } : {}),
      ...(arr(s0.uses).length ? { uses: arr(s0.uses).map(obj).filter((u) => stepId(u.step)).slice(0, 20).map((u) => ({ step: stepId(u.step), ...(text(u.port, 40) ? { port: text(u.port, 40) } : {}), ...(text(u.label, 120) ? { label: text(u.label, 120) } : {}) })) } : {}),
    };
    return step;
  });
  const has = (s: string) => steps.some((x) => x.id === s);
  const wires: FlowWire[] = [];
  for (const w0 of arr(d.wires).slice(0, LIMIT.wires).map(obj)) {
    const from = obj(w0.from), to = obj(w0.to);
    const w: FlowWire = { from: { step: stepId(from.step), port: text(from.port, 40) }, to: { step: stepId(to.step), port: text(to.port, 40) } };
    if (!has(w.from.step) || !has(w.to.step) || w.from.step === w.to.step || !w.from.port || !w.to.port) continue;
    if (wires.some((x) => x.from.step === w.from.step && x.from.port === w.from.port && x.to.step === w.to.step && x.to.port === w.to.port)) continue;
    const notify = arr(w0.notify).map((r) => key(r)).filter(Boolean).slice(0, 8);
    wires.push({ ...w, ...(notify.length ? { notify } : {}), ...(text(w0.label, 80) ? { label: text(w0.label, 80) } : {}) });
  }
  const rules: AlertRule[] = [];
  for (const r0 of arr(d.rules).slice(0, LIMIT.rules).map(obj)) {
    const k = key(r0.key ?? r0.name); if (!k || rules.some((x) => x.key === k) || !(ALERT_WHEN as readonly string[]).includes(String(r0.when))) continue;
    const r: AlertRule = { key: k, name: text(r0.name, 120) || k, when: r0.when as AlertRule['when'], notify: arr(r0.notify).map((x) => text(x, 40)).filter(Boolean).slice(0, 8) };
    const st = arr(r0.steps).map(stepId).filter(has); if (st.length) r.steps = st;
    if ((STEP_STATES as readonly string[]).includes(String(r0.state))) r.state = r0.state as AlertRule['state'];
    if (r0.days !== undefined) { const due = normalizeDue({ from: 'day1', days: r0.days, field: r0.field }, fields); if (due) { r.days = due.days; if (due.field) r.field = due.field; } }
    if (r.when === 'field-missing-by' && key(r0.field)) r.field = key(r0.field);
    if (r0.workdays === false) r.workdays = false;
    const h = num(r0.hours, 0.25, 24 * 365); if (h !== null) r.hours = h;
    const w = num(r0.waitDays, 0, 365); if (w !== null) r.waitDays = w;
    if (has(stepId(r0.after))) r.after = stepId(r0.after);
    if (stepId(r0.missing)) r.missing = stepId(r0.missing);
    if (key(r0.recordType)) r.recordType = key(r0.recordType);
    if (text(r0.status, 40)) r.status = text(r0.status, 40);
    const c = normalizeConditions(r0.when2); if (c.length) r.when2 = c;
    rules.push(r);
  }
  const scorecard: ScoreMetric[] = arr(d.scorecard).slice(0, 20).map(obj).filter((x) => key(x.key) && ['on-time', 'first-time', 'revisions', 'verdict', 'count'].includes(String(x.kind)))
    .map((x) => ({ key: key(x.key), label: text(x.label, 120) || key(x.key), kind: x.kind as ScoreMetric['kind'], ...(arr(x.steps).length ? { steps: arr(x.steps).map(stepId).filter(has) } : {}),
      ...(key(x.recordType) ? { recordType: key(x.recordType) } : {}), ...(key(x.field) ? { field: key(x.field) } : {}), ...(text(x.note, 300) ? { note: text(x.note, 300) } : {}) }));
  const c0 = obj(d.clock);
  const clock = c0.from === 'intake' && has(stepId(c0.step)) ? { from: 'intake' as const, step: stepId(c0.step) }
    : c0.from === 'field' && fields.some((f) => f.key === c0.field) ? { from: 'field' as const, field: String(c0.field) } : { from: 'start' as const };
  const t0 = obj(d.terms);
  const terms = text(t0.run, 40) ? { run: text(t0.run, 40), runs: text(t0.runs, 40) || `${text(t0.run, 40)}s` } : null;
  return { version: 2, fields, roles, stages, steps, wires, rules, scorecard, clock, terms };
}

/** The ports of a step as placed: the module's ports (a module this server does not know has none); a step with a
 *  block (FLOW-D) waits on "Starts after" and uses the rest (blocks.ts stepPorts). */
export const portsOf = (s: Pick<FlowStep, 'module'> & Partial<Pick<FlowStep, 'block' | 'settings'>>): { needs: Port[]; makes: Port[] } => stepPorts({ block: s.block ?? null, module: s.module, settings: s.settings ?? {} });

/** Modules that turn a `from` kind into a `to` kind, best first: what the builder offers on a wire that does not fit. */
export function converters(from: Kind, to: Kind): string[] {
  const score = (mm: ModuleManifest) => {
    const need = mm.needs.find((n) => n.kind === from) ? 2 : mm.needs.find((n) => n.kind === 'any') ? 1 : 0;
    const make = mm.makes.some((x) => x.kind === to) ? 2 : 0;
    return need && make ? need + make + (mm.converter ? 1 : 0) + (mm.engine === 'live' ? 0.5 : mm.engine === 'partial' ? 0.25 : 0) : 0;
  };
  return MODULES.filter((mm) => mm.needs.length && mm.category !== 'Start').map((mm) => ({ k: mm.key, s: score(mm) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 5).map((x) => x.k);
}

/** What is wrong with a definition, in words: errors stop it going live; warnings are advice. */
export function problems(def: FlowDef): Problem[] {
  const out: Problem[] = [];
  const by = new Map(def.steps.map((s) => [s.id, s]));
  for (const s of def.steps) {
    const mm = MODULE.get(s.module);
    if (!mm) { out.push({ level: 'error', step: s.id, text: `“${s.title}” uses a module this server does not have (${s.module})` }); continue; }
    if (s.who.by === 'role' && s.who.role && !def.roles.some((r) => r.key === s.who.role)) out.push({ level: 'warning', step: s.id, text: `“${s.title}” goes to the role “${s.who.role}”, which the process does not list` });
    if (s.who.by === 'role' && !s.who.role) out.push({ level: 'warning', step: s.id, text: `Choose who does “${s.title}”` });
    if (s.due && typeof s.due.days === 'object' && s.due.field) {
      const f = def.fields.find((x) => x.key === s.due!.field);
      const miss = (f?.options ?? []).filter((o) => !(o.value in (s.due!.days as Record<string, number>)));
      if (miss.length) out.push({ level: 'warning', step: s.id, text: `“${s.title}” has no due day for ${miss.map((o) => o.label).join(', ')}` });
    }
    if (s.due?.from.startsWith('step:') && !by.has(s.due.from.slice(5))) out.push({ level: 'warning', step: s.id, text: `“${s.title}” is due after a step that does not exist` });
    if (s.due?.from === 'day1' && (!def.clock || def.clock.from === 'start')) out.push({ level: 'warning', step: s.id, text: `“${s.title}” counts from Day 1, and Day 1 is the day the run starts: set the clock to an intake checklist or a date field` });
    // FLOW-D: a block step's typed needs are what it uses; one no earlier step makes is said in words, with the
    // primitive that would make it.
    if (s.block) {
      const gated = gates(def);
      for (const need of mm.needs) {
        // A meeting fixes its own time in the step: a time slot is not asked of an earlier step.
        if (need.key === 'in' || need.kind === 'any' || need.kind === 'slot' || need.required === false || def.wires.some((w) => w.to.step === s.id && w.to.port === need.key) || (s.inputs ?? []).some((i) => i.port === need.key)) continue;
        if (nearestMaker(def, s.id, need.kind, gated)) continue;
        const mk = MAKER[need.kind];
        out.push({ level: 'warning', step: s.id, text: `“${s.title}” uses ${need.label.toLowerCase()} (${KIND_LABELS[need.kind].toLowerCase()}): no earlier step makes one${mk ? `. Add ${mk.words} before it?` : ''}`,
          ...(mk ? { fix: { kind: 'block' as const, block: mk.block, blockKind: mk.kind, label: `Add ${mk.words}` } } : {}) });
      }
      const before = ancestors(def, s.id, gated);
      for (const u of s.uses ?? []) {
        const src = by.get(u.step);
        if (!src) out.push({ level: 'warning', step: s.id, text: `“${s.title}” uses ${u.label ?? 'something'} from a step that is gone` });
        else if (!before.has(src.id)) out.push({ level: 'warning', step: s.id, text: `“${s.title}” uses ${u.label ?? `what “${src.title}” makes`}, and “${src.title}” does not come before it: move it after` });
      }
      const rule = obj(s.settings.rule);
      if (s.block === 'decide' && Object.keys(rule).length && !text(rule.field, 80)) out.push({ level: 'warning', step: s.id, text: `Say which answer decides “${s.title}”, or let a person choose` });
      if (s.block === 'decide' && !def.wires.some((w) => w.from.step === s.id)) out.push({ level: 'warning', step: s.id, text: `“${s.title}” has no steps on either way yet` });
      continue;
    }
    // A typed need nobody gives does not hold the step up; say so (an untyped "starts after" port left free is fine).
    for (const need of mm.needs) {
      if (need.required === false || need.kind === 'any') continue;
      const wired = def.wires.some((w) => w.to.step === s.id && w.to.port === need.key);
      const direct = (s.inputs ?? []).some((i) => i.port === need.key);
      if (!wired && !direct) out.push({ level: 'warning', step: s.id, text: `Nobody gives “${s.title}” its ${need.label.toLowerCase()} (${KIND_LABELS[need.kind]}): wire it from a step, or name who types it in. Until then it does not wait for it` });
    }
    for (const c of s.when ?? []) if (!def.fields.some((f) => f.key === c.field)) out.push({ level: 'warning', step: s.id, text: `“${s.title}” depends on a field the process does not have (${c.field})` });
  }
  def.wires.forEach((w, i) => {
    const a = by.get(w.from.step), b = by.get(w.to.step); if (!a || !b) return;
    const ma = MODULE.get(a.module), mb = MODULE.get(b.module); if (!ma || !mb) return;
    const out1 = portsOf(a).makes.find((x) => x.key === w.from.port), in1 = portsOf(b).needs.find((x) => x.key === w.to.port);
    if (!out1) { out.push({ level: 'error', wire: i, step: a.id, text: `“${a.title}” does not make “${w.from.port}”` }); return; }
    if (!in1) { out.push({ level: 'error', wire: i, step: b.id, text: portsOf(b).needs.length ? `“${b.title}” does not need “${w.to.port}”` : `“${b.title}” starts a run: nothing can come before it` }); return; }
    if (!kindFits(out1.kind, in1.kind)) out.push({ level: 'error', wire: i, step: b.id, fix: { kind: 'converter', modules: converters(out1.kind, in1.kind) },
      text: `“${a.title}” makes a ${KIND_LABELS[out1.kind].toLowerCase()}, and “${b.title}” needs a ${KIND_LABELS[in1.kind].toLowerCase()}: add a converter between them` });
    for (const r of w.notify ?? []) if (r !== 'starter' && !def.roles.some((x) => x.key === r)) out.push({ level: 'warning', wire: i, text: `A wire tells the role “${r}”, which the process does not list` });
  });
  // A loop of required needs waits forever.
  const req = compile(def);
  const deps = new Map(def.steps.map((s) => [s.id, def.wires.filter((w) => w.to.step === s.id && req.steps[s.id]?.needs.some((n) => n.key === w.to.port && n.required)).map((w) => w.from.step)]));
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, path: string[]): string[] | null => {
    if (state.get(id) === 2) return null; if (state.get(id) === 1) return [...path.slice(path.indexOf(id)), id];
    state.set(id, 1); for (const d of deps.get(id) ?? []) { const c = visit(d, [...path, id]); if (c) return c; } state.set(id, 2); return null;
  };
  for (const s of def.steps) { const c = visit(s.id, []); if (c) { out.push({ level: 'error', step: s.id, text: `These steps wait on each other and would never open: ${c.map((x) => `“${by.get(x)?.title ?? x}”`).join(' → ')}` }); break; } }
  for (const r of def.rules) {
    if ((r.when === 'value-missing-after') && (!r.after || !r.missing || !by.has(r.missing))) out.push({ level: 'warning', text: `The alert “${r.name}” needs the step after which, and the step that is missing` });
    if (r.when === 'field-missing-by' && !def.fields.some((f) => f.key === r.field)) out.push({ level: 'warning', text: `The alert “${r.name}” needs a date field` });
    if (r.when === 'record-in-status-longer' && (!r.recordType || !r.status)) out.push({ level: 'warning', text: `The alert “${r.name}” needs a record type and its status` });
    if (!r.notify.length) out.push({ level: 'warning', text: `The alert “${r.name}” tells nobody` });
  }
  if (!def.steps.length) out.push({ level: 'error', text: 'A process needs at least one step to go live' });
  return out;
}

export type Compiled = { variant: string | null; steps: Record<string, { needs: (Port & { required: boolean })[]; makes: Port[]; finish: string; branch?: boolean; hours?: number; surface: string; skipWords?: string;
  block?: string; rule?: Condition; untilField?: string }> };
/** What the engine (0800) reads: each step's ports (a need is required only when something can give it), how it ends. */
export function compile(def: FlowDef): Compiled {
  const variant = def.fields.find((f) => f.variant)?.key ?? null;
  const steps: Compiled['steps'] = {};
  for (const s of def.steps) {
    const mm = MODULE.get(s.module); const ports = portsOf(s);
    const needs = ports.needs.map((n) => {
      const wired = def.wires.some((w) => w.to.step === s.id && w.to.port === n.key), typed = (s.inputs ?? []).some((i) => i.port === n.key);
      // A block step waits only on "Starts after" (and on what someone types in); its other needs are what it uses.
      return { ...n, required: s.block ? (n.key === 'in' && wired) || typed : n.required !== false && (wired || typed) };
    });
    const until = s.module === 'wait' ? text(s.settings.until, 20) : '';
    const untilField = until === 'field' && def.fields.some((f) => f.key === text(s.settings.field, 40)) ? text(s.settings.field, 40) : null;
    const finish = s.module === 'wait' ? (until === 'input' ? 'person' : 'timer') : mm?.finish ?? 'person';
    // A rule compares without caring about capitals (flow_answers reads answers in lower case too).
    const r = obj(s.settings.rule); const r0 = s.module === 'decision' && key(r.field) && (CONDITION_OPS as readonly string[]).includes(String(r.op)) ? normalizeConditions([r])[0] : null;
    const rule = r0 ? { ...r0, ...(typeof r0.value === 'string' ? { value: r0.value.toLowerCase() } : {}), ...(r0.values ? { values: r0.values.map((x) => x.toLowerCase()) } : {}) } : null;
    const skip = (s.when ?? []).map((c) => { const f = def.fields.find((x) => x.key === c.field); const label = (v: string) => f?.options?.find((o) => o.value === v)?.label ?? v;
      if (f?.type === 'boolean' && (c.op === 'eq' || c.op === 'ne')) return `${(c.op === 'eq') === (String(c.value) === 'true') ? '' : 'no '}${f.label.toLowerCase()}`;
      return c.op === 'in' ? `${f?.label ?? c.field}: ${(c.values ?? []).map(label).join(', ')}` : c.op === 'eq' ? `${f?.label ?? c.field}: ${label(String(c.value))}` : c.op === 'notin' ? `not ${(c.values ?? []).map(label).join(', ')}` : `${f?.label ?? c.field} ${c.op}`; });
    steps[s.id] = { needs, makes: ports.makes, finish, surface: mm?.surface ?? 'task',
      ...(s.module === 'decision' ? { branch: true } : {}),
      ...(s.module === 'wait' && finish === 'timer' ? { hours: untilField ? 24 * 3650 : num(s.settings.hours, 0.25, 24 * 90) ?? (num(s.settings.days, 0.01, 3650) ?? 1) * 24 } : {}),
      ...(untilField ? { untilField } : {}), ...(rule ? { rule } : {}), ...(s.block ? { block: s.block } : {}),
      ...(skip.length ? { skipWords: `Only for ${skip.join('; ')}` } : {}) };
  }
  return { variant, steps };
}

export function normalizeWriteup(input: unknown): WriteupSection[] {
  const seen = new Set<string>();
  return arr(input).slice(0, 400).map(obj).map((s, i) => {
    let k = text(s.key, 80).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || `section-${i + 1}`; while (seen.has(k)) k = `${k}-${i}`; seen.add(k);
    const src = obj(s.source);
    return { key: k, title: text(s.title, 200) || `Section ${i + 1}`, body: typeof s.body === 'string' ? s.body.replace(/\r\n?/g, '\n').slice(0, 200000) : '',
      ...(text(s.parent, 80) ? { parent: text(s.parent, 80) } : {}), ...(text(src.label, 200) ? { source: { label: text(src.label, 200), url: text(src.url, 500) || null } } : {}) };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Older SOPs, workflows and boards, read as processes (nothing is lost; editing one makes a Flow process from it).
type SopStepLike = { id: string; title: string; detail: string | null; kind: string; role: string | null; personId: string | null; phase: string | null; slaHours?: number | null;
  next: { to: string; label: string | null; port?: string | null; in?: string | null }[] | null; module?: string | null; pos?: { x: number; y: number } | null;
  assign?: { by: string; role?: string | null; personId?: string | null; category?: string | null } | null; handoff?: { workflowId: string } | null };
const KIND_MODULE: Record<string, string> = { task: 'checklist', approval: 'approval', decision: 'decision', wait: 'wait', end: 'end' };
const detailLines = (d: string | null) => (d ?? '').split('\n').map((l) => l.replace(/^\s*(•|-|\*|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 40);
const OLD_PORT: Record<string, Record<string, string>> = { approval: { approved: 'verdict', back: '' } };

/** An SOP: its write-up (the purpose, then each step as a section). It has no steps until someone drafts them. */
export function sopWriteup(title: string, purpose: string | null, steps: SopStepLike[]): WriteupSection[] {
  return [{ key: 'purpose', title, body: purpose ?? '' }, ...steps.map((s, i) => ({ key: `step-${s.id}`, title: `${i + 1}. ${s.title}`,
    body: [s.role ? `Who: ${s.role}` : '', s.detail ?? ''].filter(Boolean).join('\n\n') }))];
}

/** An old workflow definition as steps and wires: its blocks keep their modules (re-typed), a plain step is a Checklist,
 *  "then the next step" becomes a wire. Send-back wires have no place in a data flow and are dropped (a problem says so). */
export function workflowSteps(steps: SopStepLike[], prefix = '', stageKey: string | null = null, x0 = 0): { steps: FlowStep[]; wires: FlowWire[]; roles: RoleDef[]; dropped: number } {
  const roles: RoleDef[] = []; const id = (s: string) => `${prefix}${s}`.slice(0, 40); let dropped = 0;
  const roleKey = (r: string | null | undefined) => { if (!r) return null; const k = slug(r); if (!roles.some((x) => x.key === k)) roles.push({ key: k, label: r }); return k; };
  const out: FlowStep[] = steps.map((s, i) => {
    const module = s.module && MODULE.has(s.module) ? s.module : KIND_MODULE[s.kind] ?? 'checklist';
    const a = s.assign; const role = a?.by === 'role' ? a.role ?? s.role : s.role;
    const who: Assign = a?.by === 'person' || (!a && s.personId) ? { by: 'person', personId: a?.personId ?? s.personId } : a?.by === 'starter' ? { by: 'starter' }
      : a?.by === 'project_owner' ? { by: 'project_owner' } : a?.by === 'pool' ? { by: 'pool' } : a?.by === 'domain' ? { by: 'domain', category: a.category ?? null } : role ? { by: 'role', role: roleKey(role) } : { by: 'starter' };
    return { id: id(s.id), module, title: s.title, stage: stageKey ?? (s.phase ? slug(s.phase) : null), who, settings: {}, due: null, when: [], sop: null,
      pos: s.pos ? { x: s.pos.x + x0, y: s.pos.y } : { x: x0 + i * 280, y: 120 }, checklist: detailLines(s.detail), qualityTest: [], hours: null, inputs: [], note: null };
  });
  const wires: FlowWire[] = [];
  steps.forEach((s, i) => {
    const from = out[i]; const mf = moduleOf(from.module);
    const nexts = s.next ?? (s.kind === 'end' || i === steps.length - 1 ? [] : [{ to: steps[i + 1].id, label: null }]);
    for (const n of nexts) {
      const j = steps.findIndex((x) => x.id === n.to); if (j < 0) continue;
      const to = out[j]; const mt = moduleOf(to.module);
      let port = n.port ? (OLD_PORT[from.module]?.[n.port] ?? n.port) : mf.makes[0]?.key;
      if (port === '' || j <= i) { dropped++; continue; }
      if (from.module === 'decision' && !n.port) port = /^(no|otherwise|reject)/i.test(n.label ?? '') ? 'no' : 'yes';
      const inPort = n.in && mt.needs.some((x) => x.key === n.in) ? n.in : mt.needs[0]?.key;
      if (!port || !inPort || !mf.makes.some((x) => x.key === port)) { dropped++; continue; }
      wires.push({ from: { step: from.id, port }, to: { step: to.id, port: inPort }, ...(n.label ? { label: n.label } : {}) });
    }
  });
  return { steps: out, wires, roles, dropped };
}

export function legacyDef(steps: SopStepLike[], phases: string[] = []): { def: FlowDef; dropped: number } {
  const w = workflowSteps(steps);
  const stages = [...new Set([...phases, ...steps.map((s) => s.phase).filter((x): x is string => !!x)])].map((p) => ({ key: slug(p), label: p }));
  return { def: normalizeFlow({ version: 2, fields: [], roles: w.roles, stages, steps: w.steps, wires: w.wires, rules: [], clock: { from: 'start' } }), dropped: w.dropped };
}

/** A board: its tabs are the stages of one process; a hand-off from one tab to another becomes a wire into that tab. */
export function boardDef(tabs: { id: string; name: string; steps: SopStepLike[] }[]): { def: FlowDef; dropped: number } {
  const all: FlowStep[] = []; const wires: FlowWire[] = []; const roles: RoleDef[] = []; let dropped = 0;
  const firstOf = new Map<string, string>();
  tabs.forEach((t, i) => { const w = workflowSteps(t.steps, `t${i + 1}.`, `tab${i + 1}`, 0); firstOf.set(t.id, w.steps[0]?.id ?? '');
    // A tab's "From a hand-off" start waits for the hand-off: a pass-through step the hand-off wire feeds.
    for (const s of w.steps) { s.pos = { x: s.pos.x, y: s.pos.y + i * 260 }; if (s.module === 'handoff_in') { s.module = 'notify'; s.title = s.title || 'From the previous tab'; } }
    for (const x of w.wires) if (w.steps.some((s) => s.id === x.from.step && s.module === 'notify') && x.from.port === 'lead') x.from.port = 'then';
    all.push(...w.steps); wires.push(...w.wires); dropped += w.dropped; for (const r of w.roles) if (!roles.some((x) => x.key === r.key)) roles.push(r); });
  tabs.forEach((t, i) => t.steps.forEach((s) => {
    if (s.module !== 'handoff' || !s.handoff?.workflowId) return;
    const target = firstOf.get(s.handoff.workflowId); const hid = `t${i + 1}.${s.id}`.slice(0, 40);
    const h = all.find((x) => x.id === hid); if (h) h.module = 'notify';
    if (target && h) wires.push({ from: { step: hid, port: 'then' }, to: { step: target, port: 'in' }, label: 'Hand-off' });
  }));
  return { def: normalizeFlow({ version: 2, fields: [], roles, stages: tabs.map((t, i) => ({ key: `tab${i + 1}`, label: t.name })), steps: all, wires, rules: [], clock: { from: 'start' } }), dropped };
}

/** The new kind of an old port type. */
export const newKind = (old: string): Kind => OLD_KINDS[old] ?? 'any';
