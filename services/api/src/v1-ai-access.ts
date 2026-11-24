// AI-ACCESS (owner, 23 Nov 2026): "Everyone who connects their Claude gets exactly what they are permitted to do. From one
// account I should manage all of that." The company's AI rules (migration 2536: for the whole company, per role and per
// person; the same on / ask / off words as an AI employee's risk policy) are enforced HERE, once, for every person
// connection (an OAuth app such as Claude, ChatGPT or the pulse CLI, or a personal token) on every API v1 call, HTTP and
// MCP alike: v1.ts route() calls aiGate() after the principal and the input are checked and before anything else runs.
//   read      every GET
//   work      create and change tasks, leads, quotes, docs, projects, contracts (the default for a write)
//   messages  send a message, an e-mail, a quotation, a contract, a doc, a chat post
//   money     invoices, payments, expenses, stock, approving and issuing, bank statements, contract money
//   delete    delete, archive, discard, cancel, revoke (undo is work: it takes back your own change)
// "off" refuses with the reason; "ask" files one request (pulse.ai_access_hold) for the rule's approver (else the
// company's admins) and refuses this call while KEEPING the request: route() returns the hold from the transaction so it
// commits. After a yes the same call with the same input goes through once.
import { createHash } from 'node:crypto';
import { V1Problem, type V1Context, type V1Input, type V1Operation } from './v1.js';

export type AiGroup = 'read' | 'work' | 'messages' | 'money' | 'delete';
export const AI_GROUPS: readonly AiGroup[] = ['read', 'work', 'messages', 'money', 'delete'];
/** Who am I, where can I act, act there: never held back, so an AI can always find its way. */
export const AI_META: ReadonlySet<string> = new Set(['whoAmI', 'listMyOrganisations', 'useOrganisation']);

// Undo is not here: taking back your own AI change within 7 days is the safety net, so it counts as work.
const DELETE = /^(delete|archive|discard|remove|revoke|void|cancel|destroy|purge)/i;
const MESSAGES = /^(send|email|post|notify|reply|broadcast)/i;
const MONEY = /(invoice|payment|proforma|expense|bank|stock|approve|issue|record|price|refund|transaction|payout|ledger)/i;

/** Which of the five groups an operation belongs to (unit-tested over the whole registry: test/ai-access.test.mjs). */
export function toolGroup(op: Pick<V1Operation, 'method' | 'operationId' | 'scope' | 'mcp'>): AiGroup {
  if (op.method === 'GET') return 'read';
  const names = [op.operationId, op.mcp?.name ?? ''];
  if (op.method === 'DELETE' || names.some(n => DELETE.test(n))) return 'delete';
  if (op.scope === 'chats.write' || names.some(n => MESSAGES.test(n))) return 'messages';
  if (op.scope === 'finance.write' || ((op.scope === 'billing.write' || op.scope === 'contracts.write') && names.some(n => MONEY.test(n)))) return 'money';
  // A tool's own "destructive" flag (it cannot be taken back: sending a quote, a one-time password, merging) is not the
  // owner's "delete or archive": the part follows what the tool does, by its name, as above.
  return 'work';
}

/** What the group lets an AI do, as the refusal and Settings say it. */
export const GROUP_WORDS: Record<AiGroup, string> = { read: 'read your work', work: 'create or change work', messages: 'send messages',
  money: 'touch money', delete: 'delete or archive' };

const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
/** The exact call an approval is for: the operation and its params, query and body (never the request id). */
export const inputHash = (op: Pick<V1Operation, 'operationId'>, input: V1Input) =>
  createHash('sha256').update(op.operationId + '\0' + JSON.stringify(canonical({ params: input.params ?? {}, query: input.query ?? {}, body: input.body ?? null }))).digest('hex');

/** A short, readable line for the person who says yes: the tool's title and its fields (long text cut). */
export function summarize(op: Pick<V1Operation, 'summary' | 'mcp'>, input: V1Input): string {
  const fields = { ...(input.params ?? {}), ...(input.body && typeof input.body === 'object' ? input.body as Record<string, unknown> : {}) };
  const cut = (v: unknown) => { const text = typeof v === 'string' ? v : JSON.stringify(v); return text.length > 120 ? text.slice(0, 117) + '…' : text; };
  // The field a person reads first (a title, a name, the message) leads, in quotes; the rest follow as "field: value".
  const lead = ['title', 'name', 'subject', 'text', 'message', 'body'].find(k => typeof fields[k] === 'string' && fields[k]);
  const parts = [...(lead ? [`“${cut(fields[lead])}”`] : []), ...Object.entries(fields).filter(([k, v]) => k !== lead && v !== undefined && v !== null && v !== '').slice(0, 7)
    .map(([k, v]) => `${k}: ${cut(v)}`)];
  const head = op.mcp?.title ?? op.summary;
  return (parts.length ? `${head}: ${parts.join('; ')}` : head).slice(0, 600);
}

/** A held call: the request is kept (the transaction commits), then the call is refused with its message. A tag, not a
 *  subclass: v1.ts and this module import each other, so nothing here may touch V1Problem while the modules load. */
const HELD = Symbol('ai-access held');
export const isHeld = (e: unknown): e is V1Problem => !!e && typeof e === 'object' && HELD in e;
const held = (status: number, detail: string) => Object.assign(new V1Problem(status, detail), { [HELD]: true });

type Rules = Partial<Record<AiGroup, 'on' | 'ask' | 'off'>> & { approverId?: string | null };
/** null: not a person connection (AI employees and company keys keep their own rules). Otherwise the rule applied. */
export async function aiGate(ctx: V1Context, op: V1Operation, input: V1Input, external: boolean): Promise<'ask' | 'approved' | 'off' | null> {
  if (!external || ctx.principal.kind !== 'person' || AI_META.has(op.operationId)) return null;
  const group = toolGroup(op);
  const rules = (await ctx.client.query('select pulse.ai_access_effective(pulse.current_viewer()) v, (select name from pulse.org where id = pulse.current_org()) o')).rows[0] as { v: Rules; o: string };
  const rule = rules.v?.[group] ?? (group === 'delete' ? 'off' : 'on');
  if (rule === 'on') return null;
  const where = rules.o ? ` in ${rules.o}` : '';
  if (rule === 'off') {
    ctx.note?.({ ai: `off ${group}` });
    throw new V1Problem(403, `This company's AI rules do not let a connected AI ${GROUP_WORDS[group]}${where}. An admin can change that in Pulse: Settings → AI access.`);
  }
  const tool = op.mcp?.name ?? op.operationId;
  const hold = (await ctx.client.query('select pulse.ai_access_hold($1,$2,$3,$4,$5) v', [op.operationId, tool, group, summarize(op, input), inputHash(op, input)])).rows[0].v as
    { go: boolean; id: string; state?: string; new?: boolean; approver?: string | null; note?: string | null };
  if (hold.go) return 'approved';
  ctx.note?.({ ai: `ask ${group} ${hold.state ?? ''}`.trim() });
  const who = hold.approver ?? "your company's admins";
  if (hold.state === 'declined') throw new V1Problem(403, `${who} said no to this${hold.note ? `: ${hold.note}` : ''}. Do not try it again unless they ask you to.`);
  throw held(403, `${hold.new ? 'This needs a yes first. I asked' : 'Still waiting for a yes from'} ${who} in Pulse (Settings → AI access, request ${hold.id.slice(0, 8)}).`
    + ` When they say yes, call ${tool} again with exactly the same details${where}. Tell the person you are helping that it is waiting.`);
}
