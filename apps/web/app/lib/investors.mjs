// GROWTH-LOOP slice 1 (owner, 8 Nov 2026): the investor numbers' plain words. The API (GET /api/v0/hq/investors,
// pulse.investor_metrics 1894) sends totals and weekly series across every company; this file names them, works out
// each week's change, writes the one-line headline and the text that "Copy for the deck" puts on the clipboard.

const NUM = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A whole number the Indian way: 1,24,500. */
export const num = (n) => NUM.format(Math.round(Number(n) || 0));

/** "2026-11-02" → "2 Nov" (a week's Monday). */
export function weekLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : "";
}

/**
 * The seven numbers, in the order the page shows them. `flow` numbers happen in a week (signed, joined, handled): the
 * change is this week's count. `level` numbers stand at a time (people, agents): the change is the difference from
 * last week. Chat users are a flow by week and an all-time total.
 */
export const METRICS = [
  { key: "contractsSigned", label: "Contracts signed", kind: "flow", how: "An agreement counts once, when every side has accepted it." },
  { key: "companiesViaDeal", label: "Companies that joined through a deal", kind: "flow", how: "A company whose founder was already another company’s client, vendor or freelancer on Vitals, or that was a side of another company’s agreement, before it opened." },
  { key: "quotesAndBills", label: "Quotes and bills handled", kind: "flow", parts: ["quotes", "bills"], how: "Quotations, invoices and proformas past draft, in the week they were issued." },
  { key: "chatUsers", label: "People using chat", kind: "flow", how: "People who sent a chat message. Client-side people are counted apart too. AI employees are left out." },
  { key: "employees", label: "People working in companies on Vitals", kind: "level", how: "Active staff in every company, one per Vitals sign-in. AI employees are left out." },
  { key: "aiAgents", label: "AI agents at work", kind: "level", how: "AI employees that are switched on." },
  { key: "activeUsers", label: "Weekly active people", kind: "level", how: "People who signed in, used the app or sent a chat message that week." },
];

/** One metric's weekly series (quotes and bills added together). */
export function series(data, metric) {
  const s = data?.series ?? {};
  if (metric.parts) {
    const [a, b] = metric.parts.map((k) => s[k] ?? []);
    return a.map((v, i) => (v ?? 0) + (b[i] ?? 0));
  }
  return (s[metric.key] ?? []).map((v) => v ?? 0);
}

/** The big number on a tile: the all-time total for flows, where things stand now for levels. */
export function total(data, metric) {
  const t = data?.totals ?? {};
  return metric.parts ? metric.parts.reduce((sum, k) => sum + (t[k] ?? 0), 0) : t[metric.key] ?? 0;
}

/** This week's change: { n, text, tone } ("+46 this week", "−24 this week", "None yet this week"). */
export function change(data, metric) {
  const s = series(data, metric);
  if (!s.length) return { n: 0, text: "No weeks yet", tone: "flat" };
  const last = s[s.length - 1];
  const n = metric.kind === "flow" ? last : last - (s.length > 1 ? s[s.length - 2] : 0);
  if (n === 0) return { n, text: metric.kind === "flow" ? "None yet this week" : "Same as last week", tone: "flat" };
  return { n, text: `${n > 0 ? "+" : "−"}${num(Math.abs(n))} this week`, tone: n > 0 ? "up" : "down" };
}

/** The one-line story of the week ("This week: 46 contracts signed and 3 companies joined through a deal."). */
export function headline(data) {
  const c = change(data, METRICS[0]).n, j = change(data, METRICS[1]).n, q = change(data, METRICS[2]).n;
  const parts = [];
  if (c > 0) parts.push(`${num(c)} ${c === 1 ? "contract" : "contracts"} signed`);
  if (j > 0) parts.push(`${num(j)} ${j === 1 ? "company" : "companies"} joined through a deal`);
  if (q > 0) parts.push(`${num(q)} ${q === 1 ? "quote or bill" : "quotes and bills"} handled`);
  if (!parts.length) return "This week is just starting. The numbers fill in as companies work.";
  const last = parts.pop();
  return `This week: ${parts.length ? `${parts.join(", ")} and ${last}` : last}.`;
}

/** What "Copy for the deck" copies: one line per number, then where it came from. */
export function deckText(data) {
  const weeks = data?.weeks ?? [];
  const lines = METRICS.map((m) => {
    const ch = change(data, m);
    const extra = m.key === "chatUsers" ? ` (${num(data?.totals?.chatUsersClient ?? 0)} client-side)` : "";
    return `${m.label}: ${num(total(data, m))}${extra}${ch.n ? ` (${ch.text})` : ""}`;
  });
  const span = weeks.length ? ` Weeks of ${weekLabel(weeks[0])} to ${weekLabel(weeks[weeks.length - 1])}.` : "";
  return `Vitals network numbers\n${lines.join("\n")}\nCounted from live data across every company on Vitals.${span}`;
}

/** The spark line's points in a 100×28 box, zero at the bottom (empty for fewer than two weeks). */
export function sparkPoints(values) {
  if (!values || values.length < 2) return "";
  const max = Math.max(1, ...values);
  return values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(28 - (Math.max(0, v) / max) * 26 - 1).toFixed(1)}`).join(" ");
}

/** The "What is Vitals" funnel: how many saw the card, pressed "Start free" and opened a company, with the step rates. */
export function funnel(data) {
  const t = data?.totals ?? {};
  const viewed = t.funnelViewed ?? 0, clicked = t.funnelClicked ?? 0, made = t.funnelOrgCreated ?? 0;
  const rate = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "–");
  return { viewed, clicked, made, clickRate: rate(clicked, viewed), madeRate: rate(made, clicked) };
}
