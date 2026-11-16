export type DayTask = {
  id: string; title: string; status: string; stage: "waiting" | "revision" | "on_hold" | null; priority: "low" | "normal" | "high" | "urgent";
  dueAt: string | null; dueOn: string | null; dueTime: string | null; workOn: string | null; startsOn: string | null; estimateMinutes: number | null;
  projectId: string | null; projectName: string | null; projectColor: string | null; workstream: string | null; parentId: string | null;
  repeats: string | null; doneAt: string | null; minutesToday: number;
};
export type DayTimer = { taskId: string; title: string; startedAt: string; projectId: string | null; workstream: string | null };
export type DaySeat = {
  org: string; name: string; handle: string | null; kind: string; current: boolean; ok: boolean;
  today?: string; weekStart?: string; timeZone?: string; accent?: string | null; mark?: string | null; tasks?: DayTask[]; timer?: DayTimer | null;
  timeToday?: { projectId: string | null; projectName: string | null; workstream: string | null; color: string | null; minutes: number }[];
  timeWeek?: { workstream: string | null; minutes: number }[];
  targets?: { dailyMinutes: number | null; weeklyMinutes: number | null; own: boolean; tasksPerWeek: number | null; unit: string | null };
  counts?: { minutesWeek: number; doneToday: number; doneWeek: number; undated: number };
};
export type DayData = { generatedAt: string; more: number; seats: DaySeat[] };
export type SectionKey = "doing" | "overdue" | "scheduled" | "today" | "waiting" | "week" | "priority" | "done";
export type DayItem = DayTask & { section: SectionKey; org: string; orgName: string; current: boolean; color: string | null; mark: string | null; running: boolean };
export type Target = { target: number; actual: number; met: boolean; unit?: string | null } | null;
export type Company = {
  org: string; name: string; handle?: string | null; current: boolean; ok: boolean; color: string | null; mark: string | null; attention: number;
  overdue?: number; today?: number; doing?: number; waiting?: number; week?: number; done?: number; planned?: number; actual?: number; running?: number; urgent?: number;
  targets?: { day: Target; week: Target; tasks: Target; own: boolean }; undated?: number; doneToday?: number;
};
export type Stream = { key: string; org: string; orgName: string; color: string | null; mark: string | null; stream: string; planned: number; actual: number };
export type Day = {
  sections: { key: SectionKey; label: string; hint: string; items: DayItem[] }[]; companies: Company[]; streams: Stream[];
  timer: (DayTimer & { org: string; orgName: string; current: boolean; color: string | null; mark: string | null; minutes: number }) | null;
  totals: { overdue: number; today: number; doing: number; done: number; planned: number; actual: number }; focus: DayItem[];
};
export const SECTIONS: { key: SectionKey; label: string; hint: string }[];
export function brandOf(seat: { accent?: string | null; mark?: string | null } | null | undefined): { color: string | null; mark: string | null };
export function minutesText(m: number): string;
export function minutesIntoDay(now: number, timeZone?: string): number;
export function runningToday(timer: { startedAt: string } | null | undefined, now: number, timeZone?: string): number;
export function sectionOf(t: DayTask, today: string, weekEnd: string): SectionKey | null;
export function buildDay(data: DayData | null | undefined, now?: number, only?: string[]): Day;
export function streamsOf(seats: DaySeat[], items: DayItem[], now?: number): Stream[];
export function focusOf(items: DayItem[], n?: number): DayItem[];
export function taskHref(item: { id: string }): string;
