import { zoneDay, zoneTime } from './org-time.js';
// FOCUS (owner, 7 Nov 2026; Focus OS proposal §5): the allocator, recommend-only. Pure functions, no database, so the
// board, the daily plan and the tests all use the same rules:
//   * today's weight per company = the owner's weight, nudged by deadlines (up), blocked work (down) and how much is
//     left to do (up), then scaled back to 100. The owner's number stays the anchor; the nudge is shown with its reason;
//   * a lane's score = WSJF (value + time criticality + unblock bonus + urgent) ÷ size, times today's weight ÷ 10;
//   * a blocked lane gets no AI time: its blocker is listed once for the owner;
//   * each account keeps a reserve (default 20 % of its 5-hour window and 15 % of its week) for urgent work only;
//   * best score first, each lane goes to the cheapest allowed account with room: a subscription before paid credit,
//     the account the lane already runs on (its cache is warm), an account about to refill, and never one drained to 0.

export type Company = { key: string; name: string; weight: number; hue?: number; sort?: number };
export type Window = { usedPct?: number | null; resetsAt?: string | null; amount?: number | null; at?: string | null };
export type Account = {
  key: string; name: string; kind: 'ai' | 'api' | 'cloud' | string; ownCompany?: string | null; companies: string[]; urgentOnly?: string[];
  tiers: string[]; cost: 'sunk' | 'metered' | string; status: 'ok' | 'limited' | 'off' | string; warmLanes?: string[];
  latest?: Record<string, Window> | null;
};
export type Lane = {
  key: string; title: string; company: string; value: number; size: 'S' | 'M' | 'L' | 'XL' | string; need: 'T0' | 'T1' | 'T2' | 'T3' | string;
  dueOn?: string | null; urgent?: boolean; blockedBy?: string | null; status?: string; account?: string | null; unblocks?: number;
};
export type Settings = { reserve5h: number; reserve7d: number; autoWeights: boolean };
export type Weight = { key: string; name: string; base: number; today: number; why: string | null };
export type Placed = { lane: string; title: string; company: string; account: string; accountName: string; score: number; reason: string };
export type Waiting = { lane: string; title: string; company: string; until: string | null; reason: string };
export type Blocked = { blocker: string; lanes: string[]; company: string };
export type Plan = { day: string; weights: Weight[]; placed: Placed[]; waiting: Waiting[]; blocked: Blocked[] };

const SIZE_POINTS: Record<string, number> = { S: 1, M: 2, L: 4, XL: 8 };
/** About how much of a 5-hour window a lane of each size takes (percent). Phase 2 learns these from real lanes. */
export const SIZE_PCT: Record<string, number> = { S: 5, M: 12, L: 25, XL: 45 };
const HOUR = 3600_000;

// A due day ends at 18:00 in the company's own zone (org-time.ts; the API passes orgZone, the unit tests UTC).
const days = (dueOn: string | null | undefined, now: Date, zone = 'UTC') => {
  if (!dueOn || !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return null;
  const due = zoneTime(dueOn, zone, '18:00').getTime();
  return Number.isFinite(due) ? (due - now.getTime()) / (24 * HOUR) : null;
};

/** 0–10: rises steeply inside 3 days, past due is 10. */
export function timeCriticality(dueOn: string | null | undefined, now: Date, zone = 'UTC') {
  const d = days(dueOn, now, zone);
  if (d === null) return 0;
  if (d <= 0) return 10;
  if (d <= 3) return Math.round(10 - d * 2);
  if (d <= 14) return Math.max(1, Math.round(4 - (d - 3) / 3));
  return 0;
}

/** Today's weights: the owner's weights nudged by deadlines, blocked work and work left, scaled to sum to 100. */
export function todaysWeights(companies: Company[], lanes: Lane[], now: Date, auto = true, zone = 'UTC'): Weight[] {
  const total = companies.reduce((s, c) => s + Math.max(0, c.weight), 0) || 1;
  const raw = companies.map((c) => {
    const own = lanes.filter((l) => l.company === c.key && l.status !== 'done' && l.status !== 'parked');
    let f = 1; const why: string[] = [];
    if (auto && own.length) {
      const soonest = Math.min(...own.map((l) => days(l.dueOn, now, zone) ?? Infinity));
      if (soonest <= 3) { f *= 1.3; why.push('deadline in 3 days'); } else if (soonest <= 7) { f *= 1.15; why.push('deadline this week'); }
      const blocked = own.filter((l) => l.blockedBy).length / own.length;
      if (blocked >= 0.5) { f *= 1 - blocked * 0.5; why.push(`${Math.round(blocked * 100)}% blocked`); }
      if (own.some((l) => l.urgent)) { f *= 1.15; why.push('urgent work'); }
    } else if (auto && !own.length) { f *= 0.5; why.push('nothing to do'); }
    return { c, value: (Math.max(0, c.weight) / total) * 100 * f, why };
  });
  const sum = raw.reduce((s, r) => s + r.value, 0) || 1;
  return raw.map(({ c, value, why }) => {
    const base = Math.round((Math.max(0, c.weight) / total) * 100);
    const today = Math.round((value / sum) * 100);
    return { key: c.key, name: c.name, base, today, why: today !== base && why.length ? why.join(', ') : null };
  });
}

export function score(lane: Lane, weight: number, now: Date, zone = 'UTC') {
  const cod = lane.value + timeCriticality(lane.dueOn, now, zone) + 2 * Math.min(5, lane.unblocks ?? 0) + (lane.urgent ? 10 : 0);
  return Math.round(((weight / 10) * cod / (SIZE_POINTS[lane.size] ?? 2)) * 10) / 10;
}

const fresh = (w: Window | undefined, now: Date) => !!w && (!w.resetsAt || Date.parse(w.resetsAt) > now.getTime());
/** Percent left in a window (a window past its reset is full again). Null: nobody has read it. */
export function left(a: Account, win: '5h' | '7d', now: Date): number | null {
  const w = a.latest?.[win];
  if (!w || w.usedPct === null || w.usedPct === undefined) return null;
  return fresh(w, now) ? Math.max(0, 100 - Number(w.usedPct)) : 100;
}
const resetsIn = (a: Account, now: Date) => {
  const t = a.latest?.['5h']?.resetsAt; const ms = t ? Date.parse(t) - now.getTime() : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};
export const until = (ms: number) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

/** Room for work now, in percent of a 5-hour window, keeping the rivokeb unless the work is urgent. Paid credit with money
 *  left counts as room (it costs more, see cost()). */
export function room(a: Account, s: Settings, urgent: boolean, now: Date): number | null {
  if (a.status === 'off' || a.kind === 'cloud') return 0;
  if (a.cost === 'metered') { const amt = a.latest?.balance?.amount; return amt === null || amt === undefined ? null : Number(amt) > 0 ? 100 : 0; }
  const h5 = left(a, '5h', now), d7 = left(a, '7d', now);
  if (h5 === null && d7 === null) return a.status === 'limited' ? 0 : null;
  const r5 = (h5 ?? 100) - (urgent ? 0 : s.reserve5h), r7 = (d7 ?? 100) - (urgent ? 0 : s.reserve7d);
  return Math.max(0, Math.min(r5, r7));
}

const allows = (a: Account, l: Lane) => {
  const named = !a.companies.length || a.companies.includes(l.company);
  return named || (!!l.urgent && (a.urgentOnly ?? []).includes(l.company));
};
const supports = (a: Account, l: Lane) => a.tiers.includes(l.need);

export function plan(input: { companies: Company[]; accounts: Account[]; lanes: Lane[]; settings: Settings; zone?: string }, now = new Date()): Plan {
  const { companies, accounts, settings } = input; const zone = input.zone ?? 'UTC';
  const lanes = input.lanes.filter((l) => l.status !== 'done' && l.status !== 'parked');
  const weights = todaysWeights(companies, lanes, now, settings.autoWeights, zone);
  const w = new Map(weights.map((x) => [x.key, x.today]));
  const name = new Map(companies.map((c) => [c.key, c.name]));
  const blocked = new Map<string, Blocked>();
  for (const l of lanes.filter((x) => x.blockedBy)) {
    const b = blocked.get(l.blockedBy!) ?? { blocker: l.blockedBy!, lanes: [], company: l.company };
    b.lanes.push(l.key); blocked.set(l.blockedBy!, b);
  }
  const spent = new Map<string, number>();   // percent of a 5-hour window already planned on each account
  const placed: Placed[] = [], waiting: Waiting[] = [];
  const ready = lanes.filter((l) => !l.blockedBy).map((l) => ({ l, s: score(l, w.get(l.company) ?? 0, now, zone) })).sort((a, b) => b.s - a.s || a.l.key.localeCompare(b.l.key));
  for (const { l, s } of ready) {
    const need = SIZE_PCT[l.size] ?? 12;
    const fit = accounts.filter((a) => allows(a, l) && supports(a, l)).map((a) => {
      const r = room(a, settings, !!l.urgent, now);
      return { a, r: r === null ? null : r - (spent.get(a.key) ?? 0) };
    });
    const ok = fit.filter((x) => x.r !== null && x.r >= need);
    if (!ok.length) {
      const soon = fit.map((x) => ({ a: x.a, ms: resetsIn(x.a, now) })).filter((x) => x.ms !== null).sort((p, q) => p.ms! - q.ms!)[0];
      const unknown = fit.filter((x) => x.r === null).map((x) => x.a.name);
      waiting.push({ lane: l.key, title: l.title, company: l.company, until: soon ? new Date(now.getTime() + soon.ms!).toISOString() : null,
        reason: !fit.length ? 'No account may do this work' : soon ? `Full now; ${soon.a.name} refills in ${until(soon.ms!)}` : unknown.length ? `No reading yet for ${unknown.slice(0, 2).join(', ')}` : 'No room left this week' });
      continue;
    }
    const cost = (x: { a: Account; r: number | null }) => {
      let c = x.a.cost === 'metered' ? 30 : 0;
      if (x.a.cost === 'metered' && (l.need === 'T0' || l.need === 'T1')) c -= 35;   // easy work to cheap models
      if (l.account === x.a.key || (x.a.warmLanes ?? []).includes(l.key)) c -= 20;   // keep the warm cache
      const ms = resetsIn(x.a, now); if (ms !== null && ms < 0.75 * HOUR) c -= 10;    // about to refill: use it
      if (x.a.ownCompany === l.company) c -= 5;
      c += (100 - (x.r ?? 0)) / 10;                                                   // spread: do not drain one to 0
      return c;
    };
    const best = ok.sort((p, q) => cost(p) - cost(q) || p.a.key.localeCompare(q.a.key))[0];
    const why: string[] = [`${name.get(l.company) ?? l.company}`, `score ${s}`];
    if (l.urgent) why.push('urgent');
    if (l.account === best.a.key) why.push('already running here');
    if (best.a.cost === 'metered') why.push('paid credit'); else why.push(`${Math.round(best.r!)}% free after reserve`);
    const ms = resetsIn(best.a, now); if (ms !== null) why.push(`refills in ${until(ms)}`);
    placed.push({ lane: l.key, title: l.title, company: l.company, account: best.a.key, accountName: best.a.name, score: s, reason: why.join(' · ') });
    if (best.a.cost !== 'metered') spent.set(best.a.key, (spent.get(best.a.key) ?? 0) + need);
  }
  return { day: zoneDay(zone, now), weights, placed, waiting, blocked: [...blocked.values()] };
}

/** Burn per company per hour for the last 7 days: the sum of each hour's rise in % used across the accounts a company's
 *  work ran on (a rise is counted for the account's own company when the reading does not say). */
export function burn(samples: { account: string; at: string; win: string; usedPct: number | null; company: string | null }[], accounts: Account[], now = new Date()) {
  const own = new Map(accounts.map((a) => [a.key, a.ownCompany ?? null]));
  const start = now.getTime() - 7 * 24 * HOUR;
  const out = new Map<string, number[]>();
  const by = new Map<string, typeof samples>();
  for (const s of samples) if (s.win === '5h' && s.usedPct !== null && Date.parse(s.at) >= start) { const k = s.account; by.set(k, [...(by.get(k) ?? []), s]); }
  for (const [acct, list] of by) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (let i = 1; i < list.length; i++) {
      const rise = Number(list[i].usedPct) - Number(list[i - 1].usedPct);
      if (rise <= 0) continue;
      const company = list[i].company ?? own.get(acct) ?? 'other';
      const hour = Math.min(167, Math.floor((Date.parse(list[i].at) - start) / HOUR));
      const row = out.get(company) ?? Array(168).fill(0); row[hour] += rise; out.set(company, row);
    }
  }
  return [...out.entries()].map(([company, hours]) => ({ company, hours: hours.map((h) => Math.round(h * 10) / 10) }));
}
