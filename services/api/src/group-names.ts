// GROUPS-HUB: read an agency's group name into its parts. EA names client groups
//   "Pod 1 | Pozed Walop City | Mr. Rifob Sipehaki | Dhanori | April 2026 | Lux"
// and, once exported and imported, often without the bars: "pod 1 pozed walop city mr rifob sipehaki dhanori april 2026 lux".
// Both read the same way: pod, project, client (after Mr/Mrs/Miss/Dr…), area, month, segment codes (R residential,
// P/SP plotting, L/Lux luxury, C commercial, M/Mid mid-segment, as on the map) and services written in words
// ("videoshoot only", "cross selling", "pre launch"). Known clients, projects and areas (from Pulse) settle where a
// name without bars splits. Pure: no database, no I/O (tests: test/group-names.test.mjs).

export type Segment = 'residential' | 'plotting' | 'luxury' | 'commercial' | 'mid';
export type Parsed = {
  pod: number | null; project: string | null; client: string | null; honorific: string | null; area: string | null; city: string | null;
  month: string | null; segments: Segment[]; services: string[]; codes: string[]; other: string[]; separated: boolean;
};
export type Known = { clients?: string[]; projects?: string[]; areas?: string[] };

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i;
const YEAR = /^(20\d\d|'?\d\d)$/;
const HONORIFIC = /^(mr|mrs|ms|miss|dr|shri|smt|sau|adv|er)\.?$/i;
const SPLIT = /\s*(?:\||¦|│|\s_\s|_\s|\s_|(?<=\w)_(?=\w)|\s{2,}|\s+-\s+)\s*/;
const CODE: Record<string, Segment | null> = { r: 'residential', residential: 'residential', p: 'plotting', sp: 'plotting', plotting: 'plotting', plots: 'plotting',
  l: 'luxury', lux: 'luxury', luxury: 'luxury', c: 'commercial', commercial: 'commercial', m: 'mid', mid: 'mid' };
const JOINERS = new Set(['+', '&', 'and', ',', '/', '-']);
/** Services written in words, longest first. */
const SERVICES: [RegExp, string][] = [
  [/\bvideo\s*shoot(?:\s+only)?\b/i, 'video_shoot'], [/\bcross\s*sell(?:ing)?\b/i, 'cross_selling'], [/\bpre\s*-?\s*launch\b/i, 'pre_launch'],
  [/\bgeneric\s+ad\b/i, 'generic_ad'], [/\blanding\s+page\b|\bwebsite\b|\bweb\b/i, 'web'], [/\blogos?\b|\bbranding\b/i, 'branding'],
  [/\bgmb\b/i, 'gmb'], [/\bseo\b/i, 'seo'], [/\breels?\b/i, 'reels'], [/\bleads?\b/i, 'leads'], [/\bmarketing\b/i, 'marketing'],
  [/\bperformance\b|\bads\b/i, 'ads'], [/\bphoto\s*shoot\b/i, 'photo_shoot'],
];
export const SERVICE_LABELS: Record<string, string> = { marketing: 'Marketing', reels: 'Reels', leads: 'Leads', ads: 'Ads', video_shoot: 'Video shoot',
  photo_shoot: 'Photo shoot', cross_selling: 'Cross-selling', pre_launch: 'Pre-launch', generic_ad: 'Generic ad', web: 'Website', branding: 'Branding', gmb: 'Google profile', seo: 'SEO' };
/** Cities EA works in besides Pune (an area elsewhere is in Pune unless the name says otherwise). */
const CITIES = ['pune', 'pcmc', 'mumbai', 'navi mumbai', 'thane', 'nagpur', 'nashik', 'indore', 'sangli', 'kolhapur', 'jaysingpur', 'lonavala', 'satara',
  'solapur', 'aurangabad', 'goa', 'bangalore', 'bengaluru', 'hyderabad', 'ahmedabad', 'surat', 'nanded'];
const FILLER = new Set(['project', 'name', 'location', 'group', 'only', 'pvt', 'ltd', 'llp']);

export const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const title = (s: string) => /[A-Z]/.test(s) ? s.trim() : s.trim().replace(/\b([a-z])/g, (c) => c.toUpperCase());
const isCodeTok = (t: string) => fold(t) in CODE || JOINERS.has(t);

/** Does this run of tokens read as segment codes only ("R", "M R", "R + Lux", "l c")? */
function codesOf(tokens: string[]): Segment[] | null {
  const toks = tokens.flatMap((t) => t.split(/([+&,/])/)).map((t) => t.trim()).filter(Boolean);
  if (!toks.length || toks.some((t) => !isCodeTok(t))) return null;
  const out: Segment[] = [];
  for (const t of toks) { const s = CODE[fold(t)]; if (s && !out.includes(s)) out.push(s); }
  return out.length ? out : null;
}

function monthOf(word: string, year?: string): string | null {
  const m = MONTH_WORD.exec(word); if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!year) return null;
  const y = year.replace("'", ''); const yr = y.length === 2 ? 2000 + Number(y) : Number(y);
  return `${yr}-${String(mon).padStart(2, '0')}`;
}

/** The longest known phrase (folded) that starts the token list, in tokens; 0 if none. */
function knownPrefix(tokens: string[], known: Set<string>, max = 4): number {
  for (let n = Math.min(max, tokens.length); n >= 1; n--) if (known.has(fold(tokens.slice(0, n).join(' ')))) return n;
  return 0;
}
function knownSuffix(tokens: string[], known: Set<string>, max = 3): number {
  for (let n = Math.min(max, tokens.length); n >= 1; n--) if (known.has(fold(tokens.slice(tokens.length - n).join(' ')))) return n;
  return 0;
}

export function parseGroupName(raw: string, known: Known = {}, yearHint?: number): Parsed {
  const out: Parsed = { pod: null, project: null, client: null, honorific: null, area: null, city: null, month: null, segments: [], services: [], codes: [], other: [], separated: false };
  let name = (raw ?? '').normalize('NFC').replace(/‎/g, '').trim().replace(/^whatsapp chat (?:with |- ?)/i, '');
  if (!name) return out;
  // Services in words come out first (they may sit anywhere, often after the month).
  for (const [rx, key] of SERVICES) if (rx.test(name)) { if (!out.services.includes(key)) out.services.push(key); name = name.replace(rx, ' '); }
  name = name.replace(/\s+(?:only)\b/i, ' ');
  const clients = new Set((known.clients ?? []).map(fold)), areas = new Set([...(known.areas ?? []), ...CITIES].map(fold));
  const segs = name.split(SPLIT).map((s) => s.trim().replace(/^[.,\-–]+|[.,\-–]+$/g, '')).filter(Boolean);
  out.separated = segs.length > 2;
  // Work on tokens with segment boundaries kept as markers.
  const tokens: string[] = [];
  segs.forEach((s, i) => { if (i) tokens.push('|'); tokens.push(...s.split(/\s+/).filter(Boolean)); });
  // Pod: "pod 1", "pod-2", "pod#1" at the start.
  const podRx = /^pod[-#]?(\d+)?$/i;
  if (tokens.length && podRx.test(tokens[0])) {
    const m = podRx.exec(tokens[0])!; let n = m[1];
    if (!n && /^\d+$/.test(tokens[1] ?? '')) { n = tokens[1]; tokens.splice(1, 1); }
    if (n) { out.pod = Number(n); tokens.splice(0, 1); }
  }
  // Month and year: the last month word followed by a year; everything after it is codes or other words.
  // A month on its own ("Aug | R", "april") takes the year the group started (yearHint).
  let mi = -1, yi = -1;
  for (let i = tokens.length - 1; i >= 1 && mi < 0; i--) {
    if (!MONTH_WORD.test(tokens[i])) continue;
    const j = tokens[i + 1] === '|' ? i + 2 : i + 1;
    if (YEAR.test(tokens[j] ?? '')) { mi = i; yi = j; break; }
    const alone = (tokens[i - 1] === '|' || i === tokens.length - 1 || tokens[i + 1] === '|') && /^[a-z]{3,9}\.?$/i.test(tokens[i]);
    const thenCodes = tokens.slice(i + 1).filter((t) => t !== '|').every((t) => isCodeTok(t) || /^\d$/.test(t));
    if (yearHint && (alone || thenCodes) && i >= 2) { mi = i; yi = i; }
  }
  let tail: string[] = [];
  if (mi >= 0) {
    out.month = yi > mi ? monthOf(tokens[mi], tokens[yi]) : monthOf(tokens[mi], String(yearHint));
    tail = tokens.slice(yi + 1); tokens.splice(mi);
  }
  // Trailing codes after the month, or at the very end without a month ("... dhanori r").
  const tailWords = tail.filter((t) => t !== '|');
  const tailCodes = codesOf(tailWords);
  if (tailCodes) { out.segments.push(...tailCodes); out.codes.push(tailWords.join(' ')); }
  else if (tailWords.length) {
    // "r mid", "r 2", "c 2": codes mixed with a number or a word kept as other
    const codeToks = tailWords.filter((t) => isCodeTok(t)), rest = tailWords.filter((t) => !isCodeTok(t));
    const cs = codesOf(codeToks); if (cs) { out.segments.push(...cs); out.codes.push(codeToks.join(' ')); }
    if (rest.length) out.other.push(rest.join(' '));
  }
  while (tokens.length && tokens[tokens.length - 1] === '|') tokens.pop();
  if (mi < 0) {
    // No month: a short code run at the end still counts ("... dhanori r l").
    let k = tokens.length; while (k > 0 && isCodeTok(tokens[k - 1]) && tokens.length - k < 3) k--;
    if (k < tokens.length && k > 1) { const cs = codesOf(tokens.slice(k)); if (cs) { out.segments.push(...cs); out.codes.push(tokens.slice(k).join(' ')); tokens.splice(k); } }
  }
  const words = tokens.filter((t) => t !== '|');
  // Client: after an honorific. With bars, the client is its whole segment; without, a known client name or two words.
  const hi = tokens.findIndex((t, i) => HONORIFIC.test(t) && i < tokens.length - 1);
  let before: string[] = [], after: string[] = [];
  if (hi >= 0) {
    out.honorific = tokens[hi].replace('.', '').replace(/^./, (c) => c.toUpperCase());
    const rest = tokens.slice(hi + 1);
    let n: number;
    const bar = rest.indexOf('|');
    if (out.separated && bar > 0) n = bar;
    else n = knownPrefix(rest.filter((t) => t !== '|'), clients) || Math.min(2, rest.filter((t) => t !== '|').length);
    const clientWords = rest.filter((t) => t !== '|').slice(0, n);
    out.client = title(clientWords.join(' ').replace(/\s+(sir|ji)$/i, ''));
    before = tokens.slice(0, hi); after = rest.filter((t) => t !== '|').slice(n);
    // "mr rifob sipehaki sir" style: drop a trailing sir/ji left in the area part
    if (/^(sir|ji)$/i.test(after[0] ?? '')) after.shift();
  } else {
    before = tokens;
  }
  const beforeSegs = before.join(' ').split('|').map((s) => s.trim()).filter(Boolean);
  if (hi >= 0) {
    out.project = beforeSegs.length ? title(beforeSegs[0]) : null;
    if (beforeSegs.length > 1) out.other.push(...beforeSegs.slice(1));
    if (after.length) {
      const k = knownSuffix(after, areas);
      out.area = title((k ? after.slice(after.length - k) : after).join(' '));
      if (k && after.length > k) out.other.push(after.slice(0, after.length - k).join(' '));
    }
  } else if (out.separated && beforeSegs.length > 1) {
    out.project = title(beforeSegs[0]); out.area = title(beforeSegs[beforeSegs.length - 1]); out.other.push(...beforeSegs.slice(1, -1));
  } else {
    const ws = before.filter((t) => t !== '|');
    // Without a client: the area is a known place at the end (one or two words), else the last word when the name is long.
    const k = knownSuffix(ws, areas);
    const areaN = k || (ws.length >= 4 && (out.month || out.segments.length) ? 1 : 0);
    out.project = ws.length - areaN > 0 ? title(ws.slice(0, ws.length - areaN).join(' ')) : null;
    out.area = areaN ? title(ws.slice(ws.length - areaN).join(' ')) : null;
  }
  // A known project inside the project part tightens it ("ahefadehaf aduse" when the rest is noise).
  if (out.project && FILLER.has(fold(out.project))) { out.other.push(out.project); out.project = null; }
  if (out.area) {
    const a = fold(out.area);
    const city = CITIES.find((c) => a === c || a.endsWith(' ' + c));
    if (city) { out.city = title(city === 'pcmc' ? 'Pune' : city); if (a === city && city !== 'pcmc') out.area = null; }
  }
  if (!words.length && !out.month) out.project = null;
  return out;
}

/** How alike two names are, 0..1 (word overlap or edit similarity, whichever is higher). */
export function similarity(a: string, b: string): number {
  const x = fold(a), y = fold(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ta = new Set(x.split(' ')), tb = new Set(y.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jac = inter / new Set([...ta, ...tb]).size;
  const contain = (x.includes(y) || y.includes(x)) ? Math.min(x.length, y.length) / Math.max(x.length, y.length) : 0;
  return Math.max(jac, contain * 0.95, dice(x, y));
}
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b); let n = 0;
  for (const [g, c] of ga) n += Math.min(c, gb.get(g) ?? 0);
  return (2 * n) / (a.length - 1 + b.length - 1);
}

/** The best match among candidates, with its score and the runner-up's (to judge whether it is clear). */
export function bestMatch<T>(name: string | null, items: T[], label: (t: T) => string): { item: T; score: number; next: number } | null {
  if (!name) return null;
  let best: T | null = null, score = 0, next = 0;
  for (const it of items) {
    const s = similarity(name, label(it));
    if (s > score) { next = score; score = s; best = it; } else if (s > next) next = s;
  }
  return best ? { item: best, score, next } : null;
}

/** The group's type from its Pulse kind and what its name says. */
export function groupKind(channelKind: string, p: Parsed, name: string): 'client' | 'pod' | 'team' | 'internal' | 'vendor' | 'other' {
  if (channelKind === 'pod') return 'pod';
  if (channelKind === 'team') return 'team';
  if (channelKind === 'group') return 'internal';
  if (/\b(vendor|printer|printing|supplier|freelancer|agency partner|studio partner)\b/i.test(name)) return 'vendor';
  if (p.client || (p.month && (p.project || p.segments.length)) || p.segments.length) return 'client';
  if (p.pod !== null && !p.project) return 'pod';
  return 'internal';
}
