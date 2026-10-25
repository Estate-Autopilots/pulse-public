// SOP-WORKFLOW: what the SOP API returns (services/api/src/sops.ts, sop-model.ts).
export type StepKind = "task" | "decision" | "approval" | "wait" | "end";
export type SopStep = {
  id: string; title: string; detail: string | null; kind: StepKind; role: string | null; personId: string | null; involves: string[]; phase: string | null;
  inputs: string[]; outputs: string[]; kpis: string[]; minutes: number | null; slaHours: number | null; links: { label: string; url: string }[];
  next: { to: string; label: string | null }[] | null;
};
export type SopDoc = { steps: SopStep[]; phases: string[]; roles: string[]; outputs: string[]; watch: string[] };
export type Holder = { id: string; name: string; photoAt: string | null; pod: string | null };
export type Summary = { steps: number; phases: number; roles: string[]; handoffs: number; decisions: number; minutes: number | null; slaHours: number | null };
export type SopRow = Summary & { id: string; title: string; purpose: string | null; status: "draft" | "active" | "archived"; ownerRole: string | null; source: string; confidence: number | null;
  version: number; updatedAt: string; category: string | null; clientName: string | null; clientId: string | null; sourceName: string | null; sourceChanged: boolean; firstSteps: string[];
  shape: Pick<SopStep, "id" | "title" | "kind" | "role" | "personId" | "phase" | "next">[] };
export type Library = { canEdit: boolean; sops: SopRow[]; drive: { waiting: number; imported: number; dismissed: number; lastAt: string | null } | null };
export type SopDetail = {
  canEdit: boolean;
  sop: { id: string; title: string; purpose: string | null; status: "draft" | "active" | "archived"; doc: SopDoc; ownerRole: string | null; ownerId: string | null; ownerName: string | null;
    clientId: string | null; clientName: string | null; category: string | null; tags: string[]; source: string; confidence: number | null; version: number; updatedAt: string; updatedBy: string | null;
    confirmedAt: string | null; confirmedBy: string | null; sourceName?: string | null; sourceLink?: string | null; sourcePath?: string | null; sourceChanged?: boolean };
  summary: Summary; people: Record<string, Holder[]>; persons: (Holder & { role: string | null })[];
  versions: { version: number; title: string; note: string | null; savedAt: string; savedBy: string | null }[];
};
export type SourcePart = Summary & { index: number; title: string; purpose: string | null; ownerRole: string | null; confidence: number; confidenceWords: string; evidence: string[];
  preview: { title: string; role: string | null; kind: StepKind }[]; done: string | null; doc?: SopDoc };
export type Source = { id: string; name: string; link: string | null; path: string | null; mime: string | null; modifiedAt: string | null; score: number; reasons: string[];
  status: "new" | "imported" | "dismissed" | "gone"; owner: string | null; imported: { id: string; title: string; status: string }[]; parts: SourcePart[]; excerpt?: string };
export type DriveList = { status: string; counts: Record<string, number>; lastAt: string | null; sources: Source[] };
export type Draft = { title: string; purpose: string | null; ownerRole: string | null; ownerId?: string | null; clientId?: string | null; doc: SopDoc; status?: "draft" | "active"; confidence?: number | null };

export const KIND_LABEL: Record<StepKind, string> = { task: "Step", decision: "Decision", approval: "Approval", wait: "Wait", end: "End" };
export const emptyStep = (id: string, over: Partial<SopStep> = {}): SopStep => ({ id, title: "", detail: null, kind: "task", role: null, personId: null, involves: [], phase: null,
  inputs: [], outputs: [], kpis: [], minutes: null, slaHours: null, links: [], next: null, ...over });

// Part 2: workflows and runs (services/api/src/workflows.ts, workflow-model.ts, workflow-intel.ts).
export type AssignBy = "role" | "person" | "domain" | "starter" | "project_owner" | "pool";
export type Assign = { by: AssignBy; role?: string | null; personId?: string | null; category?: string | null; scope?: "company" | "pod" };
export type Condition = { field: string; op: "filled" | "empty" | "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains"; value?: string | number | null };
export type WfStep = Omit<SopStep, "next"> & { assign: Assign; category: string | null; formId: string | null; join: "any" | "all"; waitHours: number | null;
  next: { to: string; label: string | null; when?: Condition | null }[] | null };
export type WfDef = Omit<SopDoc, "steps"> & { steps: WfStep[] };
export type Trigger = { kind: "manual" | "package" | "milestone" | "schedule" | "form"; imported?: boolean; category?: string; projectStatus?: string; every?: "day" | "week" | "month"; at?: string; weekday?: number; day?: number; projectId?: string | null; formId?: string | null };
export type ActiveStep = { runId: string; id: string; key: string; position: number; title: string; kind: StepKind; startedAt: string; dueAt: string | null; late: boolean; asked: boolean; note: string | null;
  why: string | null; taskId: string | null; taskStatus: string | null; personId: string | null; person: string | null; photoAt: string | null; askedName: string | null; pooled: boolean; stuck: string | null };
export type RunRow = { id: string; name: string; status: "running" | "done" | "cancelled"; startedAt: string; finishedAt: string | null; via: string; projectId: string | null; clientId: string | null;
  workflowId: string; workflow: string; project: string | null; client: string | null; startedBy: string | null; steps: number; done: number; active: ActiveStep[]; late: number; stuck: string | null };
export type WorkflowRow = { id: string; name: string; purpose: string | null; status: "draft" | "live" | "paused" | "archived"; trigger: string; triggerKind: Trigger["kind"]; version: number; updatedAt: string;
  publishedAt: string | null; sopId: string | null; sopTitle: string | null; clientName: string | null; running: number; finished: number; late: number; steps: number; roles: string[];
  shape: Pick<SopStep, "id" | "title" | "kind" | "role" | "personId" | "phase" | "next">[] };
export type WorkflowList = { canEdit: boolean; canStart: boolean; workflows: WorkflowRow[] };
export type WorkflowDetail = { canEdit: boolean; canStart: boolean; categories: { key: string; label: string }[];
  workflow: { id: string; name: string; purpose: string | null; status: WorkflowRow["status"]; definition: WfDef; trigger: Trigger; triggerText: string; version: number; sopId: string | null; sopTitle: string | null;
    clientId: string | null; clientName: string | null; publishedAt: string | null; publishedBy: string | null; updatedAt: string };
  people: Record<string, Holder[]>; persons: (Holder & { role: string | null })[]; runs: RunRow[]; versions: { version: number; publishedAt: string; publishedBy: string | null }[] };
export type RunStep = { id: string; key: string; position: number; title: string; kind: StepKind; status: "waiting" | "active" | "done" | "skipped" | "cancelled"; outcome: string | null; note: string | null; rounds: number;
  why: string | null; startedAt: string | null; dueAt: string | null; doneAt: string | null; late: boolean; taskId: string | null; taskStatus: string | null; personId: string | null; person: string | null;
  photoAt: string | null; askedName: string | null; pooled: boolean; asked: boolean; canDecide: boolean; stuck: string | null; choices: string[]; formId: string | null; canFill: boolean };
export type RunDetail = { run: RunRow & { cancelNote: string | null; cancelledBy: string | null; context: Record<string, unknown> }; definition: WfDef; canCancel: boolean; steps: RunStep[];
  people: Record<string, Holder[]>; persons: Holder[]; submissions: SubmissionRow[] };
export type Candidate = { id: string; name: string; photoAt: string | null; pod: string | null; role: string | null; score: number; reasons: string[] };
export type StepAdvice = { stepId: string; category: string | null; categoryLabel: string | null; estimate: { days: number | null; minutes: number | null; n: number; basis: string } | null;
  candidates: Candidate[]; flags: { level: "warn" | "info"; text: string }[]; effect: { personId: string; name: string; lines: string[]; warn: boolean } | null };
export type Advice = { steps: StepAdvice[]; suggestions: { key: string; text: string; why: string; after: string | null; step: Partial<WfStep> }[];
  reuse: { kind: "workflow" | "sop"; id: string; name: string; shared: number; of: number; similarity: number; titles: string[] }[]; summary: string[] };
export const ASSIGN_LABEL: Record<AssignBy, string> = { role: "A role", person: "A person", domain: "By domain", starter: "Whoever starts it", project_owner: "The project's owner", pool: "The pool" };
export const RUN_STATUS: Record<RunRow["status"], string> = { running: "Running", done: "Done", cancelled: "Stopped" };

// Part 3: field forms (services/api/src/forms.ts, forms-model.ts).
export type FieldType = "photo" | "number" | "text" | "longtext" | "select" | "multi" | "checklist" | "signature" | "location" | "date" | "yesno";
export type FormField = { key: string; label: string; type: FieldType; required: boolean; help: string | null; options?: string[]; unit?: string | null; min?: number | null; max?: number | null;
  decimals?: number; geotag?: boolean; stamp?: boolean; lines?: boolean };
export type FormRow = { id: string; name: string; purpose: string | null; status: "draft" | "live" | "archived"; version: number; updatedAt: string; clientName: string | null; sent: number; lastAt: string | null;
  usedIn: number; fieldCount: number; photos: number; types: string[]; fields: { key: string; label: string; type: FieldType }[] };
export type ToFill = { stepId: string; title: string; dueAt: string | null; late: boolean; runId: string; run: string; workflow: string; project: string | null; form: string };
export type FormList = { canEdit: boolean; toFill: ToFill[]; forms: FormRow[]; templates: { key: string; name: string; purpose: string; forms: { name: string; fields: number }[]; workflow: boolean }[] };
export type SubmissionRow = { id: string; formId: string; form: string; status: "submitted" | "void"; submittedAt: string; personId: string | null; person: string | null; photoAt: string | null;
  project: string | null; projectId: string | null; client: string | null; runId: string | null; run: string | null; files: number; located: boolean };
export type FormDetail = { canEdit: boolean; form: { id: string; name: string; purpose: string | null; status: FormRow["status"]; version: number; fields: FormField[]; clientId: string | null; clientName: string | null;
  templateKey: string | null; updatedAt: string }; usedIn: { id: string; name: string; status: string; steps: string[]; starts: boolean }[]; submissions: SubmissionRow[] };
export type FillForm = { id: string; name: string; purpose: string | null; fields: FormField[]; live: boolean };
export type FillStep = { step: { id: string; title: string; status: string; dueAt: string | null; taskId: string | null; runId: string; run: string; projectId: string | null; project: string | null; client: string | null;
  workflow: string; canFill: boolean; sentAt: string | null }; form: FillForm };
export type SubmissionDetail = { canVoid: boolean; submission: { id: string; formId: string; form: string; version: number; fields: FormField[]; answers: Record<string, unknown>; status: "submitted" | "void";
  submittedAt: string; person: string | null; personId: string | null; photoAt: string | null; project: string | null; projectId: string | null; client: string | null; clientId: string | null;
  runId: string | null; run: string | null; workflow: string | null; step: string | null; taskId: string | null; location: { lat: number; lng: number; accuracy: number | null; at: string } | null; device: string | null;
  note: string | null; startedRuns: string[]; voidedBy: string | null; voidedAt: string | null; voidReason: string | null };
  files: { id: string; field: string; name: string; mime: string; size: number; width: number | null; height: number | null; source: string; capturedAt: string | null; lat: number | null; lng: number | null; accuracy: number | null; receivedAt: string }[];
  events: { kind: string; at: string; note: string | null; who: string | null }[] };
export const FIELD_TYPE_LABEL: Record<FieldType, string> = { photo: "Photo", number: "Number", text: "Short text", longtext: "Long text", select: "One choice", multi: "Several choices", checklist: "Checklist",
  signature: "Signature", location: "Location", date: "Date", yesno: "Yes or no" };

// Part 4: where runs stand.
export type LateStep = ActiveStep & { run: string; workflow: string; project: string | null; projectId: string | null; lateHours: number };
export type StuckRun = { runId: string; run: string; workflow: string; project: string | null; stepId: string; step: string; position: number; why: string; since: string; person: string | null; personId: string | null; photoAt: string | null };
export type SlowStep = { workflowId: string; workflow: string; title: string; n: number; hours: number; sla: number | null; late: number };
export type RunsOverview = { runs: RunRow[]; late: LateStep[]; stuck: StuckRun[]; slow: SlowStep[]; counts: { running: number; late: number; stuck: number; finishedWeek: number } };
