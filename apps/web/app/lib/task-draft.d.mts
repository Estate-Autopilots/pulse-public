export type TaskDraft = { title: string; details: string; whoId: string | null; due: { date: string | null; time: string | null } | null; project: string | null; priority: string; category: string | null };
export declare const TASK_DRAFT_MAX_AGE_MS: number;
export declare function draftOf(form?: { segs?: ReadonlyArray<{ kind: "text"; text: string } | { kind: "person"; id: string; name: string }>; details?: string; whoId?: string | null;
  due?: { date: string | null; time: string | null } | null; project?: string | null; priority?: string; category?: string | null }): TaskDraft | null;
export declare function saveTaskDraft(storage: Storage, person: string | null | undefined, draft: TaskDraft | null, now?: number): void;
export declare function loadTaskDraft(storage: Storage, person: string | null | undefined, now?: number): TaskDraft | null;
export declare function plainNewTask(request?: { [key: string]: unknown }): boolean;
