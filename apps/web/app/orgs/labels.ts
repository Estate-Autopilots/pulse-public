// ORG: words for a Pulse account's place in an organisation (server and browser).
const KIND: Record<string, string> = { staff: "Team", freelancer: "Freelancer", client: "Client", partner: "Partner", agent: "AI co-worker" };
export const kindLabel = (k: string) => KIND[k] ?? "Member";
export const orgInitials = (name: string) => name.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "·";
// ORG-SWITCHER-UX: the person's access in an organisation, for the switcher's line under its name ("Admin · @acme"),
// from pulse.account_seat_looks (1601); a seat without it falls back to the seat's kind.
const ACCESS: Record<string, string> = { owner: "Owner", admin: "Admin", leadership: "Leadership", hr: "HR", finance: "Finance", manager: "Manager",
  pgs: "PGS", accountant: "Accountant", member: "Member" };
export const accessLabel = (access: string | null | undefined, kind: string) => (access && ACCESS[access]) || (kind === "staff" ? "Member" : kindLabel(access || kind));
/** The same colour of its own the sidebar gives an organisation without a logo or brand colour (ui-shell orgHue). */
export function orgHue(name: string): number { let h = 7; for (const c of name) h = (h * 31 + (c.codePointAt(0) ?? 0)) % 360; return h; }
