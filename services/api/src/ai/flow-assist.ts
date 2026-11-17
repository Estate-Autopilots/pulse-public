/** FLOW-A: Pip inside a step: draft, critique, summarise, extract, check, grounded on the step's SOP section and the
 *  run's records. Like the task scorer and planner (task-scorer.ts, task-planner.ts) this sits behind an interface:
 *  Pulse has no language-model seam today, so the assistant behind it is transparent rules over the texts it is given.
 *  It reads no keys, calls nothing and sends nothing; every finding says what it rests on, and the person decides (Kazuk:
 *  "AI suggests, the CS decides"). A model-backed assistant can implement FlowAssistant later behind the owner's gates,
 *  with the same inputs (the SOP section and the run's records) and the same limits (LIMITS). */

export const LIMITS = { text: 120_000, sop: 60_000, records: 400, drafts: 12 } as const;
export type RecordLite = { type: string; title: string; status: string; data: Record<string, unknown> };
export type AssistInput = {
  action: 'draft' | 'critique' | 'summarise' | 'extract' | 'check' | 'suggest';
  step: { title: string; module: string; checklist: string[]; qualityTest: string[] };
  sop: { title: string | null; body: string } | null;
  text: string;                                   // what the person is working on (a section, a transcript, a script)
  drafts: { title: string; text: string }[];      // for check: every draft the step checks
  records: RecordLite[];                          // the run's records (facts, words, personas, offers ...)
  fields: Record<string, unknown>; today: string;
};
export type Finding = { level: 'fix' | 'check' | 'ok'; rule: string; text: string; where?: string | null; suggestion?: string | null; basis: string };
export type AssistResult = {
  summary?: string[]; followups?: string[]; tags?: { tag: string; line: string }[];
  facts?: { statement: string; figure: string | null; source: string | null }[]; openItems?: { question: string; tag: string }[]; quotes?: string[];
  findings?: Finding[]; outline?: string; headings?: string[]; checks?: { test: string; verdict: 'looks ok' | 'check' | 'missing'; why: string }[];
  basis: string[];
};
export interface FlowAssistant { readonly name: string; readonly version: string; readonly model: string | null; assist(input: AssistInput): Promise<AssistResult> }

const STOP = new Set('a an the and or but if of to in on at for with from by as is are was were be been it its this that these those we you they he she i our your their there here not no do does did have has had will would can could should may might also just so than then into over about up out more most very what which who whom when where why how all any each other some such only own same too s t'.split(' '));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sentences = (t: string) => t.replace(/\r\n?/g, '\n').split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 2);
const words = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9₹%. ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Figures a claim can rest on: money, areas, distances, times, counts, percentages, RERA numbers. */
const FIGURE = /(₹\s?\d[\d,.]*\s?(?:l|lakh|lakhs|lac|cr|crore|crores|k)?\b|\brs\.?\s?\d[\d,.]*\s?(?:l|lakh|lakhs|lac|cr|crore|crores|k)?\b|\b\d[\d,.]*\s?(?:sq\.?\s?ft|sqft|square feet|acres?|km|kms|kilometres?|min(?:ute)?s?|hrs?|hours?|bhk|floors?|storeys?|towers?|amenities|units|flats|%|lakh|lakhs|cr|crore)\b|\bP\d{11}\b)/gi;
const TAGS = /\b(ARCHITECT \/ DEVELOPER FOLLOW-UP REQUIRED|FOLLOW-UP|PENDING|CONFLICT|TO VERIFY|HOLD|PROVISIONAL)\b/;
const FOLLOW = /(follow[- ]?up|pending|to (?:send|share|confirm|check|get)|will (?:send|share|confirm|check)|need(?:s)? to|awaiting|not (?:yet )?(?:received|shared)|by (?:monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|eod)|action:|todo|\?$)/i;
/** Claims that need proof or must go (superlatives, guarantees, absolutes). */
const RISKY = /\b(best|no\.?\s?1|number one|guaranteed?|assured (?:returns?|appreciation)|cheapest|lowest price|100\s?%|risk[- ]free|only project|unmatched|unbeatable|world[- ]class|first[- ]ever|never before|limited period only|hurry)\b/gi;

function figuresOf(t: string) { return [...t.matchAll(FIGURE)].map((m) => m[0].replace(/\s+/g, ' ').trim()); }
const normFigure = (f: string) => f.toLowerCase().replace(/[,\s]/g, '').replace(/^rs\.?/, '₹').replace(/(lakhs|lakh|lac)$/, 'l').replace(/(crores|crore)$/, 'cr').replace(/(kms|kilometres?)$/, 'km').replace(/(minutes|minute|mins)$/, 'min');

function summarise(text: string, sop: string): { summary: string[]; followups: string[]; tags: { tag: string; line: string }[] } {
  const ss = sentences(text);
  const freq = new Map<string, number>(); for (const w of words(text)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const sopWords = new Set(words(sop));
  const scored = ss.map((s, i) => { const ws = words(s); const score = ws.reduce((n, w) => n + (freq.get(w) ?? 0) + (sopWords.has(w) ? 2 : 0), 0) / Math.max(4, ws.length) + (figuresOf(s).length ? 1.5 : 0);
    return { s, i, score }; });
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, Math.min(6, Math.max(2, Math.round(ss.length / 12)))).sort((a, b) => a.i - b.i).map((x) => clip(x.s, 400));
  const followups = [...new Set(ss.filter((s) => FOLLOW.test(s) || TAGS.test(s)).map((s) => clip(s, 300)))].slice(0, 20);
  const tags = ss.map((s) => ({ m: TAGS.exec(s), s })).filter((x) => x.m).map((x) => ({ tag: x.m![1], line: clip(x.s, 300) })).slice(0, 40);
  return { summary: top, followups, tags };
}

function extract(text: string) {
  const ss = sentences(text);
  const facts = ss.filter((s) => figuresOf(s).length).slice(0, 60).map((s) => {
    const src = /\b(as per|according to|per)\s+([^,.;]{3,60})/i.exec(s)?.[2] ?? (/(rera|brochure|price sheet|website|google maps|client|sales)/i.exec(s)?.[1] ?? null);
    return { statement: clip(s, 400), figure: figuresOf(s)[0] ?? null, source: src ? src.trim() : null }; });
  const openItems = ss.filter((s) => TAGS.test(s) || (FOLLOW.test(s) && /\?|pending|confirm|follow/i.test(s))).slice(0, 40)
    .map((s) => ({ question: clip(s.replace(TAGS, '').replace(/^[-:\s]+/, '').trim() || s, 400), tag: TAGS.exec(s)?.[1] ?? (/conflict|contradict|differs?/i.test(s) ? 'CONFLICT' : /follow/i.test(s) ? 'FOLLOW-UP' : 'PENDING') }));
  const quotes = [...text.matchAll(/[“"]([^”"]{12,240})[”"]/g)].map((m) => m[1]).slice(0, 30);
  return { facts, openItems, quotes };
}

function check(input: AssistInput): Finding[] {
  const out: Finding[] = [];
  const drafts = (input.drafts.length ? input.drafts : [{ title: input.step.title, text: input.text }]).slice(0, LIMITS.drafts);
  const wordsLib = input.records.filter((r) => r.type === 'word' && r.status !== 'retired');
  const facts = input.records.filter((r) => r.type === 'fact');
  const offers = input.records.filter((r) => r.type === 'offer');
  for (const d of drafts) {
    const t = d.text;
    for (const w of wordsLib) {
      const avoid = String(w.data.avoid ?? '').split(/[,/;]| or /).map((x) => x.trim()).filter((x) => x.length > 1);
      for (const a of avoid) if (new RegExp(`\\b${esc(a)}\\b`, 'i').test(t))
        out.push({ level: 'fix', rule: 'Word Library', where: d.title, text: `Uses “${a}”`, suggestion: w.data.use ? `Use “${String(w.data.use)}”${w.data.why ? ` (${String(w.data.why)})` : ''}` : null, basis: `Word Library: ${w.title}` });
    }
    for (const m of t.matchAll(RISKY)) out.push({ level: 'fix', rule: 'Claims', where: d.title, text: `“${m[0]}” is a claim that needs proof, or must go`, suggestion: 'Say the specific, provable fact instead', basis: 'Claims rule' });
    for (const fg of [...new Set(figuresOf(t))]) {
      const nf = normFigure(fg);
      const hit = facts.find((f) => figuresOf(String(f.data.statement ?? f.title)).some((x) => normFigure(x) === nf));
      if (!hit) out.push({ level: 'check', rule: 'Facts', where: d.title, text: `“${fg}” is not in the fact and claim registry`, suggestion: 'Add it with its source, or take it out', basis: 'Fact & claim registry' });
      else if (hit.status !== 'confirmed') out.push({ level: hit.status === 'hold' ? 'fix' : 'check', rule: 'Facts', where: d.title, text: `“${fg}” rests on a fact that is ${hit.status.replace('_', ' ')}: ${clip(hit.title, 120)}`,
        suggestion: hit.status === 'hold' ? 'A fact on hold is not used' : 'Confirm it before it goes out', basis: `Fact: ${clip(hit.title, 80)}` });
      if (hit && hit.data.ads_ok === false) out.push({ level: 'fix', rule: 'Facts', where: d.title, text: `“${fg}” is not approved for ads`, basis: `Fact: ${clip(hit.title, 80)}` });
    }
    for (const k of facts.filter((f) => f.data.kpc === true)) {
      const keys = words(String(k.data.statement ?? k.title)).filter((w) => w.length > 4).slice(0, 6);
      const hits = keys.filter((w) => new RegExp(`\\b${esc(w)}`, 'i').test(t));
      if (keys.length && hits.length >= Math.min(2, keys.length)) out.push({ level: 'check', rule: 'Constraints', where: d.title, text: `Touches a known product constraint: ${clip(k.title, 160)}`, basis: 'Known product constraints' });
    }
    for (const o of offers) {
      const end = String(o.data.valid_until ?? ''); const name = String(o.data.name ?? o.title);
      if (name.length > 3 && new RegExp(esc(name), 'i').test(t)) {
        if (end && end < input.today) out.push({ level: 'fix', rule: 'Offers', where: d.title, text: `The offer “${name}” ended on ${end}`, basis: `Offer: ${name}` });
        else if (o.status !== 'approved') out.push({ level: 'check', rule: 'Offers', where: d.title, text: `The offer “${name}” is not approved for ads yet`, basis: `Offer: ${name}` });
      }
    }
  }
  // The same kind of figure with different values across the drafts.
  const prices = new Map<string, Set<string>>();
  for (const d of drafts) for (const fg of figuresOf(d.text)) { const unit = normFigure(fg).replace(/[\d.]/g, '') || 'number'; if (!prices.has(unit)) prices.set(unit, new Set()); prices.get(unit)!.add(fg); }
  for (const [unit, set] of prices) if (set.size > 1 && drafts.length > 1 && /₹|cr|l$|min|km/.test(unit)) out.push({ level: 'check', rule: 'Numbers', text: `Different figures for the same thing across the drafts: ${[...set].slice(0, 5).join(', ')}`, basis: 'Numbers agree across drafts' });
  for (const test of input.step.qualityTest) {
    const lim = /under (\d+) words/i.exec(test);
    if (lim) for (const d of drafts) { const n = d.text.split(/\s+/).filter(Boolean).length; out.push({ level: n <= Number(lim[1]) ? 'ok' : 'fix', rule: 'Quality test', where: d.title, text: `${test}: ${n} words`, basis: 'Quality test' }); }
  }
  return out.slice(0, 200);
}

function critique(input: AssistInput) {
  const t = input.text; const first = sentences(t)[0] ?? '';
  const personas = input.records.filter((r) => r.type === 'persona').map((r) => r.title);
  const avoid = input.records.filter((r) => r.type === 'word').flatMap((r) => String(r.data.avoid ?? '').split(/[,/;]/).map((x) => x.trim()).filter((x) => x.length > 1));
  const tests = input.step.qualityTest.length ? input.step.qualityTest : input.step.checklist;
  return tests.slice(0, 40).map((test) => {
    const l = test.toLowerCase();
    if (/\bcta\b|call to action|action/.test(l)) return /\b(call|whatsapp|visit|book a|enquire|click|register|schedule|message)\b/i.test(t) ? { test, verdict: 'looks ok' as const, why: 'There is an action for the buyer' } : { test, verdict: 'missing' as const, why: 'No action for the buyer found' };
    if (/hook/.test(l)) { const n = first.split(/\s+/).filter(Boolean).length; return n && n <= 14 ? { test, verdict: 'looks ok' as const, why: `The opening line is ${n} words` } : { test, verdict: 'check' as const, why: n ? `The opening line is ${n} words: is it a hook?` : 'No opening line' }; }
    if (/persona/.test(l)) return personas.some((p) => new RegExp(esc(p), 'i').test(t)) ? { test, verdict: 'looks ok' as const, why: 'Names a persona of this run' } : { test, verdict: 'check' as const, why: personas.length ? `Which persona is it for? (${personas.slice(0, 3).join(', ')})` : 'No personas on this run yet' };
    if (/proof|fact|claim/.test(l)) return figuresOf(t).length ? { test, verdict: 'check' as const, why: `Figures to match with the registry: ${figuresOf(t).slice(0, 3).join(', ')}` } : { test, verdict: 'missing' as const, why: 'No proof point found' };
    if (/word library|words/.test(l)) { const bad = avoid.filter((a) => new RegExp(`\\b${esc(a)}\\b`, 'i').test(t)); return bad.length ? { test, verdict: 'missing' as const, why: `Uses ${bad.slice(0, 3).map((x) => `“${x}”`).join(', ')}` } : { test, verdict: 'looks ok' as const, why: 'No word to avoid found' }; }
    return { test, verdict: 'check' as const, why: 'Check this by reading it' };
  });
}

/** An outline from the SOP section (its headings and fields) with what this run already knows filled in. */
function draft(input: AssistInput) {
  const body = (input.sop?.body ?? '').slice(0, LIMITS.sop);
  const raw = body.split('\n').map((l) => l.replace(/^[\s*•\-–]+/, '').trim()).filter(Boolean);
  const headings = [...new Set(raw.filter((l) => l.length <= 90 && (/:$/.test(l) || /^(\d+(\.\d+)*[.)]|[A-H][.)]|(Field|Section|Step|Part|Tab|Stage|Gate) \d+(\.\d+)?[.:)]?)\s/.test(l) || (/^[A-Z][A-Za-z0-9 ,/&()'’-]+$/.test(l) && l.split(' ').length <= 8 && !/[.!?]$/.test(l)))))].slice(0, 30);
  const byType = new Map<string, RecordLite[]>(); for (const r of input.records) { if (!byType.has(r.type)) byType.set(r.type, []); byType.get(r.type)!.push(r); }
  const known = [...byType].map(([type, rs]) => `**${type.replace('_', ' ')}** (${rs.length}): ${rs.slice(0, 6).map((r) => r.title).join('; ')}${rs.length > 6 ? '…' : ''}`);
  const outline = [`# ${input.step.title}`, '', ...(headings.length ? headings.map((h) => `## ${h.replace(/:$/, '')}\n\n_…_\n`) : ['_The SOP part has no headings to follow: write it in your own order._', '']),
    ...(known.length ? ['---', 'What this run already has:', ...known.map((k) => `- ${k}`)] : []), '', '_Outline from the SOP part. You write it; Pip suggests._'].join('\n');
  return { outline, headings };
}

export const groundedAssistant: FlowAssistant = {
  name: 'grounded-rules', version: '1', model: null,
  async assist(input) {
    const text = input.text.slice(0, LIMITS.text); const sop = (input.sop?.body ?? '').slice(0, LIMITS.sop);
    const basis = [input.sop?.title ? `SOP: ${input.sop.title}` : 'No SOP part linked to this step', `${input.records.length} record${input.records.length === 1 ? '' : 's'} of this run`];
    switch (input.action) {
      case 'summarise': return { ...summarise(text, sop), basis };
      case 'extract': return { ...extract(text), basis };
      case 'check': return { findings: check({ ...input, text }), basis };
      case 'critique': return { checks: critique({ ...input, text }), findings: check({ ...input, text, drafts: [] }).filter((f) => f.level !== 'ok'), basis };
      case 'draft': return { ...draft(input), basis };
      default: return { summary: [], basis };
    }
  },
};
