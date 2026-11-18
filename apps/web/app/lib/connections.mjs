// CONNECTIONS part B (spec: reports/CONNECT-MAP.md §3): the words of a connection, from where the viewer stands.
// "Nature Solutions is a client of Vitals Technology", "Ravi works for you as a freelancer", the agreement badge, and the
// filters of My connections. Pure: no clock, no browser.

/** A side's name: a company's name, or the person's (a personal space is the person). */
export const sideName = (s) => (!s ? "Someone" : s.org && !s.personal ? s.orgName ?? s.name ?? "A company" : s.name ?? s.orgName ?? "Someone");
/** Is this side a person (a personal space or an account alone)? */
export const isPersonSide = (s) => !!s && (s.personal === true || (!s.org && !!s.account));
/** The other party, seen from my side ('a' or 'b'; null: someone who only sees it, e.g. a company admin on side a). */
export const otherSide = (row) => (row?.mySide === "b" ? row.a : row.b);
export const mySide = (row) => (row?.mySide === "b" ? row.b : row.a);

const KIND = {
  client: (a, b) => `${b} is a client of ${a}`,
  vendor: (a, b) => `${b} is a vendor to ${a}`,
  freelancer: (a, b) => `${b} works for ${a} as a freelancer`,
  partner: (a, b) => `${b} is a partner of ${a}`,
  cofounder: (a, b) => `${b} and ${a} are co-founders`,
  advisor: (a, b) => `${b} advises ${a}`,
  employee: (a, b) => `${b} works for ${a}`,
  investor: (a, b) => `${b} invested in ${a}`,
  accountant: (a, b) => `${b} is the accountant of ${a}`,
};
/** What one is to the other, in a sentence. `me` is the viewer's own account: their own personal side reads "you". */
export function sentence(row, me) {
  if (!row) return "";
  const name = (s) => (s && me && s.account === me && isPersonSide(s) ? "you" : sideName(s));
  const a = name(row.a), b = name(row.b);
  const say = (KIND[row.kind] ?? KIND.client)(a, b);
  const fixed = say.replace(/^you is /, "You are ").replace(/^you /, "You ").replace(/ works for you as/, " works for you as");
  return fixed[0].toUpperCase() + fixed.slice(1) + (row.bRole && row.kind !== "freelancer" ? ` (${row.bRole})` : "");
}

const SHORT = { client: "Client of", vendor: "Vendor to", freelancer: "Freelancer for", partner: "Partner of", cofounder: "Co-founder with",
  advisor: "Advisor to", employee: "Works for", investor: "Investor in", accountant: "Accountant for" };
/** The row's short line: what the other party is to your side ("Client of Northstar Realty", "Freelancer for you"). */
export function shortLine(row, me) {
  if (!row) return "";
  if (row.mySide === "b") return sentence(row, me);
  const a = row.a && me && row.a.account === me && isPersonSide(row.a) ? "you" : sideName(row.a);
  return `${SHORT[row.kind] ?? "Works with"} ${a}${row.bRole && row.kind !== "client" ? ` · ${row.bRole}` : ""}`;
}

/** The kinds, as people pick them: "what they are to you". */
export const KINDS = [
  ["client", "A client (you work for them)"], ["freelancer", "A freelancer (they work for you)"], ["vendor", "A vendor (they supply you)"],
  ["partner", "A partner"], ["cofounder", "A co-founder"], ["advisor", "An advisor"], ["accountant", "Your accountant"], ["investor", "An investor"],
];

/** The agreement badge: words and a tone. */
export function agreementBadge(ag) {
  switch (ag?.state) {
    case "signed": return { text: "Signed", tone: "good" };
    case "waiting": return { text: ag.waitingFor ? `Waiting for ${ag.waitingFor}` : "Waiting to be signed", tone: "warn" };
    case "draft": return { text: "Draft ready", tone: "warn" };
    case "ended": return { text: "Ended", tone: undefined };
    default: return { text: "No agreement", tone: "bad" };
  }
}

/** The one next step for a connection (the row's and the page's primary action). */
export function nextStep(row) {
  if (!row) return null;
  if (row.status === "ended") return null;
  if (row.status === "suggested") return { key: "confirm", label: "Confirm", why: "Pulse found this. Confirm you work together." };
  const st = row.agreement?.state;
  if (st === "none" && row.kind !== "investor") return { key: "draft", label: "Draft an agreement", why: "No agreement yet. Pulse drafts one; nothing is sent until you press Send." };
  if (st === "draft") return { key: "review", label: "Review the draft", why: "A draft agreement is ready. Review it, then send it yourself." };
  if (st === "waiting") return { key: "review", label: "See the agreement", why: `The agreement is out for signing${row.agreement?.waitingFor ? `: waiting for ${row.agreement.waitingFor}` : ""}.` };
  return { key: "give", label: "Give a task", why: "All set. Give a task or share a doc." };
}

/** The filters of My connections, with counts. */
export function filterRows(rows, filter) {
  const list = Array.isArray(rows) ? rows : [];
  switch (filter) {
    case "people": return list.filter((r) => isPersonSide(otherSide(r)));
    case "companies": return list.filter((r) => !isPersonSide(otherSide(r)));
    case "no-agreement": return list.filter((r) => r.status !== "ended" && (r.agreement?.state ?? "none") === "none");
    case "suggested": return list.filter((r) => r.status === "suggested");
    case "ended": return list.filter((r) => r.status === "ended");
    default: return list.filter((r) => r.status !== "ended");
  }
}

/** Seat ties in words: "Admin at Estate Autopilots", and how many have no agreement. */
export function tieSummary(t) {
  const people = t?.people ?? [];
  const none = people.filter((p) => p.agreement === "none").length;
  return { count: people.length, none, text: `${people.length} ${people.length === 1 ? "person" : "people"}${none ? ` · ${none} with no agreement` : ""}` };
}
