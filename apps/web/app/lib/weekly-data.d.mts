export type ExplainedCount = {
  value: number;
  why: {
    rule: string;
    detail: string;
    source: "deliveries_read_model";
    sampleFileIds: string[];
  };
};

export type ProjectSummary = {
  projectId: string;
  projectName: string;
  deliveries: ExplainedCount;
};

export type PodSummary = {
  name: string;
  response: { week: string; projects: ProjectSummary[] };
};

export type RecentDelivery = {
  fileId: string;
  fileName: string;
  projectId: string;
  projectName: string;
  deliverableType: string;
  deliveredAt: string;
  week: string;
  matchedRule: string;
  ruleDetail: string;
};

export const weeklyData: {
  pods: Record<string, PodSummary>;
  leadership: { week: string; deliveries: ExplainedCount; projects: ProjectSummary[] };
  recentDeliveries: Array<RecentDelivery & { uploaderAccount: string }>;
};

export function latestWeek(weeks: Array<string | null | undefined>): string | null;
export function getPod(id: string): PodSummary | null;
export function getLatestLeadershipWeek(): string | null;
export function formatWeek(week: string | null): string;
export function formatWeekDate(week: string | null): string;
export function getLeadershipPods(): Array<{
  id: string;
  name: string;
  projects: ProjectSummary[];
  deliveries: number | null;
  week: string;
  why: string;
  current: boolean;
}>;
export function getRecentDeliveries(week: string): RecentDelivery[];
