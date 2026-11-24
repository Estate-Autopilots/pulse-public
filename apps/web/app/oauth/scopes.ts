// PULSE-ID: what each scope means, in the words the consent screen and Connected apps use
// (docs/architecture/PULSE_IDENTITY_AND_DATA_API.md §5).
export type ScopeWords = { label: string; personal: string; org: string; data?: boolean; startsOff?: boolean };
export const SCOPES: Record<string, ScopeWords> = {
  openid: { label: "Who you are", personal: "Know who you are on Pulse", org: "Know who you are on Pulse" },
  profile: { label: "Profile", personal: "Your name, photo, job title and team", org: "Your name, photo, job title and team" },
  email: { label: "E-mail", personal: "Your e-mail address", org: "Your e-mail address" },
  "pulse.orgs": { label: "Organisations", personal: "The organisations you’re in on Pulse and your role in each", org: "The organisations you’re in on Pulse" },
  offline_access: { label: "Stay connected", personal: "Stay connected when you’re not using it", org: "Stay connected when you’re not using it" },
  "pulse.org.read": { label: "People", personal: "", org: "See everyone in {org}: names, photos, job titles, teams, roles and work e-mails", data: true },
  "pulse.org.webhooks": { label: "Changes", personal: "", org: "Be told when someone in {org} joins, leaves or changes", data: true },
  "pulse.signals.write": { label: "Sales activity", personal: "", org: "Add daily sales activity counts (calls analysed, leads worked, follow-ups, talk minutes) to people’s pages", data: true },
  "pulse.clients.read": { label: "Clients", personal: "See the clients you can see in Pulse", org: "See {org}’s clients and their contacts", data: true },
  "pulse.leads.write": { label: "Leads", personal: "", org: "Add and update leads in {org}’s Pulse; won leads become clients", data: true },
  "pulse.calls.write": { label: "Sales calls", personal: "", org: "Add sales calls and their analysis to {org}’s clients and people", data: true },
  "pulse.money.read": { label: "Money", personal: "", org: "See what each client was invoiced, has paid and still owes", data: true, startsOff: true },
  // SX-QUOTES (2525)
  "pulse.contacts.write": { label: "Contacts", personal: "", org: "Make the leads it sends you into contacts in {org}’s Pulse", data: true },
  "pulse.quotes.read": { label: "Quotations", personal: "", org: "See {org}’s quotations for its leads, their PDFs, and be told when one changes", data: true },
  "pulse.quotes.write": { label: "Make quotations", personal: "", org: "Make quotations for {org}’s sellers, under {org}’s prices and approval rules, and record what it sent", data: true },
  "pulse.catalogue.read": { label: "Catalogue", personal: "", org: "Read {org}’s catalogue: items, prices and GST", data: true },
};
export const scopeSentence = (scope: string, kind: "personal" | "org", org: string) =>
  (SCOPES[scope]?.[kind] || SCOPES[scope]?.personal || scope).replaceAll("{org}", org);
/** The sentences a person reads, without "who you are" (always part of signing in). */
export const shownScopes = (scopes: string[]) => scopes.filter((s) => s !== "openid" && SCOPES[s]);
