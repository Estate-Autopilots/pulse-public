// PM-UI: fixtures of the client's project page (sheets/client-view.md §3–4), all from canon: Sat, 21 Nov 2026, Orchid
// Towers launch in its Shoot phase, signed in as Ahoro Mifos (client contact, Orchid Realty).
// States: default, changes, changes-empty, approved, nothing-waiting.
import type { ClientViewVM } from "../contract/client-view";
import type { Phase } from "../contract/shared";
import { AGENCY, TODAY, orchidPhases, people, projects, viewer } from "./canon";

const P = projects.orchid;
const base = `/c/projects/${P.id}`;

/** The client names of the nine phases (sheet §3 "Your journey"; never the internal names). */
const CLIENT_NAMES: Record<string, string> = {
  "ph-kickoff": "Getting started", "ph-blueprint": "Your brand plan", "ph-shoot": "Filming", "ph-creative": "Ads and videos",
  "ph-landing": "Your website", "ph-crm": "Lead tracker", "ph-training": "Sales team training", "ph-review": "Final checks", "ph-adslive": "Ads go live",
};
const journey: Phase[] = orchidPhases.map((p) => ({ ...p, clientName: CLIENT_NAMES[p.id] ?? p.clientName }));

const review: NonNullable<ClientViewVM["review"]> = {
  stepId: "s-adfilm",
  title: "30-sec ad film",
  round: { version: 2, round: 2, maxRounds: 3 },
  due: "2026-11-23",
  media: { kind: "video", length: "0:30", src: null, poster: null },
  approve: { kind: "approve", label: "Approve", href: `${base}/review/s-adfilm?do=approve` },
  askChanges: { kind: "ask_changes", label: "Ask for changes", href: `${base}/review/s-adfilm?do=changes` },
  sendChanges: { kind: "send_changes", label: "Send changes", href: `${base}/review/s-adfilm?do=send` },
};

const base0: ClientViewVM = {
  today: TODAY,
  viewer: viewer("ahoro"),
  agency: AGENCY.name,
  project: P,
  links: { project: base, chat: `${base}/chat`, files: `${base}/files` },
  review,
  approved: null,
  needs: [
    { id: "in-rera", label: "RERA certificate", due: "2026-11-21", kind: "doc", upload: { kind: "upload", label: "Upload", href: `${base}/inputs/in-rera` } },
    { id: "in-photos", label: "Site photos", due: "2026-11-21", kind: "photos", upload: { kind: "upload", label: "Upload", href: `${base}/inputs/in-photos` } },
  ],
  journey,
  comingUp: [
    { id: "m-filming", label: "Filming wraps", date: "2026-11-24" },
    { id: "m-ads", label: "First ads and videos for your OK", date: "2026-12-04" },
    { id: "m-site", label: "Your website ready to review", date: "2026-12-11" },
    { id: "m-training", label: "Sales team training starts", date: "2026-12-19" },
    { id: "m-live", label: "Ads go live", date: "2027-01-05", milestone: true },
  ],
  team: [{ person: people.kavya, chat: { kind: "chat", label: "Chat", href: `${base}/chat?with=${people.kavya.id}` } }],
};

export const states: Record<string, ClientViewVM> = {
  default: base0,
  changes: { ...base0, review: { ...review, compose: { text: "" } } },
  "changes-empty": { ...base0, review: { ...review, compose: { text: "", error: "Please write what to change" } } },
  approved: { ...base0, review: null, approved: { title: review.title, version: review.round.version, on: TODAY } },
  "nothing-waiting": { ...base0, review: null, needs: [] },
};
