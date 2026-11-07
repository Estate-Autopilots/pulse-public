import type {
  LeadershipWeekResponse,
  MeResponse,
  MyWeekResponse,
  PodBoardResponse,
} from "./v0.js";

/** Fabricated values only; these payloads contain no EA data. */
export const syntheticV0Fixtures = {
  me: {
    email: "editor@example.test",
    roles: ["person"],
  } satisfies MeResponse,

  myWeek: {
    week: "2026-W41",
    uploaderAccount: "editor@example.test",
    deliveries: {
      value: 2,
      why: {
        rule: "configured_deliverable_folder",
        detail: "Two synthetic files matched the configured deliverables folder rule.",
        source: "deliveries_read_model",
        sampleFileIds: ["file-synthetic-001", "file-synthetic-002"],
      },
    },
    byProject: [
      {
        projectId: "project-synthetic-01",
        projectName: "Amber House",
        deliveries: {
          value: 2,
          why: {
            rule: "configured_deliverable_folder",
            detail: "Two synthetic files matched the configured deliverables folder rule.",
            source: "deliveries_read_model",
            sampleFileIds: ["file-synthetic-001", "file-synthetic-002"],
          },
        },
      },
    ],
    recentDeliveries: [
      {
        fileId: "file-synthetic-002",
        fileName: "synthetic-final-cut.mp4",
        credited_to: "00000000-0000-0000-0000-000000000001",
        how: "fingerprint",
        projectId: "project-synthetic-01",
        projectName: "Amber House",
        uploaderAccount: "editor@example.test",
        deliverableType: "model_video",
        deliveredAt: "2026-10-06T10:30:00Z",
        week: "2026-W41",
        matchedRule: "configured_deliverable_folder",
        ruleDetail: "Synthetic file in the configured deliverables folder.",
      },
      {
        fileId: "file-synthetic-001",
        fileName: "synthetic-teaser.mp4",
        credited_to: "shared login",
        how: "shared",
        projectId: "project-synthetic-01",
        projectName: "Amber House",
        uploaderAccount: "editor@example.test",
        deliverableType: "teaser_video",
        deliveredAt: "2026-10-05T09:15:00Z",
        week: "2026-W41",
        matchedRule: "configured_deliverable_folder",
        ruleDetail: "Synthetic file in the configured deliverables folder.",
      },
    ],
    attribution: {
      window_days: 30,
      total_deliveries: 3,
      credited_to_person: 2,
      credited_to_person_share: 2 / 3,
      shared_login: 1,
      shared_login_share: 1 / 3,
      unresolved: 0,
    },
  } satisfies MyWeekResponse,

  podBoard: {
    week: "2026-W41",
    projects: [
      {
        projectId: "project-synthetic-01",
        projectName: "Amber House",
        deliveries: {
          value: 3,
          why: {
            rule: "configured_deliverable_folder",
            detail: "Three synthetic files matched the configured deliverables folder rule.",
            source: "deliveries_read_model",
            sampleFileIds: ["file-synthetic-001", "file-synthetic-002", "file-synthetic-003"],
          },
        },
        byUploaderAccount: [
          {
            uploaderAccount: "editor@example.test",
            deliveries: {
              value: 2,
              why: {
                rule: "configured_deliverable_folder",
                detail: "Two synthetic files matched the configured deliverables folder rule.",
                source: "deliveries_read_model",
                sampleFileIds: ["file-synthetic-001", "file-synthetic-002"],
              },
            },
          },
          {
            uploaderAccount: "studio@example.test",
            deliveries: {
              value: 1,
              why: {
                rule: "configured_deliverable_folder",
                detail: "One synthetic file matched the configured deliverables folder rule.",
                source: "deliveries_read_model",
                sampleFileIds: ["file-synthetic-003"],
              },
            },
          },
        ],
      },
    ],
  } satisfies PodBoardResponse,

  leadershipWeek: {
    week: "2026-W41",
    deliveries: {
      value: 3,
      why: {
        rule: "configured_deliverable_folder",
        detail: "Three synthetic files matched the configured deliverables folder rule.",
        source: "deliveries_read_model",
        sampleFileIds: ["file-synthetic-001", "file-synthetic-002", "file-synthetic-003"],
      },
    },
    projects: [
      {
        projectId: "project-synthetic-01",
        projectName: "Amber House",
        deliveries: {
          value: 3,
          why: {
            rule: "configured_deliverable_folder",
            detail: "Three synthetic files matched the configured deliverables folder rule.",
            source: "deliveries_read_model",
            sampleFileIds: ["file-synthetic-001", "file-synthetic-002", "file-synthetic-003"],
          },
        },
      },
    ],
  } satisfies LeadershipWeekResponse,
} as const;
