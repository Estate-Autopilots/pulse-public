// ORG: words for a Pulse account's place in an organisation (server and browser).
const KIND: Record<string, string> = { staff: "Team", freelancer: "Freelancer", client: "Client", partner: "Partner", agent: "AI co-worker" };
export const kindLabel = (k: string) => KIND[k] ?? "Member";
export const orgInitials = (name: string) => name.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "·";
