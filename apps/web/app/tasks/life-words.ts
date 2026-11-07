// TASKS-4B: the words a finished task is described with, the same as the API's (services/api/src/task-life.ts):
// "on time", "2 days early", "1 day late" (India days), and how long it has waited for review.
const istDay = (iso: string) => new Date(Date.parse(iso) + 330 * 60000).toISOString().slice(0, 10);
export function timingOf(dueAt: string | null | undefined, doneAt: string | null | undefined): { key: "early" | "on_time" | "late"; days: number; words: string } | null {
  if (!dueAt || !doneAt) return null;
  const days = Math.round((Date.parse(`${istDay(dueAt)}T00:00:00Z`) - Date.parse(`${istDay(doneAt)}T00:00:00Z`)) / 86400000);
  if (days === 0) return { key: "on_time", days: 0, words: "on time" };
  const n = Math.abs(days), unit = `${n} day${n === 1 ? "" : "s"}`;
  return days > 0 ? { key: "early", days: n, words: `${unit} early` } : { key: "late", days: n, words: `${unit} late` };
}
export function waitedFor(doneAt: string | null | undefined, now: number) {
  if (!doneAt) return null;
  const h = Math.max(0, (now - Date.parse(doneAt)) / 3600000);
  return h < 1 ? "under an hour" : h < 24 ? `${Math.floor(h)} h` : `${Math.floor(h / 24)} day${Math.floor(h / 24) === 1 ? "" : "s"}`;
}
