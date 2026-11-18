// KAZUK-REST slice 7: what the training API answers (services/api/src/training.ts, migration 1709).
import type { Standing } from "../../lib/training.mjs";
export type { Standing };

export type MyCourse = { id: string; title: string; summary: string; passMark: number; dueOn: string | null; standing: Standing };
export type Mine = { courses: MyCourse[]; manage: boolean };
export type CourseRow = { id: string; title: string; status: "draft" | "published" | "archived"; passMark: number; updatedAt: string; videos: number; questions: number; people: number; done: number };
export type Video = { id: string; title: string; kind: "link" | "upload"; url: string | null; provider: string; minutes: number | null; mime: string | null; size: number | null; percent: number };
export type Question = { id: string; prompt: string; options: string[]; answer?: number };
export type Assignment = { id: string; kind: "person" | "side" | "role"; personId: string | null; name: string | null; target: string | null; dueOn: string | null };
export type Course = { id: string; title: string; summary: string; passMark: number; status: CourseRow["status"]; manage: boolean; videos: Video[]; questions: Question[];
  assigned: boolean; assignments: Assignment[] | null; people: { id: string; name: string; side: string }[] | null; standing: Standing | null };
export type ReportRow = { id: string; name: string; side: string; standing: Standing };
