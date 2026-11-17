// R55: market intelligence on the map. Money by place, revenue projected by area, white space, market prices, shoot
// routes and travel time: plain arithmetic on what the API sent, each with its method and a confidence label, so a
// number on the screen can always be traced to the invoices, projects, documents or shoots behind it.
import type { Market } from "./geo";

/** Great-circle distance in km (the same formula as geo.ts; kept here so this file loads on its own in tests). */
export const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

export type Confidence = "high" | "medium" | "low";
export type MoneyInvoice = { number: string; party: string; day: string; due: string | null; taxable: number; total: number; status: "paid" | "unpaid" | "unconfirmed" | string;
  overdueDays: number; paidBasis: string | null; clientId: string | null; projectId: string | null; locationId: string | null; basis: string | null; confidence: number | null };
export type MoneyParty = { key: string; party: string; status: "auto" | "confirmed" | "rejected" | "review" | "none"; basis: string; clientId: string | null; clientName: string | null;
  projectId: string | null; candidates: { clientId: string; name: string; projects: number }[]; invoices: number; taxable: number };
export type MoneyMap = { connected: true; invoices: MoneyInvoice[]; parties: MoneyParty[]; active: { name: string; projectId: string | null; locationId: string | null }[];
  packages?: { projectId: string; locationId: string | null; amount: number; currency: string }[];
  evidenceEnd: string | null; asOf: string | null; computedAt: string | null } | { connected: false; detail: string };
export type Shoot = { lat: number | null; lng: number | null; day: string | null; month: string; model: string | null; personId: string | null; projectId: string | null;
  locationId: string | null; place: string | null; placeBasis: string | null; status: string | null; clientLabel: string | null; deliverable: string | null };
export type Price = { locationId: string | null; projectId: string; price: number; kind: "apartment" | "plot" | "commercial" | "unknown"; fileName: string | null; quote: string | null; observedOn: string | null };

const monthOf = (day: string) => day.slice(0, 7);
const addMonths = (month: string, n: number) => { const [y, m] = month.split("-").map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

export type PlaceMoney = { invoiced: number; invoiced12: number; paid: number; unpaid: number; unconfirmed: number; overdue: number; invoices: number; clients: number; last: string | null; monthly: Record<string, number> };
const blank = (): PlaceMoney & { clientSet: Set<string> } => ({ invoiced: 0, invoiced12: 0, paid: 0, unpaid: 0, unconfirmed: 0, overdue: 0, invoices: 0, clients: 0, last: null, monthly: {}, clientSet: new Set() });

/** Invoices (taxable value, before GST) summed per location id. "Overdue" is past its due date with no bank credit found
 *  up to the last statement (FIN-LIVE's "unpaid"); a later invoice past due cannot be checked and stays "not yet confirmed". */
export function moneyByLocation(invoices: MoneyInvoice[], today: string): Map<string, PlaceMoney> {
  const out = new Map<string, ReturnType<typeof blank>>(), from12 = addMonths(monthOf(today), -11);
  for (const i of invoices) {
    if (!i.locationId) continue;
    const m = out.get(i.locationId) ?? blank(); out.set(i.locationId, m);
    const v = i.taxable || 0;
    m.invoiced += v; m.invoices += 1; if (monthOf(i.day) >= from12) m.invoiced12 += v;
    if (i.status === "paid") m.paid += v; else if (i.status === "unpaid") m.unpaid += v; else m.unconfirmed += v;
    if (i.status === "unpaid" && i.overdueDays > 0) m.overdue += v;   // past due with no bank credit up to the last statement
    if (i.clientId) m.clientSet.add(i.clientId);
    m.monthly[monthOf(i.day)] = (m.monthly[monthOf(i.day)] ?? 0) + v;
    if (!m.last || i.day > m.last) m.last = i.day;
  }
  for (const m of out.values()) m.clients = m.clientSet.size;
  return out;
}

/** The same, per micro-market: every location in the market adds its invoices once. */
export function moneyByMarket(markets: Market[], byLocation: Map<string, PlaceMoney>): Map<string, PlaceMoney> {
  const out = new Map<string, PlaceMoney>();
  for (const mk of markets) {
    const sum: PlaceMoney = { invoiced: 0, invoiced12: 0, paid: 0, unpaid: 0, unconfirmed: 0, overdue: 0, invoices: 0, clients: 0, last: null, monthly: {} };
    const seen = new Set<string>();
    for (const r of mk.rows) {
      if (seen.has(r.loc.id)) continue; seen.add(r.loc.id);
      const m = byLocation.get(r.loc.id); if (!m) continue;
      for (const k of ["invoiced", "invoiced12", "paid", "unpaid", "unconfirmed", "overdue", "invoices", "clients"] as const) sum[k] += m[k];
      for (const [month, v] of Object.entries(m.monthly)) sum.monthly[month] = (sum.monthly[month] ?? 0) + v;
      if (m.last && (!sum.last || m.last > sum.last)) sum.last = m.last;
    }
    if (sum.invoices) out.set(mk.key, sum);
  }
  return out;
}

export type Projection = { next6: number; perMonth: number; base: number; trend: number; months: number; activeMonths: number; confidence: Confidence; method: string };
/**
 * Revenue for the next six months in one area: the average of the last six full months, moved by the trend (the last
 * three months against the three before, capped at ±30%). Confidence follows how many of the last twelve months had
 * invoices and how many clients pay there; a market with one client is one client's plan, not a market's.
 */
export function projectRevenue(monthly: Record<string, number>, today: string, clients: number): Projection {
  const now = monthOf(today), last = addMonths(now, -1);
  const series = Array.from({ length: 12 }, (_, i) => monthly[addMonths(last, i - 11)] ?? 0);
  const six = series.slice(6), recent = series.slice(9), before = series.slice(6, 9);
  const base = six.reduce((n, v) => n + v, 0) / 6;
  const r = recent.reduce((n, v) => n + v, 0), b = before.reduce((n, v) => n + v, 0);
  const trend = b > 0 ? Math.max(-0.3, Math.min(0.3, r / b - 1)) : r > 0 ? 0.3 : 0;
  const perMonth = base * (1 + trend / 2);
  const activeMonths = series.filter((v) => v > 0).length;
  const confidence: Confidence = activeMonths >= 8 && clients >= 3 ? "high" : activeMonths >= 4 && clients >= 2 ? "medium" : "low";
  return { next6: perMonth * 6, perMonth, base, trend, months: 12, activeMonths, confidence,
    method: `Average of the last six full months (${addMonths(last, -5)} to ${last}), moved by half the trend of the last three months against the three before (capped at ±30%). ${activeMonths} of the last 12 months had invoices; ${clients} ${clients === 1 ? "client pays" : "clients pay"} here.` };
}

export type PriceStat = { key: string; name: string; kind: string; median: number; low: number; high: number; n: number; projects: number; confidence: Confidence };
/** Median price per sq ft per micro-market and kind, from the prices written in its projects' own documents. */
export function pricesByMarket(prices: Price[], markets: Market[]): PriceStat[] {
  const where = new Map<string, Market>(); for (const mk of markets) for (const r of mk.rows) where.set(r.loc.id, mk);
  const groups = new Map<string, { mk: Market; kind: string; values: number[]; projects: Set<string> }>();
  for (const p of prices) {
    const mk = p.locationId ? where.get(p.locationId) : undefined; if (!mk) continue;
    const key = `${mk.key}|${p.kind}`, g = groups.get(key) ?? { mk, kind: p.kind, values: [], projects: new Set() };
    g.values.push(p.price); g.projects.add(p.projectId); groups.set(key, g);
  }
  return [...groups.values()].map((g) => { const v = [...g.values].sort((a, b) => a - b);
    return { key: g.mk.key, name: g.mk.name, kind: g.kind, median: median(v)!, low: v[0], high: v[v.length - 1], n: v.length, projects: g.projects.size,
      confidence: (g.projects.size >= 3 ? "high" : g.projects.size === 2 ? "medium" : "low") as Confidence }; })
    .sort((a, b) => b.projects - a.projects || b.n - a.n);
}

export type Gap = { key: string; name: string; city: string; lat: number; lng: number; score: number; projects: number; nearbyRevenue: number; nearbyMarkets: string[];
  price: number | null; lastWork: string | null; why: string; confidence: Confidence };
/**
 * White space: micro-markets where there is demand but no paying client now. Demand is what Pulse can see: projects
 * EA has worked on or holds documents for there, invoiced revenue in neighbouring markets (within 6 km, nearer counts
 * more) and the price level its projects' documents quote. "No paying client now" means nothing invoiced there in
 * the last twelve months. Ranked by those three signals; a market seen once is a lead, not a trend.
 */
export function whiteSpace(markets: Market[], byMarket: Map<string, Pick<PlaceMoney, "invoiced12">>, prices: Pick<PriceStat, "key" | "kind" | "median">[]): Gap[] {
  const placed = markets.filter((m) => m.lat !== null && m.lng !== null && !m.isCity);
  const priceAt = new Map<string, number>(); for (const p of prices) if (p.kind === "apartment" && !priceAt.has(p.key)) priceAt.set(p.key, p.median);
  const allPrices = [...priceAt.values()], top = Math.max(1, ...allPrices);
  const out: Gap[] = [];
  for (const m of placed) {
    const money = byMarket.get(m.key);
    if (money && money.invoiced12 > 0) continue;
    let nearby = 0; const names: string[] = [];
    for (const o of placed) {
      if (o.key === m.key) continue;
      const d = km({ lat: m.lat!, lng: m.lng! }, { lat: o.lat!, lng: o.lng! }); if (d > 6) continue;
      const v = byMarket.get(o.key)?.invoiced12 ?? 0; if (!v) continue;
      nearby += v * (1 - d / 8); names.push(o.name);
    }
    if (!nearby && m.projects < 2) continue;
    const price = priceAt.get(m.key) ?? null;
    const score = Math.log10(1 + nearby / 1e4) * 2 + Math.min(m.projects, 8) * 0.6 + (price ? (price / top) * 1.5 : 0);
    const confidence: Confidence = names.length >= 2 && m.projects >= 2 ? "high" : names.length >= 1 || m.projects >= 3 ? "medium" : "low";
    const why = [`${m.projects} ${m.projects === 1 ? "project" : "projects"} known here${m.last ? `, latest work ${m.last}` : ""}`,
      names.length ? `paying clients in ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} nearby` : "no paying market within 6 km",
      price ? `projects here quote about ₹${Math.round(price).toLocaleString("en-IN")}/sq ft` : null].filter(Boolean).join("; ");
    out.push({ key: m.key, name: m.name, city: m.city, lat: m.lat!, lng: m.lng!, score, projects: m.projects, nearbyRevenue: nearby, nearbyMarkets: names, price, lastWork: m.last, why, confidence });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 40);
}

/**
 * Estimated driving time. Pulse has no routing service (see pulse-map.md), so a trip is the straight line times 1.35
 * for roads, at 22 km/h inside the city (the first 15 km) and 40 km/h beyond. An estimate to plan with, not a route.
 */
export function driveMinutes(kmStraight: number): number {
  const road = kmStraight * 1.35, inner = Math.min(road, 15 * 1.35), outer = Math.max(0, road - inner);
  return Math.round((inner / 22 + outer / 40) * 60);
}
/** The straight-line radius one can drive in a number of minutes by the same estimate (for travel-time rings). */
export function reachKm(minutes: number): number {
  const innerMinutes = ((15 * 1.35) / 22) * 60;
  const road = minutes <= innerMinutes ? (minutes / 60) * 22 : 15 * 1.35 + ((minutes - innerMinutes) / 60) * 40;
  return road / 1.35;
}

export type Stop = { id: string; name: string; lat: number; lng: number };
export type Route = { order: Stop[]; legs: { km: number; minutes: number }[]; km: number; minutes: number; start: Stop | null };
/** A shoot day's order: nearest first from the start, then 2-opt until no swap shortens the trip. Estimated times. */
export function planRoute(stops: Stop[], start: Stop | null): Route {
  const pts = stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (!pts.length) return { order: [], legs: [], km: 0, minutes: 0, start };
  const left = [...pts]; const order: Stop[] = [];
  let at: Stop = start ?? left.splice(0, 1)[0];
  if (!start) order.push(at);
  while (left.length) { let best = 0; for (let i = 1; i < left.length; i++) if (km(at, left[i]) < km(at, left[best])) best = i; at = left.splice(best, 1)[0]; order.push(at); }
  const path = start ? [start, ...order] : order;
  const length = (p: Stop[]) => p.slice(1).reduce((n, s, i) => n + km(p[i], s), 0);
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 1; i < path.length - 1; i++) for (let j = i + 1; j < path.length; j++) {
      const next = [...path.slice(0, i), ...path.slice(i, j + 1).reverse(), ...path.slice(j + 1)];
      if (length(next) + 1e-9 < length(path)) { path.splice(0, path.length, ...next); improved = true; }
    }
  }
  const legs = path.slice(1).map((s, i) => { const d = km(path[i], s); return { km: d * 1.35, minutes: driveMinutes(d) }; });
  return { order: start ? path.slice(1) : path, legs, km: legs.reduce((n, l) => n + l.km, 0), minutes: legs.reduce((n, l) => n + l.minutes, 0), start };
}

export const inr = (n: number | null | undefined) => n === null || n === undefined ? "–" : n >= 1e7 ? `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, "")} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(n >= 1e6 ? 1 : 2).replace(/\.?0+$/, "")} L` : `₹${Math.round(n).toLocaleString("en-IN")}`;
export const CONFIDENCE_LABEL: Record<Confidence, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
