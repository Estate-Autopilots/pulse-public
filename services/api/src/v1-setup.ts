// ONBOARD-CONFIG (owner, 13 Nov 2026, G3 T3.1.2): set a company up from a transcript, over API v1, so MCP (named tools),
// the `pulse` CLI (`pulse setup plan --from transcript.md --class private`) and the REST API share one definition. The
// reading, the diff and the apply are setup-config.ts; leadership and admins set a company up (the screens' own rule).
import { applySetup, planSetup, type SetupClass } from './setup-config.js';
import { LIMITS } from './setup-limits.js';
import { defineV1Operation, v1Fail } from './v1.js';
import { bool, int, member, object, str, text, viewerOf, type Row } from './v1-kit.js';

const arr = (items: unknown, maxItems: number) => ({ type: 'array', maxItems, items });
const opt = (max: number) => ({ type: 'string', maxLength: max });
const WORD = opt(40);
const WORDS = object({ client: WORD, clients: WORD, project: WORD, projects: WORD, run: WORD, runs: WORD, team: WORD, teams: WORD, lead: WORD, leads: WORD,
  head: WORD, heads: WORD, department: WORD, departments: WORD }, []);
const PROPOSAL = object({
  words: { ...WORDS, description: 'The company\'s words, one and many: team/teams (Pod, Squad, Department…), head/heads (who leads a team: Head, Lead, Captain), department/departments (a group of teams), client/clients (Customer, Patient…), project/projects (Campaign, Case…), lead/leads (a sales lead: Prospect, Enquiry), run/runs (one run of a process). Only the words given change.' },
  teams: arr(object({ name: text(80), kind: { enum: ['team', 'department'] } }, ['name']), LIMITS.teams),
  roles: arr(object({ name: text(80), note: opt(300) }, ['name']), LIMITS.roles),
  workflows: arr(object({ name: text(120), summary: opt(1000), steps: arr(object({ title: text(120), role: opt(80) }, ['title']), LIMITS.steps) }, ['name', 'steps']), LIMITS.workflows),
  goals: arr(object({ title: text(160), why: opt(2000), targetOn: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, ['title']), LIMITS.goals),
  projects: arr(object({ name: text(160), summary: opt(1000), goal: opt(160) }, ['name']), LIMITS.projects),
  docs: arr(object({ title: text(200), markdown: { type: 'string', minLength: 1, maxLength: 200000 } }, ['title', 'markdown']), LIMITS.docs),
}, []);
const SOURCE = {
  from: { type: 'string', minLength: 1, maxLength: 1000, description: 'The source\'s name (a file name or a title). The pulse CLI reads the file at this path into text.' },
  text: { type: 'string', maxLength: 400000, description: 'The transcript, interview, podcast or raw company notes (Markdown or plain text; Marathi or Hindi in Devanagari is read too).' },
  class: { enum: ['public', 'private'], description: 'public: publishable (the source goes to the company\'s docs); private: research only (the source and anything written from it go only to a private folder open to you).' },
  proposal: { ...PROPOSAL, description: 'A proposal to use instead of reading text: the one planCompanySetup answered, corrected by you or a person. Apply takes the same shape.' },
};
const CHANGE = object({ section: { enum: ['words', 'teams', 'roles', 'workflows', 'goals', 'projects', 'docs'] }, change: { enum: ['add', 'change', 'same'] }, name: str, detail: str });
const LEFT = object({ label: str, href: str, why: str });
const PLAN = { from: str, class: { enum: ['public', 'private'] }, sha256: str, proposal: PROPOSAL, evidence: arr(object({ what: str, seen: int }), 50),
  items: { type: 'array', items: CHANGE }, counts: object({ add: int, change: int, same: int }), privacy: str, left: { type: 'array', items: LEFT } };

const HOW = 'Reads a transcript (a business podcast, an interview, a meeting) or raw company notes on this company\'s own server, by plain rules (nothing is sent anywhere), and proposes '
  + 'its setup: the company\'s words (what it calls a team, who leads one, a group of teams, its clients, projects and sales leads), its teams and departments, its roles, its workflows '
  + '(each a draft process with steps), its goals (with a target date when one is said) and projects, and its docs. Each item says add, change or same against what the company has now. '
  + 'The rules find what is said plainly; read the source yourself too and correct the proposal (rename, add what they missed, drop what is wrong) before applying it. class private keeps '
  + 'the source and any doc written from it in a private folder open only to you, and keeps quotes out of goals; public puts the source in the company\'s docs. left lists what only people '
  + 'can do after (invite, say who holds each role, publish the processes).';

defineV1Operation({ operationId: 'planCompanySetup', method: 'POST', path: '/api/v1/workflows/setup/plan', scope: 'workflows.read',
  summary: 'Read a transcript or company notes and propose the company\'s setup: words, teams, roles, workflows, goals, projects and docs, with what would change (writes nothing)',
  body: object({ ...SOURCE }, ['class']),
  response: object(PLAN), authorize: member,
  mcp: { name: 'plan_company_setup', title: 'Plan a company setup from a transcript', description: `${HOW} This writes nothing; apply_company_setup applies it.`, idempotent: true },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    return planSetup(ctx.client, await viewerOf(ctx), { from: b.from as string | undefined, text: b.text as string | undefined, class: b.class as SetupClass, proposal: b.proposal });
  },
});

defineV1Operation({ operationId: 'applyCompanySetup', method: 'POST', path: '/api/v1/workflows/setup/apply', scope: 'workflows.write', keyScopes: ['docs.write', 'projects.write'],
  summary: 'Set the company up from a transcript or a reviewed proposal: words, teams, roles, draft processes, goals, projects and docs, in one go (dryRun shows it and changes nothing)',
  body: object({ ...SOURCE, dryRun: { ...bool, description: 'true does everything, answers what it made, then undoes it.' } }, ['class']),
  response: object({ ...PLAN, dryRun: bool, made: { type: 'array', items: object({ kind: str, name: str, id: str }) } }), authorize: member,
  mcp: { name: 'apply_company_setup', title: 'Apply a company setup', idempotent: true,
    description: `${HOW} This applies it in one transaction: one refusal and nothing changes. Send the proposal you checked (from plan_company_setup), with the same text and class so the `
      + 'source doc is kept; dryRun true first shows what it would make. Anything the company already has (same name) is left as it is, so sending it again makes nothing twice. '
      + 'Leadership and admins only. Processes are made as drafts for a person to check and publish.' },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    const held = await ctx.keyScopes!(['docs.write', 'projects.write']);
    const p = (b.proposal ?? {}) as Row;
    if (!held.includes('docs.write')) v1Fail(403, 'Setting a company up writes docs: this connection needs docs.write too (see whoami for how to add it)');
    if (((p.goals as unknown[] | undefined)?.length || (p.projects as unknown[] | undefined)?.length || (!b.proposal && typeof b.text === 'string')) && !held.includes('projects.write'))
      v1Fail(403, 'This setup makes goals or projects: this connection needs projects.write too (see whoami for how to add it)');
    return applySetup(ctx.client, await viewerOf(ctx), { from: b.from as string | undefined, text: b.text as string | undefined, class: b.class as SetupClass, proposal: b.proposal, dryRun: b.dryRun === true });
  },
});
