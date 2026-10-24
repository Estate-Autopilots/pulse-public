import type { Change, Delivery, Period, ProjectRow, Stage, TrendWeek } from "../lib/api";

/** Columns every project query returns (PROJECT_COLS in services/api/src/records.ts). */
export type ProjectBase = Omit<ProjectRow, "count" | "quiet" | "videos" | "images" | "latest">;

/** GET /api/v0/projects/:id */
export type ProjectDetail = {pgsName?:string|null;pgsId?:string|null;staff:{id:string;name:string}[];editedBy?:string|null} & ProjectBase & {
  storageRoot: string | null; locked: string[]; firstDeliveredAt: string | null;
  drafts: number; finals: number; count: number; prev: number; files: number; lastFileAt: string | null;
  period: Period; trend: TrendWeek[]; deliveries: (Delivery & { mime: string })[]; latest: (Delivery & { mime: string })[];
  related: ProjectBase[]; people: { id: string; name: string; role: string | null }[]; clients: { id: string; name: string }[];
  history: Change[]; canEdit: boolean;
};

type Tone = "neutral" | "warning" | "success" | "danger" | "accent";
/** Stage rules, word for word what STAGE in services/api/src/records.ts computes. Order is the board's column order. */
export const STAGES: { key: Stage; label: string; tone: Tone; rule: string }[] = [
  { key: "delivering", label: "Delivering", tone: "success", rule: "The latest delivery is within the last 14 days." },
  { key: "quiet", label: "Quiet", tone: "warning", rule: "The latest delivery is 14 to 56 days old." },
  { key: "new", label: "New", tone: "accent", rule: "No deliveries yet, and the start month is within the last 60 days." },
  { key: "dormant", label: "Dormant", tone: "neutral", rule: "Everything else: the latest delivery is more than 56 days old, or there are no deliveries and no recent start month." },
  { key: "paused", label: "Paused", tone: "warning", rule: "Status recorded on the project as paused. A recorded status wins over the delivery rules." },
  { key: "done", label: "Done", tone: "neutral", rule: "Status recorded on the project as done. A recorded status wins over the delivery rules." },
  { key: "cancelled", label: "Cancelled", tone: "danger", rule: "Status recorded on the project as cancelled. A recorded status wins over the delivery rules." },
];
export const CORE_STAGES: Stage[] = ["delivering", "quiet", "new", "dormant"];
export const stageOf = (key: string) => STAGES.find((s) => s.key === key) ?? STAGES[3];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-01" reads "Sep 2026". */
export const month = (value: string | null) => value ? `${MONTHS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}` : null;
export const driveUrl = (fileId: string) => `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
