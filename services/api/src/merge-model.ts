import { sameWork, workTokens } from './task-focus.js';

/** TASK-MERGE (owner, 7 Nov 2026): the merge suggester. Pure and deterministic: it reads one person's open tasks and
 *  proposes (a) duplicates: two or more tasks that read as the same work, merged into one task, and (b) clusters: three
 *  or more tasks about one thing (the same words, the same project, the same kind of work) that could become one brief
 *  with a step per task. Every proposal says why in plain words. Nothing is merged by it: a person accepts or rejects.
 *
 *  Signals are real structure and words together, never words alone for a cluster: title tokens (the task page's own
 *  "same work" rule, task-focus.ts), the project, the kind of work, how close the due days are, and, when the decision
 *  model is on (DECISION-MODELS.md, feature "merge_embeddings"), the cosine of the titles' sentence embeddings. */
export type MTask = { id: string; title: string; projectId: string | null; projectName: string | null; category: string | null;
  dueOn: string | null; parentId: string | null };
export type PairScore = { dup: number; near: number; reasons: string[] };
export type Proposal = { kind: 'duplicate' | 'cluster'; taskIds: string[]; score: number; method: 'words' | 'embedding';
  title: string; reason: string; shape: 'task' | 'brief' };
export type Cosine = (a: string, b: string) => number | null;

export const DUPLICATE_AT = 0.6;   // the task page's SAME_WORK_AT
// DECISION-MODELS.md (static 256-d model on synthetic Hinglish pairs): true duplicates 0.65-0.92, related work 0.53-0.69,
// unrelated <= 0.19. Words must agree too below 0.9; a cluster needs 0.65 inside one project.
export const COSINE_DUPLICATE_AT = 0.8;
export const COSINE_CLUSTER_AT = 0.65;
export const CLUSTER_AT = 0.5;
export const MAX_CLUSTER = 12;
const GENERIC = new Set(['task', 'tasks', 'work', 'todo', 'do', 'make', 'create', 'update', 'check', 'send', 'follow', 'up', 'new', 'example']);

const days = (a: string | null, b: string | null) => a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 86400000 : null;
export const strong = (title: string) => workTokens(title).filter((w) => !GENERIC.has(w));

/** How alike two tasks are: `dup` (the same work) and `near` (belong in one brief), each 0..1, with the reasons. */
export function pairScore(a: MTask, b: MTask, cos: number | null = null): PairScore {
  const x = strong(a.title), y = strong(b.title), ys = new Set(y);
  const shared = x.filter((w) => ys.has(w));
  const overlap = x.length && y.length ? shared.length / Math.min(x.length, y.length) : 0;
  const sameProject = !!a.projectId && a.projectId === b.projectId;
  const noProject = !a.projectId && !b.projectId;
  const sameKind = !!a.category && a.category === b.category;
  const gap = days(a.dueOn, b.dueOn);
  const reasons: string[] = [];
  if (shared.length) reasons.push(`the same words: ${shared.slice(0, 4).join(', ')}`);
  if (sameProject) reasons.push(`both in ${a.projectName ?? 'the same project'}`);
  if (sameKind) reasons.push('the same kind of work');
  if (gap !== null && gap <= 7) reasons.push(gap < 1 ? 'due the same day' : `due within ${Math.ceil(gap)} days`);
  if (cos !== null && cos >= 0.8) reasons.push('they mean the same (the decision model)');
  // A parent and its own subtask are not duplicates of each other.
  const family = a.parentId === b.id || b.parentId === a.id;
  // The same work leaves almost nothing over: "carousel post: amenities" and "carousel post: pricing" are two posts (a brief).
  const left = x.length + y.length - 2 * shared.length;
  const words = left <= 1 ? sameWork(a.title, b.title) : 0;
  const dup = family || !(sameProject || noProject) ? 0 : Math.max(words, cos !== null && cos >= COSINE_DUPLICATE_AT && overlap >= 0.34 ? cos : 0);
  // Near: the words carry most of it, structure the rest; one shared word alone never makes a cluster.
  const sem = cos ?? overlap;
  // Structure alone: the same project and due within two days of each other is one piece of work in steps (a launch day,
  // a month's payroll), even when the titles share no words.
  const together = sameProject && gap !== null && gap <= 2;
  if (together && !reasons.some((r) => r.startsWith('due'))) reasons.push('due together');
  const near = together ? Math.min(1, 0.5 + 0.15 * Math.min(overlap * 2, 1) + (cos !== null ? 0.2 * Math.max(0, cos - 0.3) : 0))
    : shared.length < 2 && !(cos !== null && cos >= COSINE_CLUSTER_AT && sameProject) ? 0
    : Math.min(1, 0.5 * overlap + 0.2 * sem + (sameProject ? 0.2 : noProject ? 0.05 : 0) + (sameKind ? 0.05 : 0) + (gap !== null && gap <= 7 ? 0.05 : 0));
  return { dup: Math.round(dup * 1000) / 1000, near: Math.round(near * 1000) / 1000, reasons };
}

/** A short title for what the tasks have in common: the shared words in the first task's own spelling and order. */
export function commonTitle(tasks: MTask[]) {
  const counts = new Map<string, number>();
  for (const t of tasks) for (const w of new Set(strong(t.title))) counts.set(w, (counts.get(w) ?? 0) + 1);
  const need = Math.max(2, Math.ceil(tasks.length * 0.6));
  const keep = new Set([...counts].filter(([, n]) => n >= need).map(([w]) => w));
  const words = tasks[0].title.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
  const picked: string[] = [];
  for (const w of words) { const s = strong(w)[0]; if (s && keep.has(s) && !picked.some((p) => strong(p)[0] === s)) picked.push(w); }
  const phrase = picked.join(' ').trim();
  return phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : '';
}

/** Proposals for one person's open tasks. `apart` holds pairs people said are different ("a:b", a<b). */
export function propose(tasks: MTask[], { apart = new Set<string>(), cosine }: { apart?: Set<string>; cosine?: Cosine } = {}): Proposal[] {
  const list = tasks.slice(0, 400);
  const key = (a: string, b: string) => a < b ? `${a}:${b}` : `${b}:${a}`;
  // Candidate pairs share at least one strong word (an index keeps this near-linear), or the model links them.
  const byWord = new Map<string, number[]>();
  list.forEach((t, i) => { for (const w of new Set(strong(t.title))) byWord.set(w, [...(byWord.get(w) ?? []), i]); });
  // ... or sit in one project (structure: steps of one piece of work need not share words).
  list.forEach((t, i) => { if (t.projectId) byWord.set(`project:${t.projectId}`, [...(byWord.get(`project:${t.projectId}`) ?? []), i]); });
  const seen = new Set<string>(); const scores = new Map<string, PairScore>(); let usedModel = false;
  for (const ids of byWord.values()) {
    if (ids.length > 120) continue; // a word (or a project) on most tasks says nothing
    for (let p = 0; p < ids.length; p++) for (let q = p + 1; q < ids.length; q++) {
      const a = list[ids[p]], b = list[ids[q]], k = key(a.id, b.id);
      if (seen.has(k)) continue; seen.add(k);
      if (apart.has(k)) continue;
      const cos = cosine ? cosine(a.id, b.id) : null; if (cos !== null) usedModel = true;
      const s = pairScore(a, b, cos); if (s.dup > 0 || s.near > 0) scores.set(k, s);
    }
  }
  const byId = new Map(list.map((t) => [t.id, t]));
  const sim = (a: string, b: string) => scores.get(key(a, b));
  const method: Proposal['method'] = usedModel ? 'embedding' : 'words';
  const out: Proposal[] = [];
  // 1. Duplicates: groups joined by "the same work" pairs (every member the same work as at least one other).
  const parent = new Map<string, string>(); const paired = new Set<string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  for (const [k, s] of scores) if (s.dup >= DUPLICATE_AT) { const [a, b] = k.split(':'); paired.add(a); paired.add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
  const groups = new Map<string, string[]>();
  for (const t of list) if (paired.has(t.id)) { const r = find(t.id); groups.set(r, [...(groups.get(r) ?? []), t.id]); }
  const inDup = new Set<string>();
  for (const ids of groups.values()) {
    if (ids.length < 2 || ids.length > 6) continue;
    const pairs = ids.flatMap((a, i) => ids.slice(i + 1).map((b) => sim(a, b))).filter(Boolean) as PairScore[];
    const score = pairs.reduce((n, s) => n + s.dup, 0) / Math.max(1, pairs.filter((s) => s.dup > 0).length);
    const members = ids.map((i) => byId.get(i)!);
    const why = [...new Set(pairs.flatMap((s) => s.reasons))].slice(0, 3);
    ids.forEach((i) => inDup.add(i));
    out.push({ kind: 'duplicate', taskIds: ids, score: Math.min(1, Math.round(score * 1000) / 1000), method, shape: 'task',
      title: members.map((m) => m.title).sort((a, b) => b.length - a.length)[0],
      reason: `${ids.length} tasks read as the same work: ${why.join('; ')}.` });
  }
  // 2. Clusters: average linkage over "near" pairs, strongest first, never past MAX_CLUSTER.
  const edges = [...scores].filter(([, s]) => s.near >= CLUSTER_AT).sort((a, b) => b[1].near - a[1].near);
  const cluster = new Map<string, Set<string>>(list.map((t) => [t.id, new Set([t.id])]));
  const linkage = (A: Set<string>, B: Set<string>) => { let n = 0; for (const a of A) for (const b of B) n += sim(a, b)?.near ?? 0; return n / (A.size * B.size); };
  for (const [k] of edges) {
    const [a, b] = k.split(':'); const A = cluster.get(a)!, B = cluster.get(b)!;
    if (A === B || A.size + B.size > MAX_CLUSTER || linkage(A, B) < CLUSTER_AT) continue;
    const M = new Set([...A, ...B]); for (const x of M) cluster.set(x, M);
  }
  for (const C of new Set(cluster.values())) {
    if (C.size < 3) continue;
    const ids = [...C]; if (ids.every((i) => inDup.has(i)) && groups.size && [...groups.values()].some((g) => g.length === ids.length && g.every((i) => C.has(i)))) continue;
    const members = ids.map((i) => byId.get(i)!).sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'));
    const pairs = ids.flatMap((a, i) => ids.slice(i + 1).map((b) => sim(a, b)?.near ?? 0));
    const score = pairs.reduce((n, s) => n + s, 0) / pairs.length;
    const project = members.every((m) => m.projectId && m.projectId === members[0].projectId) ? members[0].projectName : null;
    const dues = members.map((m) => m.dueOn).filter(Boolean) as string[];
    const phrase = commonTitle(members);
    const head = phrase || `${project ?? 'Work'} due ${dues[0] ?? 'together'}`;
    const span = dues.length > 1 ? days(dues[0], dues[dues.length - 1]) : null;
    out.push({ kind: 'cluster', taskIds: members.map((m) => m.id), score: Math.round(score * 1000) / 1000, method, shape: 'brief',
      title: (phrase ? `${phrase}${project && !phrase.toLowerCase().includes(project.toLowerCase()) ? ` · ${project}` : ''}` : head).slice(0, 300),
      reason: `${members.length} tasks ${phrase ? `about “${phrase}”` : 'that are steps of one piece of work'}${project ? ` in ${project}` : ''}${span !== null ? (span < 1 ? ', due the same day' : span <= 1 ? ', due a day apart' : `, due across ${Math.ceil(span)} days`) : ''}: one brief with a step each keeps them in one place.` });
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'duplicate' ? -1 : 1) || b.score - a.score).slice(0, 40);
}

/** The merged task's notes. A brief lists each original as a numbered step (the task page turns them into a checklist). */
export function briefNotes(sources: { title: string; dueOn: string | null; notes: string | null }[], shape: 'task' | 'brief', reason: string | null) {
  const lines: string[] = [];
  if (reason) lines.push(`Why: ${reason}`, '');
  lines.push(shape === 'brief' ? `This brief brings together ${sources.length} tasks. Steps:` : `Made from ${sources.length} tasks:`);
  sources.forEach((s, i) => lines.push(`${shape === 'brief' ? `${i + 1}.` : '-'} ${s.title.replace(/\s+/g, ' ').trim()}${s.dueOn ? ` (was due ${s.dueOn})` : ''}`));
  const kept = sources.filter((s) => s.notes && s.notes.trim());
  if (kept.length) {
    lines.push('', 'Notes from the originals:');
    for (const s of kept) lines.push(`- ${s.title.slice(0, 80)}: ${s.notes!.replace(/\s+/g, ' ').trim().slice(0, 400)}`);
  }
  return lines.join('\n').slice(0, 3900);
}
