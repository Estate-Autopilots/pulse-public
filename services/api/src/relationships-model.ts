// R46: what a relationship looks like to a reader. A head version with a confirmed version standing behind it (a
// correction waiting, from a source or a colleague) reads as confirmed with the correction pending; everything else
// reads as its own status. Edges are grouped by RE project (the project key engagement records share) or by client.

export const KINDS = ["development", "client", "team", "account_owner", "contact", "model"] as const;
export type Kind = typeof KINDS[number];
export const KIND_LABEL: Record<Kind, string> = {
  development: "Same RE project", client: "Client", team: "Assigned PM", account_owner: "Relationship owner", contact: "Client contact", model: "Model",
};
const ROLE_LABEL: Record<string, string> = { developer: "Developer", channel_partner: "Channel partner", client: "Client" };
const SOURCE_LABEL: Record<string, string> = {
  project: "Project records", review_item: "Review data suggestion", client: "Client record", client_contact: "Client contacts",
  talent_shoot: "Shoot sheets", person: "A person in Pulse",
};

export type EdgeRow = {
  thread: string; id: string; version: number; kind: Kind; role: string | null; status: Status; action: string; actor: string | null; note: string | null; at: string;
  standing: string | null; subjectType: "engagement" | "client"; subjectId: string; objectType: string; objectId: string | null; objectKey: string | null; objectLabel: string;
  validFrom: string | null; validTo: string | null; sourceFamily: string; evidence: unknown; confidence: number | null; observedAt: string | null; actorName: string | null;
  sId: string | null; sStatus: string | null; sRole: string | null; sObjectType: string | null; sObjectId: string | null; sObjectKey: string | null; sObjectLabel: string | null;
  sValidFrom: string | null; sValidTo: string | null; sActor: string | null; sActorName: string | null; sAt: string | null; sNote: string | null; sSourceFamily: string | null; sEvidence: unknown;
  subjectLabel: string | null; registryNo: number | null; projectKey: string | null; objectName: string | null; objectClientType: string | null; disputed: boolean; sameName: number;
};
export type Status = "proposed" | "confirmed" | "rejected" | "withdrawn";
export type Node = { type: string; id: string | null; key: string | null; label: string; sub: string | null; href: string | null; resolved: boolean };
export type Edge = {
  thread: string; head: string; version: number; kind: Kind; kindLabel: string; role: string | null; status: Status;
  subject: Node; object: Node; validFrom: string | null; validTo: string | null;
  source: { family: string; label: string; evidence: string[]; confidence: number | null; observedAt: string | null };
  decided: { by: string | null; at: string; action: string; note: string | null } | null;
  pending: { object: Node; role: string | null; by: string | null; at: string; note: string | null; fromSource: boolean; evidence: string[] } | null;
  disputed: boolean; sameName: number; can: { decide: boolean; undo: boolean };
  group: { key: string; label: string; type: "development" | "engagement" | "client" };
};
export type Group = { key: string; label: string; type: Edge["group"]["type"]; engagements: Node[]; edges: Edge[] };

export const evidence = (e: unknown): string[] => (Array.isArray(e) ? e : []).map((x) => x && typeof x === "object" ? String((x as Record<string, unknown>).basis ?? "") : "").filter(Boolean).slice(0, 4);
/** A project's registry number: in the company's code when the caller has it ("ACR-0042"), else "#0042" (DE-EA). */
export const registry = (n: number | null, code = "") => n === null || n === undefined ? null : `${code ? `${code}-` : "#"}${String(n).padStart(4, "0")}`;

export function node(type: string, nodeId: string | null, key: string | null, label: string, role: string | null): Node {
  const resolved = !!(nodeId || key);
  const href = !resolved ? null : type === "client" ? `/clients/${nodeId}` : type === "employee" ? `/people/${nodeId}` : type === "contact" || type === "model" ? `/contacts/${nodeId}`
    : type === "development" ? `/relationships?dev=${encodeURIComponent(key ?? "")}` : type === "engagement" ? `/projects/${nodeId}` : null;
  const sub = !resolved ? "Written name only: no record chosen" : type === "client" ? ROLE_LABEL[role ?? ""] ?? "Client" : type === "employee" ? "Employee"
    : type === "model" ? "Model" : type === "contact" ? "Contact" : type === "development" ? "RE project" : null;
  return { type, id: nodeId, key, label, sub, href, resolved };
}

export function effective(r: EdgeRow, who: { kinds: string[]; me: string | null; admin: boolean }): Edge {
  const standing = !!r.sId && (r.status === "proposed" || r.status === "withdrawn");
  const subject: Node = r.subjectType === "engagement"
    ? { ...node("engagement", r.subjectId, null, r.subjectLabel ?? "Engagement record", null), sub: registry(r.registryNo) }
    : node("client", r.subjectId, null, r.subjectLabel ?? "Client", null);
  const head = node(r.objectType, r.objectId, r.objectKey, r.objectName ?? r.objectLabel, r.objectType === "client" ? (r.objectClientType === "developer" ? "developer" : r.objectClientType === "channel_partner" ? "channel_partner" : r.role) : r.role);
  const object = standing ? node(r.sObjectType ?? r.objectType, r.sObjectId, r.sObjectKey, r.sObjectLabel ?? "", r.sRole) : head;
  const group: Edge["group"] = r.subjectType === "client" ? { key: `client:${r.subjectId}`, label: r.subjectLabel ?? "Client", type: "client" }
    : r.projectKey ? { key: `dev:${r.projectKey}`, label: r.kind === "development" ? (standing ? r.sObjectLabel : r.objectLabel) ?? r.subjectLabel ?? r.projectKey : r.subjectLabel ?? r.projectKey, type: "development" }
    : { key: `eng:${r.subjectId}`, label: r.subjectLabel ?? "Engagement record", type: "engagement" };
  return {
    thread: r.thread, head: r.id, version: r.version, kind: r.kind, kindLabel: KIND_LABEL[r.kind], role: standing ? r.sRole : r.role,
    status: standing ? "confirmed" : r.status, subject, object,
    validFrom: standing ? r.sValidFrom : r.validFrom, validTo: standing ? r.sValidTo : r.validTo,
    source: standing ? { family: r.sSourceFamily ?? "person", label: SOURCE_LABEL[r.sSourceFamily ?? "person"] ?? "Source", evidence: evidence(r.sEvidence), confidence: null, observedAt: null }
      : { family: r.sourceFamily, label: SOURCE_LABEL[r.sourceFamily] ?? "Source", confidence: r.confidence, observedAt: r.observedAt,
          evidence: r.action === "suggest" ? [`Suggested by ${r.actorName ?? "a colleague"}${r.note ? `: “${r.note}”` : ""}`] : evidence(r.evidence) },
    decided: standing ? { by: r.sActorName, at: r.sAt ?? r.at, action: "confirm", note: r.sNote } : r.actor && r.action !== "suggest" ? { by: r.actorName, at: r.at, action: r.action, note: r.note } : null,
    pending: standing && r.status === "proposed" ? { object: head, role: r.role, by: r.actor ? r.actorName : null, at: r.at, note: r.note, fromSource: !r.actor, evidence: evidence(r.evidence) } : null,
    disputed: !!r.disputed, sameName: Number(r.sameName) || 0,
    can: { decide: who.kinds.includes(r.kind), undo: !!r.actor && (r.actor === who.me || who.kinds.includes(r.kind) || who.admin) },
    group,
  };
}

/** Edges by RE project (engagement records sharing a project key), engagement record without a key, or client. */
export function groupEdges(edges: Edge[]): Group[] {
  const groups = new Map<string, Group>();
  for (const e of edges) {
    let g = groups.get(e.group.key);
    if (!g) groups.set(e.group.key, g = { key: e.group.key, label: e.group.label, type: e.group.type, engagements: [], edges: [] });
    if (e.kind === "development" && e.object.resolved) g.label = e.object.label;
    if (e.subject.type === "engagement" && !g.engagements.some((x) => x.id === e.subject.id)) g.engagements.push(e.subject);
    g.edges.push(e);
  }
  return [...groups.values()];
}
