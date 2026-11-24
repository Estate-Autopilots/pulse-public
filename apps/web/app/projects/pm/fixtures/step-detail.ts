// PM-UI fixtures for Step detail (sheets/step-detail.md). Built from canon only. Today is Sat, 21 Nov 2026.
// Signed in: Rifob Das (the step's owner) unless a state says Kavya (the reviewer, to show Approve / Send to client).
import type { ChainLink, StepAction, StepActivity, StepDetailBehind, StepDetailStep, StepDetailVM, StepFile } from "../contract/step-detail";
import type { DueSource, IsoDate, Person, StepRow } from "../contract/shared";
import { TODAY, addDays, orchidClocks, orchidPhases, people, projects, viewer } from "./canon";

const project = projects.orchid;
const day0 = "2026-11-21";
const fromDay0 = (offset: number): { due: IsoDate; dueSource: DueSource } =>
  ({ due: addDays(day0, offset), dueSource: { clockKey: "inputs_complete", clockLabel: "Day 0", offset } });
const creative = { id: "ph-creative", name: "Creative assets" };
const shoot = { id: "ph-shoot", name: "Shoot" };

const act = (kind: StepAction["kind"], label: string): StepAction => ({ kind, label });
const START = act("start", "Start");
const SUBMIT = act("submit", "Submit for review");
const APPROVE = act("approve", "Approve");
const CHANGES = act("request_changes", "Request changes");
const SEND = act("send_client", "Send to client");
const DONE = act("mark_done", "Mark done");

const link = (person: Person, role: ChainLink["role"], state: ChainLink["state"], afterName?: string): ChainLink =>
  ({ person, role, state, ...(afterName ? { afterName } : {}) });
const chain = (owner: ChainLink["state"], reviewer: ChainLink["state"], client: ChainLink["state"]): ChainLink[] => [
  link(people.rifob, "owner", owner),
  link(people.kavya, "reviewer", reviewer),
  link(people.ahoro, "client", client, client === "after" ? "Kavya" : undefined),
];

const FILES: StepFile[] = [
  { id: "f-adfilm-v1", name: "30-sec ad film (v1)", version: 1, kind: "MP4", uploadedOn: "2026-11-20", latest: false, href: "#file-v1" },
  { id: "f-adfilm-v2", name: "30-sec ad film (v2)", version: 2, kind: "MP4", uploadedOn: "2026-11-21", latest: true, href: "#file-v2" },
];

const a = (id: string, who: Person, on: IsoDate, text: string, kind: StepActivity["kind"] = "comment"): StepActivity => ({ id, who, on, text, kind });
const ACTIVITY: StepActivity[] = [
  a("a1", people.kavya, "2026-11-20", "Notes on v1: trim the opening, make the tower shots bigger."),
  a("a2", people.rifob, "2026-11-21", "Updated the cut as per the notes."),
  a("a3", people.rifob, "2026-11-21", "Uploaded v2.", "event"),
];
const SUBMITTED = a("a4", people.rifob, TODAY, "Submitted v2 for review.", "event");
const APPROVED = a("a5", people.kavya, TODAY, "Approved v2.", "event");
const SENT = a("a6", people.kavya, TODAY, "Sent v2 to Ahoro Mifos for approval.", "event");

const items = (done: number) => [
  "Cut rough edit (v1)", "Apply Kavya's notes (v2)", "Add supers, music and VO", "Export final (30 sec, H.264)",
].map((text, i) => ({ id: `c${i + 1}`, text, done: i < done }));

const BLUEPRINT = { id: "s-blueprint-approved", title: "Brand blueprint approved", done: true, href: "#dep-blueprint" };
const FOOTAGE = { id: "s-footage", title: "Shoot footage received", done: false, href: "#dep-footage" };

/** The open step in its default moment: Rifob is doing it. */
const film: StepDetailStep = {
  id: "s-adfilm", title: "30-sec ad film", phase: creative, status: "doing",
  owner: people.rifob, role: "Video editor", reviewer: people.kavya, needsClientApproval: true,
  ...fromDay0(18), mine: true, clientVisible: true,
  checklist: items(2), dependsOn: [BLUEPRINT], clientApprover: people.ahoro,
};

/** The Creative assets list behind the laptop panel (no Done rows with future dates, nothing late). */
const row = (id: string, title: string, owner: Person, offset: number, status: StepRow["status"] = "todo"): StepRow =>
  ({ id, title, phase: creative, status, owner, ...fromDay0(offset), mine: owner.id === people.rifob.id });
function behindFor(step: StepDetailStep, mine = true): StepDetailBehind {
  const open: StepRow = { id: step.id, title: step.title, phase: step.phase, status: step.status, owner: step.owner, due: step.due, late: step.late, blockedBy: step.blockedBy, mine, toReview: !mine && step.status === "in_review" };
  return {
    health: { key: "waiting_client", reason: "floor plans, 4 days" },
    clocks: orchidClocks, phases: orchidPhases, selectedPhaseId: creative.id,
    steps: [
      row("s-adcopy1", "Ad copy, set 1", people.zoya, 6),
      row("s-adgraphics", "Ad graphics (key visuals)", people.tara, 10),
      row("s-brochure", "Brochure PDF", people.tara, 12),
      open,
      row("s-cutdowns", "6-sec ad cutdowns (3)", people.rifob, 19),
    ].map((r) => (r.id === step.id || mine ? r : { ...r, mine: false })),
  };
}

const SUGGESTION = { title: "Draft a client update", detail: "A short, ready-to-send note on v2.", actionLabel: "Use this", href: "#use-suggestion" };

const base = (step: StepDetailStep, over: Partial<StepDetailVM> = {}): StepDetailVM => ({
  today: TODAY, viewer: viewer("rifob"), project,
  projectHref: "/projects/pr-orchid", phaseHref: "/projects/pr-orchid?phase=ph-creative",
  step, chain: chain("doing", "next", "after"), files: FILES, activity: ACTIVITY, suggestion: SUGGESTION,
  primary: SUBMIT, secondary: null, note: null, behind: behindFor(step), ...over,
});

const todoStep: StepDetailStep = { ...film, status: "todo", checklist: items(0) };
const lateStep: StepDetailStep = { ...todoStep, ...fromDay0(-1), late: { days: 1, who: "team" } };
const reviewStep: StepDetailStep = { ...film, status: "in_review", checklist: items(4) };
const asKavya = (s: StepDetailStep): StepDetailStep => ({ ...s, mine: false, toReview: true });
const clientStep: StepDetailStep = { ...film, status: "waiting_client", checklist: items(4) };
const blockedStep: StepDetailStep = { ...film, status: "blocked", blockedBy: FOOTAGE.title, checklist: items(0), dependsOn: [BLUEPRINT, FOOTAGE] };

/** A step with no approval: the only kind that shows "Mark done" (SPEC §0.5 rule 2). In the Shoot phase. */
const footage: StepDetailStep = {
  id: "s-footage", title: "Shoot footage received", phase: shoot, status: "doing",
  owner: people.rifob, role: "Video editor", reviewer: null, needsClientApproval: false,
  ...fromDay0(3), mine: true,
  checklist: [
    { id: "f1", text: "Copy cards from both cameras", done: true },
    { id: "f2", text: "Back up to the shared drive", done: true },
    { id: "f3", text: "Share the folder link with Tara", done: true },
  ],
  dependsOn: [{ id: "s-shoot-day", title: "Shoot day (on site)", done: true, href: "#dep-shoot-day" }], clientApprover: null,
};
const shootRow = (id: string, title: string, owner: Person, offset: number, status: StepRow["status"]): StepRow =>
  ({ id, title, phase: shoot, status, owner, ...fromDay0(offset), mine: owner.id === people.rifob.id });

export const states: Record<string, StepDetailVM> = {
  /** Rifob is doing it: filled "Submit for review". */
  default: base(film),
  /** Not started: filled "Start". */
  todo: base(todoStep, { chain: chain("todo", "next", "after"), files: [], activity: [], suggestion: null, primary: START, behind: behindFor(todoStep) }),
  /** After submit: no button for Rifob, a quiet line. */
  "in-review": base(reviewStep, { chain: chain("done", "in_review", "after"), activity: [...ACTIVITY, SUBMITTED], primary: null, note: "Waiting for Kavya's review", behind: behindFor(reviewStep) }),
  /** `todo`, due yesterday (Day 0 − 1 = 20 Nov): red "Late · 1 day". */
  late: base(lateStep, { chain: chain("todo", "next", "after"), files: [], activity: [], suggestion: null, primary: START, behind: behindFor(lateStep) }),
  /** Kavya (reviewer) opens it: "Your turn", filled "Approve" + outline "Request changes". */
  "review-kavya": base(asKavya(reviewStep), {
    viewer: viewer("kavya"), chain: chain("done", "in_review", "after"), activity: [...ACTIVITY, SUBMITTED],
    suggestion: { title: "Summarise the changes", detail: "What changed from v1 to v2, in three lines.", actionLabel: "Use this", href: "#use-suggestion" },
    primary: APPROVE, secondary: CHANGES, behind: behindFor(asKavya(reviewStep), false),
  }),
  /** Kavya approved v2: filled "Send to client". */
  "send-client": base(asKavya(reviewStep), {
    viewer: viewer("kavya"), chain: chain("done", "approved", "next"), activity: [...ACTIVITY, SUBMITTED, APPROVED],
    primary: SEND, behind: behindFor(asKavya(reviewStep), false),
  }),
  /** Sent to the client: Rifob sees "Waiting on client", no button. */
  "waiting-client": base(clientStep, {
    chain: chain("done", "approved", "with_client"), activity: [...ACTIVITY, SUBMITTED, APPROVED, SENT], suggestion: null,
    primary: null, note: "Waiting on Ahoro Mifos (client) to approve v2", behind: behindFor(clientStep),
  }),
  /** Waits on a step that is not done: no button. */
  blocked: base(blockedStep, {
    chain: chain("todo", "next", "after"), files: [], activity: [], suggestion: null,
    primary: null, note: "You can start once “Shoot footage received” is done", behind: behindFor(blockedStep),
  }),
  /** A step with no approval, all ticked: filled "Mark done". */
  "mark-done": base(footage, {
    phaseHref: "/projects/pr-orchid?phase=ph-shoot", chain: [],
    files: [{ id: "f-footage", name: "Shoot footage (both cameras)", version: 1, kind: "Link", uploadedOn: TODAY, latest: true, href: "#footage" }],
    activity: [a("b1", people.rifob, TODAY, "Copied both cards and backed them up."), a("b2", people.rifob, TODAY, "Shared the folder link with Tara.", "event")],
    suggestion: null, primary: DONE,
    behind: {
      health: { key: "waiting_client", reason: "floor plans, 4 days" }, clocks: orchidClocks, phases: orchidPhases, selectedPhaseId: shoot.id,
      steps: [
        shootRow("s-shoot-plan", "Shoot plan & call sheet", people.kavya, 0, "done"),
        shootRow("s-shoot-day", "Shoot day (on site)", people.rifob, 0, "done"),
        { ...shootRow("s-footage", "Shoot footage received", people.rifob, 3, "doing") },
        shootRow("s-photo-selects", "Photo selects", people.tara, 3, "todo"),
      ],
    },
  }),
};
