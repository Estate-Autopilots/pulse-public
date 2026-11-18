// FIN-AGENT-2 (18 Nov 2026): what an AI employee learned, as tools. A published skill (agent_skill, 2240: proposed by
// the AI with its tests, published by leadership with the Money permission or an admin) is a tool every AI employee of
// the company, and every person who reads Finance, can call through API v1 and MCP:
//   list_skills  the company's published skills: what each does, how often it was used, the model calls it saved;
//   run_skill    a categoriser's rules on lines of text, at once and with no model; or any skill on a chat's files, as a
//                job in the sandbox (the chat's message shows its progress, as with a statement sent there);
//   get_job      how far a job is, and what it found (totals, the AI's guesses, GST findings).
// The database decides who may (agent_skill_tool_ok, agent_job_create, the agent_job read policy).
import { createHash } from 'node:crypto';
import { defineV1Operation, v1Fail, type V1Context } from './v1.js';
import { int, maybe, member, num, object, one, rows, str, text, uuid, type Row } from './v1-kit.js';

const SKILL = object({ name: str, title: str, kind: str, area: str, version: int, uses: num, linesHandled: num, modelCallsSaved: num,
  lastUsedAt: maybe, why: maybe, rules: { type: ['integer', 'null'] }, bank: maybe, learnedBy: maybe, publishedAt: maybe });
const LINE = object({ text: text(300), direction: { enum: ['in', 'out'] } }, ['text']);
const RESULT = object({ text: str, category: maybe, rule: maybe });
const JOB = object({ id: str, kind: str, title: str, status: str, progress: int, line: maybe, rowsIn: num, rowsOut: num, toCheck: int, tokens: int, modelCalls: int,
  error: maybe, createdAt: str, finishedAt: maybe, result: { type: ['object', 'null'] } });
const NAME = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{2,60}$' };

type Rule = { match: string; category: string; kind?: string; direction?: 'in' | 'out'; regex?: boolean };
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The sandbox's categoriser (fin_ingest.py Categoriser), for rules that are words: the first rule whose words appear in
 *  the line (as whole words, any case), on its side. A rule written as a pattern runs only in a job's sandbox. */
export function applyRules(rules: Rule[], lines: { text: string; direction?: string }[]) {
  const compiled = rules.filter((r) => !r.regex && typeof r.match === 'string' && r.match.trim().length >= 2 && typeof r.category === 'string')
    .slice(0, 2000).map((r) => ({ rx: new RegExp(`\\b${escape(r.match.trim())}\\b`, 'i'), r }));
  return lines.map((l) => {
    const hit = compiled.find(({ rx, r }) => (!r.direction || !l.direction || r.direction === l.direction) && rx.test(l.text));
    return { text: l.text, category: hit ? hit.r.category.slice(0, 60) : null, rule: hit ? hit.r.match.slice(0, 80) : null };
  });
}
const uuid5 = (s: string) => { const h = createHash('sha1').update(`pulse-skills:${s}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const allowed = async (ctx: V1Context) => { await member(ctx); if (!(await one<boolean>(ctx, 'select pulse.agent_skill_tool_ok() v'))) v1Fail(403, 'The company\'s learned skills are for its AI employees and the people who read Finance'); };

defineV1Operation({ operationId: 'listSkills', method: 'GET', path: '/api/v1/finance/skills', scope: 'finance.read',
  summary: 'The company\'s published learned skills (statement parsers, category rules), with their use',
  query: object({ area: { enum: ['finance', 'billing', 'work', 'people', 'general'] } }, []),
  response: object({ items: { type: 'array', items: SKILL } }),
  mcp: { name: 'list_skills', title: 'List learned skills',
    description: 'Lists the skills the company\'s AI employees learned and an approver published: parsers for a bank\'s statement layout (kind parser, with its bank) and ' +
      'category rules learned from what people confirmed (kind categoriser, with how many rules). Each shows its uses, the lines it handled and the model calls it saved. ' +
      'Use run_skill with a name from here instead of working the same thing out again.' },
  handler: async (ctx, { query }) => {
    await allowed(ctx);
    const list = (await one<Row[]>(ctx, 'select pulse.agent_skill_catalog($1) v', [query.area ?? null])) ?? [];
    return { items: list.map((s) => ({ name: String(s.name), title: String(s.title), kind: String(s.kind), area: String(s.area), version: Number(s.version), uses: Number(s.uses),
      linesHandled: Number(s.linesHandled), modelCallsSaved: Number(s.modelCallsSaved), lastUsedAt: (s.lastUsedAt as string) ?? null, why: (s.why as string) ?? null,
      rules: s.rules == null ? null : Number(s.rules), bank: (s.bank as string) ?? null, learnedBy: (s.learnedBy as string) ?? null, publishedAt: (s.publishedAt as string) ?? null })) };
  },
});

defineV1Operation({ operationId: 'runSkill', method: 'POST', path: '/api/v1/finance/skills/{name}/run', scope: 'finance.write',
  summary: 'Run a published learned skill: category rules on lines of text now, or any skill on a chat\'s files as a job',
  params: object({ name: NAME }),
  body: object({ lines: { type: 'array', items: LINE, minItems: 1, maxItems: 500 }, chatId: uuid, fileIds: { type: 'array', items: uuid, minItems: 1, maxItems: 20 } }, []),
  response: object({ skill: str, version: int, kind: str, lines: int, matched: int, results: { type: 'array', items: RESULT }, jobId: maybe, statusMessageId: maybe }),
  authorize: allowed,
  mcp: { name: 'run_skill', title: 'Run a learned skill', idempotent: true,
    description: 'Runs one published skill (list_skills names them). With lines ([{text, direction: in|out}], up to 500 bank narrations or payee names), a categoriser\'s ' +
      'rules give each line its category at once, with no model call (category null where no rule knows it). With chatId and fileIds (files someone attached in that chat), ' +
      'any skill, a statement parser included, runs on the files as a job in the sandbox: the chat shows its progress and the lines go to Finance → AI analyst to check; ' +
      'read it with get_job. It never saves anything to Finance by itself.' },
  handler: async (ctx, { params, body }) => {
    const b = (body ?? {}) as { lines?: { text: string; direction?: string }[]; chatId?: string; fileIds?: string[] };
    if (!!b.lines === !!b.fileIds) v1Fail(400, 'Send either lines, or chatId with fileIds');
    const s = await one<Row>(ctx, 'select pulse.agent_skill_take($1) v', [params.name]);
    const base = { skill: String(s.name), version: Number(s.version), kind: String(s.kind) };
    if (b.lines) {
      if (!['categoriser', 'rule'].includes(base.kind)) v1Fail(400, `${base.skill} is a ${base.kind}: it reads files, so send chatId and fileIds`);
      const results = applyRules(((s.body as { rules?: Rule[] })?.rules ?? []), b.lines);
      const matched = results.filter((r) => r.category).length;
      await ctx.client.query('select pulse.agent_skill_count($1,$2)', [base.skill, matched]);
      return { ...base, lines: results.length, matched, results, jobId: null, statusMessageId: null };
    }
    if (ctx.principal.kind !== 'ai') v1Fail(400, 'A person runs a skill on files from Finance → AI analyst → Send files; an AI employee sends chatId and fileIds');
    if (!b.chatId) v1Fail(400, 'Say which chat the files are in (chatId)');
    const title = `Running "${String(s.title).slice(0, 80)}" on ${b.fileIds!.length === 1 ? 'a file' : `${b.fileIds!.length} files`}`;
    const r = await one<Row>(ctx, 'select pulse.agent_job_create($1,$2,$3,null,$4,$5::uuid[],$6) v',
      ['fin.skill', title, b.chatId, JSON.stringify({ skill: base.skill, version: base.version }), b.fileIds, uuid5(`${ctx.principal.id}|${b.chatId}|${base.skill}|${[...b.fileIds!].sort().join(',')}`)]);
    return { ...base, lines: 0, matched: 0, results: [], jobId: String(r.id), statusMessageId: (r.statusMessageId as string) ?? null };
  },
});

defineV1Operation({ operationId: 'getJob', method: 'GET', path: '/api/v1/finance/jobs/{jobId}', scope: 'finance.read',
  summary: 'How far an AI employee\'s job is, and what it found',
  params: object({ jobId: uuid }),
  response: object({ job: JOB }),
  mcp: { name: 'get_job', title: 'Read a job', description: 'Reads one heavy job (a statement read, a GST check, a skill run): its status (queued, running, done, failed), progress, ' +
    'the line people see, how many lines are still to check, its model calls and tokens, and what it found: totals, the AI\'s guesses, and for GST the months and findings ' +
    '(GSTR-1 vs GSTR-3B, credit above GSTR-2B, invoices missing either side, supplier bills with no payment). An AI employee reads its own jobs.' },
  handler: async (ctx, { params }) => {
    await member(ctx);
    const j = (await rows(ctx, `select j.id,j.kind,j.title,j.status,j.progress,j.status_line "line",j.rows_in::float "rowsIn",j.rows_out::float "rowsOut",j.tokens,j.model_calls "modelCalls",
      j.error,j.created_at::text "createdAt",j.finished_at::text "finishedAt",j.result,(select count(*)::int from pulse.fin_review_item r where r.job_id=j.id and r.status='open') "toCheck"
      from pulse.agent_job j where j.id=$1`, [params.jobId]))[0] ?? v1Fail(404, 'No such job, or not one you may read');
    const res = (j.result ?? null) as Row | null;
    // The result as people read it: totals and what needs them, not every line (those are in Finance → AI analyst).
    const result = res ? { totals: res.totals ?? null, months: res.months ?? null, missingMonths: res.missingMonths ?? null, unclear: Array.isArray(res.unclear) ? res.unclear.slice(0, 20) : null,
      ai: res.ai ?? null, learned: res.learned ?? null, added: res.added ?? null, files: res.files ?? null,
      gst: res.gst ? { months: (res.gst as Row).months, counts: (res.gst as Row).counts, findings: Array.isArray((res.gst as Row).findings) ? ((res.gst as Row).findings as Row[]).slice(0, 50) : [], notes: (res.gst as Row).notes } : null } : null;
    return { job: { id: String(j.id), kind: String(j.kind), title: String(j.title), status: String(j.status), progress: Number(j.progress), line: (j.line as string) ?? null,
      rowsIn: Number(j.rowsIn), rowsOut: Number(j.rowsOut), toCheck: Number(j.toCheck), tokens: Number(j.tokens), modelCalls: Number(j.modelCalls), error: (j.error as string) ?? null,
      createdAt: String(j.createdAt), finishedAt: (j.finishedAt as string) ?? null, result } };
  },
});

