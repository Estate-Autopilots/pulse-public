export type Task = {
  id: string; title: string; status: string; priority: "low" | "normal" | "high" | "urgent";
  projectId: string | null; projectName: string | null; parentId: string | null; parentTitle?: string | null;
  assigneeId: string | null; assigneeName: string | null; assigneePhotoAt: string | null;
  reviewerId: string | null; reviewerName: string | null; createdBy: string | null;
  dueAt: string | null; dueOn: string | null; dueLabel: string | null; workOn: string | null; type: string | null;
  startedAt: string | null; doneAt: string | null; acceptedAt: string | null; valueNote: string | null;
  source: string; sourceStatus: string | null; sourcePeriod: string | null; trackerProject: string | null; trackerOwner: string | null; sourceRef?: string | null;
  updatedAt: string | null; createdAt: string | null; openBlockers: number; subtasks: number; subtasksDone: number; subtasksOpen?: number; proof: number;
  /** UX-TASKS-2 */
  category?: string | null; categoryLabel?: string | null; tags?: string[]; urgency?: "low" | "normal" | "high"; estimateMinutes?: number | null;
  poolScope?: "company" | "department" | "pod" | null; poolRef?: string | null; claimedBy?: string | null; projectPod?: string | null; projectKind?: string | null;
  inDomain?: { id: string; title: string; basis: string } | null;
  /** TASKS-P0 */
  comments?: number; waiting?: number; unlockedAt?: string | null; projectCategory?: string | null; projectCategoryLabel?: string | null; projectColor?: string | null; projectIcon?: string | null;
  /** TASKS-4B: how it was accepted (rated, acknowledged, auto, or legacy effort × impact when null on accepted work). */
  reviewKind?: "rated" | "acknowledged" | "auto" | "legacy" | null; reviewQuality?: number | null; reviewAbove?: boolean; leaderWork?: boolean | null;
  /** MY-TASKS: who gave it to its person (My tasks' lists only). */
  assignerId?: string | null; assignerName?: string | null; assignerPhotoAt?: string | null;
};
/** TASKS-4B: finishing and reviewing (services/api/src/task-life.ts). */
export type Timing = { key: "early" | "on_time" | "late"; days: number; words: string };
export type Flag = { id: string; cause: "finished" | "reopened"; detail: { open?: { id: string; title: string; status: string }[] }; raisedAt: string; raisedBy: "migration" | "pulse" };
export type ReviewPolicy = { reviewBy: "assigner" | "head" | "creator"; reviewScale: "three" | "five"; reviewLeaders: "acknowledge" | "auto_proof" | "review"; aboveBonus: number; helpPoints: number; reviewNudgeHours: number; /** UX-5B */ autoDone?: "on" | "ask" };
export type Life = { flags: Flag[]; leaderWork: boolean; mode: "rate" | "acknowledge"; policy: ReviewPolicy; quality: { value: string; label: string }[];
  acceptedBy: { id: string; name: string; photoAt: string | null } | null; doneBy: { id: string; name: string } | null;
  returned: { note: string | null; at: string; byId: string | null; by: string | null } | null; timing: Timing | null; waited: string | null; me: string | null;
  clock: { running: { startedAt: string; personId: string } | null; last: { endedAt: string; reason: string } | null; captured: number; proposed: number; mine: boolean }; askEstimate: boolean };
export type ReviewRow = Task & { doerPhotoAt: string | null; leaderWork: boolean; flags: number; openChildren: number; timing: Timing | null; waited: string | null; waitedHours: number | null };
export type Same = { id: string; title: string; linked: boolean };
export type Unlock = { id: string; title: string; status: string; personId: string | null; personName: string | null; photoAt: string | null;
  estimateMinutes: number | null; dueOn: string | null; dueAt: string | null; openBlockers: number };
export type Plan = { summary: string; steps: { text: string; minutes: number | null; phone: boolean }[]; fromNotes: boolean; fastest: string[]; ask: { id: string; name: string; why: string }[];
  message: { channel: string; to: string | null; toId: string | null; text: string } | null; basis: string[]; planner: string; version: string; at: string; fresh: boolean };
export type Domain = { id: string; personId: string; title: string; basis: "agreement" | "policy"; categories: string[]; categoryLabels: string[]; tags: string[]; pod: string | null; projectId: string | null; projectName: string | null;
  clientId: string | null; clientName: string | null; note: string | null; status: "proposed" | "active" | "declined" | "withdrawn" | "ended"; proposedSide: "employee" | "company"; proposedById: string; proposedBy: string;
  effectiveFrom: string | null; agreedOn: string | null; companyAgreedBy: string | null; answerNote: string | null; endedAt: string | null; endedBy: string | null; endNote: string | null; createdAt: string;
  actions?: { key: string; label: string; tone: string; path: string; fields?: { key: string; label: string; type: "text" }[]; done: string }[] };
export type Blocker = { taskId: string; linkId: string; note: string | null; since: string; id: string; title: string; status: string; assigneeId: string | null; assigneeName: string | null; visible: boolean };
export type Person = { id: string; name: string; username?: string | null; pod?: string | null; photoAt?: string | null };
export type Home = { me: string | null; canLead: boolean; workRole?: string; asks?: number; today: string; week: string; mode?: "shift" | "outcome"; rows: Task[]; blockers: Blocker[]; waitingOnMe: (Task & { blockerId: string; blockerTitle: string })[]; review: Task[];
  /** MY-TASKS: what I created for someone else (or the pool), and what I review that someone else does. */
  created?: Task[]; reviewing?: Task[]; same?: Record<string, Same>;
  domains?: { id: string; title: string; basis: string; status: string }[]; pool?: { open: number; fits: number };
  summary: { weekDone: number; weekAccepted: number; streak: number; shipped: Task[]; minutes: number; proposals: number; pendingTasks?: number;
    /** TASKS-4B: each day of the week: tasks finished (INTEGRITY: no value). */ days?: { day: string; done: number }[] } | null };
export type Board = { scope: string; pod: string | null; pods: string[]; myPod: string | null; me: string | null; canAll: boolean; columns: Record<Column, Task[]>; counts: { status: string; n: number }[]; blockers: Blocker[]; people: Person[];
  person?: { id: string; name: string; role: string | null; pod: string | null; photoAt: string | null } | null; same?: Record<string, Same>; today?: string };
export type Column = "todo" | "doing" | "blocked" | "done" | "accepted";
/** AI-TASKS (1064): a task given to an AI employee: what it is doing with it (agent_task_status). */
export type AiWork = { agentId: string; name: string; title: string | null; phase: "queued" | "working" | "waiting" | "in_review" | "returned" | "stopped"; running: boolean; queued: boolean;
  plan: { label: string; done: boolean }[]; waitingOn: string | null; note: string | null; updatedAt: string | null; submittedAt: string | null; off: boolean;
  runtime: { state: string; until: string | null } | null; runs: number; tokens: number;
  lastRun: { at: string; state: string; model: string | null; tokens: number | null; seconds: number | null; errorCode: string | null } | null;
  asks: { to: string; via: "comment" | "direct"; at: string; answered: boolean }[] };
export type Detail = { ai?: AiWork | null; task: Task & { notes: string | null; locked: string[]; requiresProof: boolean | null; canEdit: boolean; evidenceSource: string | null;
    /** INTEGRITY (owner, 22 Oct 2026): a task carries no value; Pip suggests importance and effort only. */
    canValue?: boolean; suggestion?: { importance: string; effortMinutes: number; reason: string; basis?: string[]; confidence?: string; version?: string } | null;
    pooledAt?: string | null; pooledBy?: string | null; claimedAt?: string | null; canClaim?: boolean };
  parents: { id: string; title: string; status: string }[]; children: Task[];
  blockedBy: { linkId: string; note: string | null; since: string; id: string; title: string; status: string; assigneeId: string | null; assigneeName: string | null; assigneePhotoAt?: string | null }[];
  blocks: { linkId: string; id: string; title: string; status: string; assigneeName: string | null }[];
  proof: { id: string; kind: "link" | "file" | "document"; label: string; url: string | null; addedAt: string; addedBy: string | null; readable?: boolean; concerns?: string | null }[];
  /** READY (0960): the brief and references that came with the task; never proof. */
  attachments?: { id: string; kind: "link" | "file"; label: string; url: string | null; addedAt: string; addedBy: string | null }[];
  time: { id: string; personId: string; personName: string; date: string; minutes: number; note: string | null; source: string; status: string }[];
  events: { kind: string; from: string | null; to: string | null; note: string | null; at: string; by: string | null; byId?: string | null; byPhotoAt?: string | null }[];
  me: string | null; can: { edit: boolean; accept: boolean; take: boolean; review: boolean; ask: boolean; join: boolean; value?: boolean; claim?: boolean; release?: boolean; delete?: boolean };
  members: { id: string; name: string; role: "collaborator" | "watcher"; photoAt: string | null }[]; asks: import("./work-client").Ask[]; watching: boolean;
  project: { kind: string; clientName: string | null; summary?: string | null; ownerId?: string | null; category?: string | null; color?: string | null; icon?: string | null } | null; comments: import("./work-client").Comment[];
  checks?: { key: string; label: string; doneAt: string; doneBy: string | null }[];
  unlocks?: { tasks: Unlock[]; now: number; people: number; minutes: number; chain: { tasks: number; minutes: number; people: number } };
  same?: { id: string; title: string; status: string; projectName: string | null; projectId: string | null; state: string | null; score: number }[]; plan?: Plan | null; life?: Life };
export type Options = { me: string | null; people: Person[]; reviewers: Person[]; projects: { id: string; name: string; tasks: number }[] };
