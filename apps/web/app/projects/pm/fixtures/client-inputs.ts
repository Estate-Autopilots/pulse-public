// PM-UI fixtures for Client inputs (sheets/client-inputs.md). Built from canon only. Today is Sat, 21 Nov 2026.
// Signed in: Ahoro Mifos, the client contact of Orchid Realty, in every state.
import type { ClientInput, ClientInputsVM, JourneyStep } from "../contract/client-inputs";
import { AGENCY, TODAY, orchidClocks, people, projects, viewer } from "./canon";

const DUE = "2026-11-21";
/** The client's project pages (same paths as client-view's fixture). */
const PAGE = `/c/projects/${projects.orchid.id}`;
const ADS_LIVE = orchidClocks.find((c) => c.key === "ads_live")?.planned ?? null;

const input = (id: string, name: string, icon: ClientInput["icon"], state: ClientInput["state"], failed?: boolean): ClientInput =>
  ({ id, name, icon, state, due: state === "needed" ? DUE : null, ...(failed ? { failed } : {}) });

const inputs = (reraDone: boolean, photosDone: boolean, reraFailed = false): ClientInput[] => [
  input("in-brochure", "Brochure", "file", "done"),
  input("in-floorplans", "Floor plans", "layers", "done"),
  input("in-pricesheet", "Price sheet", "table", "done"),
  input("in-rera", "RERA certificate", "shield", reraDone ? "done" : "needed", reraFailed),
  input("in-photos", "Site photos", "image", photosDone ? "done" : "needed"),
];

const journey = (allIn: boolean): JourneyStep[] => [
  { key: "share_inputs", label: "Share inputs", state: allIn ? "done" : "current", ...(allIn ? {} : { note: "Waiting on you" }) },
  { key: "review_materials", label: "Review materials", state: allIn ? "current" : "later", ...(allIn ? { note: "We are on it" } : {}) },
  { key: "approve_ads", label: "Approve ads", state: "later" },
  { key: "ads_live", label: "Ads live", state: "later", date: ADS_LIVE },
];

const base: ClientInputsVM = {
  today: TODAY,
  viewer: viewer("ahoro"),
  agency: AGENCY.name,
  project: projects.orchid,
  links: { project: PAGE, chat: `${PAGE}/chat`, files: `${PAGE}/files` },
  inputs: inputs(false, false),
  sub: "Your ads go live sooner when these are in",
  journey: journey(false),
  team: { person: people.kavya, chatHref: "/projects/pm/preview/client-inputs?state=default#chat" },
};

export const states: Record<string, ClientInputsVM> = {
  default: base,
  "upload-sheet": { ...base, openUploadFor: "in-rera" },
  "one-left": { ...base, inputs: inputs(true, false) },
  "all-in": { ...base, inputs: inputs(true, true), sub: "We are on it", journey: journey(true) },
  "upload-failed": { ...base, inputs: inputs(false, false, true) },
};
