/** FLOW-A (owner, 21 Oct 2026; ~/ea-research/flow/FLOW-OS.md): the shared shapes of Flow, one engine that can hold any
 *  company's work. A Process is a write-up plus a definition (steps, wires, stages, variants, alert rules); a Run is one
 *  client or project going through it; a Step is one module placed in a process; a wire joins a step's Makes to another
 *  step's Needs of the same kind. Readiness, not permission: a step opens when the data it needs exists.
 *  Pure (no imports, no runtime beyond constants): the web app imports these types and labels as they are, like
 *  apps/web/app/finance/types.ts does with finance-model.ts. The contract is ~/ea-research/flow/CONTRACT.md. */

// ---------------------------------------------------------------------------------------------------------------------
// Kinds: what travels on a wire. Industry words are labels on ports and steps, never new kinds.
export const KINDS = ['contact', 'talk', 'doc', 'media', 'answers', 'money', 'verdict', 'slot', 'list', 'any'] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABELS: Record<Kind, string> = {
  contact: 'Contact', talk: 'Talk', doc: 'Document', media: 'Media', answers: 'Answers', money: 'Money', verdict: 'Verdict',
  slot: 'Time slot', list: 'List', any: 'Anything',
};
export const KIND_HELP: Record<Kind, string> = {
  contact: 'A person or company outside: a lead, client or buyer',
  talk: 'A call, meeting or chat: its recording, transcript and summary',
  doc: 'A written document with sections, versions and comments',
  media: 'Photos, video, audio or files, each with when, where and who',
  answers: 'The fields of a form',
  money: 'A quote, invoice or payment',
  verdict: 'An approval, confirmation or choice, with who and when',
  slot: 'A scheduled time with people and a place',
  list: 'A set of records: personas, USPs, hooks, assets, items asked for',
  any: 'Anything: takes whatever comes in',
};
/** The old builder's port types (workflow-blocks.ts) in the new kinds. A hand-off is a wire option, not a kind. */
export const OLD_KINDS: Record<string, Kind> = { lead: 'contact', call: 'talk', quote: 'money', photo: 'media', form: 'answers', hand: 'any', any: 'any' };

/** A wire fits when the kinds are the same, or either end takes anything. */
export const kindFits = (from: Kind, to: Kind) => from === to || from === 'any' || to === 'any';

// ---------------------------------------------------------------------------------------------------------------------
// Modules: a module is a plugin (a manifest + handlers). GET /api/v1/flow/modules returns the manifests.
export type Port = { key: string; label: string; kind: Kind; required?: boolean; many?: boolean; recordType?: string };
export const CATEGORIES = ['Start', 'People', 'Talk', 'Write', 'Media', 'Field', 'Money', 'Review', 'Flow', 'Apps', 'AI'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Surface = 'task' | 'doc' | 'meeting' | 'media' | 'form' | 'money' | 'review' | 'board' | 'none';
/** person: the doer says it is done · auto: finishes by itself · output: done when its record is final · verdict: done when answered */
export type Finish = 'person' | 'auto' | 'output' | 'verdict';
export const PIP_ACTIONS = ['draft', 'critique', 'summarise', 'extract', 'check', 'suggest'] as const;
export type PipAction = (typeof PIP_ACTIONS)[number];
/** live: built and running · partial: works, part of it opens another page or is typed in by hand · stub: holds its place */
export type Engine = 'live' | 'partial' | 'stub';
export type SettingField = {
  key: string; label: string;
  type: 'text' | 'longtext' | 'number' | 'boolean' | 'choice' | 'role' | 'person' | 'form' | 'template' | 'list' | 'recordType' | 'items';
  options?: { value: string; label: string }[]; help?: string; default?: unknown;
};
export type ModuleManifest = {
  key: string; version: number; name: string; icon: string;           // lucide icon name
  category: Category; summary: string;                                 // one plain sentence
  needs: Port[]; makes: Port[];
  surface: Surface; finish: Finish;
  settings: SettingField[];
  defaults: { role?: string; checklist?: string[]; qualityTest?: string[]; dueDays?: number; hours?: number };
  pip: PipAction[];
  engine: Engine; status: string;                                      // honest: how much is built, in words
  records?: string[];                                                  // record types its step works on
  converter?: boolean;                                                 // its needs and makes are different kinds
  legacy?: string[];                                                   // old builder block keys it replaces
  actions?: { key: string; label: string; help: string }[];            // POST /steps/:id/actions/:key
  link?: string;                                                       // an existing Pulse page that does the work today
};

// ---------------------------------------------------------------------------------------------------------------------
// Records + Links: typed records with fields and a status machine (Persona, Competitor, USP, Fact, Asset ...). Any company
// can define its own record types the same way (POST /api/v1/flow/record-types).
export type RecordField = {
  key: string; label: string;
  type: 'text' | 'longtext' | 'number' | 'date' | 'boolean' | 'choice' | 'multi' | 'person' | 'url' | 'list' | 'record' | 'money' | 'json';
  required?: boolean; options?: string[]; recordType?: string; help?: string; max?: number;
};
export type RecordStatus = { key: string; label: string; next: string[]; final?: boolean; tone?: 'neutral' | 'good' | 'warn' | 'bad' };
export type RecordType = {
  key: string; name: string; plural: string; icon: string; summary: string;
  fields: RecordField[]; statuses: RecordStatus[]; initial: string;
  titleField: string;                                                  // which field names a record
  code?: { pattern: string; help: string };                            // e.g. the Asset ID
  sections?: { key: string; title: string }[];                         // a document's tabs
  builtin: boolean;
};
export type FlowRecord = {
  id: string; type: string; title: string; status: string; statusLabel: string; code: string | null;
  runId: string | null; stepKey: string | null; projectId: string | null; clientId: string | null;
  data: Record<string, unknown>; source: { label: string; url?: string | null; on?: string | null } | null;
  version: number; frozenAt: string | null; createdAt: string; createdBy: string | null; updatedAt: string;
  links?: { id: string; kind: string; recordId: string; type: string; title: string; direction: 'out' | 'in' }[];
};

// ---------------------------------------------------------------------------------------------------------------------
// The process definition (stored JSON, versioned when published; a run keeps the version it started with).
export const ASSIGN_BY = ['role', 'person', 'starter', 'project_owner', 'pool', 'domain'] as const;
export type Assign = { by: (typeof ASSIGN_BY)[number]; role?: string | null; personId?: string | null; category?: string | null };
export const CONDITION_OPS = ['eq', 'ne', 'in', 'notin', 'filled', 'empty', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
export type Condition = { field: string; op: (typeof CONDITION_OPS)[number]; value?: string | number | boolean | null; values?: string[] };
/** When a step is due: N days after the run starts, after Day 1 (the sprint clock), after another step is done, or after
 *  a date field of the run. `days` may differ per value of a variant field (Starter 4 / Growth 5 / Sell-Out 6). */
export type DueRule = { from: 'start' | 'day1' | `step:${string}` | `field:${string}`; days: number | Record<string, number>; field?: string; workdays?: boolean };
/** A Needs port that a person fills by hand (typed in or uploaded) rather than a wire: who owns it. */
export type DirectInput = { port: string; owner: Assign; label?: string | null };
/** FLOW-D: something a step uses from an earlier step ("the brochure from step 1.2"); Pulse checks it comes earlier. */
export type StepUse = { step: string; port?: string | null; label?: string | null };
export type FlowStep = {
  id: string; module: string; title: string; stage?: string | null;
  /** FLOW-D: the primitive this step is (start, task, collect, meet, write, review, decide, wait, message, ai, app,
   *  repeat, end); `module` is the backend that does it, chosen by the primitive's kind. A step with a block waits for
   *  the steps before it ("Starts after"); what it uses from earlier steps passes by itself. */
  block?: string | null;
  preset?: string | null;                                               // the company block it was made from
  uses?: StepUse[];
  who: Assign; settings: Record<string, unknown>;
  due?: DueRule | null;
  when?: Condition[];                                                   // variant filter: all must hold, else skipped
  sop?: { processId?: string | null; section?: string | null } | null;  // which part of the write-up explains it
  pos: { x: number; y: number };
  checklist?: string[]; qualityTest?: string[];
  hours?: number | Record<string, number> | null;                       // focused hours (capacity), per variant value
  inputs?: DirectInput[];
  note?: string | null;
};
export type FlowWire = { from: { step: string; port: string }; to: { step: string; port: string }; notify?: string[]; label?: string | null };
export type VariantField = {
  key: string; label: string; type: 'choice' | 'boolean' | 'text' | 'date' | 'number' | 'person';
  options?: { value: string; label: string }[]; required?: boolean; variant?: boolean; help?: string | null;
};
export type RoleDef = { key: string; label: string; note?: string | null };
export type Stage = { key: string; label: string; note?: string | null };
export const ALERT_WHEN = ['not-done-by-due', 'not-done-by-day', 'in-state-longer', 'field-missing-by', 'value-missing-after', 'blocked-longer', 'record-in-status-longer'] as const;
export type AlertWhen = (typeof ALERT_WHEN)[number];
/** Generic alert rules; a company's alerts are data in its template, never code. `notify` holds role keys and the words
 *  'doer' (whoever has the step), 'data-owner' (whoever owes the data a step waits for) and 'starter'. */
export type AlertRule = {
  key: string; name: string; when: AlertWhen; notify: string[];
  steps?: string[];                 // not-done-by-due, not-done-by-day, in-state-longer, blocked-longer (none: every step)
  state?: StepState;                // in-state-longer
  days?: number | Record<string, number>; field?: string; workdays?: boolean;   // not-done-by-day: Day N; field-missing-by: the date field
  hours?: number;                   // in-state-longer, blocked-longer, value-missing-after (or workdays below)
  after?: string; missing?: string; // value-missing-after: step `after` done, step `missing` not done in time
  recordType?: string; status?: string;  // record-in-status-longer
  waitDays?: number;                // working days allowed (in-state-longer, value-missing-after, blocked-longer, record-in-status-longer)
  when2?: Condition[];              // only for runs whose fields match (e.g. Sell-Out)
};
export type ScoreMetric = {
  key: string; label: string; kind: 'on-time' | 'first-time' | 'revisions' | 'verdict' | 'count';
  steps?: string[]; recordType?: string; field?: string; note?: string | null;
};
/** The sprint clock: Day 1 is the day the intake step's critical items are all in (or the run's start, or a date field). */
export type Clock = { from: 'start' | 'intake' | 'field'; step?: string | null; field?: string | null };
export type FlowDef = {
  version: 2;
  fields: VariantField[]; roles: RoleDef[]; stages: Stage[];
  steps: FlowStep[]; wires: FlowWire[]; rules: AlertRule[];
  scorecard?: ScoreMetric[]; clock?: Clock | null;
  terms?: { run?: string; runs?: string } | null;
};

// ---------------------------------------------------------------------------------------------------------------------
// Steps of a run: data, not permission.
export const STEP_STATES = ['waiting', 'open', 'in_progress', 'in_review', 'confirmed', 'done', 'skipped'] as const;
export type StepState = (typeof STEP_STATES)[number];
export const STEP_STATE_LABELS: Record<StepState, string> = {
  waiting: 'Waiting for data', open: 'Open', in_progress: 'In progress', in_review: 'Sent for review', confirmed: 'Confirmed', done: 'Done', skipped: 'Skipped',
};
export const OPEN_STATES: StepState[] = ['open', 'in_progress', 'in_review', 'confirmed'];

/** A problem in a definition, in words, and where it is. */
export type Problem = { level: 'error' | 'warning'; text: string; step?: string; wire?: number;
  fix?: { kind: 'converter'; modules: string[] } | { kind: 'block'; block: string; blockKind: string; label: string } | null };

// ---------------------------------------------------------------------------------------------------------------------
// API shapes (GET /api/v1/flow/...)
export type ProcessStatus = 'written' | 'draft' | 'live' | 'paused' | 'archived';
/** Where a process lives: a Flow process, or an older SOP, workflow or board read through Flow (nothing is lost). */
export type ProcessSource = 'flow' | 'sop' | 'workflow' | 'board';
export type WriteupSection = { key: string; title: string; body: string; parent?: string | null; source?: { label: string; url?: string | null } | null };
export type PersonRef = { id: string; name: string; photoAt?: string | null; role?: string | null };
export type ProcessSummary = {
  id: string; source: ProcessSource; name: string; summary: string | null; status: ProcessStatus;
  statusText: string;               // "Written only" · "Steps drafted" · "Live · 3 running"
  stages: { key: string; label: string; steps: number }[];
  roles: string[]; people: PersonRef[]; steps: number; running: number; late: number;
  template: string | null; updatedAt: string; readOnly: boolean; terms: { run: string; runs: string };
};
export type ProcessDetail = ProcessSummary & {
  writeup: WriteupSection[]; definition: FlowDef; version: number; publishedAt: string | null; publishedBy: string | null;
  problems: Problem[]; canEdit: boolean; canStart: boolean;
  legacy: { sopId?: string | null; workflowId?: string | null; boardId?: string | null } | null;
  roleHolders: Record<string, PersonRef[]>;
};
export type Due = { on: string | null; text: string; late: boolean; days: number | null };
export type WaitingFor = { port: string; label: string; kind: Kind; from: { step: string; title: string; who: PersonRef | null; role: string | null } | null; owner: PersonRef | null; ownerRole: string | null };
export type RunStep = {
  id: string; key: string; title: string; module: string; moduleName: string; icon: string; surface: Surface; stage: string | null;
  state: StepState; stateText: string; waitingFor: WaitingFor[]; skippedWhy: string | null;
  who: PersonRef | null; role: string | null; due: Due;
  openedAt: string | null; startedAt: string | null; sentAt: string | null; confirmedAt: string | null; doneAt: string | null;
  rounds: number; taskId: string | null; record: { type: string; id: string; title: string } | null;
  checklist: string[]; checks: number[]; sop: { processId: string | null; section: string | null; title: string | null } | null;
  blocked: { since: string; note: string | null } | null; alerts: { rule: string; name: string; at: string }[];
  needs: (Port & { filled: boolean })[]; makes: (Port & { filled: boolean })[]; href: string;
  block?: string | null; kind?: string | null;                          // FLOW-D: the primitive and its kind, in words
};
export type RunValue = { step: string | null; port: string; side: 'makes' | 'needs'; kind: Kind; value: unknown; setBy: string | null; setAt: string };
export type RunSummary = {
  id: string; processId: string; process: string; name: string; status: 'running' | 'done' | 'cancelled'; mode: 'live' | 'demo';
  projectId?: string | null; clientId?: string | null;                                      // FLOW-C: the project / client the run is for
  fields: Record<string, unknown>; fieldsText: { key: string; label: string; text: string }[];   // "Package: Sell-Out"
  startedAt: string; finishedAt: string | null; day1: string | null; day: number | null;
  counts: { open: number; waiting: number; late: number; done: number; skipped: number; total: number };
  next: { key: string; title: string; due: Due; who: PersonRef | null } | null; alertCount: number; terms: { run: string; runs: string };
};
export type RunDetail = RunSummary & {
  stages: Stage[]; roles: RoleDef[]; people: Record<string, PersonRef | { name: string; demo: true } | null>;
  steps: RunStep[]; values: RunValue[]; intake: IntakeItem[];
  alerts: { key: string; rule: string; name: string; step: string | null; at: string; notified: string[] }[];
  pip: string; canEdit: boolean; wires: FlowWire[];
  /** FLOW-D: who was told what (notifications in a live run; who would have heard in Try it and demo runs). */
  notices: { at: string; step: string | null; to: string; role: string | null; title: string; sent: boolean; how: string }[];
};
export type IntakeItem = { step: string; key: string; label: string; critical: boolean; owner: string | null; receivedOn: string | null; note: string | null };
// ---------------------------------------------------------------------------------------------------------------------
// FLOW-D (owner, 21 Oct 2026: "can there not be blocks that are just the primitives of all?"): about a dozen
// primitives, nothing industry-specific. Each asks one plain question; its kinds pick the backend module that does it.
export const BLOCK_KEYS = ['start', 'task', 'collect', 'meet', 'write', 'review', 'decide', 'wait', 'message', 'ai', 'app', 'repeat', 'end'] as const;
export type BlockKey = (typeof BLOCK_KEYS)[number];
/** One kind of a primitive ("Photos on the spot" for Collect): the backend module and the settings it starts with. */
export type BlockKind = { key: string; label: string; help: string; module: string; settings?: Record<string, unknown>; more?: boolean };
export type Primitive = {
  key: BlockKey; name: string; icon: string; question: string; summary: string;
  kinds: BlockKind[];                                                    // the first is the default; `more` ones fold away
  finish: string;                                                        // how it ends, in words
};
/** A company block: a saved, named preset of a primitive (title, checklist, write-up part, template, who, due). */
export type CompanyBlock = {
  id: string; key: string; name: string; summary: string | null; block: BlockKey; source: string | null;
  step: Pick<FlowStep, 'module' | 'title' | 'settings' | 'who'> & Partial<Pick<FlowStep, 'checklist' | 'qualityTest' | 'due' | 'sop' | 'hours' | 'note' | 'inputs'>>;
  updatedAt: string;
};

export type MyStep = {
  id: string; runId: string; run: string; process: string; key: string; title: string; module: string; icon: string; surface: Surface;
  state: StepState; stateText: string; due: Due; checklist: string[]; checks: number[]; sop: { processId: string | null; section: string | null } | null;
  waitingFor: WaitingFor[]; href: string; demo: boolean;
  block?: string | null; kind?: string | null;
  role?: string | null;                                                  // FLOW-E: the role it came to me as (a person can hold several)
};
