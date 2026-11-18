// BHARATA-2 (16 Nov 2026, owner: "Bharata works every time, by text and voice, at low token cost"): a quotation asked in
// words, matched on the server. The AI employee used to make 4 to 6 model rounds per quotation (find the client, search
// the catalogue word by word, list drafts, create, submit), about 95k tokens; WL-QUOTE-LIVE's suite also saw misheard
// voice notes ("1.5 kW" for "five kilowatt", "Desideri" for Desai Dairy) turn into wrong drafts. Here the request's items,
// said in short words ("5 kW system", "10-year warranty", "ACDB", "transport"), are matched against the company's own
// catalogue: numbers (digits, or number words in English, Hindi and Marathi) are sizes, a size must match, an accessory
// ("ACDB for <product> 5.0") is only picked when its own words are said, and a size left out is taken from the
// quotation's main product. Nothing is guessed: no fitting item, two that fit equally or a size the catalogue does not
// have is a question back, in the asker's language. Pure functions (unit-tested in test/quote-words.test.mjs).

export type CatItem = { id: string; code: string | null; name: string; description?: string | null; kind?: string | null; price: number; gstRate: number };
export type Pick =
  | { kind: 'item'; item: CatItem; score: number; viaContext: boolean; heardAs?: { said: number; count: number; size: number } }
  | { kind: 'ambiguous'; choices: CatItem[] }
  | { kind: 'size-missing'; size: number; choices: CatItem[] }
  | { kind: 'none' };

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100,
  // Hindi
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पाँच': 5, 'पांच': 5, 'छह': 6, 'छः': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10, 'ग्यारह': 11, 'बारह': 12, 'तेरह': 13,
  'चौदह': 14, 'पंद्रह': 15, 'पन्द्रह': 15, 'बीस': 20, 'पच्चीस': 25, 'तीस': 30, 'पचास': 50, 'साठ': 60, 'सौ': 100,
  // Marathi
  'दोन': 2, 'पाच': 5, 'सहा': 6, 'नऊ': 9, 'दहा': 10, 'अकरा': 11, 'बारा': 12, 'तेरा': 13, 'चौदा': 14, 'पंधरा': 15, 'वीस': 20, 'पंचवीस': 25, 'पन्नास': 50, 'शंभर': 100,
};
/** Romanised Hindi/Marathi numbers, only right before a unit ("paanch kilowatt"): alone, "do" is an English word. */
const LATIN_NUMBERS: Record<string, number> = { ek: 1, do: 2, don: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, pach: 5, chhe: 6, saat: 7, aath: 8, nau: 9,
  das: 10, dus: 10, daha: 10, gyarah: 11, barah: 12, baarah: 12, bara: 12, pandrah: 15, pandhra: 15, bees: 20, vees: 20, tees: 30, pachas: 50 };
const DEV_DIGITS = '०१२३४५६७८९';

// Words said in Hindi or Marathi (or spelled several ways) as the one English word catalogues use.
const SAME: [RegExp, string][] = [
  [/किलो\s*वाट|किलोवाट|किलोवॅट|किलोवेट|किलो\s*वॅट|\bkilo\s*watts?\b|\bkilowatts?\b|\bkwp\b|\bk\.w\.?(?=\s|$)/giu, ' kw '],
  [/वारंटी|वॉरंटी|वारण्टी|वॉरन्टी|\bwarrant(?:y|ee|ies)\b|\bguarantee\b/giu, ' warranty '],
  [/सिस्टम|सिस्टिम|\bsystems\b/giu, ' system '],
  [/सोलर/giu, ' solar '],
  [/इंस्टॉलेशन|इन्स्टॉलेशन|इंस्टालेशन|इन्स्टालेशन|फिटिंग|\binstall(?:ation|ing|ed)?s?\b/giu, ' installation '],
  [/ट्रांसपोर्ट|ट्रान्सपोर्ट|वाहतूक|डिलीवरी|डिलिव्हरी|\btransportation\b|\bfreight\b/giu, ' transport '],
  [/डोंगल/giu, ' dongle '],
  [/लाइट|लाईट/giu, ' lite '],
  [/वर्षांच्या|वर्षांची|वर्षांचा|वर्षे|वर्षों|वर्ष|साल|\byears\b|\byrs?\b|\bsaal\b/giu, ' year '],
  [/प्रतिशत|टक्के|\bpercent\b|\bper cent\b/giu, ' % '],
];
/** Words that say little about which item: they add a little when they match and cost nothing when they do not. */
const GENERIC = new Set(['kw', 'system', 'solar', 'set', 'unit', 'units', 'nos', 'no', 'piece', 'pieces', 'pcs', 'plant', 'rooftop', 'roof', 'top', 'grid', 'ongrid', 'home',
  'kit', 'complete', 'new', 'model', 'size', 'type', 'capacity', 'product', 'item', 'extra', 'addon', 'add', 'line', 'charge', 'charges', 'year', 'standard', 'normal', 'basic',
  'total', 'full', 'whole', 'main', 'qty', 'quantity', 'only', 'also', 'one']);
const STOP = new Set(['for', 'with', 'of', 'and', 'the', 'a', 'an', 'per', 'each', 'to', 'in', 'on', 'at', 'by', 'its', 'it', 'or', 'plus', 'x', 'ke', 'ki', 'ka', 'liye',
  'saathi', 'sathi', 'aur', 'ani', 'और', 'के', 'की', 'का', 'लिए', 'साठी', 'सह', 'सोबत', 'साथ', 'आणि', 'वाला', 'वाली', 'वाले', 'चा', 'ची', 'चे', '%', '&']);

const DEV = /[\u0900-\u097f]/;
const isNum = (t: string) => /^\d+(?:\.\d+)?$/.test(t);

/** The words lowercased, Devanagari digits and number words as digits, the same thing said one way. */
export function normWords(s: string): string {
  let t = String(s ?? '').normalize('NFC').toLowerCase();
  t = t.replace(/[०-९]/g, (d) => String(DEV_DIGITS.indexOf(d))).replace(/(\d),(?=\d)/g, '$1');
  for (const [re, to] of SAME) t = t.replace(re, to);
  // "10-year", "5kw", "(+7 years)": numbers apart from their units.
  t = t.replace(/(\d)(?=[a-z\u0900-\u097f])/g, '$1 ').replace(/[(),;:+/"“”'!?।]+/g, ' ').replace(/(\d)-(?=\D)|(?<=\D)-(?=\d)/g, '$1 ').replace(/\s+-\s+|\s+-|-\s+/g, ' ');
  const words = t.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (NUMBER_WORDS[w] !== undefined) words[i] = String(NUMBER_WORDS[w]);
    else if (LATIN_NUMBERS[w] !== undefined && /^(kw|kilo|year|%)$/.test(words[i + 1] ?? '')) words[i] = String(LATIN_NUMBERS[w]);
  }
  return words.join(' ').replace(/(\d+)\s*\.\s*(\d+)/g, '$1.$2').trim();
}

export type Parsed = { words: string[]; sizes: number[]; unitSizes: number[]; bare: number[] };
/** What a request's words say: its words, and its sizes (a number with kW, or a bare number), not counted as sizes:
 *  a duration ("10 year"), a percentage, a rupee amount. */
export function parseWords(s: string): Parsed {
  let t = normWords(s);
  t = t.replace(/(?:₹|\brs\.?|\binr)\s*[\d,]+(?:\.\d+)?/g, ' ').replace(/\b\d[\d,]*(?:\.\d+)?\s*(?:rupees?|रुपये|रुपए)/g, ' ');
  t = t.replace(/\b\d+(?:\.\d+)?\s+year\b/g, ' year ').replace(/\b\d+(?:\.\d+)?\s*%/g, ' ');
  // A rating in another unit ("12V fan", "100 Ah") is not a size.
  t = t.replace(/\b\d+(?:\.\d+)?\s*(?:v|volts?|a|amps?|ah|mah|mm|cm|kg|hp|va|kva)\b/g, ' ');
  const unitSizes = [...t.matchAll(/\b(\d+(?:\.\d+)?)\s*kwh?\b/g)].map((m) => Number(m[1]));
  const toks = t.split(/\s+/).filter(Boolean);
  const bare = toks.filter(isNum).map(Number).filter((n) => !unitSizes.includes(n));
  const words = toks.filter((w) => !isNum(w) && !STOP.has(w));
  return { words, sizes: unitSizes.length ? unitSizes : bare, unitSizes, bare };
}

type Prep = { item: CatItem; tokens: Set<string>; named: Set<string>; head: Set<string> | null; tail: string; nums: number[]; code: string; squashed: string };
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, '');
const distinct = (w: string) => !GENERIC.has(w) && !STOP.has(w) && !isNum(w);
/** A catalogue item's words, numbers and (for "<thing> for <product>") the words of the thing itself. */
export function prepItem(item: CatItem): Prep {
  const name = String(item.name ?? '');
  const parsed = parseWords(name);
  const split = name.split(/\s+for\s+/i);
  const head = split.length > 1 ? new Set(parseWords(split[0]).words.filter(distinct)) : null;
  const codeWords = parseWords(String(item.code ?? '').replace(/[-_]/g, ' ')).words;
  const nums = parsed.sizes.length ? parsed.sizes : parseWords(String(item.code ?? '').replace(/[-_]/g, ' ').replace(/(\d)([a-z])$/i, '$1')).bare;
  return { item, tokens: new Set([...parsed.words, ...codeWords]), named: new Set(parsed.words), head: head && head.size ? head : null, tail: split.length > 1 ? squash(split.slice(1).join(' for ')) : '', nums, code: squash(String(item.code ?? '')), squashed: squash(name) };
}
const sameNum = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const hit = (q: string, p: Prep) => p.tokens.has(q) || (q.length >= 3 && !DEV.test(q) && [...p.tokens].some((t) => t.length >= 3 && (t.startsWith(q) || q.startsWith(t)))) || (q.length >= 4 && p.squashed.includes(q));

/** How well one item fits the words (higher is better) and whether it fits at all. */
export function scoreItem(q: Parsed, p: Prep, context: number[] = [], raw = '', main = ''): { score: number; base: number; evidence: number; viaContext: boolean } {
  const rawSq = squash(raw);
  if (p.code && p.code.length >= 3 && (rawSq === p.code || String(raw).split(/\s+/).some((t) => squash(t) === p.code) || new RegExp(`(^|[^a-z0-9])${p.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(raw.toLowerCase().replace(/[-_ ]/g, ''))))
    return { score: 10, base: 10, evidence: 5, viaContext: false };
  let score = 0, evidence = 0, viaContext = false;
  const qd = q.words.filter(distinct), qg = q.words.filter((w) => GENERIC.has(w));
  for (const w of qd) { if (hit(w, p)) { score += 1; evidence += 1; } else score -= 0.6; }
  for (const w of qg) if (p.tokens.has(w)) score += 0.3;
  const headSaid = !!p.head && qd.some((w) => [...p.head!].some((h) => h === w || (w.length >= 3 && (h.startsWith(w) || w.startsWith(h)))));
  if (p.head && !headSaid) score -= 2;
  // BHARATA-2: an add-on "for <the quotation's main product>" (its exact name) over a spare part that only shares the
  // size (a real catalogue's "DCDB 2-In 2-Out 12.0 …" beside "DC Distribution Box (DCDB) for <product> 12.0").
  if (headSaid && main && p.tail === main) { score += 1.5; evidence += 1; }
  if (q.sizes.length) {
    if (p.nums.length && p.nums.some((n) => q.sizes.some((s) => sameNum(n, s)))) { score += 2; evidence += 1; }
    else if (p.nums.length) score -= 1.5;
  } else if (context.length && p.nums.length) {
    if (p.nums.some((n) => context.some((s) => sameNum(n, s)))) { score += 1; viaContext = true; } else score -= 0.5;
  }
  // Words of the item nobody said: only to prefer the plainer of two that fit ("3 kW" is the 3.0, not the 3.0 Lite).
  const extra = [...p.named].filter((t) => distinct(t) && !qd.some((w) => t === w || (w.length >= 3 && (t.startsWith(w) || w.startsWith(t))))).length;
  return { score: score - 0.3 * Math.min(extra, 5), base: score, evidence, viaContext };
}

/** The catalogue item the words mean, or why there is none (ambiguous, a size it does not have, nothing like it). */
export function pickItem(words: string, items: CatItem[], context: number[] = [], { heard = false, main = '' }: { heard?: boolean; main?: string } = {}): Pick {
  const q = parseWords(words);
  const preps = items.map(prepItem);
  // A bare number no item has is a count, not a size ("2 ACDB"); a number said with kW is always a size.
  const known = new Set(preps.flatMap((p) => p.nums));
  const sizes = q.unitSizes.length ? q.unitSizes : q.bare.filter((n) => [...known].some((k) => sameNum(k, n)));
  const qq: Parsed = { ...q, sizes };
  const mainKey = squash(main);
  const scored = preps.map((p) => ({ p, ...scoreItem(qq, p, context, words, mainKey) })).filter((x) => x.evidence > 0).sort((a, b) => b.score - a.score);
  if (sizes.length) {
    const fit = scored.filter((x) => x.p.nums.some((n) => sizes.some((s) => sameNum(n, s))) || x.evidence >= 5);
    if (!fit.length && heard) {
      // BHARATA-2: heard, not typed, "one five kilowatt" comes back from Whisper as "1.5 kW" and "one twelve" as
      // "1.12 kW" (the suite's en-13, en-14): a count run into the size. When the size is not sold and exactly that
      // reading is (count 1 to 9, then a size the catalogue has), it is the item, and the answer says how it was read.
      // "112 kW" (no point) is the same run-together: "one twelve". Only a reading whose size is sold, never a sold size.
      const m = /^([1-9])\.(\d+)$/.exec(String(sizes[0])) ?? /^([1-9])([1-9]\d*)$/.exec(String(sizes[0]));
      const size = m ? Number(m[2]) : NaN;
      if (m && [...known].some((k) => sameNum(k, size))) {
        const again = pickItem(words.replace(new RegExp(`(^|[^\\d.])${m[0].replace('.', '\\.')}(?![\\d.])`), `$1${size}`), items, context, { main });
        if (again.kind === 'item') return { ...again, heardAs: { said: sizes[0], count: Number(m[1]), size } };
      }
    }
    if (!fit.length) {
      // The words fit items, but not at that size: ask which size (a voice note may have misheard the number).
      const like = preps.map((p) => ({ p, ...scoreItem({ ...qq, sizes: [] }, p, [], words) })).filter((x) => x.evidence > 0 && x.base > 0 && x.p.nums.length).sort((a, b) => b.score - a.score);
      const top = like.length ? like[0].score : 0;
      // Only sizes said ("1.5 kW system"): the products sold by size (not an accessory "for" one of them).
      const family = like.length ? like.filter((x) => x.score >= top - 0.35).map((x) => x.p.item)
        : q.words.some(distinct) ? [] : preps.filter((p) => !p.head && p.nums.length).map((p) => p.item);
      // The plainest names first (the products themselves before parts that share a size), then the nearest size.
      const words1 = (i: CatItem) => prepItem(i).named.size;
      if (family.length) return { kind: 'size-missing', size: sizes[0], choices: family.sort((a, b) => words1(a) - words1(b) || Math.abs(numOf(a) - sizes[0]) - Math.abs(numOf(b) - sizes[0])).slice(0, 6) };
      if (q.unitSizes.length) return { kind: 'none' };
    }
  }
  const good = scored.filter((x) => x.base >= 0.7);
  if (!good.length) return { kind: 'none' };
  const [a, b] = good;
  if (b && a.score - b.score < 0.25) return { kind: 'ambiguous', choices: good.filter((x) => a.score - x.score < 0.25).slice(0, 6).map((x) => x.p.item) };
  return { kind: 'item', item: a.p.item, score: a.score, viaContext: a.viaContext };
}
const numOf = (i: CatItem) => prepItem(i).nums[0] ?? 0;
/** The sizes a matched item carries (its main product's size: the context for "warranty" or "ACDB" said without one). */
export const sizesOf = (i: CatItem) => prepItem(i).nums;

/** WL-FOLLOWUP (17 Nov 2026): the colleague a "new client" name is, if it is one. Willow Lane: Sakobe's voice note "assign
 *  Savuzo a task …" became a new client "Savuzo Roberatano" (a colleague) and a ₹3.8 L draft quotation. A name equal to a
 *  colleague's (accents, case and spaces aside), or two or more of its words all in one colleague's name, is that person. */
export function colleagueNamed(name: string, people: { name: string }[]): string | null {
  const fold = (s: string) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim();
  const said = fold(name); if (!said) return null;
  const parts = said.split(' ');
  for (const p of people) {
    const theirs = fold(p.name); if (!theirs) continue;
    if (theirs === said) return p.name;
    const words = new Set(theirs.split(' '));
    if (parts.length >= 2 && parts.every((w) => words.has(w))) return p.name;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ the answer, in their language
export type Lang = 'en' | 'hi' | 'mr';
export const langOf = (l: unknown, text = ''): Lang => (l === 'hi' || l === 'mr' || l === 'en' ? l : DEV.test(text) ? 'hi' : 'en');
const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const rupees = (paise: number) => `₹${INR.format(Math.round(paise) / 100)}`;
export { rupees };
type DocLine = { description: string; qty: number; rate: number; gstRate: number; total: number; discountPercent?: number | null };
export type DocView = { id: string; url: string; status: string; number: string | null; buyer: string; lines: DocLine[]; total: number; roundOff: number; waitingFor?: string | null };

const W = {
  en: { draft: (c: string) => `Draft quotation for ${c}`, isNew: ' (new client, added)', total: (t: string) => `Total ${t} incl. GST`, round: ' (rounded to the rupee)',
    notSent: 'It is a draft: not sent to the client.', offer: 'Submit it for approval?', submitted: (a: string) => `Submitted to ${a} for approval.`,
    waiting: (a: string) => `It is already waiting for ${a}'s approval.`, existing: 'This is the existing draft with the same lines (no second draft made).',
    updated: (c: string) => `Quotation for ${c} updated`, took: (w: string, i: string) => `I took “${w}” as ${i}.`, approved: (n: string) => `Approved as ${n}.`,
    whichClient: 'Which client is this for?', newNamed: (n: string) => `A new client named ${n}`, didYouMean: (n: string) => `Did you mean ${n}?`,
    confirmNew: (n: string) => `I heard the new client's name as “${n}”. Is that spelled right? Reply yes, or type the right name.`,
    colleague: (n: string) => `${n} is a colleague here, not a client, so I made no quotation. If you meant a task for ${n}, say so and I will create the task.`,
    noPrice: (w: string) => `“${w}” is not in the catalogue. What price should I put for it (₹, before GST)?`, which: (w: string) => `Which one for “${w}”?`,
    noSize: (w: string, s: number) => `There is no ${s} kW option for “${w}”. Which one did you mean?`, noLast: (c: string) => `${c} has no approved quotation yet to copy. What should this one have?`,
    sameAs: (n: string) => `Same lines as ${n}.`, heardAs: (s: number, n: number, k: number, i: string) => `I heard “${s} kW” and took it as ${n} × ${k} kW (${i}); tell me if that is wrong.`, nothing: 'Tell me what to put on the quotation (the products and how many).',
    quote: (n: string, c: string) => `Quotation ${n} for ${c}`, pdfLater: 'I will post the PDF here as soon as it is approved.',
    byRule: (lim: string) => `Approved at once by the company's rule (catalogue prices, no discount, up to ${lim}).`, pdfHere: 'The PDF is in this chat.',
    ready: (n: string, c: string, t: string, by: string | null) => `${n} for ${c} is approved${by ? ` by ${by}` : ''}: ${t} incl. GST. Here is the PDF.` },
  hi: { draft: (c: string) => `${c} के लिए ड्राफ्ट कोटेशन`, isNew: ' (नया क्लाइंट, जोड़ दिया)', total: (t: string) => `कुल ${t} (GST सहित)`, round: ' (रुपये में राउंड किया)',
    notSent: 'यह ड्राफ्ट है: ग्राहक को अभी नहीं भेजा गया।', offer: 'मंज़ूरी के लिए भेज दूँ?', submitted: (a: string) => `${a} को मंज़ूरी के लिए भेज दिया है।`,
    waiting: (a: string) => `यह पहले से ${a} की मंज़ूरी का इंतज़ार कर रहा है।`, existing: 'यही लाइनों वाला ड्राफ्ट पहले से है (दूसरा ड्राफ्ट नहीं बनाया)।',
    updated: (c: string) => `${c} का कोटेशन बदल दिया`, took: (w: string, i: string) => `“${w}” को ${i} माना।`, approved: (n: string) => `${n} के रूप में मंज़ूर।`,
    whichClient: 'यह किस क्लाइंट के लिए है?', newNamed: (n: string) => `नया क्लाइंट: ${n}`, didYouMean: (n: string) => `क्या आपका मतलब ${n} है?`,
    confirmNew: (n: string) => `मैंने नए क्लाइंट का नाम “${n}” सुना। क्या यह सही है? हाँ लिखें, या सही नाम लिखें।`,
    colleague: (n: string) => `${n} यहाँ सहकर्मी हैं, क्लाइंट नहीं, इसलिए कोटेशन नहीं बनाया। अगर ${n} के लिए टास्क चाहिए था, तो बताइए, मैं टास्क बना दूँगा।`,
    noPrice: (w: string) => `“${w}” कैटलॉग में नहीं है। इसकी कीमत क्या लिखूँ (₹, GST से पहले)?`, which: (w: string) => `“${w}” के लिए कौन सा?`,
    noSize: (w: string, s: number) => `“${w}” में ${s} kW नहीं है। कौन सा चाहिए?`, noLast: (c: string) => `${c} का अभी कोई मंज़ूर कोटेशन नहीं है जिसे कॉपी करूँ। इसमें क्या रखना है?`,
    sameAs: (n: string) => `${n} जैसी ही लाइनें।`, heardAs: (s: number, n: number, k: number, i: string) => `“${s} kW” सुना, उसे ${n} × ${k} kW (${i}) माना; गलत हो तो बताइए।`, nothing: 'कोटेशन में क्या रखना है, बताइए (कौन से प्रोडक्ट और कितने)।',
    quote: (n: string, c: string) => `${c} के लिए कोटेशन ${n}`, pdfLater: 'मंज़ूर होते ही PDF यहीं भेज दूँगा।',
    byRule: (lim: string) => `कंपनी के नियम से तुरंत मंज़ूर (कैटलॉग कीमतें, कोई छूट नहीं, ${lim} तक)।`, pdfHere: 'PDF इसी चैट में है।',
    ready: (n: string, c: string, t: string, by: string | null) => `${c} का ${n}${by ? ` ${by} ने` : ''} मंज़ूर कर दिया: ${t} (GST सहित)। PDF यह रहा।` },
  mr: { draft: (c: string) => `${c} साठी ड्राफ्ट कोटेशन`, isNew: ' (नवीन ग्राहक, जोडला)', total: (t: string) => `एकूण ${t} (GST सह)`, round: ' (रुपयात पूर्णांक)',
    notSent: 'हे ड्राफ्ट आहे: ग्राहकाला अजून पाठवलेले नाही.', offer: 'मंजुरीसाठी पाठवू का?', submitted: (a: string) => `${a} यांच्याकडे मंजुरीसाठी पाठवले आहे.`,
    waiting: (a: string) => `हे आधीच ${a} यांच्या मंजुरीची वाट पाहत आहे.`, existing: 'याच ओळींचे ड्राफ्ट आधीच आहे (दुसरे ड्राफ्ट केले नाही).',
    updated: (c: string) => `${c} चे कोटेशन बदलले`, took: (w: string, i: string) => `“${w}” म्हणजे ${i} घेतले.`, approved: (n: string) => `${n} म्हणून मंजूर.`,
    whichClient: 'हे कोणत्या ग्राहकासाठी आहे?', newNamed: (n: string) => `नवीन ग्राहक: ${n}`, didYouMean: (n: string) => `तुम्हाला ${n} म्हणायचे आहे का?`,
    confirmNew: (n: string) => `मी नवीन ग्राहकाचे नाव “${n}” असे ऐकले. हे बरोबर आहे का? हो लिहा, किंवा योग्य नाव लिहा.`,
    colleague: (n: string) => `${n} हे इथले सहकारी आहेत, ग्राहक नाहीत, म्हणून कोटेशन केले नाही. ${n} यांच्यासाठी टास्क हवा असल्यास सांगा, मी टास्क तयार करतो.`,
    noPrice: (w: string) => `“${w}” कॅटलॉगमध्ये नाही. त्याची किंमत किती लिहू (₹, GST आधी)?`, which: (w: string) => `“${w}” साठी कोणते?`,
    noSize: (w: string, s: number) => `“${w}” साठी ${s} kW पर्याय नाही. कोणता हवा?`, noLast: (c: string) => `${c} चे अजून कोणतेही मंजूर कोटेशन नाही. यात काय घ्यायचे?`,
    sameAs: (n: string) => `${n} सारख्याच ओळी.`, heardAs: (s: number, n: number, k: number, i: string) => `“${s} kW” ऐकले, ते ${n} × ${k} kW (${i}) घेतले; चुकीचे असल्यास सांगा.`, nothing: 'कोटेशनमध्ये काय घ्यायचे ते सांगा (कोणते प्रॉडक्ट आणि किती).',
    quote: (n: string, c: string) => `${c} साठी कोटेशन ${n}`, pdfLater: 'मंजूर होताच PDF इथेच पाठवतो.',
    byRule: (lim: string) => `कंपनीच्या नियमाने लगेच मंजूर (कॅटलॉग किंमती, सवलत नाही, ${lim} पर्यंत).`, pdfHere: 'PDF याच चॅटमध्ये आहे.',
    ready: (n: string, c: string, t: string, by: string | null) => `${c} चे ${n}${by ? ` ${by} यांनी` : ''} मंजूर केले: ${t} (GST सह). PDF हे घ्या.` },
};
export const words = (l: Lang) => W[l];

/** The answer for a drafted, changed or reused quotation, ready to post (the link opens it beside the chat). */
// QUOTE-FAST (18 Nov 2026): submitted from a chat, it says the PDF comes to this chat once approved (pdfLater); approved
// at once by the company's rule (byRule, the limit in paise), it says so, and that the PDF is already here (pdfHere).
export function draftReply(lang: Lang, d: DocView, o: { created?: boolean; status: 'drafted' | 'updated' | 'existing'; reused?: boolean; submittedTo?: string | null; notes?: string[];
  pdfLater?: boolean; pdfHere?: boolean; byRule?: number | null }) {
  const w = W[lang];
  const head = o.byRule && d.number ? w.quote(d.number, d.buyer) : o.status === 'updated' ? w.updated(d.buyer) : w.draft(d.buyer);
  const lines = d.lines.map((l, i) => `${i + 1}. ${l.description} × ${Number(l.qty)}: ${rupees(l.rate)}${l.discountPercent ? ` −${Number(l.discountPercent)}%` : ''} + ${Number(l.gstRate)}% GST = ${rupees(l.total)}`);
  const later = o.pdfLater ? ` ${w.pdfLater}` : '';
  const after = o.byRule && d.number ? `${w.byRule(rupees(o.byRule))}${o.pdfHere ? ` ${w.pdfHere}` : ''}` : o.submittedTo ? `${w.submitted(o.submittedTo)}${later}` : d.waitingFor ? `${w.waiting(d.waitingFor)}${later}`
    : d.status !== 'draft' && d.number ? w.approved(d.number) : `${w.notSent} ${w.offer}`;
  return [`${head}${o.created ? w.isNew : ''}:`, ...lines, `${w.total(rupees(d.total))}${d.roundOff ? w.round : ''}.`, ...(o.reused ? [w.existing] : []), ...(o.notes ?? []), d.url, after]
    .join('\n').slice(0, 3800);
}

/** QUOTE-FAST: the one line that comes with an approved quotation's PDF in the chat it was asked in, in each language. */
export function readyLines(q: { number: string; buyer: string; total: number; by: string | null }) {
  return Object.fromEntries((['en', 'hi', 'mr'] as Lang[]).map((l) => [l, W[l].ready(q.number, q.buyer || 'the client', rupees(q.total), q.by)])) as Record<Lang, string>;
}

/** QUOTE-FAST (18 Nov 2026; Willow Lane: "Submit it for approval?" cost a round trip before the approver even heard): an AI
 *  employee's new quotation goes for approval in the same call when nothing in it is a judgement call: a known client
 *  (not one just added), every line a catalogue item at its catalogue price with no discount, nothing assumed (a
 *  sound-alike client, a heard size). submit false (the person asked only for a draft) keeps it a draft. */
export function submitsAtOnce(o: { ai: boolean; submit: unknown; created: boolean; assumed: number; lines: { itemId?: unknown; rate?: unknown; discountPercent?: unknown }[] | null }) {
  if (o.submit === true) return true;
  if (!o.ai || o.submit === false || o.created || o.assumed > 0 || !o.lines?.length) return false;
  return o.lines.every((l) => typeof l.itemId === 'string' && l.rate === undefined && !Number(l.discountPercent ?? 0));
}
