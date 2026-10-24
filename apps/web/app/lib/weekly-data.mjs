/** @typedef {{ rule: string, detail: string, source: 'deliveries_read_model', sampleFileIds: string[] }} DeliveryWhy */
/** @typedef {{ value: number, why: DeliveryWhy }} ExplainedCount */
/** @typedef {{ projectId: string, projectName: string, deliveries: ExplainedCount }} ProjectSummary */
/** @typedef {{ fileId: string, fileName: string, projectId: string, projectName: string, uploaderAccount: string, deliverableType: string, deliveredAt: string, week: string, matchedRule: string, ruleDetail: string }} RecentDelivery */

const count = (value, detail, ...ids) => ({
  value,
  why: {
    rule: "configured_deliverable_folder",
    detail,
    source: "deliveries_read_model",
    sampleFileIds: ids,
  },
});

const project = (projectId, projectName, deliveries) => ({ projectId, projectName, deliveries });

// Synthetic API v0-shaped payloads. Replace this module with SDK calls when the API reaches main.
export const weeklyData = {
  pods: {
    "pod-north": {
      name: "Pod North",
      response: {
        week: "2026-W41",
        projects: [
          project("project-synthetic-01", "Amber House", count(3, "Three synthetic files matched the configured deliverables folder rule.", "file-synthetic-001", "file-synthetic-002", "file-synthetic-003")),
          project("project-synthetic-02", "Cedar Court", count(2, "Two synthetic files matched the configured deliverables folder rule.", "file-synthetic-004", "file-synthetic-005")),
        ],
      },
    },
    "pod-south": {
      name: "Pod South",
      response: {
        week: "2026-W40",
        projects: [
          project("project-synthetic-03", "Juniper Residences", count(2, "Two synthetic files matched the configured deliverables folder rule.", "file-synthetic-006", "file-synthetic-007")),
          project("project-synthetic-04", "Maple Square", count(1, "One synthetic file matched the configured deliverables folder rule.", "file-synthetic-008")),
        ],
      },
    },
  },
  leadership: {
    week: "2026-W41",
    deliveries: count(5, "Five synthetic files were counted across the latest week with delivery data.", "file-synthetic-001", "file-synthetic-002", "file-synthetic-003", "file-synthetic-004", "file-synthetic-005"),
    projects: [
      project("project-synthetic-01", "Amber House", count(3, "Three synthetic files matched the configured deliverables folder rule.", "file-synthetic-001", "file-synthetic-002", "file-synthetic-003")),
      project("project-synthetic-02", "Cedar Court", count(2, "Two synthetic files matched the configured deliverables folder rule.", "file-synthetic-004", "file-synthetic-005")),
    ],
  },
  /** @type {RecentDelivery[]} */
  recentDeliveries: [
    { fileId: "file-synthetic-003", fileName: "amber-house-final-cut.mp4", projectId: "project-synthetic-01", projectName: "Amber House", uploaderAccount: "editor@example.test", deliverableType: "model_video", deliveredAt: "2026-10-05T09:15:00Z", week: "2026-W41", matchedRule: "configured_deliverable_folder", ruleDetail: "Synthetic file in the configured deliverables folder." },
    { fileId: "file-synthetic-002", fileName: "amber-house-teaser.mp4", projectId: "project-synthetic-01", projectName: "Amber House", uploaderAccount: "studio@example.test", deliverableType: "teaser_video", deliveredAt: "2026-10-05T08:40:00Z", week: "2026-W41", matchedRule: "configured_deliverable_folder", ruleDetail: "Synthetic file in the configured deliverables folder." },
    { fileId: "file-synthetic-008", fileName: "maple-square-social.mp4", projectId: "project-synthetic-04", projectName: "Maple Square", uploaderAccount: "editor@example.test", deliverableType: "social_video", deliveredAt: "2026-10-02T14:05:00Z", week: "2026-W40", matchedRule: "configured_deliverable_folder", ruleDetail: "Synthetic file in the configured deliverables folder." },
  ],
};

export function latestWeek(weeks) {
  return [...weeks].filter(Boolean).sort((a, b) => b.localeCompare(a))[0] ?? null;
}

export function getPod(id) {
  return weeklyData.pods[id] ?? null;
}

export function getLatestLeadershipWeek() {
  return latestWeek([weeklyData.leadership.week, ...Object.values(weeklyData.pods).map(({ response }) => response.week)]);
}

export function formatWeekDate(week) {
  if (!week) return "No week selected";
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return week;
  const jan4 = Date.UTC(Number(match[1]), 0, 4);
  const weekday = new Date(jan4).getUTCDay() || 7;
  const monday = jan4 - (weekday - 1) * 86_400_000 + (Number(match[2]) - 1) * 7 * 86_400_000;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(monday);
}

export function formatWeek(week) {
  return `Week of ${formatWeekDate(week)}`;
}

export function getLeadershipPods() {
  const week = getLatestLeadershipWeek();
  return Object.entries(weeklyData.pods).map(([id, pod]) => {
    const current = pod.response.week === week;
    const projects = current ? pod.response.projects : [];
    const deliveries = current ? projects.reduce((sum, item) => sum + item.deliveries.value, 0) : 0;
    return {
      id,
      name: pod.name,
      projects,
      deliveries: current ? deliveries : null,
      week: pod.response.week,
      why: current ? `${deliveries} synthetic deliveries across ${projects.length} projects in ${formatWeek(week)}.` : `No delivery records for ${formatWeek(week)}; latest available data is ${formatWeek(pod.response.week)}.`,
      current,
    };
  });
}

export function getRecentDeliveries(week) {
  return weeklyData.recentDeliveries
    .filter((delivery) => delivery.week === week)
    .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt))
    .map(({ uploaderAccount: _uploaderAccount, ...delivery }) => delivery);
}
