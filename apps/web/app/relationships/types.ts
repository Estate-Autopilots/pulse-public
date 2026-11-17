// R46: the relationship graph as the API sends it (services/api/src/relationships.ts, relationships-model.ts).
export type Kind = "development" | "client" | "team" | "account_owner" | "contact" | "model";
export type Status = "proposed" | "confirmed" | "rejected" | "withdrawn";
export type Node = { type: string; id: string | null; key: string | null; label: string; sub: string | null; href: string | null; resolved: boolean };
export type Edge = {
  thread: string; head: string; version: number; kind: Kind; kindLabel: string; role: string | null; status: Status;
  subject: Node; object: Node; validFrom: string | null; validTo: string | null;
  source: { family: string; label: string; evidence: string[]; confidence: number | null; observedAt: string | null };
  decided: { by: string | null; at: string; action: string; note: string | null } | null;
  pending: { object: Node; role: string | null; by: string | null; at: string; note: string | null; fromSource: boolean; evidence: string[] } | null;
  disputed: boolean; sameName: number; can: { decide: boolean; undo: boolean };
};
export type Group = { key: string; label: string; type: "development" | "engagement" | "client"; engagements: Node[]; edges: Edge[] };
export type Counts = { confirmed: number; proposed: number; rejected: number; withdrawn: number; unresolved: number; corrections: number };
export type Graph = {
  view: "graph" | "review"; counts: Counts; byKind: { kind: Kind; label: string; confirmed: number; proposed: number; rejected: number; corrections: number }[];
  developments: { engagements: number; keyed: number; developments: number; shared: number; inShared: number }; hiddenModels: number;
  groups: Group[]; shown: number; more: boolean; me: { reviewer: boolean; kinds: Kind[]; admin: boolean }; models: { defined: boolean };
  lastRun: { at: string; counts: Record<string, number> } | null;
};
export type Setup = {
  reviewers: { personId: string; name: string; kinds: Kind[]; note: string | null; grantedBy: string | null; grantedAt: string; waiting: number }[];
  staff: { id: string; name: string; pod: string | null }[]; model: { definition: string; source: string; by: string | null; at: string } | null;
  hiddenModels: number; runs: { at: string; counts: Record<string, number>; by: string | null }[]; kinds: { kind: Kind; label: string }[];
};
export type Version = { id: string; version: number; status: Status; action: string; role: string | null; objectType: string; objectId: string | null; objectKey: string | null;
  objectLabel: string; validFrom: string | null; validTo: string | null; sourceFamily: string; evidence: { basis?: string }[]; confidence: number | null; note: string | null;
  at: string; by: string | null; undoneAt: string | null; undoneBy: string | null; standing: string | null };

export const STATUS: Record<Status, { label: string; tone: "success" | "accent" | "warning" | "neutral" | "danger" }> = {
  confirmed: { label: "Confirmed", tone: "success" }, proposed: { label: "Proposed", tone: "accent" }, rejected: { label: "Rejected", tone: "neutral" }, withdrawn: { label: "Withdrawn", tone: "neutral" },
};
export const ACTION: Record<string, string> = {
  source: "Proposed from the sources", source_changed: "The source changed", source_gone: "The source no longer says this", suggest: "Suggested",
  confirm: "Confirmed", reject: "Rejected", correct: "Corrected",
};
export const ROLE: Record<string, string> = { developer: "Developer", channel_partner: "Channel partner", client: "Client" };
export const day = (iso: string | null) => iso ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";
