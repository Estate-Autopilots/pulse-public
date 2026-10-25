// EST-1363: what Pulse's API answers for the Sales X-Ray app. The call and lead shapes are Sales X-Ray's own
// (/v1/api), passed through as they are; every field the page reads may be missing, so each has a default.
export type Status = {
  configured: boolean;
  ask: boolean;
  connected: boolean;
  base?: string | null;
  scopes?: string[];
  account?: { person: string | null; workspace: string | null; kind: "personal" | "organisation"; role: string | null };
  connectedAt?: string;
  lastUsedAt?: string | null;
};

export type Call = { id: string; title?: string | null; created_at?: string; duration_seconds?: number | null; has_report?: boolean; open_url?: string | null };
export type CallPage = { calls?: Call[]; next_before?: string | null };
export type Fact = { object_id?: string; label?: string; category?: string; value?: unknown; display?: string | null; evidence?: { text?: string; quote?: string }[] };
export type CallDetail = Call & { facts?: Fact[] | null };

export type LeadRow = { lead_id: string; name?: string; company?: string | null; city?: string | null; interest?: string | null; stage?: string; stage_label?: string;
  source_label?: string; owner_name?: string | null; why?: string; next_action_at?: string | null; created_at?: string; calls?: number; last_result_label?: string | null; overdue?: boolean };
export type LeadPage = { leads?: LeadRow[]; total?: number; next_offset?: number | null };
export type LeadDetail = { lead?: LeadRow; phone?: string | null; email?: string | null; next_action_note?: string | null; fields?: { label: string; value: string }[];
  events?: { kind?: string; at?: string; actor_name?: string | null; stage_label?: string | null; reason_label?: string | null; note?: string | null }[] };

export const LEAD_STAGES = [
  { value: "open", label: "Open" }, { value: "new", label: "New" }, { value: "follow_up", label: "Follow up" },
  { value: "interested", label: "Interested" }, { value: "not_connected", label: "Not connected" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" },
] as const;
