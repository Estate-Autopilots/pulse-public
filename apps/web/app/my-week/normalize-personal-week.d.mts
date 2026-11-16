export type CreativeType = keyof typeof creativeTypeLabels;
export const creativeTypeLabels: Readonly<Record<CreativeType, string>>;

export type TargetedDelivery = {
  target: number | null;
  delivered: { drafts: number; finals: number };
  claimed: { drafts: number; finals: number };
  gap: number | null;
  placeholder: boolean;
};

export type EditorOpenTask = {
  id: string;
  title: string;
  status: "open" | "in_progress" | "blocked" | "in_review";
  dueAt: string | null;
  assets: { id: string; url: string | null }[];
};

export type EditorWeekResponse = {
  week: string;
  types: Partial<Record<CreativeType, TargetedDelivery>>;
  openTasks?: EditorOpenTask[];
};

export type TypeProgress = {
  type: CreativeType;
  label: string;
  target: number | null;
  delivered: number | null;
  drafts: number | null;
  finals: number | null;
  claimed: { drafts: number; finals: number };
  gap: number | null;
  placeholder: boolean;
};

export type OpenTask = EditorOpenTask;
export type PersonalWeek = {
  week: string;
  types: TypeProgress[];
  totalDeliveries?: number;
  drafts?: number;
  finals?: number;
  openTasks?: OpenTask[];
};

export function currentIsoWeek(now?: Date): string;
export function normalizePersonalWeek(response: EditorWeekResponse): PersonalWeek;
