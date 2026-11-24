// PM-UI: the view model of the client's project page (screens/client-view.tsx), SPEC §5 client view, PICKS 06. One read
// of GET /client/projects/:id returns this, plus `viewer` (the client contact) and `today`. Client-safe by construction:
// no money, hours, day counts, health, internal reasons, owner names on steps or internal phase names (sheet §3).
import type { IsoDate, Person, Phase, ProjectRef, Round, Viewer } from "./shared";

/** An action the client can take, described as data. `href` is where it lands without JavaScript; the client wiring
 *  posts instead. */
export type ClientAction = {
  kind: "approve" | "ask_changes" | "send_changes" | "upload" | "chat";
  /** In words: "Approve", "Ask for changes", "Send changes", "Upload", "Chat". */ label: string;
  href: string;
};

/** The one item waiting for the client's OK (SPEC §1.8 client approval). Shown as card 1, "Needs your OK: <title>". */
export type ClientReview = {
  /** The step (task) id. */ stepId: string;
  /** "30-sec ad film" (the client-facing title, without the version). */ title: string;
  /** "v2 · Round 2 of 3". */ round: Round;
  /** When the agency needs the answer ("Due 23 Nov"). */ due: IsoDate;
  /** The file under review. `length` is the video's running time in words ("0:30"). */
  media: { kind: "video"; length: string; src?: string | null; poster?: string | null };
  approve: ClientAction;
  askChanges: ClientAction;
  sendChanges: ClientAction;
  /** The "Ask for changes" box as it should first paint (preview states and a re-render after a failed send):
   *  absent = closed; `error` = the send was pressed with no text ("Please write what to change"). */
  compose?: { text: string; error?: string | null };
};

/** The client's OK, once given: one quiet green row "Approved · 30-sec ad film v2 · 21 Nov". */
export type ClientApproved = { title: string; version: number; on: IsoDate };

/** One thing the agency needs from the client (SPEC §1.6 client inputs), oldest due first. */
export type ClientNeed = {
  id: string;
  /** "RERA certificate". */ label: string;
  /** Shown as "Due by 21 Nov". */ due: IsoDate;
  /** "pdf" | "photos": picks the row icon. */ kind: "doc" | "photos";
  upload: ClientAction;
};

/** One row of "Coming up": a client-facing milestone, dates rising. `milestone` = the project's goal (Ads go live),
 *  drawn as the tinted, bold last row. */
export type ClientMilestone = { id: string; label: string; date: IsoDate; milestone?: boolean };

/** A team contact the client may write to ("Your team"). */
export type ClientContact = { person: Person; chat: ClientAction };

export type ClientViewVM = {
  today: IsoDate;
  /** The client contact (orgRole "client"). */ viewer: Viewer;
  /** The agency's name for the top bar ("Brightpath Marketing"). */ agency: string;
  /** The project (client-facing: name, colour, icon). */ project: ProjectRef;
  /** Top bar links (sheet §2; from 600 px): this page, the chat with the team, the shared files. */
  links: { project: string; chat: string; files: string };
  /** The item waiting for the client's OK; null when none waits. */ review: ClientReview | null;
  /** Set right after the client approved (card 1 turns into one quiet green row); null otherwise. */ approved: ClientApproved | null;
  /** What the agency still needs from the client; empty = nothing. */ needs: ClientNeed[];
  /** The plan's phases in order, each with its CLIENT name (`clientName`); the current one is "You are here". The gate
   *  (Ads go live) shows its date. */ journey: Phase[];
  /** The next client-facing milestones, dates rising; the last is the project's goal. */ comingUp: ClientMilestone[];
  /** The client's contact(s) on the agency team (the lead first). */ team: ClientContact[];
};
