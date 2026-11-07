// WORKFLOW BUILDER: what the board API returns (services/api/src/workflow-boards.ts, workflow-blocks.ts).
import type { BlockSpec, PortType } from "../lib/wf-canvas.mjs";
import type { Condition, Holder, StepKind, Trigger, WfDef, WfStep } from "./types";

export type { BlockSpec, PortType };
export type BlockStep = Omit<WfStep, "next"> & { module?: string | null; pos?: { x: number; y: number } | null; handoff?: { workflowId: string } | null;
  next: { to: string; label: string | null; when?: Condition | null; port?: string | null; in?: string | null }[] | null };
export type BlockDef = Omit<WfDef, "steps"> & { steps: BlockStep[] };
export type Tab = { id: string; name: string; purpose: string | null; status: "draft" | "live" | "paused" | "archived"; version: number; definition: BlockDef; trigger: Trigger;
  boardId: string | null; position: number | null; sopId: string | null; clientId: string | null; tabRole: string | null; tabPersonId: string | null; tabPerson: string | null; tabPhotoAt: string | null; updatedAt: string;
  publishedAt: string | null; running: number };
export type TestStep = { runId: string; id: string; key: string; position: number; title: string; kind: StepKind; status: "waiting" | "active" | "done" | "skipped" | "cancelled";
  outcome: string | null; note: string | null; why: string | null; checks: number[]; startedAt: string | null; doneAt: string | null; personId: string | null; person: string | null; photoAt: string | null };
export type TestRun = { id: string; name: string; status: "running" | "done" | "cancelled"; workflowId: string; workflow: string; startedAt: string; finishedAt: string | null;
  parentRunId: string | null; context: Record<string, unknown>; project: string | null; projectId: string | null; client: string | null; startedBy: string | null; steps: TestStep[] };
export type BoardDetail = { canEdit: boolean; canStart: boolean; board: { id: string; name: string; purpose: string | null; status: "active" | "archived"; updatedAt: string };
  blocks: BlockSpec[]; types: Record<PortType, string>; categories: { key: string; label: string }[];
  forms: { id: string; name: string; photo: boolean; fields: { key: string; label: string; type: string }[] }[];
  workflows: { id: string; name: string; status: string; board: string | null }[]; tabs: Tab[]; people: Record<string, Holder[]>;
  persons: (Holder & { role: string | null })[]; tests: TestRun[] };
export type BoardRow = { id: string; name: string; purpose: string | null; status: "active" | "archived"; updatedAt: string;
  tabs: { id: string; name: string; status: Tab["status"]; tabRole: string | null; tabPerson: string | null; tabPersonId: string | null; tabPhotoAt: string | null; blocks: number; modules: string[]; running: number }[] };
export type BoardList = { canEdit: boolean; boards: BoardRow[] };
export type WaitingItem = { id: string; runId: string; key: string; position: number; title: string; kind: StepKind; startedAt: string; dueAt: string | null; late: boolean; checks: number[];
  why: string | null; taskId: string | null; taskStatus: string | null; run: string; projectId: string | null; workflowId: string; workflow: string; boardId: string | null; board: string | null;
  personId: string | null; person: string | null; photoAt: string | null; module: string; block: string; engine: BlockSpec["engine"]; link: string | null; checklist: string[];
  formId: string | null; canFill: boolean; values: { key: string; value: string }[]; outputs: { key: string; label: string; type: PortType }[]; choices: string[] };

/** Port colours: one per type, from the categorical set the SOP area uses (both themes). */
export const TYPE_SLOT: Record<PortType, number> = { lead: 6, call: 2, quote: 1, photo: 3, form: 4, hand: 5, any: 0 };
export const ENGINE_WORD: Record<BlockSpec["engine"], string> = { live: "Live", auto: "Runs by itself", partial: "Opens its page", stub: "Coming soon" };
