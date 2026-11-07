// FEATURES-1024: Product Story's types and words (services/api/src/story.ts, Product Story migration).
export type Stage = "idea" | "prototype" | "beta" | "live" | "retired";
export type ChangeKind = "new" | "improved" | "fixed" | "removed";
export type MediaKind = "screenshot" | "video" | "tutorial" | "doc" | "demo";
export type Change = { kind: ChangeKind; text: string };
export type Media = { kind: MediaKind; url: string; label: string };
export type Tests = { passed?: number | null; failed?: number | null; note?: string; url?: string | null };
export type Product = { id: string; name: string; blurb: string; repoUrl: string | null; sort: number };
export type Version = { id: string; productId: string; label: string; title: string; stage: Stage; releasedOn: string | null; summary: string; changes: Change[]; media: Media[];
  tests: Tests; releaseRef: string; createdAt: string; updatedAt: string; by: string | null };
export type StoryData = { canRemove: boolean; products: Product[]; versions: Version[] };

export const STAGES: readonly { key: Stage; label: string; tone: string }[] = [
  { key: "idea", label: "Idea", tone: "var(--accent)" }, { key: "prototype", label: "Prototype", tone: "var(--info)" }, { key: "beta", label: "Beta", tone: "var(--warn)" },
  { key: "live", label: "Live", tone: "var(--good)" }, { key: "retired", label: "Retired", tone: "var(--faint)" },
];
export const KINDS: readonly { key: ChangeKind; label: string; tone: string }[] = [
  { key: "new", label: "New", tone: "var(--good)" }, { key: "improved", label: "Improved", tone: "var(--info)" }, { key: "fixed", label: "Fixed", tone: "var(--warn)" }, { key: "removed", label: "Removed", tone: "var(--bad)" },
];
export const MEDIA: readonly { key: MediaKind; label: string }[] = [
  { key: "screenshot", label: "Screenshot" }, { key: "video", label: "Video" }, { key: "tutorial", label: "Tutorial" }, { key: "doc", label: "Doc" }, { key: "demo", label: "Demo" },
];
export const stageOf = (s: Stage) => STAGES.find((x) => x.key === s) ?? STAGES[3];
export const kindOf = (k: ChangeKind) => KINDS.find((x) => x.key === k) ?? KINDS[0];
export const day = (d: string | null) => d ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${d}T12:00:00Z`)) : "No date";
/** Oldest first: dated versions by date, undated last (they are being written). */
export const chronological = (list: Version[]) => [...list].sort((a, b) => (a.releasedOn ?? "9999").localeCompare(b.releasedOn ?? "9999") || a.createdAt.localeCompare(b.createdAt));
export const countKinds = (changes: Change[]) => KINDS.map((k) => ({ ...k, n: changes.filter((c) => c.kind === k.key).length })).filter((k) => k.n);
export const daysBetween = (a: string | null, b: string | null) => a && b ? Math.round(Math.abs(Date.parse(b) - Date.parse(a)) / 86400000) : null;
