// PM-UI 14 Quote to project: fixtures from canon (Sat, 21 Nov 2026). Kavya Rao turns the accepted quote Q-1043 (Growth
// package, Orchid Realty) into the draft "Orchid Towers launch": six lines → 12 + 40 + 5 + 3 + 3 + 34 = 97 steps in 9
// phases. No money, no dates (the invoice is not paid yet).
import type { QuoteLineVM, QuoteToProjectVM } from "../contract/quote-to-project";
import { TODAY, people, projects, viewer } from "./canon";

const lines: QuoteLineVM[] = [
  { id: "ql-creative", name: "Creative set × 2", icon: "image", blocks: ["Set 1", "Set 2"], steps: 12 },
  { id: "ql-meta", name: "Meta ads × 4 months", icon: "megaphone", blocks: ["Month 1", "Month 2", "Month 3", "Month 4"], steps: 40 },
  { id: "ql-crm", name: "CRM setup · 5 users", icon: "database", blocks: [], steps: 5 },
  { id: "ql-cp", name: "CP activation kit", icon: "gift", blocks: [], tag: "Bonus", steps: 3 },
  { id: "ql-always", name: "Always-on", icon: "refresh", blocks: ["Kick-off", "Inputs", "Close-out"], steps: 3 },
  { id: "ql-core", name: "Core plan", icon: "layers", blocks: [], steps: 34 },
];

const base: QuoteToProjectVM = {
  today: TODAY,
  viewer: viewer("kavya"),
  status: "ready",
  backHref: "/projects",
  quote: { id: "q-1043", number: "Q-1043", packageName: "Growth package", client: "Orchid Realty", hue: "teal", icon: "building", status: "accepted" },
  lines,
  total: { steps: lines.reduce((n, l) => n + l.steps, 0), phases: 9 },
  lead: { person: people.kavya, suggested: true },
  note: "Dates start when the invoice is paid",
  create: { kind: "create_draft_project", label: "Create draft project", busyLabel: "Creating…" },
  draft: { project: projects.orchid, health: { key: "not_started", reason: "Starts when invoice is paid" }, href: null },
  openLabel: "Open draft",
  existsNote: "A draft already exists for quote Q-1043",
};

const made = { ...base.draft, href: "/projects/pm/preview/project-detail" };

export const states: Record<string, QuoteToProjectVM> = {
  default: base,
  creating: { ...base, status: "creating" },
  created: { ...base, status: "created", draft: made },
  "already-made": { ...base, status: "exists", draft: made },
  loading: { ...base, status: "loading", lines: [] },
};
