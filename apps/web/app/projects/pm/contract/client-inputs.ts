// PM-UI: the view model of Client inputs (PICKS 12, sheets/client-inputs.md). A client-facing page: the client sees the
// things the agency asked for, which are still missing, and uploads them. One API read; no money, no day counts, no
// internal clock names, no health.
import type { IsoDate, Person, ProjectRef, Viewer } from "./shared";

/** Icon of an input row (lucide-react, mapped in the screen). Never a currency sign. */
export type ClientInputIcon = "file" | "layers" | "table" | "shield" | "image" | "video" | "link";

/** One thing the agency needs from the client (a client-visible input step, SPEC §1.6 client_visible + waiting_client). */
export type ClientInput = {
  id: string;
  /** "Brochure", "RERA certificate". */ name: string;
  icon: ClientInputIcon;
  /** done = received ("Done", green); needed = the client's to send ("Your turn", amber). */ state: "done" | "needed";
  /** Due date shown on needed rows as "Due by 21 Nov"; null = no date. */ due: IsoDate | null;
  /** The last upload of this input failed ("Upload failed. Try again", red; the button reads "Try again"). */ failed?: boolean;
  /** POST target for the upload (real wiring); absent in fixtures. */ uploadTo?: string;
};

/** One step of the client's journey (four, in order). */
export type JourneyStep = {
  key: "share_inputs" | "review_materials" | "approve_ads" | "ads_live";
  /** "Share inputs", "Review materials", "Approve ads", "Ads live". */ label: string;
  /** done = ticked; current = "you are here" (accent ring and label); later = grey ring. Exactly one is current. */
  state: "done" | "current" | "later";
  /** The current step's line: "Waiting on you" (Share inputs) or "We are on it" (the agency's turn). */ note?: string;
  /** A planned date shown under the label (Ads live: the ads_live clock, 5 Jan). */ date?: IsoDate | null;
};

/** The client's contact on the team (the project lead) and where Chat goes. */
export type ClientTeamContact = { person: Person; /** The client's chat with the team. */ chatHref: string };

export type ClientInputsVM = {
  /** Fixed "today" (Sat, 21 Nov 2026 in fixtures). */ today: IsoDate;
  /** The signed-in client contact (Ahoro Mifos, orgRole "client"). */ viewer: Viewer;
  /** The agency's name for the top bar ("Brightpath Marketing"). */ agency: string;
  /** The project (top bar: its colour tile + name, the page title). */ project: ProjectRef;
  /** Top bar links (from 600 px), the same as client-view's: the project page, the chat with the team, the shared files.
   *  This page is none of the three, so none is marked current. */
  links: { project: string; chat: string; files: string };
  /** What we need from the client, in the order the agency asked. Counts and the ring are computed from `state`. */
  inputs: ClientInput[];
  /** The line under the title: "Your ads go live sooner when these are in"; "We are on it" once all are in. */ sub: string;
  /** The four journey steps. */ journey: JourneyStep[];
  /** "Your team: Kavya" with Chat. */ team: ClientTeamContact;
  /** UI state for the preview only (not served by the API): the input whose upload sheet is open on first paint. */
  openUploadFor?: string | null;
};
