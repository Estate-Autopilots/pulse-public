// GROUPS-2 (owner's standing decision wa-ai-analysis = "redacted", 25 Oct 2026): text bound for an outside AI engine,
// with people, clients, projects, phone numbers, e-mail and postal addresses and other names replaced by stable ids
// ([P12] a person, [C3] a client, [PRJ7] a project, [G1] a group, [PH2] a phone number, [E1] an e-mail address, [A4] an
// address, [N9] another name), and the names put back in the engine's answer. Pure: the ids' numbers and the company's
// own word counts come from the database (migration 1113; groups-hub.ts asks for them). Layers, in order:
//   1. links (only well-known platforms keep their domain), e-mail addresses, UPI ids, @mentions, tax and bank ids,
//      coordinates, phone numbers (Indian mobiles and landlines, any form), other long numbers, postal addresses;
//   2. known names: every person of the company (client contacts and former colleagues too), client, project and
//      imported sender, up to four words, longest first; a single word of a name too, unless it is an ordinary word
//      (then only when written with a capital inside a sentence);
//   3. other names: a word after Mr/Mrs/Dr or before sir/ji/madam/bhai, or after hi/dear/thanks; a capitalised word the
//      company's messages do not use as an ordinary word; a lower-case word that is rare and mostly written with a
//      capital elsewhere; a rare word in another script (Devanagari names have no capitals).
// A word is ordinary when it is common English, Hinglish or Marathi written in Latin letters, a code or platform name,
// a known area or city, or when the company writes it in lower case at least half the time in four chats or more.
import { createHash } from 'node:crypto';
import { CITIES } from './group-names.js';

export type AliasKind = 'person' | 'participant' | 'label' | 'client' | 'project' | 'group' | 'phone' | 'email' | 'address' | 'name';
export type Alias = { prefix: string; kind: AliasKind; digest: string; ref: string | null; value: string | null };
/** A name the redactor knows: a person, an imported sender (participant: its id; label: only its name), a client, a project. */
export type Entity = { kind: 'person' | 'participant' | 'label' | 'client' | 'project'; ref: string | null; name: string; local?: boolean };
/** How the company writes a word: times, chats it appears in, times inside a sentence, of those with a capital. */
export type WordStat = [n: number, chats: number, mid: number, cap: number];
export type Counts = Record<string, number>;

const PREFIX: Record<AliasKind, string> = { person: 'P', participant: 'P', label: 'P', client: 'C', project: 'PRJ', group: 'G', phone: 'PH', email: 'E', address: 'A', name: 'N' };
const RANK: Record<Entity['kind'], number> = { person: 0, participant: 1, client: 2, project: 3, label: 4 };

const words = (s: string) => s.split(/\s+/).filter(Boolean);
const ENGLISH = new Set(words(`a about above after again against all almost alone along already also although always am among an and another any anybody
anyone anything anyway anywhere are around as at away back be became because become been before behind being below beside besides best better between
beyond both but by can cannot could did do does doing done down during each either else enough even ever every everybody everyone everything everywhere
except few for from further get gets getting give given gives go goes going gone got had has have having he her here hers herself him himself his how
however if in inside instead into is it its itself just last least less let like likely many may maybe me might mine more most much must my myself near
need neither never next no nobody none nor not nothing now of off often on once one only onto or other others otherwise our ours ourselves out outside
over own per perhaps please quite rather really same see seem shall she should since so some somebody someone something sometimes somewhere soon still
such than that the their theirs them themselves then there these they this those though through thus till to today together tomorrow too toward towards
under unless until up upon us very via was we well were what whatever when whenever where wherever whether which while who whoever whole whom whose why
will with within without would yes yet yesterday you your yours yourself yourselves
able accept accepted access account action active actual actually add added adding address advance afternoon agency agenda agree agreed ahead aim allow
alright amount answer anytime apply approve approved approval area arrange arrive ask asked asking attach attached available avoid aware bad balance bank
based basic basis begin big bill black blue board body book booked booking bottom box brand break brief bring budget build busy buy call called calling
calls came campaign cancel card care case cash cause center centre change changed changes channel charge charges chat check checked checking choose city
clear click client clients close closed code cold colour color come comes coming comment comments common company complete completed confirm confirmed
confirmation connect contact content continue copy correct cost could count country course cover create created creative creatives current customer cut
daily data date day days deal dear decide decided delay deliver delivered delivery design details develop different direct discuss discussed discussion
document documents door double draft drive due early easy edit edited edits email end enquiry error evening event exact example excellent expect
experience extra face fact fair fast feedback feel field file files fill final finalize finalise finalized finalised fine finish first fix fixed floor
follow following font form format forward free fresh front full fund funds future gallery general glad good great green group guide half hand happy hard
head hear held hello help high hold home hope hot hour hours house idea image images important include included increase info information interest
interested issue issues item join keep key kind kindly know known large late later latest launch lead leads learn leave left letter level life light
line link list little live local location logo long look looking looks lot low made main make making manage manager mark market marketing matter mean
meet meeting member members mention message messages method middle mind minute minutes miss missing mode model money month months morning move music
name names needed needs new news nice night normal note notes notice number numbers offer office okay old online open option options order original page
paid part party pass past pay payment pending people person phone photo photos pick piece place plan plans play plus point post posted posts price
print problem process product profile project projects proper property provide public put quality question questions quick quickly rate reach read ready
real reason receive received recent record red reel reels regarding regards related release remember reminder remove reply report request required
response rest result results review revert revised right room round run sale sales sample save say schedule school screen script second section seen
select send sending sent series service services set share shared sheet shift shoot shooting short show side sign simple single site size small social
sorry sound space special start started status stay step stop story strong style submit success suggest suggestion summary support sure system table
take taken talk target task tasks team text thank thanks thing things think thought time times title told took top total touch track training transfer
true try trying turn type understand unit update updated updates upload urgent use used user using value version video videos view visit voice wait
waiting want wanted watch water way website week weekly weeks welcome went white win window wise wish word work worked working works world write written
wrong year years yellow young
ad ads adset adsets advertising amenities amenity analytics apartment apartments artwork audience audiences banner banners bhk brochure brochures builder
builders bungalow buyer buyers campaigns caption captions carousel clubhouse commercial conversion conversions copywriting creative dashboard deck developer
developers daruhis drone duplex editing engagement enquiries flat flats flyer footage forms funnel hoarding hoardings impressions influencer influencers
inventory invoice invoices landing layout leaflet listing listings luxury mailer metrics microsite mockup mockups offers organic pamphlet penthouse plot
plots plotting possession poster posters prelaunch presentation pricing promo promotion quotation quotations relaunch residential retargeting revenue
samples scripts shoots sitevisit sqft standee storyboard storyboards template templates testimonial testimonials thumbnail thumbnails tower towers township
units villa villas walkthrough blueprint briefing persona personas phase wing carpet boost boosted spend spends monthly reports
park garden gardens hill hobod valley heights greens meadows residences enclave county nest square avenue plaza court springs woods vista grand royal
elite prime palm palms lake river sky skyline crown pearl sunrise sunset gold golden silver star stars height east west north south central
hook hooks headline headlines variant variants concept concepts angle angles received generated marathi hindi english gujarati apologies
facebook instagram google meta whatsapp youtube canva excel gmail drive zoom teams linkedin pinterest twitter iphone android pulse
january february march april june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec
monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun`));
/** Hinglish and Marathi in Latin letters, forms of address and chat words: ordinary, never names on their own. */
const KEEP = new Set(words(`aaj kal parso abhi abi jaldi jldi haan han haa nahi nahin nai hai hain ho hoga hogi hoyega kar karo karna karenge kardo
kardena kijiye dijiye bhej bhejo bhejna bhejdo bhejiye dekh dekho dekhna dekhiye bata batao bataiye bolo bol boliye theek thik thike achha acha accha sahi
bas bhi aur lekin kya kyu kyun kab kaise kitna kitne kaun koi kuch sab chalega chalo ruko mera meri mere tera teri apka aapka aap tum hum ham humko mujhe
muze unko usko yeh woh idhar udhar yaha yahan waha wahan pehle pahle baad tak mein wala wali wale ahe aahe ahet naahi kay kaay zala jhala zhala kara
pahije amhi tumhi mala tula kele kel karto karte sangto sanga dya ghya hoil kadun madhe madhye ani pan ata atta udya parva lagel jaiel yeil bagha baghu
sir madam mam maam ji bhai sahab saheb saab tai dada bhau didi sirji namaste namaskar dhanyavad shukriya thanku thankyou plz pls okk okie hmm hmmm yaa
yeah yup nope pod lux mid`));
/** Codes and abbreviations written in capitals: never names. */
const ACRONYMS = new Set(words(`rera bhk cpl cpa cpm ctr gst cta usp pdf otp upi neft rtgs imps emi crm seo sem smm vov pov cgi ppt jpg png mp4 nri
sqft eod asap fyi tds kyc pan gstin ifsc roi kpi ist utc pcmc pmc pmrda mahrera`));
/** Words of a company's or a person's name that say nothing on their own (and forms of address). */
const STOP = new Set(words(`pvt ltd llp private limited developers developer builders builder realty realtors realtor group infra infrastructure
constructions construction properties property estates estate homes associates enterprises enterprise india ventures corporation corp company and the of
sir madam mam ji bhai team autopilots mr mrs ms miss dr shri smt client contact number ending unknown new old official office admin support sales
marketing accounts`));
const HONORIFIC = /^(mr|mrs|ms|miss|dr|shri|smt|sau|adv|er)\.?\s+/i;
const PLATFORMS = /(^|\.)(google\.com|goo\.gl|facebook\.com|fb\.com|fb\.me|instagram\.com|youtube\.com|youtu\.be|canva\.com|linkedin\.com|meta\.com|bit\.ly|zoom\.us|dropbox\.com|wetransfer\.com|we\.tl|onedrive\.live\.com|sharepoint\.com|figma\.com|pinterest\.com|twitter\.com|x\.com|apple\.com|whatsapp\.com|maharera\.mahaonline\.gov\.in|maharera\.maharashtra\.gov\.in)$/i;

export const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}']+/gu, ' ').replace(/(^| )'+|'+( |$)/g, ' ').trim();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const WORD = /[\p{L}][\p{L}\p{M}']*/gu;
const LATIN = /^[A-Za-z']+$/;
/** Words a text holds, lower case, for asking the database how the company writes them. */
export function wordsOf(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? '').matchAll(WORD)) { const w = m[0].toLowerCase().replace(/'s$/, ''); if (w.length >= 2 && w.length <= 40) out.add(w); }
  return [...out];
}

// Placeholders while redacting: private-use characters no later layer matches (not letters, not digits).
const OPEN = '', CLOSE = '';
const SLOT = /([-]+)/g;
const enc = (i: number) => OPEN + [...String(i)].map((d) => String.fromCharCode(0xE010 + Number(d))).join('') + CLOSE;
const dec = (s: string) => Number([...s].map((ch) => ch.charCodeAt(0) - 0xE010).join(''));

const URL = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const UPI = /(?<![\p{L}\p{N}])[\p{L}\p{N}.\-_]{2,}@[a-z][a-z0-9]{1,}(?![\p{L}\p{N}])/giu;
const AT_PHONE = /@\+?(\d{7,15})(?!\d)/g;
const AT_NAME = /@~?\s?([\p{L}][\p{L}\p{M}\p{N}_.']*)/gu;
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const IFSC = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
const COORDS = /-?\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g;
const DIGITS = /(?<![\p{L}\p{N}])(?:\+|00)?\d[\d \-(). ]{5,22}\d(?![\p{L}\p{N}])/gu;
const GLUED = /[\p{L}\p{N}_\-\/]*(?:\p{L}[\p{L}_\-\/]*\d{9,}|\d{9,}[\p{L}_\-\/]+)[\p{L}\p{N}_\-\/]*/gu;
const PHONE_CUE =/(?:ph|phone|mob|mobile|tel|call|contact|whatsapp|wa|no|number)\.?\s*[:\-]?\s*$/i;
const ADDR_WORD = /(?<![\p{L}])(road|rd|lane|marg|path|chowk|nagar|colony|society|soc|apartments?|apt|residency|heights|building|bldg|complex|wing|floor|sector|plaza|enclave|village|taluka|tal|dist|district|galli|gully|peth|wadi|wada|hsg|chs|bungalow|row ?house|opp|opposite)(?![\p{L}])/iu;
const UNIT = /(?<![\p{L}])(?:flat|plot|office|shop|unit|house|bungalow|villa|row\s?house|survey|s\.?\s?no|sr\.?\s?no|gat|cts|h\.?\s?no|door|room)(?![\p{L}])\.?\s*(?:no\.?|number|#)?\s*[:\-]?\s*(?:[A-Za-z]\s?[\-\/]?\s?)?\d[\w\/\-]*/iu;
const PIN = /(?<!\d)[1-8]\d{2}\s?\d{3}(?!\d)/;
const MONEY = /(?<![\p{L}])(lakh|lakhs|lac|lacs|cr|crore|crores|rs|inr|sq\.?\s?ft|sqft|bhk|budget|price|cost|amount|per)(?![\p{L}])|₹|%/iu;
const AFTER_HONORIFIC = /(?<![\p{L}])(mr|mrs|ms|miss|dr|shri|smt|sau)(\.?\s+)([\p{L}][\p{L}\p{M}']*)/giu;
const BEFORE_HONORIFIC = /(?<![\p{L}\p{M}])([\p{L}][\p{L}\p{M}']*)(\s+)(?=(?:sir|ji|madam|mam|ma'am|maam|bhai|sahab|saheb|saab|tai|dada|bhau|didi|sirji)(?![\p{L}]))/giu;
const AFTER_GREETING = /(?<![\p{L}])(hi|hello|hey|dear|thanks|thank you|thanku|cc|attn)(\s+)([\p{L}][\p{L}\p{M}']*)/giu;
const TOKEN = /\[(PRJ|PH|P|C|G|E|A|N)(\d{1,6})\]/g;

type Slot = { digest: string } | { literal: string };

export class Redactor {
  /** What was replaced, by kind (counts only). */
  readonly counts: Counts = {};
  private slots: Slot[] = [];
  private aliases = new Map<string, Alias>();
  private full = new Map<string, Entity[]>();
  private parts = new Map<string, Entity[]>();
  private vocab: Map<string, WordStat>;
  private places: Set<string>;
  private longest = 1;

  constructor(entities: Entity[], opts: { vocab?: Record<string, WordStat> | Map<string, WordStat>; places?: string[] } = {}) {
    this.vocab = opts.vocab instanceof Map ? opts.vocab : new Map(Object.entries(opts.vocab ?? {}));
    this.places = new Set((opts.places ?? []).flatMap((p) => [fold(p), ...fold(p).split(' ')]).filter((p) => p.length >= 3));
    const people = new Set(entities.filter((e) => e.kind === 'person').map((e) => fold(e.name.replace(HONORIFIC, ''))));
    for (const e of entities) {
      const f = fold((e.name ?? '').replace(HONORIFIC, ''));
      if (f.length < 3 || /^number ending\b/.test(f) || /^[\d ]+$/.test(f)) continue;
      if (e.kind === 'label' && people.has(f)) continue; // an imported sender already mapped to that person
      const toks = f.split(' ').filter((t) => !/^(mr|mrs|ms|miss|dr|shri|smt)$/.test(t));
      if (toks.length > 1) { this.push(this.full, toks.join(' '), e); this.longest = Math.max(this.longest, Math.min(toks.length, 5)); }
      for (const t of toks) {
        if (t.length < 3 || /^\d+$/.test(t) || STOP.has(t)) continue;
        // A client's or a project's ordinary words ("green", "park") are not names on their own.
        if ((e.kind === 'client' || e.kind === 'project') && this.ordinary(t)) continue;
        this.push(this.parts, t, e);
      }
    }
  }

  private push(m: Map<string, Entity[]>, k: string, e: Entity) { const l = m.get(k); if (!l) m.set(k, [e]); else if (!l.some((x) => x.kind === e.kind && x.ref === e.ref && x.name === e.name)) l.push(e); }
  private count(k: string) { this.counts[k] = (this.counts[k] ?? 0) + 1; }
  /** Common language, codes, forms of address and known places (the fixed lists, whatever the company writes). */
  private common(w: string): boolean { return ENGLISH.has(w) || KEEP.has(w) || ACRONYMS.has(w) || STOP.has(w) || this.places.has(w); }
  /** Ordinary words stay (common language, codes, places, or what the company writes in lower case). */
  ordinary(w: string): boolean {
    if (this.common(w)) return true;
    const s = this.vocab.get(w);
    if (!s || s[1] < 4) return false;
    // Written in lower case inside sentences at least half the time; a word that mostly opens sentences ("Apologies")
    // when it is in six chats or more.
    return s[2] >= 3 ? (s[2] - s[3]) / s[2] >= 0.5 : s[1] >= 6;
  }

  private slot(s: Slot) { this.slots.push(s); return enc(this.slots.length - 1); }
  private literal(text: string, kind: string) { this.count(kind); return this.slot({ literal: text }); }
  private alias(kind: AliasKind, key: string, ref: string | null, value: string | null) {
    const digest = sha(`${kind}:${key}`);
    if (!this.aliases.has(digest)) this.aliases.set(digest, { prefix: PREFIX[kind], kind, digest, ref, value: value === null ? null : value.slice(0, 300) });
    this.count(kind === 'participant' || kind === 'label' ? 'person' : kind);
    return this.slot({ digest });
  }
  /** The id of someone or something known by its Pulse id (a person, client, project, group, imported sender). */
  ref(kind: 'person' | 'participant' | 'client' | 'project' | 'group', id: string) { return this.alias(kind, id, id, null); }
  /** The id of an imported sender known only by the name the export gave. */
  label(name: string) { return this.alias('label', fold(name), null, name); }
  private entity(e: Entity) { return e.kind === 'label' || !e.ref ? this.label(e.name) : this.ref(e.kind as 'person', e.ref); }
  private name(word: string) { return this.alias('name', fold(word), null, word); }

  /** The text with every layer applied (placeholders until finish()). */
  text(input: string | null | undefined): string {
    let t = String(input ?? '');
    if (!t.trim()) return t;
    t = t.replace(URL, (u) => {
      const host = u.replace(/^https?:\/\//i, '').split(/[/?#:]/)[0].toLowerCase().replace(/^www\./, '');
      if (/(^|\.)maps\.|goo\.gl\/maps|maps\.app\.goo\.gl|\/maps\b/i.test(u)) return this.literal('[map link]', 'link');
      return this.literal(PLATFORMS.test(host) ? `[link ${host}]` : '[link]', 'link');
    });
    t = t.replace(EMAIL, (e) => this.alias('email', e.toLowerCase(), null, e));
    t = t.replace(UPI, () => this.literal('[UPI id]', 'id'));
    t = t.replace(AT_PHONE, (_, d: string) => '@' + (this.phone(d) ?? this.literal('[number]', 'number')));
    t = t.replace(GSTIN, () => this.literal('[ID]', 'id')).replace(PAN, () => this.literal('[ID]', 'id')).replace(IFSC, () => this.literal('[ID]', 'id'));
    t = t.replace(COORDS, () => this.literal('[location]', 'address'));
    // Dates and times inside a run of digits stay ("2026-10-25 10:30", "12.10.2026"); so do ranges ("50000 - 60000").
    t = t.replace(DIGITS, (m, at: number, all: string) => m.split(/(\b\d{4}[-.]\d{1,2}[-.]\d{1,2}\b|\b\d{1,2}[-.]\d{1,2}[-.]\d{2,4}\b|\s+[-–]\s+)/)
      .map((part, i) => i % 2 ? part : this.number(part, all.slice(Math.max(0, at - 24), at))).join(''));
    // Long digit runs glued to letters (booking, order, transaction and account ids; a number with a letter in front).
    t = t.replace(GLUED, (m) => { const tail = m.replace(/\D/g, '').slice(-12); return (tail.length >= 10 ? this.phone(tail.slice(-10)) : null) ?? this.literal('[ID]', 'id'); });
    t = t.split('\n').map((line) => this.addresses(line)).join('\n');
    t = t.replace(AT_NAME, (m, w: string) => { const e = this.lookup(fold(w)); return e ? '@' + this.entity(e) : this.ordinary(w.toLowerCase()) ? m : '@' + this.name(w); });
    t = this.known(t);
    t = t.replace(AFTER_HONORIFIC, (m, h: string, sp: string, w: string) => this.ordinary(w.toLowerCase()) ? m : h + sp + this.name(w));
    t = t.replace(BEFORE_HONORIFIC, (m, w: string, sp: string) => this.ordinary(w.toLowerCase().replace(/'s$/, '')) || w.length < 3 ? m : this.name(w) + sp);
    t = t.replace(AFTER_GREETING, (m, g: string, sp: string, w: string) => this.ordinary(w.toLowerCase().replace(/'s$/, '')) || w.length < 3 ? m : g + sp + this.name(w));
    return t.replace(WORD, (w) => this.unknown(w));
  }

  /** A phone number's id, or null when the digits are not a phone number. */
  private phone(raw: string): string | null {
    const d = raw.replace(/\D/g, '');
    const mobile = d.match(/^(?:0{0,2}91|0)?([6-9]\d{9})$/);
    if (mobile) return this.alias('phone', mobile[1], null, mobile[1].slice(-4));
    // A landline with its area code (020 2567 8901, +91 20 2567 8901); ten bare digits from 1–5 are not a number to call.
    const land = d.match(/^(?:0{0,2}91|0)([1-9]\d{9})$/);
    if (land) return this.alias('phone', land[1], null, land[1].slice(-4));
    return null;
  }
  private number(part: string, before: string): string {
    const d = part.replace(/\D/g, '');
    if (d.length < 6) return part;
    const lead = part.match(/^[\s(]*/)?.[0] ?? '', trail = part.match(/[\s)]*$/)?.[0] ?? '';
    const core = part.slice(lead.length, part.length - trail.length);
    const p = d.length >= 10 ? this.phone(core) : null;
    if (p) return lead + p + trail;
    if (d.length >= 9) return lead + this.literal('[number]', 'number') + trail;
    if (PHONE_CUE.test(before) && d.length >= 6 && d.length <= 8 && !/^\d{6}$/.test(core.trim())) return lead + this.alias('phone', d, null, d.slice(-4)) + trail;
    return part;
  }

  /** Postal addresses in a line: from a flat/plot/office number, back from a PIN code, or three address-like parts. */
  private addresses(line: string): string {
    if (!line || !(UNIT.test(line) || PIN.test(line) || ADDR_WORD.test(line))) return line;
    const segs: { s: string; at: number }[] = [];
    let at = 0;
    for (const s of line.split(',')) { segs.push({ s, at }); at += s.length + 1; }
    const cityOrArea = (s: string) => fold(s).split(' ').some((w) => this.places.has(w) || /^(pune|mumbai|maharashtra|india|thane)$/.test(w));
    const pinIn = (s: string, i: number) => PIN.test(s) && (/\bpin(?:\s?code)?\b/i.test(s) || cityOrArea(s) || ADDR_WORD.test(s) || UNIT.test(s) || (i > 0 && (ADDR_WORD.test(segs[i - 1].s) || cityOrArea(segs[i - 1].s) || UNIT.test(segs[i - 1].s))));
    const looks = (s: string) => s.trim().length > 0 && s.trim().length <= 48 && !MONEY.test(s)
      && (ADDR_WORD.test(s) || UNIT.test(s) || PIN.test(s) || cityOrArea(s) || (/\d/.test(s) && words(s).length <= 3) || /^\s*(?:\p{Lu}[\p{L}\p{M}'.]*\s*){1,4}$/u.test(s));
    const spans: [number, number][] = [];
    for (let i = 0; i < segs.length; i++) {
      const unit = segs[i].s.match(UNIT), pin = pinIn(segs[i].s, i);
      if (!unit && !pin && !ADDR_WORD.test(segs[i].s)) continue;
      // Back over address-like parts before it, forward over the ones after it.
      let a = i, b = i;
      if (!unit) while (a > 0 && looks(segs[a - 1].s) && i - a < 4) a--;
      while (b + 1 < segs.length && !PIN.test(segs[b].s) && looks(segs[b + 1].s) && b - i < 5) b++;
      const parts = segs.slice(a, b + 1);
      const strong = parts.filter((p) => ADDR_WORD.test(p.s) || cityOrArea(p.s)).length;
      if (!unit && !parts.some((p, k) => pinIn(p.s, a + k)) && !(parts.length >= 3 && strong >= 2)) continue;
      let start = segs[a].at + (unit && a === i ? unit.index ?? 0 : (segs[a].s.match(/^\s*/)?.[0].length ?? 0));
      if (!unit && a === i) { const cap = segs[i].s.match(/(?:\p{Lu}[\p{L}\p{M}'.]*\s+)*\p{Lu}?[\p{L}\p{M}'.]*\s*$/u); if (cap && ADDR_WORD.test(cap[0])) start = segs[i].at + (cap.index ?? 0); }
      const last = segs[b];
      const pm = last.s.match(/(?<!\d)[1-8]\d{2}\s?\d{3}(?!\d)/);
      const end = pm && pm.index !== undefined ? last.at + pm.index + pm[0].length : last.at + last.s.replace(/\s+$/, '').length;
      if (end > start) spans.push([start, end]);
      i = b;
    }
    let out = line;
    for (const [s, e] of spans.reverse()) {
      const addr = out.slice(s, e);
      if (!addr.replace(SLOT, '').trim()) continue;
      out = out.slice(0, s) + this.alias('address', fold(addr.replace(SLOT, ' ')), null, addr.replace(SLOT, '').trim()) + out.slice(e);
    }
    return out;
  }

  private lookup(key: string): Entity | null {
    const whole = this.full.get(key);
    if (whole) return this.pick(whole, true);
    const part = this.parts.get(key);
    return part ? this.pick(part, false) : null;
  }
  private pick(es: Entity[], whole: boolean): Entity | null {
    const uniq = es.filter((e, i) => es.findIndex((x) => x.kind === e.kind && x.ref === e.ref && fold(x.name) === fold(e.name)) === i);
    const local = uniq.filter((e) => e.local);
    if (whole) return [...(local.length ? local : uniq)].sort((a, b) => RANK[a.kind] - RANK[b.kind])[0] ?? null;
    if (local.length === 1) return local[0];
    if (uniq.length === 1) return uniq[0];
    return null;
  }

  /** Known names: up to four words of a person, client, project or sender, or one word of a name. */
  private known(t: string): string {
    const toks = [...t.matchAll(WORD)].map((m) => ({ w: m[0], at: m.index ?? 0 }));
    const out: string[] = [];
    let pos = 0;
    for (let i = 0; i < toks.length; i++) {
      let done = false;
      for (let n = Math.min(this.longest, toks.length - i); n >= 1 && !done; n--) {
        let ok = true;
        for (let k = i + 1; k < i + n; k++) if (!/^[\s._\-]+$/.test(t.slice(toks[k - 1].at + toks[k - 1].w.length, toks[k].at))) { ok = false; break; }
        if (!ok) continue;
        const span = toks.slice(i, i + n);
        const key = span.map((x) => x.w.toLowerCase()).join(' ').replace(/'s$/, '');
        const keyF = fold(key);
        let e: Entity | null = null, generic = false;
        if (this.full.has(keyF)) {
          // A name made only of common words ("Green Park") when it is written as a name.
          if (keyF.split(' ').every((x) => this.common(x)) && !span.every((x) => /^\p{Lu}/u.test(x.w))) continue;
          e = this.pick(this.full.get(keyF)!, true);
        } else if (n === 1 && this.parts.has(keyF)) {
          const w = span[0].w;
          // A name that is also a common word ("Will", "Hope") only when capitalised inside a sentence. A colleague's
          // name the company types in lower case everywhere is still a name (the fixed lists decide, not the counts).
          const weak = this.common(keyF);
          const prev = t.slice(0, span[0].at).replace(/[\s-]+$/, '');
          const sentenceStart = !prev || /[.!?:\n]$/.test(prev);
          if (weak && !(/^\p{Lu}\p{Ll}/u.test(w) && !sentenceStart)) continue;
          e = this.pick(this.parts.get(keyF)!, false); generic = !e;
        } else continue;
        const end = span[n - 1].at + span[n - 1].w.length;
        const tail = /'s$/i.test(span[n - 1].w) ? t.slice(end - 2, end) : '';
        out.push(t.slice(pos, span[0].at), (generic ? this.name(span.map((x) => x.w.replace(/'s$/i, '')).join(' ')) : this.entity(e!)) + tail);
        pos = end; i += n - 1; done = true;
      }
    }
    out.push(t.slice(pos));
    return out.join('');
  }

  /** Words left after the known names: other names by how they are written and how the company uses them. */
  private unknown(w: string): string {
    const lw = w.toLowerCase().replace(/'s$/, '');
    if (!LATIN.test(w)) {
      // Another script (no capitals): a word the company uses in fewer than three chats is taken for a name.
      const s = this.vocab.get(lw);
      if (s && s[1] >= 3) return w;
      return this.name(w);
    }
    if (lw.length < 3 || this.ordinary(lw)) return w;
    if (/^\p{Lu}/u.test(w)) {
      if (w.length <= 3 && w === w.toUpperCase()) return w; // a short code
      return this.name(w);
    }
    // A lower-case word that is rare and mostly capitalised inside sentences elsewhere: a name typed in lower case.
    const s = this.vocab.get(lw);
    if (s && s[1] <= 3 && s[2] >= 1 && s[3] / s[2] >= 0.5) return this.name(w);
    return w;
  }

  /** The aliases this redactor needs numbers for (to ask pulse.ai_alias_get). */
  pending(): Alias[] { return [...this.aliases.values()]; }
  /** Placeholders → ids ("[P3]"), with the numbers the database gave ({digest: "P3"}). */
  finish(text: string, ids: Record<string, string>): string {
    return text.replace(SLOT, (_, s: string) => {
      const slot = this.slots[dec(s)];
      if (!slot) return '[redacted]';
      if ('literal' in slot) return slot.literal;
      const id = ids[slot.digest];
      return id ? `[${id}]` : '[redacted]';
    });
  }
  /** Every id the finished text uses. */
  tokens(ids: Record<string, string>): string[] { return [...new Set([...this.aliases.keys()].map((d) => ids[d]).filter(Boolean))].sort(); }
}

/** Placeholders → ids in every string of a value (objects and arrays too). */
export function finishAll<T>(r: Redactor, value: T, ids: Record<string, string>): T {
  if (typeof value === 'string') return r.finish(value, ids) as T;
  if (Array.isArray(value)) return value.map((v) => finishAll(r, v, ids)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, finishAll(r, v, ids)])) as T;
  return value;
}

/** Names back in an engine's answer: every "[P3]" the job's prompt used becomes what it stands for. */
export function rehydrate<T>(value: T, map: Record<string, string>): T {
  if (typeof value === 'string') return value.replace(TOKEN, (m, p: string, n: string) => map[p + n] ?? m) as T;
  if (Array.isArray(value)) return value.map((v) => rehydrate(v, map)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rehydrate(v, map)])) as T;
  return value;
}

/** What pulse.ai_redaction_names(group) gives (1113). */
export type Names = { people: [string, string, string, boolean][]; clients: [string, string, string | null][]; projects: [string, string, string | null][];
  participants: [string, string, string | null, string][]; labels: string[]; group: { client?: string | null; project?: string | null } | null; places: string[] };
/** The names and places the redactor knows for one group: its own people, client, project and senders count as local. */
export function knownNames(n: Names, g: { clientId?: string | null; projectId?: string | null }): { entities: Entity[]; places: string[] } {
  const mapped = new Set(n.participants.filter((p) => p[2]).map((p) => p[2] as string));
  const entities: Entity[] = [
    ...n.people.map(([ref, name, , member]) => ({ kind: 'person' as const, ref, name, local: member || mapped.has(ref) })),
    ...n.clients.flatMap(([ref, name, company]) => [name, ...(company && company !== name ? [company] : [])].map((x) => ({ kind: 'client' as const, ref, name: x, local: ref === g.clientId }))),
    ...n.projects.map(([ref, name]) => ({ kind: 'project' as const, ref, name, local: ref === g.projectId })),
    ...n.participants.filter((p) => !p[2] && !['number', 'unknown'].includes(p[3])).map(([ref, name]) => ({ kind: 'participant' as const, ref, name, local: true })),
    ...n.labels.map((name) => ({ kind: 'label' as const, ref: null, name })),
    ...[n.group?.client, n.group?.project].filter((x): x is string => typeof x === 'string' && !!x).map((name) => ({ kind: 'label' as const, ref: null, name, local: true })),
  ];
  const places = [...CITIES, ...n.places, ...n.projects.map((p) => (p[2] ?? '').split(',')[0].trim()).filter((x) => x && x.length <= 30)];
  return { entities, places };
}
/** A word on the redactor's fixed lists (common language, codes, forms of address): the leak check skips these. */
export function commonWord(w: string): boolean { return ENGLISH.has(w) || KEEP.has(w) || ACRONYMS.has(w) || STOP.has(w); }

/** In-memory numbers for tests and the leak check (the database gives the real, stable ones). */
export function localIds(aliases: Alias[], start: Record<string, number> = {}): Record<string, string> {
  const next = { ...start }, out: Record<string, string> = {};
  for (const a of aliases) { next[a.prefix] = (next[a.prefix] ?? 0) + 1; out[a.digest] = `${a.prefix}${next[a.prefix]}`; }
  return out;
}
