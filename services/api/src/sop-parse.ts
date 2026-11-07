/** SOP-WORKFLOW: reads an SOP written for people (a Google Doc, a Word file, a PDF's text, or pasted text) into the
 *  SOP model: phases, steps, the role that owns each step and the roles it involves, inputs and outputs, KPIs, time and
 *  SLA, approvals and decisions, and "watch out for" lists. Each part comes with a confidence and the evidence it rests
 *  on, so leadership can judge it before confirming. Pure and deterministic: no model, no network.
 *
 *  What it understands, from EA's own documents:
 *   - step tables (a "Step | PGS Tasks / Responsibility | KPIs" table, exported as tab-led cells with • bullets);
 *   - numbered steps ("1. Sample Flat Check", "Step 2: Prepare Content First", "#3: Select ABO or CBO") with bullets;
 *   - phases ("Phase 1 — Project Blueprint™") and several SOPs in one file ("SOP: Img", "Model Selection Process");
 *   - sections that are not steps (Objective, Team Structure, Common Challenges, Overview). */
import { normalizeDoc, type SopDoc, type SopStep } from './sop-model.js';

export type ParsedSop = { title: string; purpose: string | null; ownerRole: string | null; doc: SopDoc; confidence: number; evidence: string[] };
type Item = { title: string; lines: string[]; table?: { role: string | null; detail: string[]; kpis: string[]; time: string | null; owner: string | null } };
type Section = { heading: string | null; phase: string | null; items: Item[]; steppy: boolean; intro: string[] };

const GENERIC_ROLES = ['Project Growth Strategist', 'PGS', 'Creative Strategist', 'Graphic Designer', 'Designer', 'Video Editor', 'Editor', 'Videographer',
  'Cinematographer', 'Social Media Executive', 'Performance Marketer', 'Senior PM', 'Senior Performance Marketer', 'PM', 'Intern', 'Project Coordinator',
  'Access Coordinator', 'Resource Coordinator', 'Coordinator', 'Account Manager', 'Project Manager', 'Sales Head', 'Sales Team', 'Client', 'Model', 'Production Head',
  'Script Writer', 'Content Writer', 'Copywriter', 'Team Lead', 'HR', 'Founder', 'CEO', 'Accountant', 'Field Technician', 'Technician', 'Installer', 'Supervisor'];
const NON_STEP = /^(objective|purpose|scope|overview|introduction|background|summary|team structure|structure|glossary|definitions?|contents|table of contents|notes?|important notes?|why\b|what is\b|who is\b|kpis?\b|outcome|deliverables|support|links?)\b/i;
const WATCH = /\b(challenges?|problems?|issues?|mistakes?|risks?|avoid|don'?ts|pitfalls|common errors)\b/i;
const PHASE = /^(?:phase|stage)\s*#?\s*(\d{1,2})\b\s*[—–:\-.]?\s*(.*)$/i;
const PART = /^\s*(?:sop\s*[:\-–]\s*(.+)|(.{3,80}?)\s*[–—-]?\s*\b(process|procedure|workflow|sop|checklist)\s*(?:™)?\s*:?)$/i;
const NUMBERED = /^\s*(?:step\s*#?\s*(\d{1,2})\s*[:.)\-–]\s*|#\s?(\d{1,2})\s*[:.)\-–]\s*|(\d{1,2})\s*[.)]\s+)(.*)$/i;
const BULLET = /^(\s*)[*•\-–▪●◦]\s+(.*)$/;
const INPUT_INTRO = /(must (?:make sure|ensure)|required|mandatory|you(?:'ll| will)? need|before (?:assigning|starting|the intern starts|you start)|inputs?\b|keep ready|collect)/i;
const OUTPUT_INTRO = /(deliverables?|outputs?|the (?:content|submission) should include|submit|hand ?over|share (?:the )?following)/i;

const tidy = (s: string) => s.replace(/\s+/g, ' ').replace(/^[\s*•\-–:#]+/, '').trim();
const short = (s: string, n = 200) => s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;

/** A role lexicon: the organisation's own role names first, then common ones. Short acronyms match in capitals only. */
function lexicon(known: string[]) {
  // An organisation's one-word role names that are everyday words ("Sales", "Social") would match "Social Media":
  // only names of two or more words, acronyms (PGS, HOO) and the common roles below are read.
  const own = known.map((r) => r.replace(/\s*\(.*\)\s*$/, '').trim()).filter((r) => r.length >= 2 && r.length <= 40 && !/^team member$/i.test(r)
    && (/\s/.test(r) || /^[A-Z]{2,5}$/.test(r) || GENERIC_ROLES.some((g) => g.toLowerCase() === r.toLowerCase())));
  const names = [...new Set([...own, ...GENERIC_ROLES])];
  const rules = names.sort((a, b) => b.length - a.length).map((name) => ({ name, re: name.length <= 3 && name === name.toUpperCase()
    ? new RegExp(`(?<![A-Za-z])${name}(?![A-Za-z])`) : new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'i') }));
  return {
    all(text: string) { const out: { name: string; at: number }[] = []; let rest = text;
      for (const r of rules) { const m = r.re.exec(rest); if (m) { out.push({ name: r.name, at: m.index }); rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length); } }
      return out.sort((a, b) => a.at - b.at).map((x) => x.name); },
    first(text: string) { return this.all(text)[0] ?? null; },
    /** The role a sentence starts with, as its subject ("The intern prepares…", "Client selects…"), not its object. */
    lead(text: string) { const t = text.replace(/^\s*(?:the|a|an|our|your|each|every)\s+/i, ''); for (const r of rules) { const m = r.re.exec(t); if (m && m.index === 0) return r.name; } return null; },
  };
}

/** Time words in a step: an SLA ("within 24 hours", "same day", "by EOD", "Duration - 3 days") or effort ("takes 2 hours"). */
export function readTime(text: string): { minutes: number | null; slaHours: number | null } {
  const unit = (n: number, u: string) => /^m/i.test(u) ? n / 60 : /^h/i.test(u) ? n : /^w/i.test(u) ? n * 24 * 7 : /^mo/i.test(u) ? n * 24 * 30 : n * 24;
  let sla: number | null = null, minutes: number | null = null;
  const within = /\b(?:within|in|before|under|tat|turnaround|sla|duration|deadline)\s*[:\-–]?\s*(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(minutes?|mins?|hours?|hrs?|h\b|working days?|business days?|days?|weeks?|months?)/i.exec(text);
  if (within) sla = unit(Number(within[2] ?? within[1]), within[3].replace(/^(working|business) /i, ''));
  else if (/\b(same day|end of (?:the )?day|by eod|eod)\b/i.test(text)) sla = 8;
  else if (/\b(next day|within a day|24 ?hours?)\b/i.test(text)) sla = 24;
  const takes = /\b(?:takes?|spend|effort|approx(?:imately)?\.?|about|around)\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?)/i.exec(text);
  if (takes) minutes = Math.round(unit(Number(takes[1]), takes[2]) * 60);
  return { minutes, slaHours: sla === null ? null : Math.round(sla * 100) / 100 };
}

function kindOf(title: string, detail: string): SopStep['kind'] {
  if (/\b(approv\w*|sign[- ]?off|final review)\b/i.test(title) || /\breview\b/i.test(title) && /\b(approv|before (?:it|they|we) (?:go|goes|move|publish))/i.test(detail)) return 'approval';
  if (/\breview\b/i.test(title)) return 'approval';
  if (/^(if\b|decide|check (?:if|whether))|\?$/i.test(title.trim())) return 'decision';
  return 'task';
}

/** "Ensure required brochures, logos, fonts and PSDs are available" → the things listed. */
function listed(text: string, re: RegExp) {
  const m = re.exec(text); if (!m) return [];
  return m[1].split(/,|\band\b|\/|;/).map((x) => tidy(x).replace(/^(the|all|any|other)\s+/i, '')).filter((x) => x.length >= 2 && x.length <= 60 && !/^(etc|others?)$/i.test(x)).slice(0, 8);
}
const REQUIRED = /(?:ensure|make sure|check)\s+(?:that\s+)?(?:the\s+|all\s+)?required\s+(.+?)\s+(?:are|is)\s+(?:available|ready|received|collected|shared)/i;
const COLLECT = /\b(?:collect|gather|obtain|receive)\s+(?:the\s+|all\s+)?(.+?)(?:\s+from\b|\s+before\b|[.;]|$)/i;
const PRODUCE = /\b(?:deliver|submit|share|send|publish|hand over)\s+(?:the\s+|a\s+|an\s+|final\s+)?(.+?)(?:\s+(?:with|to|in|on|for|before|after|via)\b|[.;]|$)/i;

/** Splits text into lines with table cells, items, bullets and headings told apart. */
function lines(text: string) {
  const out: string[] = []; let prev = '';
  for (const raw of text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').replace(/ /g, ' ').split('\n')) {
    const l = raw.replace(/\s+$/, ''); if (!l.trim()) { out.push(''); prev = ''; continue; }
    if (l.trim() === prev.trim()) continue;          // Docs repeats a heading on export
    if (/^\s*_{5,}\s*$/.test(l)) { out.push(''); prev = ''; continue; }
    out.push(l); prev = l;
  }
  return out;
}
const isHeading = (l: string, next: string | undefined) => !!l && !l.startsWith('\t') && !NUMBERED.test(l) && !BULLET.test(l) && l.trim().length <= 90
  && !/[.,;]$/.test(l.trim()) && next !== undefined && (/:$/.test(l.trim()) || /^[A-Z#🚀\d"“]/.test(l.trim()));

/** Reads a step table that starts at line i ("Step" then tab-led header cells, then rows of cells). */
function readTable(ls: string[], i: number): { items: Item[]; end: number; columns: string[] } | null {
  const header = [ls[i].trim()]; let j = i + 1;
  while (j < ls.length && ls[j].startsWith('\t') && !/^\t\s*(\d{1,2}[.)]|[•*])/.test(ls[j]) && ls[j].trim().length <= 60 && header.length < 8) { header.push(ls[j].trim()); j++; }
  if (header.length < 2 || !(j < ls.length && ls[j].startsWith('\t'))) return null;
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const cTitle = Math.max(0, col(/^(step|stage|activity|task name|#|sr\.?\s*no\.?|s\.?\s*no\.?)$/i));
  const cDetail = col(/(task|responsib|what|action|description|how|activities)/i);
  const cKpi = col(/(kpi|measure|metric|success|output|deliverable)/i);
  const cTime = col(/(time|duration|sla|tat|timeline|when|deadline)/i);
  const cOwner = col(/^(owner|who|role|responsible( person)?|by)$/i);
  const roleHead = cDetail >= 0 ? header[cDetail].replace(/\b(tasks?|responsibilit(y|ies)|activities|actions|what to do|description|and|&|\/)\b/gi, ' ').replace(/[\/&]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  // Cells are tab-led lines; a cell's later bullets come on lines of their own (between blank lines) and join it.
  const cells: string[] = [];
  for (; j < ls.length; j++) {
    const l = ls[j];
    if (l.startsWith('\t')) cells.push(l.trim());
    else if (!l) { const ahead = ls.slice(j + 1).find((x) => x); if (!ahead || !(ahead.startsWith('\t') || /^\s*[•*]/.test(ahead))) break; }
    else if (/^\s*[•*]/.test(l) && cells.length) cells[cells.length - 1] += ' ' + l.trim();
    else break;
  }
  const width = header.length, items: Item[] = [];
  for (let k = 0; k + width <= cells.length; k += width) {
    const row = cells.slice(k, k + width); const split = (x: string | undefined) => (x ?? '').split(/\s*•\s*/).map(tidy).filter(Boolean);
    const title = tidy(row[cTitle].replace(NUMBERED, (...m: string[]) => m[4] ?? ''));
    if (!title) continue;
    items.push({ title, lines: [], table: { role: roleHead && roleHead.length <= 40 && roleHead.split(' ').length <= 4 ? roleHead : null, detail: split(cDetail >= 0 ? row[cDetail] : undefined),
      kpis: split(cKpi >= 0 ? row[cKpi] : undefined), time: cTime >= 0 ? row[cTime] ?? null : null, owner: cOwner >= 0 ? tidy(row[cOwner] ?? '') || null : null } });
  }
  return items.length ? { items, end: j, columns: header } : null;
}

/** A table exported as "a | b | c" rows (Sheets, Word): a header row, then rows; a sheet that sets two tables side by side
 *  repeats its header, and only the first is read. */
function readPipeTable(ls: string[], i: number): { items: Item[]; end: number; columns: string[] } | null {
  const cellsOf = (l: string) => l.split('|').map((x) => x.trim());
  let header = cellsOf(ls[i]);
  const again = header.findIndex((h, k) => k > 0 && h && h.toLowerCase() === header[0].toLowerCase());
  if (again > 0) header = header.slice(0, again);
  if (header.length < 2 || header.filter(Boolean).length < 2) return null;
  // Rows that start with their number ("1) | Task | …") under a header whose first cell covers number and task
  // ("Step By Step | Task complexity | …"): the header moves one cell right.
  const sample = ls.slice(i + 1, i + 9).filter((l) => l.includes('|')).map(cellsOf);
  if (sample.length && sample.filter((r) => /^\d{1,2}[.)]?$/.test(r[0])).length >= Math.ceil(sample.length / 2) && !/^(#|no\.?|sr\.?\s*no\.?|s\.?\s*no\.?|sl\.?)$/i.test(header[0])) header = ['#', ...header];
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const cOwner = col(/(team member|owner|who|responsib|role|assigned|person|done by|doer)/i);
  const cTime = col(/(time|duration|sla|tat|timeline|when|deadline)/i);
  const cDetail = col(/(description|details|how|notes?|instructions|what to do)/i);
  const cKpi = col(/(kpi|output|deliverable|success|measure)/i);
  let cTitle = col(/^(task|step|activity|what|action|process)( name)?$/i);
  const items: Item[] = []; let j = i + 1;
  for (; j < ls.length && ls[j].includes('|'); j++) {
    const row = cellsOf(ls[j]).slice(0, header.length);
    // The title is the named column, else the first cell that is not just a number ("1)").
    const k = cTitle >= 0 && row[cTitle] && !/^\d{1,2}[.)]?$/.test(row[cTitle]) ? cTitle : row.findIndex((x) => x && !/^\d{1,2}[.)]?$/.test(x));
    if (cTitle < 0 && k >= 0) cTitle = k;
    const title = k >= 0 ? tidy(row[k].replace(NUMBERED, (...m: string[]) => m[4] ?? '')) : '';
    if (!title || title.length > 160) continue;
    items.push({ title, lines: [], table: { role: null, detail: cDetail >= 0 && row[cDetail] ? [tidy(row[cDetail])] : [], kpis: cKpi >= 0 && row[cKpi] ? [tidy(row[cKpi])] : [],
      time: cTime >= 0 ? row[cTime] ?? null : null, owner: cOwner >= 0 ? tidy(row[cOwner] ?? '') || null : null } });
  }
  return items.length >= 2 ? { items, end: j, columns: header.filter(Boolean) } : null;
}

type Part = { title: string; sections: Section[]; intro: string[]; tables: { at: string; columns: string[]; rows: number }[] };

/** One pass over the text: parts (several SOPs in one file), phases, sections, items with their bullet lines. */
function outline(title: string, text: string): Part[] {
  const ls = lines(text); const parts: Part[] = [];
  let part: Part = { title, sections: [], intro: [], tables: [] }; let phase: string | null = null;
  let sec: Section = { heading: null, phase: null, items: [], steppy: false, intro: [] }; let item: Item | null = null;
  const pushSec = () => { if (sec.items.length || sec.intro.length) part.sections.push(sec); item = null; };
  const newSec = (heading: string | null) => { pushSec(); sec = { heading, phase, items: [], steppy: false, intro: [] }; };
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]; if (!l) continue;
    const next = ls.slice(i + 1).find((x) => x);
    const t = l.trim();
    const ph = PHASE.exec(t);
    if (ph && t.length <= 90 && !l.startsWith('\t')) { phase = tidy(t.replace(/\s*[—–]\s*/, ' — ')); newSec(null); continue; }
    // A sheet's tab ("## #2 - Script Writing") is a stage of the work.
    if (/^##\s+/.test(t)) { phase = tidy(t.replace(/^##\s+/, '').replace(/^#?\d{1,2}\s*[-–—:.]\s*/, '')) || null; newSec(null); continue; }
    if ((t.match(/\|/g)?.length ?? 0) >= 2 && (next?.match(/\|/g)?.length ?? 0) >= 1 && !l.startsWith('\t')) {
      const tab = readPipeTable(ls, i);
      if (tab) { newSec(null); sec.items = tab.items; sec.steppy = true; part.tables.push({ at: phase ?? part.title, columns: tab.columns, rows: tab.items.length }); i = tab.end - 1; newSec(null); continue; }
    }
    const pm = !l.startsWith('\t') && t.length <= 90 ? PART.exec(t) : null;
    if (pm && isHeading(l, next) && !NUMBERED.test(t)) {
      const name = tidy(pm[1] ?? `${pm[2]} ${pm[3]}`).replace(/\s*[–—-]\s*$/, '');
      pushSec();
      if (part.sections.length || part.intro.length) parts.push(part);
      part = { title: name.length >= 3 ? name : title, sections: [], intro: [], tables: [] }; phase = null;
      sec = { heading: null, phase: null, items: [], steppy: false, intro: [] }; item = null; continue;
    }
    // A step table: a "Step" cell followed by tab-led header cells and rows.
    if (!l.startsWith('\t') && /^(step|stage|activity|#|sr\.?\s*no\.?|s\.?\s*no\.?)$/i.test(t) && next?.startsWith('\t')) {
      const tab = readTable(ls, i);
      if (tab) { newSec(null); sec.items = tab.items; sec.steppy = true; part.tables.push({ at: phase ?? part.title, columns: tab.columns, rows: tab.items.length }); i = tab.end - 1; newSec(null); continue; }
    }
    const nm = NUMBERED.exec(l);
    if (nm && !l.startsWith('\t\t')) {
      const body = tidy(nm[4] ?? ''); const steppy = !!(nm[1] || /^\s*step/i.test(l));
      if (!body) continue;
      if (BULLET.test(l) === false && /^\s{3,}/.test(l) && item) { item.lines.push(body); continue; }   // a numbered sub-point
      if (steppy) sec.steppy = true;
      item = { title: body, lines: [] }; sec.items.push(item); continue;
    }
    const bm = BULLET.exec(l);
    if (bm) { if (item) item.lines.push(tidy(bm[2])); else sec.intro.push('• ' + tidy(bm[2])); continue; }
    if (isHeading(l, next)) { newSec(tidy(t.replace(/:$/, ''))); continue; }
    if (item && item.lines.length < 40) item.lines.push(tidy(t)); else if (sec.intro.length < 30) sec.intro.push(tidy(t)); else if (part.intro.length < 10) part.intro.push(tidy(t));
  }
  pushSec(); parts.push(part);
  return parts.filter((p) => p.sections.some((s) => s.items.length));
}

function toSteps(p: Part, roles: ReturnType<typeof lexicon>) {
  const evidence: string[] = []; const watch: string[] = []; const outputs: string[] = []; const steps: Partial<SopStep>[] = [];
  const phases = [...new Set(p.sections.map((s) => s.phase).filter(Boolean))] as string[];
  const partRole = roles.first(p.title);
  // Watch-out lists and deliverables are kept beside the steps; sections that only describe are skipped.
  for (const s of p.sections) {
    if (s.heading && WATCH.test(s.heading)) { watch.push(...s.items.map((x) => x.title), ...s.intro.map((x) => x.replace(/^• /, ''))); continue; }
    if (s.heading && /^(deliverables?|outputs?)\b/i.test(s.heading)) outputs.push(...s.items.map((x) => x.title), ...s.intro.map((x) => x.replace(/^• /, '')));
  }
  const usable = p.sections.filter((s) => s.items.length && !(s.heading && (WATCH.test(s.heading) || NON_STEP.test(s.heading) || /^(deliverables?|outputs?)\b/i.test(s.heading))));
  // Prefer explicit steps (a table, "Step 2:"); else numbered lists; per phase, the first list when a phase has several.
  const explicit = usable.filter((s) => s.steppy);
  let chosen = explicit.length ? explicit : usable;
  if (!explicit.length && phases.length >= 2) {
    const seen = new Set<string>(); chosen = chosen.filter((s) => { const k = s.phase ?? ''; if (seen.has(k)) return false; seen.add(k); return true; });
    evidence.push('The first list in each phase was read as its steps');
  }
  let tableRole: string | null = null;
  let purpose: string | null = null;
  for (const s of chosen) for (const it of s.items) {
    if (!purpose && /^(objective|purpose|overview|summary)\b/i.test(it.title) && !it.table) purpose = it.lines.find((x) => x.length > 20) ?? null;
    if (NON_STEP.test(it.title) && !it.table) continue;
    if (WATCH.test(it.title) && !it.table) { watch.push(...it.lines); continue; }
    const split = /^(.{3,70}?)\s+[–—]\s+(.{3,})$/.exec(it.title) ?? /^(.{3,70}?):\s+(.{3,})$/.exec(it.title);
    // "Model Shortlisting (Coordinator)": a role in brackets at the end names who does it.
    const bracket = /^(.*\S)\s*\(([^()]{2,40})\)\s*$/.exec(split ? split[1] : it.title); const bracketRole = bracket ? roles.first(bracket[2]) : null;
    const title = short(tidy(bracketRole ? bracket![1] : split ? split[1] : it.title), 120);
    const detailLines = [...(split ? [split[2]] : []), ...(it.table?.detail ?? []), ...it.lines];
    const detail = detailLines.length ? detailLines.map((x) => `• ${x}`).join('\n') : null;
    const all = `${it.title} ${detailLines.join(' ')}`;
    const explicitOwner = roles.first(/\b(?:owner|responsible|who|done by|by)\s*[:\-–]\s*([A-Za-z][\w /&.-]{1,40})/i.exec(all)?.[1] ?? '');
    const head = roles.lead(title) ?? roles.first(/\b(?:by|for)\s+(?:the\s+)?([\w ]{2,40})$/i.exec(title)?.[1] ?? '');
    const firstLine = detailLines[0] ? roles.lead(detailLines[0]) : null;
    const tr = it.table ? (it.table.owner ? roles.first(it.table.owner) ?? it.table.owner : it.table.role ? roles.first(it.table.role) : null) : null;
    if (tr) tableRole = tr;
    const role = tr ?? bracketRole ?? explicitOwner ?? head ?? firstLine ?? partRole ?? null;
    const involves = roles.all(all).filter((r) => r.toLowerCase() !== (role ?? '').toLowerCase()).slice(0, 4);
    const time = readTime(`${it.table?.time ?? ''} ${all}`);
    const inputs = [...new Set([...listed(all, REQUIRED), ...listed(all, COLLECT)])].slice(0, 8);
    const produced = listed(all, PRODUCE).slice(0, 4);
    // Bullets after "must make sure the intern has:" are inputs; after "should include:" / "Deliverables" outputs.
    const intro = it.lines.findIndex((x) => /:$/.test(x));
    if (intro >= 0) { const after = it.lines.slice(intro + 1, intro + 9).filter((x) => x.length <= 80);
      if (INPUT_INTRO.test(it.lines[intro])) inputs.push(...after); else if (OUTPUT_INTRO.test(it.lines[intro])) produced.push(...after); }
    steps.push({ title, detail, role, involves, phase: s.phase, inputs: [...new Set(inputs)].slice(0, 10), outputs: [...new Set(produced)].slice(0, 8),
      kpis: it.table?.kpis ?? [], minutes: time.minutes, slaHours: time.slaHours, kind: kindOf(title, detail ?? '') });
  }
  if (p.tables.length) evidence.push(...p.tables.map((t) => `A table of ${t.rows} steps${t.at && t.at !== p.title ? ` in “${t.at}”` : ''} (${t.columns.join(' · ')})`));
  if (tableRole) evidence.push(`Who owns the steps comes from the table: ${tableRole}`);
  const used = phases.filter((ph) => steps.some((x) => x.phase === ph));
  return { steps, phases: used, purpose, watch: [...new Set(watch)].slice(0, 24), outputs: [...new Set(outputs)].slice(0, 24), evidence, explicit: explicit.length > 0, chosen: chosen.length };
}

/** Confidence from structure: explicit steps, owners, phases, a sensible length and how much of the text the steps cover. */
function confidence(p: Part, r: ReturnType<typeof toSteps>, titleSaysSop: boolean, textLength: number) {
  const n = r.steps.length; if (!n) return 0.05;
  let c = p.tables.length ? 0.45 : r.explicit ? 0.4 : 0.28;
  const owned = r.steps.filter((s) => s.role).length / n;
  if (owned >= 0.5) c += 0.12; else if (owned > 0) c += 0.05;
  if (r.phases.length >= 2) c += 0.05;
  if (titleSaysSop) c += 0.1;
  if (n >= 3 && n <= 40) c += 0.1; else if (n > 60) c -= 0.1; else if (n < 3) c -= 0.1;
  const covered = r.steps.reduce((t, s) => t + (s.title?.length ?? 0) + (s.detail?.length ?? 0), 0) / Math.max(1, textLength);
  if (covered < 0.12) c -= 0.12;
  return Math.max(0.05, Math.min(0.95, Math.round(c * 100) / 100));
}

/** The parts of a document read as SOPs (most files hold one; some hold several), best first. */
export function parseSop(input: { title: string; text: string; knownRoles?: string[] }): ParsedSop[] {
  const roles = lexicon(input.knownRoles ?? []);
  const title = tidy(input.title.replace(/\.(docx?|pdf|txt|md)$/i, '')) || 'Untitled SOP';
  const parts = outline(title, input.text);
  const titleSaysSop = /\b(sops?|standard operating|procedure|workflow|process|checklist|responsibilit)/i.test(title);
  const out: ParsedSop[] = [];
  for (const p of parts) {
    const r = toSteps(p, roles); if (!r.steps.length) continue;
    const purposeSec = p.sections.find((s) => s.heading && /^(objective|purpose|overview|summary)\b/i.test(s.heading));
    const objective = /(?:^|\n)\s*objective\s*[:\n-]\s*([^\n]{12,300})/i.exec(input.text)?.[1];
    const purpose = purposeSec?.intro.find((x) => x.length > 20) ?? r.purpose ?? (parts.length === 1 ? objective : null) ?? p.intro.find((x) => x.length > 30 && x.length < 300) ?? null;
    const counts = new Map<string, number>(); for (const s of r.steps) if (s.role) counts.set(s.role, (counts.get(s.role) ?? 0) + 1);
    const ownerRole = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const norm = normalizeDoc({ steps: r.steps.map((s, i) => ({ ...s, id: `s${i + 1}` })), phases: r.phases, outputs: r.outputs, watch: r.watch });
    if ('error' in norm) continue;
    const timed = r.steps.filter((s) => s.minutes || s.slaHours).length;
    const evidence = [
      `${r.steps.length} step${r.steps.length === 1 ? '' : 's'}${r.phases.length ? ` in ${r.phases.length} phase${r.phases.length === 1 ? '' : 's'}` : ''}`,
      ...r.evidence,
      counts.size ? `Roles: ${[...counts.keys()].slice(0, 6).join(', ')}` : 'No owner named for the steps: choose a role for each',
      ...(timed ? [`Times or SLAs found on ${timed} step${timed === 1 ? '' : 's'}`] : []),
      ...(r.watch.length ? [`${r.watch.length} common problem${r.watch.length === 1 ? '' : 's'} kept as “Watch out for”`] : []),
      ...(parts.length > 1 ? [`One of ${parts.length} SOPs in this document`] : []),
    ];
    out.push({ title: short(p.title, 200), purpose: purpose ? short(purpose, 400) : null, ownerRole, doc: norm.doc, confidence: confidence(p, r, titleSaysSop || parts.length > 1, input.text.length / Math.max(1, parts.length)), evidence });
  }
  return out.sort((a, b) => b.confidence - a.confidence || b.doc.steps.length - a.doc.steps.length).slice(0, 8);
}

/** Confidence in words, as the screens say it. */
export const confidenceWords = (c: number) => c >= 0.75 ? 'High' : c >= 0.5 ? 'Medium' : 'Low';
