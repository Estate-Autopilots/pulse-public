// HR-PEOPLE (T1.1.11): the pay policy document's state, from GET /api/v0/hr/policies (the company's policy documents;
// kind "pay" since migration 2041): its latest version, whether it is published, and how many accepted it.
export type PolicyRow = { id: string; kind: string; title: string; version: number; revision?: number; status: "draft" | "published"; ackCount?: number; body?: string; published_at?: string | null };
export type PolicyList = { rows: PolicyRow[]; canEdit: boolean; headcount: number; versions?: { id: string; kind: string; version: number; status: string }[]; acks?: { document_id: string; person_id: string }[] };

/** The latest pay policy version anyone can read (published), whether a newer draft waits, and its acceptances. */
export function payDocState(list: PolicyList | null | undefined) {
  if (!list) return null;
  const latest = list.rows.find((r) => r.kind === "pay") ?? null;
  const published = latest?.status === "published" ? latest : (list.versions ?? []).filter((v) => v.kind === "pay" && v.status === "published").sort((a, b) => b.version - a.version)[0] ?? null;
  const accepted = published ? (latest?.id === published.id ? latest.ackCount ?? 0 : (list.acks ?? []).filter((a) => a.document_id === published.id).length) : 0;
  return { version: published?.version ?? null, published: !!published, accepted, of: list.headcount ?? 0, draft: latest?.status === "draft", latest };
}
