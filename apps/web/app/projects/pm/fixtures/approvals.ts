// PM-UI: fixtures of the Approvals screen (sheets/approvals.md), all from canon. Signed in: Kavya Rao, Growth lead, the
// named team reviewer. Today Sat, 21 Nov 2026.
import type { ApprovalAction, ApprovalsVM, ClientApproval, TeamApproval } from "../contract/approvals";
import { TODAY, daysBetween, people, projects, viewer } from "./canon";

const actions = (id: string, locked?: string): TeamApproval["actions"] => {
  const a = (kind: ApprovalAction["kind"], label: string): ApprovalAction => ({ kind, label, href: `/api/approvals/${id}/${kind}`, ...(locked ? { disabledReason: locked } : {}) });
  return { approve: a("approve", "Approve"), requestChanges: a("request_changes", "Request changes"), sendRequest: a("send_request", "Send request") };
};

const team: TeamApproval[] = [
  {
    id: "ap-launch-video", title: "Launch video – final cut", project: projects.bluewater, round: { version: 2, round: 2, maxRounds: 3 },
    media: { kind: "video", length: "0:45" }, requestedBy: people.rifob, due: "2026-11-20", late: { days: 1, who: "team" },
    state: "requested", toReview: true, href: "/projects/pr-bluewater/steps/s-launch-video",
    pinned: [
      { id: "c1", by: people.kavya, at: "2026-11-18", round: 1, text: "Make the opening 2 s shorter and lead with the exterior shot." },
      { id: "c2", by: people.tara, at: "2026-11-19", round: 1, text: "Use the updated tagline on the end frame." },
    ],
    actions: actions("ap-launch-video"),
  },
  {
    id: "ap-shoot-plan", title: "Shoot plan and call sheet", project: projects.orchid, round: { version: 1, round: 1, maxRounds: 3 },
    media: { kind: "pdf", pages: 3 }, requestedBy: people.tara, due: TODAY, state: "requested", toReview: true,
    href: "/projects/pr-orchid/steps/s-shoot-plan", pinned: [], actions: actions("ap-shoot-plan"),
  },
  {
    id: "ap-social-set1", title: "Social ad creatives – set 1", project: projects.cedar, round: { version: 3, round: 3, maxRounds: 3 },
    media: { kind: "video", length: "0:30" }, requestedBy: people.tara, due: TODAY, state: "requested", toReview: true,
    href: "/projects/pr-cedar/steps/s-social-set1",
    pinned: [{ id: "c3", by: people.kavya, at: "2026-11-19", round: 2, text: "Bigger price line on the last card; keep the logo bottom right." }],
    actions: actions("ap-social-set1"),
  },
  {
    id: "ap-landing-copy", title: "Landing page copy", project: projects.marigold, round: { version: 1, round: 1, maxRounds: 3 },
    media: { kind: "pdf", pages: 3 }, requestedBy: people.zoya, due: "2026-11-23", state: "requested", toReview: true,
    href: "/projects/pr-marigold/steps/s-landing-copy", pinned: [], actions: actions("ap-landing-copy"),
  },
  {
    id: "ap-ad-film", title: "Ad film – 30s", project: projects.sunpeak, round: { version: 2, round: 2, maxRounds: 3 },
    media: { kind: "video", length: "0:30" }, requestedBy: people.ira, due: "2026-11-24", state: "requested", toReview: true,
    href: "/projects/pr-sunpeak/steps/s-ad-film",
    pinned: [{ id: "c4", by: people.dev, at: "2026-11-17", round: 1, text: "Cut a 15 s version from the same edit for Reels." }],
    actions: actions("ap-ad-film"),
  },
];

const clientItem = (id: string, title: string, project: ClientApproval["project"], round: ClientApproval["round"], media: ClientApproval["media"], sentAt: string): ClientApproval => ({
  id, title, project, round, media, sentAt, waitingDays: daysBetween(sentAt, TODAY),
  remind: { kind: "remind_client", label: "Remind client", href: `/api/approvals/${id}/remind`, lastSentAt: null }, href: `/projects/${project.id}/steps/${id}`,
});
const client: ClientApproval[] = [
  clientItem("ca-price-sheet", "Price sheet", projects.cedar, { version: 2, round: 2, maxRounds: 3 }, { kind: "pdf", pages: 2 }, "2026-11-17"),
  clientItem("ca-brochure", "Brochure – 8 pages", projects.palm, { version: 1, round: 1, maxRounds: 3 }, { kind: "pdf", pages: 8 }, "2026-11-19"),
  clientItem("ca-teaser", "Teaser – 15s", projects.sunpeak, { version: 3, round: 3, maxRounds: 3 }, { kind: "video", length: "0:15" }, "2026-11-20"),
];

const tabs = (t: number, c: number): ApprovalsVM["tabs"] => ({
  team: { label: "Team review", count: t, href: "/approvals?tab=team" },
  client: { label: "Client approval", count: c, href: "/approvals?tab=client" },
});

const base: ApprovalsVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  tab: "team",
  tabs: tabs(team.length, client.length),
  helper: "Only Kavya can approve for the team. Only the client approves for the client.",
  team,
  client,
  selectedId: team[0].id,
  sheetOpen: false,
  compose: null,
  emptyAction: { label: "See client approvals" },
};

/** Row 1 after Kavya asked for changes: locked until Rifob uploads v3 (SPEC §1.8). */
const lockedTeam: TeamApproval[] = team.map((t, i) => i === 0 ? {
  ...t, state: "changes_requested",
  changes: { by: people.kavya, at: TODAY, waitingFor: people.rifob, nextVersion: 3, text: "Exterior shot still comes in late. Open on it and trim the first 2 s." },
  actions: actions(t.id, "Locked until Rifob uploads v3"),
} : t);

export const states: Record<string, ApprovalsVM> = {
  default: base,
  detail: { ...base, sheetOpen: true },
  "request-changes": { ...base, sheetOpen: true, compose: { open: true, text: "", error: "Comment is required" } },
  "changes-requested": { ...base, team: lockedTeam, sheetOpen: true },
  "client-tab": { ...base, tab: "client", selectedId: client[0].id },
  empty: { ...base, team: [], tabs: tabs(0, client.length), selectedId: null },
};
