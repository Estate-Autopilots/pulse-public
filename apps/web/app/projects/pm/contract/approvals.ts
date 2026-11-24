// PM-UI: view model of the Approvals screen (/approvals). SPEC §5.6 (screen), §1.7 (deliverable versions), §1.8 + §3.3
// (approval states; after "changes requested" the decision is locked until a new version is uploaded). One read returns
// both tabs; the screen switches tabs, rows and the phone sheet with local state.
import type { IsoDate, LateFlag, Person, ProjectRef, Round, Viewer } from "./shared";

/** What the preview draws for the file under review (SPEC §1.7 deliverable). No real image: a placeholder in the project colour. */
export type ApprovalMedia =
  | { kind: "video"; /** Running time as shown on the thumbnail, "0:45". */ length: string }
  | { kind: "pdf"; /** Page count, "PDF · 3 pages". */ pages: number }
  | { kind: "image" };

/** A comment pinned to the deliverable from an earlier round (shown above the decision). */
export type PinnedComment = {
  id: string;
  by: Person;
  /** Day it was written. */ at: IsoDate;
  text: string;
  /** Round it was written in. */ round: number;
};

/** A button described as data; the real wiring posts `kind` for the item. */
export type ApprovalAction = {
  kind: "approve" | "request_changes" | "send_request" | "remind_client" | "upload_version";
  label: string;
  /** Endpoint or page for the action (lane A fills it). */ href?: string;
  /** Present when the action cannot be used now, with the reason in words. */ disabledReason?: string;
};

/** One item in "Team review": a deliverable version waiting for the named team reviewer (SPEC §1.8 approver_id). */
export type TeamApproval = {
  /** approval id. */ id: string;
  /** The thing to approve (the deliverable / step title), e.g. "Launch video – final cut". Never the project name. */ title: string;
  /** Shown as a small tag in the project's colour, plus the icon tile. */ project: ProjectRef;
  /** "v2 · Round 2 of 3" (§1.7 version, §1.8 round / max_rounds). */ round: Round;
  media: ApprovalMedia;
  /** The step owner who asked for review. */ requestedBy: Person;
  /** §1.8 due_at as a day. */ due: IsoDate;
  /** Present when due < today: the row shows "Late · 1 day" INSTEAD of "Your turn" (one chip per row). */ late?: LateFlag;
  /** §1.8 state of this reviewer's decision row: `requested` (decide now) or `changes_requested` (locked until a new version). */
  state: "requested" | "changes_requested";
  /** The signed-in person is the named reviewer (gives "Your turn"; only then can they decide). */ toReview: boolean;
  /** Comments pinned from earlier rounds. */ pinned: PinnedComment[];
  /** Set when state = changes_requested: what was asked, by whom, and who must upload the next version. */
  changes?: { by: Person; at: IsoDate; text: string; /** Who uploads the next version (the step owner). */ waitingFor: Person; /** The version that unlocks the decision. */ nextVersion: number };
  /** The decision buttons. `approve` is the one filled button; `requestChanges` opens the comment box; `sendRequest`
   *  needs a comment (required). With state = changes_requested all carry `disabledReason`. */
  actions: { approve: ApprovalAction; requestChanges: ApprovalAction; sendRequest: ApprovalAction };
  /** The step page. */ href: string;
};

/** One item in "Client approval": a version the team approved and sent to the client, still undecided. */
export type ClientApproval = {
  id: string;
  title: string;
  project: ProjectRef;
  round: Round;
  media: ApprovalMedia;
  /** Day it was sent to the client: "Sent to client Tue, 17 Nov". */ sentAt: IsoDate;
  /** Calendar days waiting (today − sentAt): "Waiting on client · 4 days". */ waitingDays: number;
  /** Outline "Remind client" (SPEC §6 rule 7: a nudge by WhatsApp/e-mail on a person's tap). */
  remind: ApprovalAction & { /** Last reminder sent, if any. */ lastSentAt?: IsoDate | null };
  href: string;
};

/** The Approvals screen. Lists come sorted from the API: team = Late first (most days), then due; client = longest wait first. */
export type ApprovalsVM = {
  today: IsoDate;
  /** The signed-in person (the named team reviewer). */ viewer: Viewer;
  /** Tab shown on load. */ tab: "team" | "client";
  /** Tab labels with counts: "Team review (5)", "Client approval (3)". */
  tabs: { team: { label: string; count: number; href: string }; client: { label: string; count: number; href: string } };
  /** Grey helper line under the tabs. */ helper: string;
  team: TeamApproval[];
  client: ClientApproval[];
  /** Row selected on load (tablet/laptop detail pane; the phone sheet when `sheetOpen`). Null = first row. */ selectedId: string | null;
  /** Phone only: the detail sheet is open on load over the dimmed list. */ sheetOpen: boolean;
  /** The "Request changes" comment box open on load (otherwise closed until tapped), with its text and error. */
  compose: { open: boolean; text: string; error?: string } | null;
  /** Empty team list: the card's outline button. */ emptyAction: { label: string };
};
