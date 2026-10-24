/** LIFECYCLE: the People moves desk, joining and leaving cases, and HR's review of people who have probably left. */
export type Stage = "candidate" | "offer" | "joining" | "probation" | "active" | "notice" | "left";
export type LeftType = "resigned" | "terminated" | "contract_ended" | "not_joined";
export type Brief = { id: string; name: string; role: string | null; pod: string | null; department: string | null; photoAt?: string | null };
export type Reason = { source: "workspace" | "attendance" | "work" | "hr_sheet" | "mail" | "roster"; kind: string; summary: string; on: string; lastDay?: string | null; weight: number };
export type Review = { personId: string; name: string; role: string | null; pod: string | null; photoAt: string | null; status: string; confidence: "high" | "medium" | "low";
  proposedOn: string | null; proposedType: Exclude<LeftType, "not_joined"> | null; alreadyInactive: boolean; reasons: Reason[]; openedAt: string; refreshedAt: string };
export type CaseRow = { id: string; kind: "joining" | "leaving"; effectiveOn: string; leftType: LeftType | null; person: Brief; done: number; total: number; next: string | null };
export type PersonStage = Brief & { status: string; stage: Stage; since: string | null; leftType: LeftType | null; leftOn: string | null; lastWorkingDay: string | null; joinedOn: string | null };
export type Move = { id: string; personId: string; name: string; kind: "stage" | "change" | "review"; from: Stage | null; to: Stage | null; on: string; leftType: LeftType | null;
  detail: Record<string, unknown>; note: string | null; at: string; by: string | null };
export type Moves = { today: string; counts: Record<Stage, number>; pods: string[]; cases: CaseRow[]; review: Review[] | null; decided: { personId: string; name: string; status: string; note: string | null; decidedAt: string; by: string | null }[];
  unmatched: { name: string; kind: string; on: string; summary: string }[]; lastScan: string | null; pipeline: PersonStage[]; alumni: PersonStage[]; moves: Move[]; can: { act: boolean; review: boolean } };

export type Step = { key: string; status: "todo" | "done" | "skipped"; pending: number; confirmed: boolean; auto: boolean; proposal: Record<string, unknown>; result: Record<string, unknown>;
  note: string | null; doneBy: string | null; doneAt: string | null };
export type CaseView = { id: string; kind: "joining" | "leaving"; status: "open" | "done" | "cancelled"; effectiveOn: string; leftType: LeftType | null; note: string | null; openedAt: string; openedBy: string | null;
  closedAt: string | null; person: Brief & { stage: Stage }; steps: Step[]; done: number; total: number; canAct: boolean; canWorkspace: boolean; people: Brief[]; categories?: Record<string, string> };
export type PersonLifecycle = { today: string; stage: Stage; since: string | null; leftType: LeftType | null; leftOn: string | null;
  employment: { probationFrom: string | null; probationTo: string | null; noticeFrom: string | null; lastWorkingDay: string | null; payrollFrom: string | null } | null;
  events: Omit<Move, "personId" | "name">[]; cases: { id: string; kind: string; status: string; effectiveOn: string; openedAt: string }[];
  review: { status: string; confidence: string; proposedOn: string | null; proposedType: string | null; reasons: Reason[] } | null; canMove: boolean };

export const STAGE_LABEL: Record<Stage, string> = { candidate: "Candidate", offer: "Offer", joining: "Joining", probation: "Probation", active: "Active", notice: "On notice", left: "Alumni" };
export const LEFT_LABEL: Record<LeftType, string> = { resigned: "Resigned", terminated: "Terminated", contract_ended: "Contract ended", not_joined: "Did not join" };
/** Where a person can move from each stage (the database enforces the same list). */
export const NEXT: Record<Stage, Stage[]> = { candidate: ["offer", "joining", "left"], offer: ["candidate", "joining", "left"], joining: ["probation", "active", "left"],
  probation: ["active", "notice", "left"], active: ["notice", "left"], notice: ["active", "left"], left: ["candidate", "offer", "joining"] };
export const MOVE_LABEL: Record<string, string> = { "candidate>offer": "Make an offer", "offer>candidate": "Back to candidate", "candidate>joining": "Joining", "offer>joining": "Offer accepted: joining",
  "joining>probation": "Started: on probation", "joining>active": "Started", "probation>active": "Confirm after probation", "active>notice": "Notice given", "probation>notice": "Notice given",
  "notice>active": "Resignation withdrawn", "left>candidate": "Re-hire: candidate", "left>offer": "Re-hire: offer", "left>joining": "Re-hire: joining" };
export const moveLabel = (from: Stage, to: Stage) => MOVE_LABEL[`${from}>${to}`] ?? (to === "left" ? (["candidate", "offer"].includes(from) ? "Did not join" : "Left the company") : STAGE_LABEL[to]);
export const STEP_LABEL: Record<string, { title: string; line: string }> = {
  work: { title: "Hand over open work", line: "Open tasks, pool claims and reviews go to the person you choose, with a note" },
  projects: { title: "Transfer projects", line: "Projects they own get a new owner; project memberships end" },
  pods: { title: "Move out of pods and roles", line: "Pod, head, access roles and responsibility domains end; reports get a new head" },
  settlement: { title: "Final settlement inputs", line: "Last working day, leave to encash, notice to recover, comp-off" },
  assets: { title: "Asset return", line: "Laptop, phone, ID card and anything else to collect" },
  access: { title: "End Pulse access", line: "Sign-in, sessions and devices end; nothing is deleted" },
  chats: { title: "Remove from current groups", line: "Their messages stay; they show as a former member" },
  workspace: { title: "Google Workspace", line: "An admin's checklist in Google Admin. Pulse never changes Workspace" },
  alumni: { title: "Move to alumni", line: "Out of current counts, groups, pickers and attendance; history stays" },
  record: { title: "Role and place", line: "Role, pod or team, head and joining date" },
  invite: { title: "Pulse invitation", line: "Sent only when HR presses Send on their record" },
  welcome: { title: "Welcome and documents", line: "They fill in /welcome: profile, documents, check-in consent" },
  groups: { title: "Pods and groups", line: "Their pod and team decide the groups they join" },
  domains: { title: "Responsibility domains", line: "What work comes to them directly" },
  payroll: { title: "Payroll start", line: "The first day payroll counts" },
  probation: { title: "Probation", line: "Probation dates for the confirmation review" },
};
