// CONNECTORS-CONTRACTS (owner, 6 Nov 2026): contracts over API v1, so MCP and the `pulse` CLI get them from the same
// definitions (docs/spec/CONTRACTS.md §7). Area `contracts` (contracts.read / contracts.write). Every rule is the
// screens' own (contracts.ts and the database's contract_* functions under forced row security). Accepting a contract
// and recording money need confirm true.
import { acceptContract, addTxn, getContract, linkWork, listContracts, myContracts, saveContract, sendContract } from './contracts.js';
import { TEMPLATES } from './contract-templates.js';
import { pageResponse, PAGE_QUERY, pageV1 } from './v1-paging.js';
import { defineV1Operation } from './v1.js';
import { bool, change, confirm, confirmed, day, int, maybe, member, object, str, text, uuid, type Row } from './v1-kit.js';

const KIND = { enum: ['employment', 'retainer', 'services', 'revenue_share', 'equity'] };
const STATUS = { enum: ['draft', 'proposed', 'active', 'ended', 'cancelled'] };
const ROLE = { enum: ['provider', 'client', 'employer', 'employee', 'partner'] };
const MAYBE_ID = { type: ['string', 'null'], pattern: uuid.pattern };
const MAYBE_DAY = { type: ['string', 'null'], pattern: day.pattern };
const MAYBE_INT = { type: ['integer', 'null'] };
const RATE = object({ label: text(120), amountMinor: { type: 'integer', minimum: 0, maximum: 9e12 }, unit: { enum: ['month', 'hour', 'deliverable', 'one_off', 'percent'] } });
const PARTY = object({ id: MAYBE_ID, key: uuid, kind: { enum: ['company', 'person'] }, role: ROLE, name: str, orgId: MAYBE_ID, personId: MAYBE_ID, onPulse: bool,
  acceptedAt: maybe, acceptedVersion: MAYBE_INT, acceptedBy: maybe, acceptedNote: maybe, current: bool, mine: bool });
const TXN = object({ id: MAYBE_ID, key: uuid, kind: { enum: ['invoice', 'retainer', 'payout', 'payment'] }, payer: uuid, payee: uuid, label: str, amountMinor: int,
  currency: str, status: { enum: ['billed', 'paid', 'void'] }, dueOn: maybe, paidOn: maybe, erpDocumentId: MAYBE_ID, finEntryId: MAYBE_ID });
const TOTAL = object({ currency: str, billedMinor: int, paidMinor: int, outstandingMinor: int });
const SIDE = { type: ['object', 'null'], additionalProperties: false, required: ['notes', 'ownerId', 'owner', 'clientId'], properties: { notes: maybe, ownerId: MAYBE_ID, owner: maybe, clientId: MAYBE_ID } };
const CONTRACT = object({ id: MAYBE_ID, key: uuid, here: bool, heldBy: maybe, status: STATUS, version: int, kind: KIND, title: str, scope: str,
  deliverables: { type: 'array', items: str }, rates: { type: 'array', items: RATE }, currency: str, schedule: str, startsOn: maybe, endsOn: maybe,
  noticeDays: MAYBE_INT, template: maybe, endedOn: maybe, endReason: maybe, updatedAt: str, parties: { type: 'array', items: PARTY },
  transactions: { type: 'array', items: TXN }, totals: { type: 'array', items: TOTAL }, canManage: bool, canAccept: bool, myParty: MAYBE_ID, side: SIDE });
const OLD_TERMS = object({ kind: KIND, title: str, scope: str, deliverables: { type: 'array', items: str }, rates: { type: 'array', items: RATE }, currency: str,
  schedule: str, startsOn: maybe, endsOn: maybe, noticeDays: MAYBE_INT });
const VERSION = object({ version: int, terms: OLD_TERMS, changedBy: maybe, changedAt: str });
const LINK = object({ id: uuid, kind: { enum: ['project', 'task', 'invoice', 'goal'] }, refId: uuid, title: str, status: maybe });
const NEW_PARTY = object({ kind: { enum: ['company', 'person'] }, role: ROLE, name: text(160), orgId: uuid, personId: uuid, accountId: uuid }, ['kind', 'role']);
const TERMS = { kind: KIND, title: text(160), scope: { type: 'string', maxLength: 20000 }, deliverables: { type: 'array', maxItems: 100, items: text(300) },
  rates: { type: 'array', maxItems: 50, items: RATE }, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  schedule: { enum: ['monthly', 'quarterly', 'milestones', 'on_delivery', 'one_off'] }, startsOn: MAYBE_DAY, endsOn: MAYBE_DAY,
  noticeDays: { type: ['integer', 'null'], minimum: 0, maximum: 3650 }, notes: { type: ['string', 'null'], maxLength: 5000 }, ownerId: MAYBE_ID, clientId: MAYBE_ID };
const DESCRIBE = 'Terms: kind (employment, retainer, services, revenue_share, equity), title, scope, deliverables (a list of lines), rates (lines of label, '
  + 'amountMinor in paise, or hundredths of a percent for unit percent, and unit month, hour, deliverable, one_off or percent), currency, schedule, startsOn, '
  + 'endsOn, noticeDays. notes, ownerId and clientId (the other side as our client or vendor record) are this company\'s own side and never reach the other party.';

defineV1Operation({ operationId: 'listContracts', method: 'GET', path: '/api/v1/contracts', scope: 'contracts.read',
  summary: 'This company\'s contracts you may see (admins, leadership and Finance: all; a person: the ones naming them)',
  query: object({ ...PAGE_QUERY, status: STATUS, kind: KIND }, []), response: pageResponse(CONTRACT),
  mcp: { name: 'list_contracts', title: 'List contracts',
    description: 'Lists this company\'s contracts with their parties, acceptance, transactions and billed/paid totals. Filter by status (draft, proposed, active, ended, cancelled) or kind. Contracts held by other companies that name you are in list_my_contracts.' },
  handler: async (ctx, input) => {
    await member(ctx);
    const q = input.query;
    return pageV1(ctx, 'listContracts', input, async (after, take) => (await listContracts(ctx.client, { status: q.status, kind: q.kind, after, take })).map((c) => ({ ...c, id: c.id ?? c.key })));
  },
});

defineV1Operation({ operationId: 'listMyContracts', method: 'GET', path: '/api/v1/contracts/mine', scope: 'contracts.read',
  summary: 'Your contracts in every company where you are a party (the shared part only)',
  response: object({ items: { type: 'array', items: CONTRACT } }),
  mcp: { name: 'list_my_contracts', title: 'List my contracts',
    description: 'Every contract, in any company on Vitals OS, where you are a party (as an employee, partner or by your account): its terms, parties, acceptance and transactions, never a company\'s internal notes. heldBy names the company holding it.' },
  handler: async (ctx) => ({ items: await myContracts(ctx.client) }),
});

defineV1Operation({ operationId: 'listContractTemplates', method: 'GET', path: '/api/v1/contracts/templates', scope: 'contracts.read',
  summary: 'The templates a new contract can start from',
  response: object({ items: { type: 'array', items: object({ key: str, kind: KIND, name: str, summary: str, title: str, scope: str,
    deliverables: { type: 'array', items: str }, rates: { type: 'array', items: RATE }, schedule: str, noticeDays: int, roles: { type: 'array', items: str } }) } }),
  mcp: { name: 'list_contract_templates', title: 'List contract templates', description: 'The templates (retainer, services, employment, revenue_share) with the terms each fills in.' },
  handler: async () => ({ items: TEMPLATES.map((t) => ({ ...t, deliverables: [...t.deliverables], rates: [...t.rates], roles: [...t.roles] })) }),
});

defineV1Operation({ operationId: 'getContract', method: 'GET', path: '/api/v1/contracts/{contractId}', scope: 'contracts.read',
  summary: 'One contract with its versions and (for this company\'s managers) its links',
  params: object({ contractId: uuid }),
  response: object({ contract: CONTRACT, versions: { type: 'array', items: VERSION }, links: { type: 'array', items: LINK } }),
  mcp: { name: 'get_contract', title: 'Get a contract', description: 'Reads one contract by its id (or its shared key from list_my_contracts): terms, parties and who accepted which version, earlier versions, transactions and totals, and this company\'s links to projects, tasks and invoices.' },
  handler: async (ctx, { params }) => { await member(ctx); const d = await getContract(ctx.client, params.contractId); return { ...d, contract: { ...d.contract, id: d.contract.id ?? d.contract.key } }; },
});

defineV1Operation({ operationId: 'createContract', method: 'POST', path: '/api/v1/contracts', scope: 'contracts.write',
  summary: 'Draft a contract from a template or blank (admins, leadership and Finance)',
  body: object({ template: { enum: ['retainer', 'services', 'employment', 'revenue_share'] }, ...TERMS, parties: { type: 'array', minItems: 2, maxItems: 20, items: NEW_PARTY } }, ['parties']),
  response: object({ contract: CONTRACT, changeId: maybe }), authorize: member,
  mcp: { name: 'create_contract', title: 'Draft a contract',
    description: `Drafts a contract only this company sees until send_contract. parties: at least two, each {kind company|person, role provider|client|employer|employee|partner} with orgId (a company on Vitals OS; this company's id is in whoami), personId (someone in this company), accountId, or just a name for someone off Vitals OS; this company or one of its people must be a party. template fills the terms. ${DESCRIBE}` },
  handler: async (ctx, { body }) => {
    const d = await getContract(ctx.client, await saveContract(ctx.client, null, body as Row));
    return { contract: d.contract, changeId: await change(ctx, 'contract.create', d.contract.id!, { kind: d.contract.kind, title: d.contract.title }) };
  },
});

defineV1Operation({ operationId: 'updateContract', method: 'PATCH', path: '/api/v1/contracts/{contractId}', scope: 'contracts.write',
  summary: 'Change a contract\'s terms (after sending: a new version that every party accepts again) or this company\'s notes',
  params: object({ contractId: uuid }), body: object({ ...TERMS, parties: { type: 'array', minItems: 2, maxItems: 20, items: NEW_PARTY } }, []),
  response: object({ contract: CONTRACT, changeId: maybe }), authorize: member,
  mcp: { name: 'update_contract', title: 'Change a contract',
    description: `Changes only the fields sent. Once sent, a change to the terms makes a new version, keeps the old one and clears every acceptance. Parties change only while a draft. ${DESCRIBE}`, idempotent: true },
  handler: async (ctx, { params, body }) => {
    const d = await getContract(ctx.client, await saveContract(ctx.client, params.contractId, body as Row));
    return { contract: d.contract, changeId: await change(ctx, 'contract.update', d.contract.id!, { fields: Object.keys(body as Row), version: d.contract.version }) };
  },
});

defineV1Operation({ operationId: 'sendContract', method: 'POST', path: '/api/v1/contracts/{contractId}/send', scope: 'contracts.write',
  summary: 'Send a draft to the other parties (other companies on Vitals OS get their own copy)',
  params: object({ contractId: uuid }), body: object({ confirm }, ['confirm']), response: object({ status: STATUS, changeId: maybe }), authorize: member,
  mcp: { name: 'send_contract', title: 'Send a contract', description: 'Sends a draft: it becomes proposed and appears in every other party company\'s contracts and in each named person\'s contracts. Needs confirm true: ask the person first.' },
  handler: async (ctx, { params, body }) => {
    confirmed(body, 'the contract goes to the other parties');
    const status = await sendContract(ctx.client, params.contractId);
    return { status, changeId: await change(ctx, 'contract.send', params.contractId, {}) };
  },
});

defineV1Operation({ operationId: 'acceptContract', method: 'POST', path: '/api/v1/contracts/{contractId}/accept', scope: 'contracts.write',
  summary: 'Accept the current version for your side: yourself, or (managers) this company or a party off Vitals OS with a note',
  params: object({ contractId: uuid }), body: object({ confirm, partyId: uuid, note: text(300) }, ['confirm']),
  response: object({ status: STATUS, changeId: maybe }), authorize: member,
  mcp: { name: 'accept_contract', title: 'Accept a contract',
    description: 'Records your acceptance (the time, your name and the version) on your own party: yourself as a person, or this company when you are one of its admins, leadership or Finance. For a party off Vitals OS, a manager passes its partyId and a note of how it accepted. A contract held by another company is accepted by its key from list_my_contracts. Needs confirm true: a signature is the person\'s own decision.' },
  handler: async (ctx, { params, body }) => {
    confirmed(body, 'your acceptance is recorded on the contract');
    const status = await acceptContract(ctx.client, params.contractId, body as Row);
    return { status, changeId: await change(ctx, 'contract.accept', params.contractId, { partyId: (body as Row).partyId ?? null }) };
  },
});

defineV1Operation({ operationId: 'addContractTransaction', method: 'POST', path: '/api/v1/contracts/{contractId}/transactions', scope: 'contracts.write',
  summary: 'Record an invoice, retainer, payout or payment under a contract (both sides see it)',
  params: object({ contractId: uuid }),
  body: object({ confirm, kind: { enum: ['invoice', 'retainer', 'payout', 'payment'] }, payerKey: uuid, payeeKey: uuid, label: text(160),
    amountMinor: { type: 'integer', minimum: 1, maximum: 9e12 }, currency: { type: 'string', pattern: '^[A-Z]{3}$' }, status: { enum: ['billed', 'paid'] },
    dueOn: day, paidOn: day, erpDocumentId: uuid, finEntryId: uuid }, ['confirm', 'kind', 'payerKey', 'payeeKey', 'label', 'amountMinor']),
  response: object({ id: uuid, contract: CONTRACT, changeId: maybe }), authorize: member,
  mcp: { name: 'add_contract_transaction', title: 'Record money under a contract',
    description: 'Records money under a contract: payerKey and payeeKey are party keys from get_contract; amountMinor in paise; status billed (default) or paid. erpDocumentId (an invoice) or finEntryId (a ledger entry) ties it to this company\'s own money records, which the other side never sees. Needs confirm true.' },
  handler: async (ctx, { params, body }) => {
    confirmed(body, 'the amount is recorded on the contract for both sides');
    const id = await addTxn(ctx.client, params.contractId, body as Row);
    const d = await getContract(ctx.client, params.contractId);
    return { id, contract: d.contract, changeId: await change(ctx, 'contract.txn', params.contractId, { txn: id, amountMinor: (body as Row).amountMinor }) };
  },
});

defineV1Operation({ operationId: 'linkContractWork', method: 'POST', path: '/api/v1/contracts/{contractId}/links', scope: 'contracts.write',
  summary: 'Link a project, task or invoice of this company to a contract (this company\'s own side)',
  params: object({ contractId: uuid }), body: object({ projectId: uuid, taskId: uuid, invoiceId: uuid, goalId: uuid }, []),
  response: object({ linkId: uuid, changeId: maybe }), authorize: member,
  mcp: { name: 'link_contract_work', title: 'Link work to a contract', description: 'Links one project, task, invoice (billing document) or goal to a contract. Only this company\'s managers see links. Linking the same thing twice is harmless.', idempotent: true },
  handler: async (ctx, { params, body }) => {
    const linkId = await linkWork(ctx.client, params.contractId, body as Row);
    return { linkId, changeId: await change(ctx, 'contract.link', params.contractId, { linkId }) };
  },
});
