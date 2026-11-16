// R55: which model gives how much benefit, which doesn't, and what works. Plain arithmetic on the talent index, so
// every number can be traced to the shoots, projects, videos and (for leadership) fees behind it. Associations, not
// causes: a client who came back after a shoot may have come back for many reasons. Small samples are labelled and
// pulled towards the company average instead of ranked as if they were certain.

export type ShootFact = { personId: string; shootOn: string | null; month: string; projectId: string | null; clientId: string | null;
  clientLabel: string | null; language: string | null; segment: string | null; deliverable: string | null; status: string | null; scripts: number | null; sourceKey: string };
export type Engagement = { clientId: string; month: string };            // every client project in Pulse, by start month
export type MediaFact = { personId: string; kind: string; basis: string; files: number; delivered: number };
export type FeeFact = { personId: string | null; shootOn: string | null; total: number | null; charges: number | null; travel: number | null; extra: number | null; shootKeys: string[] };
export type AdFact = { name: string; spend: number; leads: number; impressions: number; clicks: number };
export type Person = { id: string; name: string; aliases: string[]; portfolio: number };
export type Confidence = "high" | "medium" | "low" | "too_new";

export type ModelRow = {
  id: string; name: string; aliases: string[]; rank: number | null; score: number | null; confidence: Confidence; why: string;
  shootDays: number; shootLines: number; scripts: number; first: string | null; last: string | null; languages: string[];
  projects: number; clients: number; clientsFollowed: number; clientsBack: number; returnRate: number | null; returnShrunk: number | null; lift: number | null;
  videos: number; delivered: number; portfolio: number; videosPerDay: number | null;
  cost?: { total: number; paidLines: number; perDay: number | null; perScript: number | null; travelShare: number | null; perClientBack: number | null };
  ads: { spend: number; leads: number; cpl: number | null; ctr: number | null } | null;
};
export type WhatWorks = { dimension: string; label: string; value: string; shootDays: number; clientsFollowed: number; returnRate: number | null; videosPerDay: number | null; note: string }[];

const FOLLOW_DAYS = 90;      // a client needs this long after the shoot before "came back or not" can be read
const SHRINK = 4;            // pseudo-clients at the company rate added to every model's return rate
const day = (s: string) => new Date(s + (s.length === 7 ? "-01" : "") + "T00:00:00Z").getTime();
const monthOf = (s: string) => s.slice(0, 7);
const median = (xs: number[]) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
/** Percentile of x among xs (0..1); ties share the middle. */
const percentile = (x: number, xs: number[]) => { if (xs.length < 2) return 0.5; const below = xs.filter((v) => v < x).length, same = xs.filter((v) => v === x).length; return (below + (same - 1) / 2) / (xs.length - 1); };

/** For each client first shot on `first`: did they start another engagement in a later month, or shoot again 45+ days later? */
export function cameBack(clientId: string, first: string, engagements: Map<string, string[]>, shootsByClient: Map<string, string[]>): boolean {
  const later = (engagements.get(clientId) ?? []).some((m) => m > monthOf(first));
  const again = (shootsByClient.get(clientId) ?? []).some((d) => day(d) - day(first) >= 45 * 864e5);
  return later || again;
}

export function rankModels(input: { people: Person[]; shoots: ShootFact[]; engagements: Engagement[]; media: MediaFact[]; fees?: FeeFact[]; ads?: AdFact[]; today: string }): { models: ModelRow[]; baseline: { clientsFollowed: number; clientsBack: number; returnRate: number | null }; whatWorks: WhatWorks; costVisible: boolean } {
  const { people, shoots, engagements, media, fees, ads = [], today } = input;
  const now = day(today);
  const engagementsBy = new Map<string, string[]>(); for (const e of engagements) engagementsBy.set(e.clientId, [...(engagementsBy.get(e.clientId) ?? []), monthOf(e.month)]);
  const dated = shoots.filter((s) => s.clientId && (s.shootOn || s.month));
  const shootsByClient = new Map<string, string[]>(); for (const s of dated) shootsByClient.set(s.clientId!, [...(shootsByClient.get(s.clientId!) ?? []), s.shootOn ?? s.month]);

  // Company baseline: every client, from their first shoot with any model.
  const firstShoot = new Map<string, string>(); for (const s of dated) { const d = s.shootOn ?? s.month; const f = firstShoot.get(s.clientId!); if (!f || d < f) firstShoot.set(s.clientId!, d); }
  let baseFollowed = 0, baseBack = 0;
  for (const [client, first] of firstShoot) if (now - day(first) >= FOLLOW_DAYS * 864e5) { baseFollowed++; if (cameBack(client, first, engagementsBy, shootsByClient)) baseBack++; }
  const base = baseFollowed ? baseBack / baseFollowed : null;

  const feesBy = new Map<string, FeeFact[]>(); for (const f of fees ?? []) if (f.personId) feesBy.set(f.personId, [...(feesBy.get(f.personId) ?? []), f]);
  const rows: ModelRow[] = people.map((p) => {
    const mine = shoots.filter((s) => s.personId === p.id);
    const days = new Set(mine.map((s) => s.shootOn ?? s.sourceKey));
    const months = mine.map((s) => s.shootOn ?? s.month).sort();
    const clientFirst = new Map<string, string>(); for (const s of mine) if (s.clientId) { const d = s.shootOn ?? s.month; const f = clientFirst.get(s.clientId); if (!f || d < f) clientFirst.set(s.clientId, d); }
    let followed = 0, back = 0;
    for (const [client, first] of clientFirst) if (now - day(first) >= FOLLOW_DAYS * 864e5) { followed++; if (cameBack(client, first, engagementsBy, shootsByClient)) back++; }
    const rate = followed ? back / followed : null;
    const shrunk = base === null ? rate : (back + SHRINK * base) / (followed + SHRINK);
    const m = media.filter((x) => x.personId === p.id);
    const videos = m.filter((x) => x.basis === "shoot_date" || x.basis === "shoot_project").reduce((n, x) => n + x.files, 0);
    const delivered = m.reduce((n, x) => n + x.delivered, 0);
    const lang = [...new Set(mine.map((s) => s.language).filter((x): x is string => !!x).map((x) => x.trim().replace(/^\w/, (c) => c.toUpperCase())))];
    const scripts = mine.reduce((n, s) => n + (s.scripts ?? 0), 0);
    const myAds = ads.filter((a) => p.aliases.concat(p.name).some((alias) => alias.length >= 4 && new RegExp(`(^|[^a-z])${alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(a.name.toLowerCase())));
    const adSum = myAds.reduce((t, a) => ({ spend: t.spend + a.spend, leads: t.leads + a.leads, impressions: t.impressions + a.impressions, clicks: t.clicks + a.clicks }), { spend: 0, leads: 0, impressions: 0, clicks: 0 });
    const row: ModelRow = {
      id: p.id, name: p.name, aliases: p.aliases, rank: null, score: null, confidence: "too_new", why: "",
      shootDays: days.size, shootLines: mine.length, scripts, first: months[0] ?? null, last: months[months.length - 1] ?? null, languages: lang,
      projects: new Set(mine.map((s) => s.projectId).filter(Boolean)).size, clients: clientFirst.size, clientsFollowed: followed, clientsBack: back,
      returnRate: rate, returnShrunk: shrunk, lift: shrunk !== null && base !== null ? shrunk - base : null,
      videos, delivered, portfolio: p.portfolio, videosPerDay: days.size ? videos / days.size : null,
      ads: myAds.length ? { spend: adSum.spend, leads: adSum.leads, cpl: adSum.leads ? adSum.spend / adSum.leads : null, ctr: adSum.impressions ? adSum.clicks / adSum.impressions : null } : null,
    };
    if (fees) {
      const f = feesBy.get(p.id) ?? [];
      const total = f.reduce((n, x) => n + (x.total ?? (x.charges ?? 0) + (x.travel ?? 0) + (x.extra ?? 0)), 0), travel = f.reduce((n, x) => n + (x.travel ?? 0), 0);
      const paidDays = new Set(f.map((x) => x.shootOn ?? x.shootKeys[0])).size;
      row.cost = { total, paidLines: f.length, perDay: paidDays ? total / paidDays : null, perScript: scripts ? total / scripts : null, travelShare: total ? travel / total : null, perClientBack: back ? total / back : null };
    }
    row.confidence = days.size < 2 ? "too_new" : days.size >= 10 && followed >= 6 ? "high" : days.size >= 4 && followed >= 3 ? "medium" : "low";
    return row;
  });

  // Benefit index: percentiles among ranked models (two or more shoot days). Clients coming back weighs most; then
  // what a shoot day produces, how many clients they reached, and (leadership) what a shoot day costs.
  const ranked = rows.filter((r) => r.confidence !== "too_new");
  const lifts = ranked.map((r) => r.lift ?? 0), outputs = ranked.map((r) => r.videosPerDay ?? 0), reach = ranked.map((r) => r.clients);
  const costs = ranked.map((r) => r.cost?.perDay).filter((x): x is number => x !== null && x !== undefined);
  const medianCost = median(costs);
  for (const r of ranked) {
    const parts: [number, number][] = [[0.4, percentile(r.lift ?? 0, lifts)], [0.25, percentile(r.videosPerDay ?? 0, outputs)], [0.15, percentile(r.clients, reach)]];
    if (fees && r.cost?.perDay !== null && r.cost?.perDay !== undefined && costs.length >= 2) parts.push([0.2, 1 - percentile(r.cost.perDay, costs)]);
    const weight = parts.reduce((n, [w]) => n + w, 0);
    r.score = Math.round((parts.reduce((n, [w, v]) => n + w * v, 0) / weight) * 100);
    const says: string[] = [];
    if (r.clientsFollowed) says.push(`${r.clientsBack} of ${r.clientsFollowed} clients came back${base !== null ? ` (company ${Math.round(base * 100)}%)` : ""}`);
    else says.push("no client old enough to tell if they came back");
    if (r.videosPerDay !== null) says.push(`${r.videosPerDay.toFixed(1)} model videos a shoot day`);
    if (r.cost?.perDay && medianCost) says.push(`${r.cost.perDay > medianCost * 1.15 ? "costs more" : r.cost.perDay < medianCost * 0.85 ? "costs less" : "costs about the same"} per shoot day than the median`);
    r.why = says.join("; ");
  }
  ranked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.shootDays - a.shootDays || a.name.localeCompare(b.name));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  for (const r of rows) if (r.confidence === "too_new") r.why = r.shootDays ? "One shoot day so far: too early to compare." : "No shoot recorded in the coordinator's sheets.";
  const order = [...ranked, ...rows.filter((r) => r.confidence === "too_new").sort((a, b) => b.shootDays - a.shootDays || b.videos + b.portfolio - (a.videos + a.portfolio) || a.name.localeCompare(b.name))];

  return { models: order, baseline: { clientsFollowed: baseFollowed, clientsBack: baseBack, returnRate: base }, whatWorks: whatWorks(shoots, media, engagementsBy, shootsByClient, now), costVisible: !!fees };
}

/** What works: the same reading by language, segment, deliverable and crew-less vs crewed, with sample sizes. */
function whatWorks(shoots: ShootFact[], media: MediaFact[], engagementsBy: Map<string, string[]>, shootsByClient: Map<string, string[]>, now: number): WhatWorks {
  void media;
  const dims: [string, string, (s: ShootFact) => string | null][] = [
    ["language", "Language", (s) => s.language ? s.language.trim().toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : null],
    ["segment", "Segment", (s) => s.segment ? s.segment.trim().replace(/\s+/g, " ") : null],
    ["deliverable", "What was shot", (s) => !s.deliverable ? null : /testimonial/i.test(s.deliverable) ? "Client testimonial" : /founder/i.test(s.deliverable) ? "Founder video" : /model[- ]led/i.test(s.deliverable) ? `Model-led ad${/#\s*2/.test(s.deliverable) ? " (second set)" : ""}` : s.deliverable.slice(0, 40)],
  ];
  const out: WhatWorks = [];
  for (const [dimension, label, read] of dims) {
    const groups = new Map<string, ShootFact[]>(); for (const s of shoots) { const v = read(s); if (v) groups.set(v, [...(groups.get(v) ?? []), s]); }
    for (const [value, list] of groups) {
      const first = new Map<string, string>(); for (const s of list) if (s.clientId) { const d = s.shootOn ?? s.month; const f = first.get(s.clientId); if (!f || d < f) first.set(s.clientId, d); }
      let followed = 0, back = 0; for (const [c, d] of first) if (now - day(d) >= FOLLOW_DAYS * 864e5) { followed++; if (cameBack(c, d, engagementsBy, shootsByClient)) back++; }
      const days = new Set(list.map((s) => `${s.personId}|${s.shootOn ?? s.sourceKey}`)).size;
      out.push({ dimension, label, value, shootDays: days, clientsFollowed: followed, returnRate: followed ? back / followed : null, videosPerDay: null,
        note: followed < 5 ? "Too few clients followed for 90 days to compare" : `${back} of ${followed} clients came back` });
    }
  }
  return out.sort((a, b) => a.dimension.localeCompare(b.dimension) || b.shootDays - a.shootDays);
}

export const TALENT_METHOD = [
  "Shoots come from the shoot coordinator's sheets (shoot Details and the Model & Cinematographer Pay Tracker), from June 2025. A shoot day is one model on one date.",
  "A shoot's project is read from the client written in the sheet, the dated model videos in the project's Drive folder, and the place and month; unsure links wait in Review data.",
  `Came back: the client started another engagement in a later month, or shot again 45 days or more later. Only clients first shot at least ${FOLLOW_DAYS} days ago count.`,
  `Small samples are pulled towards the company rate (as if each model had ${SHRINK} more clients at that rate), so one lucky client does not top the list.`,
  "Benefit index (0–100): where a model stands among models with two or more shoot days: clients coming back 40%, model videos per shoot day 25%, clients reached 15%, and for leadership cost per shoot day 20% (cheaper is better).",
  "Confidence: high with 10+ shoot days and 6+ clients followed, medium with 4+ and 3+, low below that. One shoot day is too new to rank.",
  "These are associations, not causes: a client who came back may have come back for the ads, the price or the team.",
];
