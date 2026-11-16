// ONBOARD-CONFIG (owner, 13 Nov 2026, OWNER-FEEDBACK-1113 G3 T3.1.2): set a company up from a transcript or raw notes
// in minutes. A business-podcast, interview or meeting transcript (public: publishable; private: research only) is read
// here, on the company's own server, by plain rules: nothing is sent anywhere. It proposes the company's words (what it
// calls a team, who leads one, its clients, projects and leads), its teams and departments, its roles, its workflows as
// draft processes, its goals and projects, and its docs; shows what would change against what the company has now; and
// applies it in one transaction (a dry run does the same and undoes it). An AI working through MCP (or a person with
// `pulse setup plan --json`) can correct the proposal and send it back: apply takes the same shape. Private material stays
// private: a private source and anything written from it go only into a private folder of this company's docs, open to
// the person who ran the setup. Onboarding then shows only what is left (the guide's items this setup covered are ticked).
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { fail, type Viewer } from './routes.js';
import { linkGoal, saveGoal } from './goals.js';
import { saveDoc, saveFolder } from './docs.js';
import { normalizeFlow } from './flow/model.js';
import { canDesign } from './flow/store.js';
import { NEUTRAL_WORDS, WORD_KEYS, wordsOf, type WordKey, type Words } from './flow/packs.js';
import { LIMITS } from './setup-limits.js';

export type SetupClass = 'public' | 'private';
export type SetupWords = Partial<Record<WordKey, string>>;
export type SetupTeam = { name: string; kind: 'department' | 'team' };
export type SetupRole = { name: string; note?: string };
export type SetupStep = { title: string; role?: string };
export type SetupWorkflow = { name: string; summary?: string; steps: SetupStep[] };
export type SetupGoal = { title: string; why?: string; targetOn?: string };
export type SetupProject = { name: string; summary?: string; goal?: string };
export type SetupDoc = { title: string; markdown: string };
export type Proposal = { words: SetupWords; teams: SetupTeam[]; roles: SetupRole[]; workflows: SetupWorkflow[]; goals: SetupGoal[]; projects: SetupProject[]; docs: SetupDoc[] };
export type Evidence = { what: string; seen: number };
export const SECTIONS = ['words', 'teams', 'roles', 'workflows', 'goals', 'projects', 'docs'] as const;
export type Section = (typeof SECTIONS)[number];
export type Change = { section: Section; change: 'add' | 'change' | 'same'; name: string; detail: string };
export type Left = { label: string; href: string; why: string };

const MAX_SOURCE = 400_000;
const clean = (s: unknown, max: number) => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "social media manager" → "Social media manager"; an acronym stays (CEO, HR, QA). */
const label = (s: string) => cap(s.split(' ').map((w) => /^(ceo|cto|cfo|coo|cmo|hr|qa|ui|ux|bd|ops|it|ai|pr|seo)$/i.test(w) ? w.toUpperCase() : w.toLowerCase()).join(' '));
const keyOf = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'role';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plural = (w: string) => /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : /(s|sh|ch|x)$/i.test(w) ? `${w}es` : `${w}s`;
/** A word or its plural, whole, any case. */
const wordRe = (w: string) => new RegExp(`\\b(?:${esc(w)}|${esc(plural(w))})\\b`, 'gi');
const count = (t: string, re: RegExp) => (t.match(re) ?? []).length;

// Marathi and Hindi speech written in Devanagari borrows these English words as they sound; read them as the English word.
const LOANS: [RegExp, string][] = [
  [/क्लायंट|क्लाएंट|क्लाइंट/g, 'client'], [/कस्टमर/g, 'customer'], [/प्रोजेक्ट/g, 'project'], [/टीम/g, 'team'], [/पॉड/g, 'pod'],
  [/डिपार्टमेंट/g, 'department'], [/मॅनेजर|मैनेजर/g, 'manager'], [/हेड/g, 'head'], [/लीड/g, 'lead'], [/सेल्स/g, 'sales'], [/ओनर/g, 'owner'],
];
/** The text as the rules read it: loan words in English, no timestamps or "Speaker 1:" labels, one space between words on a line. */
export function prepare(text: string): string {
  let t = String(text ?? '').slice(0, MAX_SOURCE).replace(/\r/g, '');
  for (const [re, w] of LOANS) t = t.replace(re, ` ${w} `);
  return t.replace(/\[?\b\d{1,2}:\d{2}(?::\d{2})?\]?/g, ' ').replace(/^\s*speaker\s*\d+\s*:\s*/gim, '').replace(/[ \t]+/g, ' ');
}
const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3);

// ------------------------------------------------------------------------------------------------ words
const TEAM_WORDS = ['pod', 'squad', 'crew', 'cell', 'desk', 'studio', 'cluster', 'tribe'];
const GROUP_WORDS = ['department', 'division', 'vertical', 'practice', 'wing'];
const HEAD_WORDS = ['head', 'lead', 'leader', 'captain', 'manager', 'coordinator', 'champion'];
const CLIENT_WORDS = ['client', 'customer', 'patient', 'student', 'buyer', 'dealer', 'guest', 'tenant'];
// Not "production" or "job": they say "the production app" and "a good job" far more often than a unit of work.
const PROJECT_WORDS = ['project', 'campaign', 'engagement', 'case', 'shoot', 'matter'];
const LEAD_WORDS = ['lead', 'prospect', 'enquiry', 'inquiry'];
/** The word used most (at least `min` times), with how often. */
function top(t: string, words: string[], min: number, re: (w: string) => RegExp = wordRe): { word: string; seen: number } | null {
  const best = words.map((word) => ({ word, seen: count(t, re(word)) })).sort((a, b) => b.seen - a.seen)[0];
  return best && best.seen >= min ? best : null;
}

/** The company's words as the source uses them; only words it clearly uses are proposed (the rest stay as they are). */
export function wordsFrom(t: string): { words: SetupWords; evidence: Evidence[] } {
  const words: SetupWords = {}, evidence: Evidence[] = [];
  const set = (one: WordKey, many: WordKey, word: string, seen: number, what: string) => {
    words[one] = label(word); words[many] = label(plural(word)); evidence.push({ what: `${what}: "${label(word)}"`, seen });
  };
  const team = top(t, TEAM_WORDS, 2);
  if (team) set('team', 'teams', team.word, team.seen, 'A team is called');
  const teamWord = team?.word ?? 'team';
  const head = top(t, HEAD_WORDS, 1, (w) => new RegExp(`\\b(?:${esc(teamWord)}|team)s?\\s+(?:${esc(w)}|${esc(plural(w))})\\b`, 'gi'));
  if (head) set('head', 'heads', head.word, head.seen, `Who leads a ${teamWord} is called`);
  const group = top(t, GROUP_WORDS, 2);
  if (group) set('department', 'departments', group.word, group.seen, 'A group of teams is called');
  const client = top(t, CLIENT_WORDS, 3);
  if (client && client.word !== 'client') set('client', 'clients', client.word, client.seen, 'A client is called');
  else if (client) evidence.push({ what: 'A client is called: "Client"', seen: client.seen });
  const project = top(t, PROJECT_WORDS, 3);
  if (project && project.word !== 'project') set('project', 'projects', project.word, project.seen, 'A project is called');
  // A sales lead, never "team lead" or "to lead".
  const lead = top(t.replace(/\b(?:team|pod|squad|project|tech|design|sales)\s+leads?\b|\bto\s+lead\b|\blead(?:s|ing)?\s+(?:the|a|our|by)\b/gi, ' '), LEAD_WORDS, 3);
  if (lead && lead.word !== 'lead') set('lead', 'leads', lead.word, lead.seen, 'A sales lead is called');
  return { words, evidence };
}

// ------------------------------------------------------------------------------------------------ teams
const FUNCTIONS = 'sales|marketing|design|creative|tech|technology|engineering|product|operations|ops|finance|accounts|hr|people|support|customer success|'
  + 'content|growth|research|delivery|admin|legal|production|editing|video|social media|performance|strategy|data|qa|training|coaching|partnerships|business development';
const STOP = new Set(['the', 'our', 'this', 'that', 'every', 'each', 'one', 'your', 'my', 'his', 'her', 'their', 'a', 'an', 'whole', 'entire', 'same', 'new', 'other', 'which', 'what', 'any', 'no', 'its', 'his']);
export function teamsFrom(t: string, words: SetupWords): SetupTeam[] {
  const unit = `team|department|division|pod|squad|desk|crew|studio${words.team ? `|${esc(words.team.toLowerCase())}` : ''}`;
  const found = new Map<string, SetupTeam & { seen: number }>();
  const add = (name: string, kindWord: string, by = 1) => {
    const n = label(name.trim()); if (!n || STOP.has(n.toLowerCase())) return;
    const kind = /department|division/i.test(kindWord) ? 'department' : 'team';
    const k = n.toLowerCase(); const had = found.get(k);
    found.set(k, { name: n, kind: had?.kind === 'department' ? 'department' : kind, seen: (had?.seen ?? 0) + by });
  };
  for (const m of t.matchAll(new RegExp(`\\b(${FUNCTIONS})\\s+(${unit})s?\\b`, 'gi'))) add(m[1], m[2], 2);
  for (const m of t.matchAll(new RegExp(`\\b([A-Z][a-z]+(?: [A-Z][a-z]+)?) (${unit.split('|').map(cap).join('|')})\\b`, 'g'))) if (!STOP.has(m[1].split(' ')[0].toLowerCase())) add(m[1], m[2]);
  return [...found.values()].filter((x) => x.seen >= 2).sort((a, b) => b.seen - a.seen).slice(0, LIMITS.teams).map(({ name, kind }) => ({ name, kind }));
}

// ------------------------------------------------------------------------------------------------ roles
const ROLE_NOUNS = 'manager|head|lead|strategist|designer|editor|writer|copywriter|developer|engineer|coordinator|executive|salesperson|seller|closer|setter|founder|co-founder|'
  + 'cofounder|director|analyst|accountant|recruiter|consultant|assistant|intern|associate|specialist|officer|architect|marketer|producer|videographer|photographer|coach|trainer|'
  + 'administrator|operator|representative|rep|owner|ceo|cto|cfo|coo|cmo';
const ROLE_MODS = 'sales|account|project|product|creative|growth|content|social media|media|graphic|video|marketing|operations|ops|finance|hr|customer success|customer|client|'
  + 'support|performance|business development|business|team|pod|squad|art|tech|technical|qa|data|community|brand|delivery|research|office|general|managing|senior|junior|chief|design|'
  + 'ui|ux|frontend|backend|software|field|site|area|regional|store|branch|inside|creative strategy|growth strategy';
/** Nouns that are a role only with a word before them ("team lead", "sales head"), never alone ("a lead", "the head"). */
const NEEDS_MOD = new Set(['head', 'lead', 'executive', 'officer', 'operator', 'assistant', 'associate', 'rep', 'representative', 'specialist']);
export function rolesFrom(t: string): SetupRole[] {
  const found = new Map<string, { name: string; seen: number }>();
  for (const m of t.matchAll(new RegExp(`\\b(?:(${ROLE_MODS})\\s+)?(${ROLE_NOUNS})s?\\b`, 'gi'))) {
    const mod = (m[1] ?? '').toLowerCase(), noun = m[2].toLowerCase();
    if (!mod && NEEDS_MOD.has(noun)) continue;
    const name = label(mod ? `${mod} ${noun}` : noun), k = keyOf(name);
    found.set(k, { name, seen: (found.get(k)?.seen ?? 0) + 1 });
  }
  return [...found.values()].filter((x) => x.seen >= 2).sort((a, b) => b.seen - a.seen).slice(0, LIMITS.roles).map(({ name, seen }) => ({ name, note: `Named ${seen} times in the source` }));
}

// ------------------------------------------------------------------------------------------------ workflows
const stepTitle = (s: string) => cap(s.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s*/, '').replace(/^(?:and\s+)?then\s+|^after that,?\s+|^next,?\s+|^finally,?\s+/i, '').replace(/\*\*|__|`/g, '').replace(/[.;,]+$/, '').trim()).slice(0, 120);
const roleIn = (s: string, roles: SetupRole[]) => roles.find((r) => new RegExp(`\\b${esc(r.name)}s?\\b`, 'i').test(s))?.name;
export function workflowsFrom(t: string, roles: SetupRole[]): SetupWorkflow[] {
  const out: SetupWorkflow[] = [];
  const push = (name: string, raw: string[], summary?: string) => {
    const steps = raw.map(stepTitle).filter((s) => s.length > 2).slice(0, LIMITS.steps).map((title) => ({ title, ...(roleIn(title, roles) ? { role: roleIn(title, roles) } : {}) }));
    const n = cap(clean(name.replace(/[#*_`]/g, '').replace(/^\s*(?:[-•]\s*)?(?:\d+[.)]\s*)?(?:[A-Z]{1,3}-?[A-Z]?\d+(?:\.\d+)*\s*(?:\([A-Z]{1,3}\))?\s*[.:)\-–]?\s*)?/, ''), 80));
    if (steps.length >= 3 && n && !out.some((w) => w.name.toLowerCase() === n.toLowerCase())) out.push({ name: n, steps, ...(summary ? { summary: clean(summary, 300) } : {}) });
  };
  // "Name: a → b → c" (an analysis or a note writes a flow this way).
  for (const line of t.split('\n')) {
    for (const s of line.split(/(?<=\.)\s+/)) {
      const parts = s.split(/\s*(?:→|->|⇒|=>)\s*/);
      if (parts.length < 3) continue;
      const head = parts[0].includes(':') ? parts[0].slice(0, parts[0].lastIndexOf(':')) : '';
      if (head) parts[0] = parts[0].slice(parts[0].lastIndexOf(':') + 1);
      const name = head.replace(/^[|\s]*(?:[A-Z]{1,2}\d+\s*\|)?\s*/, '').replace(/^.*\|\s*/, '') || `${stepTitle(parts[0])} to ${stepTitle(parts[parts.length - 1]).toLowerCase()}`;
      push(name.length > 80 ? `${stepTitle(parts[0])} to ${stepTitle(parts[parts.length - 1]).toLowerCase()}` : name, parts.map((p) => p.split('|')[0]));
    }
  }
  // A heading about a flow, process, workflow, journey or steps, then a numbered list.
  const lines = t.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.*(?:flow|process|workflow|journey|steps|how we|playbook|sop).*)$/i);
    if (!h) continue;
    const items: string[] = [];
    for (let j = i + 1; j < lines.length && !/^#{1,6}\s/.test(lines[j]); j++) if (/^\s*\d{1,2}[.)]\s+\S/.test(lines[j])) items.push(lines[j].split(/[:.](?=\s)/)[0]);
    push(h[1], items);
  }
  // Spoken: "first we …, then …, after that …, finally …".
  for (const s of sentences(t)) {
    if (!/\bfirst\b/i.test(s) || count(s, /\b(?:then|after that|next|finally)\b/gi) < 2 || s.length > 600) continue;
    const parts = s.replace(/^.*?\bfirst\b,?\s*(?:we\s+|you\s+|they\s+)?/i, '').split(/,?\s*\b(?:and then|then|after that|next|finally)\b,?\s*/i);
    push(`${stepTitle(parts[0]).split(' ').slice(0, 5).join(' ')} process`, parts);
  }
  return out.slice(0, LIMITS.workflows);
}

// ------------------------------------------------------------------------------------------------ goals and projects
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** A date written in the sentence (2026-11-20, 20 Nov 2026, November 20, 2026), as YYYY-MM-DD. */
export function dateIn(s: string): string | undefined {
  const iso = s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const pad = (n: number) => String(n).padStart(2, '0');
  const dmy = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})\b/i);
  if (dmy) return `${dmy[3]}-${pad(MONTHS.indexOf(dmy[2].toLowerCase()) + 1)}-${pad(Number(dmy[1]))}`;
  const mdy = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i);
  if (mdy) return `${mdy[3]}-${pad(MONTHS.indexOf(mdy[1].toLowerCase()) + 1)}-${pad(Number(mdy[2]))}`;
  return undefined;
}
const firstSentence = (s: string) => {
  const one = clean(s.replace(/\*\*|__|`/g, '').replace(/^\s*[-*•>]\s*/, '').split(/(?<=[.!?])\s/)[0].replace(/[.:]+$/, ''), 400);
  const head = one.length > 100 && one.indexOf(':') > 15 ? one.slice(0, one.indexOf(':')) : one;
  return head.length > 160 ? `${head.slice(0, 159).replace(/\s+\S*$/, '')}…` : head;
};
const sectionOf = (lines: string[], re: RegExp) => {
  const out: { heading: string; body: string[]; level: number }[] = [];
  lines.forEach((l, i) => {
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (!h || !re.test(h[2])) return;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) { const n = lines[j].match(/^(#{1,6})\s/); if (n && n[1].length <= h[1].length) break; body.push(lines[j]); }
    out.push({ heading: h[2], body, level: h[1].length });
  });
  return out;
};
export function goalsFrom(t: string, cls: SetupClass): SetupGoal[] {
  const out: SetupGoal[] = [];
  const add = (title: string, why?: string, when?: string) => {
    const g = cap(firstSentence(title).replace(/^(?:the\s+)?(?:goal|objective|target|aim)\s*(?:is|:)\s*(?:to\s+)?/i, ''));
    if (g.length < 8 || out.some((x) => x.title.toLowerCase() === g.toLowerCase())) return;
    const targetOn = dateIn(when ?? title);
    out.push({ title: g, ...(why && cls === 'public' ? { why: clean(why.replace(/\*\*/g, ''), 600) } : {}), ...(targetOn ? { targetOn } : {}) });
  };
  for (const s of sectionOf(t.split('\n'), /^(?:[\d.)\s]*)(?:(?:the|our|main|company)\s+)?(?:goals?|objectives?|north star)\b/i)) {
    const para = s.body.map((l) => l.trim()).filter((l) => l && !/^[|#-]{3}/.test(l));
    const first = para.find((l) => !/^\s*[-*]\s*\*\*(?:why|measure|target)/i.test(l));
    if (first) add(first, para.find((l) => /why it matters/i.test(l)), para.find((l) => /target/i.test(l) && !!dateIn(l)) ?? first);
  }
  for (const s of sentences(t)) {
    const m = s.match(/\b(?:our|the|main|big|one|first|next)\s+(?:goal|objective|target|aim)\s+(?:is|was|will be)\s+(?:to\s+)?(.{8,200})/i)
      ?? s.match(/\bwe (?:want|need|plan) to (reach|hit|get to|grow|build|launch|ship|sign|close|open|hire|double|triple)\b(.{4,160})/i);
    if (m) add(m.length > 2 && m[2] ? `${m[1]}${m[2]}` : m[1], undefined, s);
    if (out.length >= LIMITS.goals) break;
  }
  return out.slice(0, LIMITS.goals);
}
export function projectsFrom(t: string, goals: SetupGoal[]): SetupProject[] {
  const out: SetupProject[] = [];
  const add = (name: string, summary?: string) => {
    const n = cap(clean(name.replace(/\*\*|__|`/g, '').replace(/^\s*(?:P\d+|Project\s*\d*)\s*[.:)\-–]\s*/i, '').replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, '').replace(/[.:]+$/, ''), 160));
    if (n.length < 3 || out.some((x) => x.name.toLowerCase() === n.toLowerCase())) return;
    out.push({ name: n, ...(summary ? { summary: clean(summary.replace(/\*\*/g, ''), 600) } : {}), ...(goals.length === 1 ? { goal: goals[0].title } : {}) });
  };
  const lines = t.split('\n');
  // A project is a heading one level inside a Projects section (its tasks sit deeper).
  for (const s of sectionOf(lines, /^(?:[\d.)\s]*)(?:(?:the|our)\s+)?projects?\b/i)) for (const l of s.body) { const h = l.match(/^(#{1,6})\s+(.*)$/); if (h && h[1].length === s.level + 1) add(h[2]); }
  for (const l of lines) { const h = l.match(/^#{2,6}\s+((?:P\d+|Project\s*\d*)\s*[.:)\-–]\s*.+)$/i); if (h) add(h[1]); }
  for (const m of t.matchAll(/\bproject (?:called|named) ["“]?([A-Z][\w-]*(?: [A-Z][\w-]*){0,3})/g)) add(m[1]);
  return out.slice(0, LIMITS.projects);
}

/** Read a source: the proposal and why each word was chosen. */
export function extractSetup(text: string, cls: SetupClass): { proposal: Proposal; evidence: Evidence[] } {
  const t = prepare(text);
  const { words, evidence } = wordsFrom(t);
  const roles = rolesFrom(t), goals = goalsFrom(t, cls);
  const proposal: Proposal = { words, teams: teamsFrom(t, words), roles, workflows: workflowsFrom(t, roles), goals, projects: projectsFrom(t, goals), docs: [] };
  for (const [k, n] of [['teams', proposal.teams.length], ['roles', roles.length], ['workflows', proposal.workflows.length], ['goals', goals.length], ['projects', proposal.projects.length]] as const)
    evidence.push({ what: `${cap(k)} found`, seen: n });
  return { proposal, evidence };
}

// ------------------------------------------------------------------------------------------------ cleaning a sent proposal
/** A proposal as sent (by the extractor, a person or an AI): trimmed, limited and de-duplicated, words only of known keys. */
export function cleanProposal(raw: unknown): Proposal {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(b[k]) ? b[k] as Record<string, unknown>[] : []).filter((x) => x && typeof x === 'object');
  const uniq = <T>(xs: T[], key: (x: T) => string) => xs.filter((x, i) => key(x) && xs.findIndex((y) => key(y) === key(x)) === i);
  const w = (b.words && typeof b.words === 'object' ? b.words : {}) as Record<string, unknown>;
  const words: SetupWords = {};
  for (const k of WORD_KEYS) { const v = clean(w[k], 40); if (v) words[k] = v; }
  const day = (x: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(x)) ? String(x) : undefined;
  const opt = <K extends string>(k: K, v: string) => (v ? { [k]: v } : {}) as Partial<Record<K, string>>;
  return {
    words,
    teams: uniq(arr('teams').map((x) => ({ name: clean(x.name, 80), kind: x.kind === 'department' ? 'department' as const : 'team' as const })), (x) => x.name.toLowerCase()).slice(0, LIMITS.teams),
    roles: uniq(arr('roles').map((x) => ({ name: clean(x.name, 80), ...opt('note', clean(x.note, 300)) })), (x) => keyOf(x.name)).slice(0, LIMITS.roles),
    workflows: uniq(arr('workflows').map((x) => ({ name: clean(x.name, 120), ...opt('summary', clean(x.summary, 1000)),
      steps: (Array.isArray(x.steps) ? x.steps as Record<string, unknown>[] : []).map((s) => ({ title: clean(s?.title, 120), ...opt('role', clean(s?.role, 80)) })).filter((s) => s.title).slice(0, LIMITS.steps) })),
    (x) => x.name.toLowerCase()).filter((x) => x.steps.length).slice(0, LIMITS.workflows),
    goals: uniq(arr('goals').map((x) => ({ title: clean(x.title, 160), ...opt('why', clean(x.why, 2000)), ...opt('targetOn', day(x.targetOn) ?? '') })), (x) => x.title.toLowerCase()).slice(0, LIMITS.goals),
    projects: uniq(arr('projects').map((x) => ({ name: clean(x.name, 160), ...opt('summary', clean(x.summary, 1000)), ...opt('goal', clean(x.goal, 160)) })), (x) => x.name.toLowerCase()).slice(0, LIMITS.projects),
    docs: uniq(arr('docs').map((x) => ({ title: clean(x.title, 200), markdown: typeof x.markdown === 'string' ? x.markdown.slice(0, 200_000) : '' })), (x) => x.title.toLowerCase()).filter((x) => x.markdown).slice(0, LIMITS.docs),
  };
}

// ------------------------------------------------------------------------------------------------ what the company has, and the diff
type Have = { words: Words; teams: Map<string, { id: string; name: string; kind: string }>; roles: Map<string, string>; workflows: Map<string, string>;
  goals: Map<string, string>; projects: Map<string, string>; docs: Map<string, string> };
const lower = (s: string) => s.trim().toLowerCase();
export const FOLDER = 'Company setup', PRIVATE_FOLDER = 'Private sources', PUBLIC_FOLDER = 'Sources';
const sourceTitle = (from: string) => `Source: ${from}`.slice(0, 200);
const SUMMARY_TITLE = 'How we are set up';

async function have(c: PoolClient, docTitles: string[]): Promise<Have> {
  const q = async (sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows as Record<string, string>[];
  const pack = (await c.query('select words from pulse.org_pack where org_id=pulse.current_org()')).rows[0];
  return {
    words: wordsOf(pack?.words),
    teams: new Map((await q(`select id,name,kind from pulse.unit where valid_to is null and kind in ('pod','team','department')`)).map((r) => [lower(r.name), { id: r.id, name: r.name, kind: r.kind }])),
    roles: new Map((await q('select id,key,name from pulse.work_role where archived_at is null')).flatMap((r) => [[r.key, r.id], [keyOf(r.name), r.id]] as [string, string][])),
    workflows: new Map((await q(`select id,name from pulse.flow_process where status<>'archived'`)).map((r) => [lower(r.name), r.id])),
    goals: new Map((await q(`select id,title from pulse.goal where status<>'dropped'`)).map((r) => [lower(r.title), r.id])),
    projects: new Map((await q('select id,coalesce(title,name) name from pulse.project')).map((r) => [lower(r.name ?? ''), r.id])),
    docs: new Map((await q('select id,title from pulse.doc where archived_at is null and title=any($1)', [docTitles])).map((r) => [lower(r.title), r.id])),
  };
}

export function diff(p: Proposal, h: Have, src: { from: string; cls: SetupClass } | null): Change[] {
  const out: Change[] = [];
  const said = (k: WordKey) => h.words[k] ?? NEUTRAL_WORDS[k];
  for (const k of WORD_KEYS) {
    const to = p.words[k];
    if (to) out.push(to === said(k) ? { section: 'words', change: 'same', name: k, detail: to } : { section: 'words', change: 'change', name: k, detail: `${said(k)} → ${to}` });
  }
  for (const t of p.teams) {
    const had = h.teams.get(lower(t.name));
    out.push(had ? { section: 'teams', change: 'same', name: had.name, detail: 'already there' } : { section: 'teams', change: 'add', name: t.name, detail: t.kind === 'department' ? 'a group of teams' : 'a team' });
  }
  for (const r of p.roles) out.push(h.roles.has(keyOf(r.name)) ? { section: 'roles', change: 'same', name: r.name, detail: 'already a role' } : { section: 'roles', change: 'add', name: r.name, detail: r.note ?? 'a new role' });
  for (const w of p.workflows) out.push(h.workflows.has(lower(w.name)) ? { section: 'workflows', change: 'same', name: w.name, detail: 'a process with this name exists' }
    : { section: 'workflows', change: 'add', name: w.name, detail: `a draft process of ${w.steps.length} steps` });
  for (const g of p.goals) out.push(h.goals.has(lower(g.title)) ? { section: 'goals', change: 'same', name: g.title, detail: 'already a goal' }
    : { section: 'goals', change: 'add', name: g.title, detail: `a company goal${g.targetOn ? ` for ${g.targetOn}` : ''}` });
  for (const x of p.projects) out.push(h.projects.has(lower(x.name)) ? { section: 'projects', change: 'same', name: x.name, detail: 'already a project' }
    : { section: 'projects', change: 'add', name: x.name, detail: x.goal ? `under the goal "${x.goal}"` : 'a project' });
  const docs = [...(src ? [{ title: sourceTitle(src.from), where: src.cls === 'private' ? `${FOLDER}/${PRIVATE_FOLDER}, open only to you` : `${FOLDER}/${PUBLIC_FOLDER}, for the company` }] : []),
    { title: SUMMARY_TITLE, where: `${FOLDER}, for the company: what this setup made (no words from the source)` },
    ...p.docs.map((d) => ({ title: d.title, where: src?.cls === 'private' ? `${FOLDER}/${PRIVATE_FOLDER}, open only to you` : `${FOLDER}, for the company` }))];
  for (const d of docs) out.push(h.docs.has(lower(d.title)) ? { section: 'docs', change: 'same', name: d.title, detail: 'already a doc' } : { section: 'docs', change: 'add', name: d.title, detail: d.where });
  return out;
}

/** What is left after the setup: the parts only people can do (invite, say who holds a role or heads a team, check and publish the processes). */
export async function leftToDo(c: PoolClient): Promise<Left[]> {
  const n = async (sql: string) => Number((await c.query(sql)).rows[0]?.n ?? 0);
  const out: Left[] = [];
  const people = await n(`select count(*) n from pulse.person where side='staff' and status='active'`);
  if (people <= 1) out.push({ label: 'Invite your people', href: '/people/add', why: 'You are the only one here.' });
  const roles = await n('select count(*) n from pulse.work_role r where r.archived_at is null and not exists(select 1 from pulse.work_role_holder h where h.role_id=r.id)');
  if (roles) out.push({ label: 'Say who holds each role', href: '/settings?tab=industry', why: `${roles} ${roles === 1 ? 'role has' : 'roles have'} no one yet.` });
  const heads = await n(`select count(*) n from pulse.unit where valid_to is null and kind in ('pod','team','department') and head_person_id is null`);
  if (heads) out.push({ label: 'Name who heads each team', href: '/settings?tab=organisation', why: `${heads} ${heads === 1 ? 'team has' : 'teams have'} no head yet.` });
  const drafts = await n(`select count(*) n from pulse.flow_process where status='draft'`);
  if (drafts) out.push({ label: 'Check and publish your processes', href: '/sops', why: `${drafts} ${drafts === 1 ? 'process is a draft' : 'processes are drafts'}.` });
  const goals = await n(`select count(*) n from pulse.goal where status='active'`);
  if (!goals) out.push({ label: 'Set your first goal', href: '/work?view=goals', why: 'No goal yet.' });
  return out;
}

/** A source and what reading it proposes, against the company now. Writes nothing. */
export async function planSetup(c: PoolClient, v: Viewer, b: { from?: string; text?: string; class: SetupClass; proposal?: unknown }) {
  if (!canDesign(v)) fail(403, 'Leadership and admins set up the company');
  const from = clean(b.from, 200) || 'transcript';
  const text = typeof b.text === 'string' ? b.text.slice(0, MAX_SOURCE) : '';
  if (!text.trim() && !b.proposal) fail(400, 'Send the transcript as text, or a proposal');
  const read = text.trim() ? extractSetup(text, b.class) : { proposal: cleanProposal({}), evidence: [] as Evidence[] };
  const proposal = b.proposal ? cleanProposal(b.proposal) : read.proposal;
  const items = diff(proposal, await have(c, docTitles(proposal, text.trim() ? from : null)), text.trim() ? { from, cls: b.class } : null);
  return { from, class: b.class, sha256: createHash('sha256').update(text).digest('hex'), proposal, evidence: read.evidence, items, counts: tally(items),
    privacy: b.class === 'private'
      ? `Private: the source and any doc written from it go only to ${FOLDER}/${PRIVATE_FOLDER}, open only to you. Goals keep no quotes from it.`
      : `Public: the source goes to ${FOLDER}/${PUBLIC_FOLDER} for the whole company.`,
    left: await leftToDo(c) };
}
const tally = (items: Change[]) => ({ add: items.filter((i) => i.change === 'add').length, change: items.filter((i) => i.change === 'change').length, same: items.filter((i) => i.change === 'same').length });
const docTitles = (p: Proposal, from: string | null) => [...(from ? [sourceTitle(from)] : []), SUMMARY_TITLE, ...p.docs.map((d) => d.title)];

// ------------------------------------------------------------------------------------------------ apply
async function folder(c: PoolClient, name: string, parent: string | null, onlyMe: boolean, me: string): Promise<string> {
  const had = (await c.query(`select id from pulse.doc_folder where archived_at is null and lower(name)=lower($1) and parent_id is not distinct from $2::uuid order by created_at limit 1`, [name, parent])).rows[0];
  if (had) {
    // A private folder found by name must still be open to no one else; refuse to put private material in a shared one.
    if (onlyMe && (await c.query(`select access from pulse.doc_folder where id=$1`, [had.id])).rows[0]?.access !== 'people') fail(409, `The folder "${name}" is open to the company: rename it, then run the setup again`);
    return String(had.id);
  }
  return saveFolder(c, null, { name, parentId: parent, ...(onlyMe ? { access: 'people', people: [me] } : {}) });
}
const summaryMarkdown = (p: Proposal, w: Words) => [
  `# ${SUMMARY_TITLE}`, '', 'Made by the company setup. Change anything here in Settings, Work and Processes.', '',
  '## Our words', ...WORD_KEYS.filter((_, i) => i % 2 === 0).map((k) => `- ${cap(k)}: ${w[k]} (many: ${w[WORD_KEYS[WORD_KEYS.indexOf(k) + 1]]})`), '',
  ...(p.teams.length ? ['## Teams', ...p.teams.map((t) => `- ${t.name}${t.kind === 'department' ? ` (${w.department ?? 'department'})` : ''}`), ''] : []),
  ...(p.roles.length ? ['## Roles', ...p.roles.map((r) => `- ${r.name}`), ''] : []),
  ...(p.workflows.length ? ['## Processes (drafts)', ...p.workflows.flatMap((x) => [`### ${x.name}`, ...x.steps.map((s, i) => `${i + 1}. ${s.title}${s.role ? ` (${s.role})` : ''}`), '']), ''] : []),
  ...(p.goals.length ? ['## Goals', ...p.goals.map((g) => `- ${g.title}${g.targetOn ? ` (by ${g.targetOn})` : ''}`), ''] : []),
  ...(p.projects.length ? ['## Projects', ...p.projects.map((x) => `- ${x.name}`), ''] : []),
].join('\n');

/** Apply a proposal in the caller's transaction; a dry run does it all and undoes it. */
export async function applySetup(c: PoolClient, v: Viewer, b: { from?: string; text?: string; class: SetupClass; proposal?: unknown; dryRun?: boolean }) {
  const plan = await planSetup(c, v, b);
  const me = v.person ?? fail(403, 'Sign in as a person to set up the company');
  const { proposal: p, from } = plan, text = typeof b.text === 'string' ? b.text.slice(0, MAX_SOURCE) : '';
  const made: { kind: string; name: string; id: string }[] = [];
  await c.query('savepoint company_setup');
  try {
    const h = await have(c, docTitles(p, text.trim() ? from : null));
    // Words: only the ones proposed change. A group of teams nobody named stays derived from the team word (not stored).
    const stored = { ...((await c.query('select words from pulse.org_pack where org_id=pulse.current_org()')).rows[0]?.words ?? {}), ...p.words } as Record<string, unknown>;
    const words = wordsOf(stored);
    if (Object.keys(p.words).length) {
      const keep = Object.fromEntries(Object.entries(words).filter(([k]) => !k.startsWith('department') || (typeof stored[k] === 'string' && (stored[k] as string).trim())));
      await c.query(`insert into pulse.org_pack(org_id,pack_key,words,updated_by) values(pulse.current_org(),'neutral',$1,$2)
        on conflict(org_id) do update set words=excluded.words,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify(keep), me]);
    }
    // Each item is tried on its own: what this person's role may not make (teams are admins'; projects are leadership's or
    // a pod head's in their pod; company goals are leadership's and admins') is skipped, and left says who can add it.
    const skipped: { kind: string; name: string; why: string }[] = [];
    let sp = 0;
    const attempt = async <T>(kind: string, name: string, make: () => Promise<T>): Promise<T | null> => {
      const s = `company_setup_item_${++sp}`;
      await c.query(`savepoint ${s}`);
      try { const out = await make(); await c.query(`release savepoint ${s}`); return out; }
      catch (e) {
        const err = e as { code?: string; statusCode?: number; message?: string };
        if (err.code !== '42501' && err.statusCode !== 403) throw e;
        await c.query(`rollback to savepoint ${s}`);
        skipped.push({ kind, name, why: String(err.message ?? 'Your role cannot make this') });
        return null;
      }
    };
    for (const t of p.teams) {
      if (h.teams.has(lower(t.name))) continue;
      const id = await attempt('team', t.name, async () => String((await c.query(`insert into pulse.unit(org_id,kind,name) values(pulse.current_org(),$1,$2) returning id`, [t.kind === 'department' ? 'department' : 'pod', t.name])).rows[0].id));
      if (id) { h.teams.set(lower(t.name), { id, name: t.name, kind: t.kind }); made.push({ kind: 'team', name: t.name, id }); }
    }
    let pos = Number((await c.query('select coalesce(max(position),0) n from pulse.work_role where archived_at is null')).rows[0].n);
    for (const r of p.roles) {
      const key = keyOf(r.name);
      if (h.roles.has(key)) continue;
      const id = await attempt('role', r.name, async () => String((await c.query(`insert into pulse.work_role(org_id,key,name,note,screens,home,tiles,position,created_by,updated_by,source)
        values(pulse.current_org(),$1,$2,$3,$4,null,$5,$6,$7,$7,'setup') returning id`, [key, r.name, r.note ?? null, ['work', 'sops'],
        JSON.stringify([{ key: 'mine', label: 'My steps', of: 'mine', href: '/me/steps' }]), pos += 10, me])).rows[0].id));
      if (id) { h.roles.set(key, id); made.push({ kind: 'role', name: r.name, id }); }
    }
    for (const w of p.workflows) {
      if (h.workflows.has(lower(w.name))) continue;
      const roles = [...new Map(w.steps.filter((s) => s.role).map((s) => [keyOf(s.role!), { key: keyOf(s.role!), label: s.role! }])).values()];
      const def = normalizeFlow({ roles, steps: w.steps.map((s, i) => ({ id: `s${i + 1}`, block: 'task', title: s.title,
        who: s.role ? { by: 'role', role: keyOf(s.role) } : { by: 'starter' }, settings: {}, pos: { x: 80 + i * 260, y: 120 } })) });
      const writeup = [{ key: 'steps', title: 'The steps', body: w.steps.map((s, i) => `${i + 1}. ${s.title}${s.role ? ` (${s.role})` : ''}`).join('\n') }];
      const id = await attempt('workflow', w.name, async () => {
        const pid = String((await c.query(`insert into pulse.flow_process(org_id,name,summary,writeup,definition,created_by,updated_by) values(pulse.current_org(),$1,$2,$3,$4,$5,$5) returning id`,
          [w.name, w.summary ?? `Drafted by the company setup from ${b.class === 'private' ? 'a private source' : from}. Check the steps, then publish it.`, JSON.stringify(writeup), JSON.stringify(def), me])).rows[0].id);
        await c.query(`select pulse.audit_write('insert','flow_process',$1)`, [pid]);
        return pid;
      });
      if (id) { h.workflows.set(lower(w.name), id); made.push({ kind: 'workflow', name: w.name, id }); }
    }
    for (const g of p.goals) {
      if (h.goals.has(lower(g.title))) continue;
      const id = await attempt('goal', g.title, () => saveGoal(c, null, { level: 'company', title: g.title, ...(g.why ? { why: g.why } : {}), ...(g.targetOn ? { targetOn: g.targetOn } : {}) }));
      if (id) { h.goals.set(lower(g.title), id); made.push({ kind: 'goal', name: g.title, id }); }
    }
    for (const x of p.projects) {
      let id = h.projects.get(lower(x.name)) ?? null;
      if (!id) {
        id = await attempt('project', x.name, async () => {
          const r = (await c.query('select pulse.work_project_save(null,$1) v', [JSON.stringify({ type: 'internal', name: x.name, ...(x.summary ? { summary: x.summary } : {}) })])).rows[0]?.v;
          return String(r?.id ?? r?.projectId ?? fail(409, `The project "${x.name}" could not be made`));
        });
        if (id) { h.projects.set(lower(x.name), id); made.push({ kind: 'project', name: x.name, id }); }
      }
      const goal = x.goal ? h.goals.get(lower(x.goal)) : undefined;
      if (goal && id) await attempt('link', x.name, () => linkGoal(c, goal, { projectId: id! }));
    }
    // Docs: the source (private: a folder open only to this person; public: the company's), the summary, and any written.
    const root = await folder(c, FOLDER, null, false, me);
    const priv = b.class === 'private' ? await folder(c, PRIVATE_FOLDER, root, true, me) : null;
    const put = async (title: string, markdown: string, where: string, access: 'private' | 'company') => {
      if (h.docs.has(lower(title))) return;
      const id = await saveDoc(c, null, { title, markdown, folderId: where, access, category: 'Company setup' }, 'import');
      h.docs.set(lower(title), id); made.push({ kind: 'doc', name: title, id });
    };
    if (text.trim()) await put(sourceTitle(from), text, priv ?? await folder(c, PUBLIC_FOLDER, root, false, me), priv ? 'private' : 'company');
    for (const d of p.docs) await put(d.title, d.markdown, priv ?? root, priv ? 'private' : 'company');
    await put(SUMMARY_TITLE, summaryMarkdown(p, words), root, 'company');
    // The guide: what this setup did is done (words, a project, targets); the guide then shows only what is left. Only its
    // own function reads it (pulse_api has no grant on org_onboarding); a company without a guide has nothing to tick (P0002).
    const any = (k: string) => made.some((m) => m.kind === k) || (k === 'project' ? p.projects.some((x) => h.projects.has(lower(x.name))) : p.goals.some((g) => h.goals.has(lower(g.title))));
    for (const [item, did] of [['words', Object.keys(p.words).length > 0], ['project', any('project')], ['targets', any('goal')]] as const) {
      if (!did) continue;
      await c.query('savepoint company_setup_guide');
      try { await c.query('select pulse.onboarding_mark($1,true)', [item]); await c.query('release savepoint company_setup_guide'); }
      catch (e) {
        await c.query('rollback to savepoint company_setup_guide');
        if ((e as { code?: string }).code !== 'P0002') throw e;
        break;
      }
    }
    const counts = tally(plan.items);
    // Every run is in the company's audit log (by the source's sha256, never its words); the pack's history too when it has one.
    await c.query(`select pulse.audit_write('insert','company_setup',$1,$2)`, [plan.sha256, [`class=${b.class}`, `made=${made.length}`, `skipped=${skipped.length}`]]);
    await c.query(`update pulse.org_pack set history=history||jsonb_build_array(jsonb_build_object('setup',$1::text,'class',$2::text,'sha256',$3::text,'at',now(),'by',$4::uuid,'made',$5::int))
      where org_id=pulse.current_org()`, [from, b.class, plan.sha256, me, made.length]);
    const WHO: Record<string, string> = { team: 'an admin', project: 'leadership', goal: 'leadership or an admin' };
    const left = [...[...new Set(skipped.map((x) => x.kind))].map((k) => {
      const these = skipped.filter((x) => x.kind === k);
      return { label: `Ask ${WHO[k] ?? 'leadership'} to add ${these.length} ${these.length === 1 ? k : `${k}s`}`, href: '/settings?tab=industry',
        why: `${these[0].why.replace(/[.\s]+$/, '')}. Not made: ${these.map((x) => x.name).slice(0, 5).join(', ')}${these.length > 5 ? '…' : ''}. Running the same setup again adds them.` };
    }), ...await leftToDo(c)];
    if (b.dryRun) await c.query('rollback to savepoint company_setup');
    else await c.query('release savepoint company_setup');
    return { ...plan, dryRun: b.dryRun === true, made: b.dryRun ? made.map((m) => ({ ...m, id: '' })) : made, counts, left };
  } catch (e) {
    await c.query('rollback to savepoint company_setup').catch(() => undefined);
    throw e;
  }
}
