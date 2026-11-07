// AGENT-API (owner, 4 Nov 2026): the money path over API v1, so a bot such as Willow Lane's Bhrata can do what Akabod
// asked for ("Make a quotation for Pure Power 20.0 for Majestic Infra at ₹X"): find or create the client, pick the
// catalogue item, draft the quotation, send it for approval, and once a person has approved it, send it. Also the
// catalogue and stock (stock in, set the count), invoices and payments. Every operation runs as its principal and
// calls the Billing screens' own code (erp.ts: createDraft, saveDraft, issueDocument, createItem, stockMove) and
// functions (erp_quote_revise, erp_document_mark, erp_payment_add …), so leadership and the Finance role write, the
// Accountant reads, and a price that differs from the catalogue still waits for the owner. Two rules of the API's own:
// approving a quotation or issuing an invoice is a person's click (an AI member or a bot key drafts, submits and
// sends, never approves), and money moves only with confirm: true. Money is integer paise (₹1 = 100).
import { randomBytes, createHash } from 'node:crypto';
import { companyLinkOrigin, companyOrigin } from './tenant-context.js';
import { readModules } from './modules.js';
import { ORG_TZ } from './org-time.js';
import { createDraft, createItem, DOC_COLS, issueDocument, LINE_COLS, saveDraft, stockMove } from './erp.js';
import { defineV1Operation, v1Fail, type Closed, type V1Context } from './v1.js';
import { aiReviewer, bool, change, confirm, confirmed, day, digits, int, list, maybe, maybeNum, member, num, object, one, paise, qText, rows, squash, squashed, str, text,
  undoUntil, uuid, viewerOf, viewerIs, type Row } from './v1-kit.js';

const origin = () => companyOrigin();
const UNDO = { changeId: maybe, undoUntil: maybe };
const int0 = (v: unknown) => Math.round(Number(v ?? 0));

// ------------------------------------------------------------------------------------------------ who may
async function moneyOn(ctx: V1Context) {
  if ((await readModules(ctx.client, ctx.tenantId)).off.includes('money')) v1Fail(404, 'Billing is switched off for this company');
}
const canBill = (ctx: V1Context, write: boolean) => one<boolean>(ctx, 'select pulse.erp_can($1) v', [write]);
const billingReader = async (ctx: V1Context) => { await member(ctx); await moneyOn(ctx); if (!(await canBill(ctx, false))) v1Fail(403, 'Billing is for leadership, the Finance role and the Accountant'); };
const billingWriter = async (ctx: V1Context) => { await member(ctx); await moneyOn(ctx); if (!(await canBill(ctx, true))) v1Fail(403, 'Quotations and invoices are made by leadership and the Finance role'); };
const seesBilling = (write: boolean) => async (ctx: V1Context) => !(await readModules(ctx.client, ctx.tenantId)).off.includes('money') && await canBill(ctx, write);
/** Approving and issuing number a document for good: a person does it through their own sign-in or token. */
const human = (ctx: V1Context, what: string) => { if (ctx.principal.kind !== 'person') v1Fail(403, `${what} is a person's decision: an AI member or bot key may draft, submit and send an approved quotation, and a person approves in Pulse or through their own connection`); };

// ------------------------------------------------------------------------------------------------ clients, contacts, leads
const CLIENT = object({ id: uuid, name: str, company: maybe, phone: maybe, email: maybe, city: maybe, type: maybe, status: maybe, url: str });
const clientOut = (r: Row) => ({ id: String(r.id), name: String(r.name), company: (r.company as string) ?? null, phone: (r.phone as string) ?? null, email: (r.email as string) ?? null,
  city: (r.city as string) ?? null, type: (r.type as string) ?? null, status: (r.status as string) ?? null, url: `${origin()}/clients/${r.id}` });
const CLIENT_COLS = `c.id,c.display_name name,c.company_name company,coalesce(x.phone,cp.phone,c.phone) phone,coalesce(x.email,cp.email,c.email) email,c.city,c.client_type type,c.status`;
const CLIENT_FROM = `pulse.client c left join pulse.erp_party x on x.client_id=c.id left join pulse.contact_profile cp on cp.person_id=c.primary_contact_id`;
const NOT_MERGED = `not exists(select 1 from pulse.record_merge m where m.entity_type='client' and m.gone_id=c.id and m.undone_at is null)`;
/** Name, company or legal name ignoring case and spaces; phone by its last 10 digits; GSTIN by its start. */
async function findClients(ctx: V1Context, q: string, limit = 12) {
  const sq = squash(q), ph = digits(q).slice(-10);
  return rows(ctx, `select ${CLIENT_COLS},(${ph.length >= 6 ? `right(regexp_replace(coalesce(x.phone,'')||coalesce(cp.phone,'')||coalesce(c.phone,''),'\\D','','g'),10)=$2` : 'false'}) phone_hit,
      regexp_replace(lower(c.display_name),'[^a-z0-9\\u0900-\\u097f]+','','g')=$1 name_hit
    from ${CLIENT_FROM} where ${NOT_MERGED} and ($1='' or ${squashed('c.display_name', 1)} or ${squashed('c.company_name', 1)} or ${squashed('x.legal_name', 1)}
      or upper(coalesce(x.gstin,'')) like upper($3)||'%'
      or (length($2)>=6 and regexp_replace(coalesce(x.phone,'')||' '||coalesce(cp.phone,'')||' '||coalesce(c.phone,''),'\\D','','g') like '%'||$2||'%'))
    order by phone_hit desc,name_hit desc,c.updated_at desc nulls last limit ${limit}`, [sq, ph, q.trim() || '~']);
}
const CONTACT = object({ id: uuid, name: str, phone: maybe, email: maybe, city: maybe, type: maybe, clientId: maybe, client: maybe });
async function findContacts(ctx: V1Context, q: string, limit = 12) {
  const full = await seesDetails(ctx), sq = squash(q), ph = full ? digits(q).slice(-10) : '';
  const r = await rows(ctx, `select p.id,p.display_name name,cp.phone,cp.email,cp.city,cp.contact_type type,cl.id "clientId",cl.display_name client
    from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id
    left join lateral (select cc.client_id from pulse.client_contact cc where cc.person_id=p.id order by cc.is_primary desc limit 1) l on true left join pulse.client cl on cl.id=l.client_id
    where p.side<>'staff' and p.side<>'agent' and p.status='active' and not exists(select 1 from pulse.record_merge m where m.entity_type='contact' and m.gone_id=p.id and m.undone_at is null)
      and ($1='' or ${squashed('p.display_name', 1)} or ($4 and lower(coalesce(cp.email,'')) like '%'||lower($3)||'%') or ${squashed('cl.display_name', 1)}
        or (length($2)>=6 and regexp_replace(coalesce(cp.phone,''),'\\D','','g') like '%'||$2||'%'))
    order by cp.updated_at desc nulls last limit ${limit}`, [sq, ph, q.trim(), full]);
  return r.map(c => quiet(full, { id: String(c.id), name: String(c.name), phone: (c.phone as string) ?? null, email: (c.email as string) ?? null, city: (c.city as string) ?? null,
    type: (c.type as string) ?? null, clientId: (c.clientId as string) ?? null, client: (c.client as string) ?? null }));
}
const companiesReader = async (ctx: V1Context) => { await member(ctx); };
// Review (5 Nov 2026): Clients and Contacts are on everyone's screens, but a token must not turn them into a phone and
// e-mail export. Phone numbers and e-mails go to admins, leadership and Billing readers (the Finance role, the
// Accountant, an AI member with Billing); leads to them and to the people on an Acquisition project (acq_can).
const seesDetails = (ctx: V1Context) => one<boolean>(ctx, "select pulse.viewer_is('admin','leadership') or pulse.erp_can(false) v");
const seesLeads = (ctx: V1Context) => one<boolean>(ctx, `select pulse.viewer_is('admin','leadership') or pulse.erp_can(false)
  or exists(select 1 from pulse.project p where p.deleted_at is null and pulse.acq_can(p.id)) v`);
const quiet = <T extends { phone: string | null; email: string | null }>(full: boolean, r: T): T => (full ? r : { ...r, phone: null, email: null });

defineV1Operation({ operationId: 'searchClients', method: 'GET', path: '/api/v1/companies/clients', scope: 'companies.read',
  summary: 'Find clients by name, company, phone or GSTIN (case and spaces ignored)', query: object({ query: qText(120) }, []), response: list(CLIENT),
  mcp: { name: 'search_clients', title: 'Find clients', description: 'Finds clients by name, company or legal name (case, spaces and dots ignored: "majestic infra" finds "Majestic Infra Pvt. Ltd."), phone (any format, last 10 digits) or GSTIN. Up to 12. Use find_or_create_client before a quotation.' },
  handler: async (ctx, { query }) => {
    await companiesReader(ctx);
    const full = await seesDetails(ctx), asked = query.query ?? '', q = full ? asked : asked.replace(/[0-9+() -]{6,}/g, ' ').trim();
    if (asked.trim() && !q) return { items: [] };   // a phone number alone finds nothing without the right to see phones
    return { items: (await findClients(ctx, q)).map(r => quiet(full, clientOut(r))) };
  },
});
defineV1Operation({ operationId: 'getClient', method: 'GET', path: '/api/v1/companies/clients/{clientId}', scope: 'companies.read',
  summary: 'Read one client with its contacts, projects and latest billing documents', params: object({ clientId: uuid }),
  response: object({ client: CLIENT, contacts: { type: 'array', items: CONTACT }, projects: { type: 'array', items: object({ id: uuid, name: str, status: maybe }) },
    documents: { type: 'array', items: object({ id: uuid, docType: str, number: maybe, status: str, total: int }) } }),
  mcp: { name: 'get_client', title: 'Read a client', description: 'Reads one client by id: contact details, its contacts, projects and (for Billing readers) the latest 20 quotations and invoices.' },
  handler: async (ctx, { params }) => {
    await companiesReader(ctx);
    const r = (await ctx.client.query(`select ${CLIENT_COLS} from ${CLIENT_FROM} where c.id=$1`, [params.clientId])).rows[0] ?? v1Fail(404, 'Client not found');
    const contacts = await rows(ctx, `select p.id,p.display_name name,cp.phone,cp.email,cp.city,cp.contact_type type from pulse.client_contact cc join pulse.person p on p.id=cc.person_id
      left join pulse.contact_profile cp on cp.person_id=p.id where cc.client_id=$1 order by cc.is_primary desc,p.display_name limit 30`, [params.clientId]);
    // Only the projects this person sees (members-only and leadership-only projects stay hidden, as on the screens).
    const projects = await rows(ctx, `select id,coalesce(title,name) name,status from pulse.project where client_id=$1 and deleted_at is null and pulse.project_sees(id)
      order by starts_on desc nulls last limit 20`, [params.clientId]);
    const full = await seesDetails(ctx);
    const docs = await canBill(ctx, false) ? await rows(ctx, `select id,doc_type "docType",number,status,total::float8 total from pulse.erp_document where client_id=$1 order by created_at desc limit 20`, [params.clientId]) : [];
    return { client: quiet(full, clientOut(r)), contacts: contacts.map(c => quiet(full, { id: String(c.id), name: String(c.name), phone: (c.phone as string) ?? null, email: (c.email as string) ?? null,
        city: (c.city as string) ?? null, type: (c.type as string) ?? null, clientId: params.clientId, client: String(r.name) })),
      projects: projects.map(p => ({ id: String(p.id), name: String(p.name ?? 'Project'), status: (p.status as string) ?? null })),
      documents: docs.map(d => ({ id: String(d.id), docType: String(d.docType), number: (d.number as string) ?? null, status: String(d.status), total: int0(d.total) })) };
  },
});
const NEW_CLIENT = { name: text(200), company: text(200, 0), phone: text(40, 0), email: text(200, 0), city: text(80, 0), type: text(48, 0) };
async function makeClient(ctx: V1Context, b: Row) {
  const id = await one<string>(ctx, 'select pulse.v1_client_create($1) v', [JSON.stringify({ name: String(b.name).trim(), company: b.company ?? null, phone: b.phone ?? null,
    email: b.email ?? null, city: b.city ?? null, type: b.type ?? null })]);
  const r = (await ctx.client.query(`select ${CLIENT_COLS} from ${CLIENT_FROM} where c.id=$1`, [id])).rows[0];
  return { client: clientOut(r), changeId: await change(ctx, 'client.create', id, { name: String(b.name).trim() }) };
}
defineV1Operation({ operationId: 'createClient', method: 'POST', path: '/api/v1/companies/clients', scope: 'companies.write',
  summary: 'Add a client to Clients (admins, leadership and the Finance role)', body: object(NEW_CLIENT, ['name']),
  response: object({ client: CLIENT, ...UNDO }), authorize: member,
  mcp: { name: 'create_client', title: 'Add a client',
    description: 'Adds a client (a person or company we bill) with optional company, phone, email, city and type. Prefer find_or_create_client, which checks for the same client first. Undo with undo_change for 7 days while nothing is billed to it.' },
  handler: async (ctx, { body }) => { const r = await makeClient(ctx, body as Row); return { ...r, undoUntil: undoUntil() }; },
});
defineV1Operation({ operationId: 'findOrCreateClient', method: 'POST', path: '/api/v1/companies/clients/find-or-create', scope: 'companies.write',
  summary: 'Find the client by phone or name; add them only when nobody matches and create is true',
  body: object({ ...NEW_CLIENT, create: bool }, ['name']),
  response: object({ result: { enum: ['found', 'ambiguous', 'none', 'created'] }, client: { anyOf: [CLIENT, { type: 'null' }] }, candidates: { type: 'array', items: CLIENT },
    contacts: { type: 'array', items: CONTACT }, message: str, ...UNDO }),
  authorize: member,
  mcp: { name: 'find_or_create_client', title: 'Find or add a client',
    description: 'Looks for the client by phone (last 10 digits) and by name or company (case and spaces ignored). result "found": one clear match (use client.id). "ambiguous": several; ask the person which (candidates). "none": nobody matched; contacts lists people in Contacts or leads who might be them; ask the person, then call again with create true to add a new client. "created": added (undo_change for 7 days).' },
  handler: async (ctx, { body }) => {
    const b = body as Row, name = String(b.name), phone = digits(String(b.phone ?? '')).slice(-10);
    const byPhone = phone.length >= 6 ? (await findClients(ctx, phone, 5)).filter(r => r.phone_hit) : [];
    const byName = (await findClients(ctx, String(b.company ?? '') || name, 8));
    const exact = byName.filter(r => r.name_hit || squash(String(r.company ?? '')) === squash(String(b.company ?? name)));
    const pick = byPhone.length === 1 ? byPhone : byPhone.length ? byPhone : exact;
    if (pick.length === 1) return { result: 'found' as const, client: clientOut(pick[0]), candidates: [], contacts: [], message: `Found ${pick[0].name}.`, changeId: null, undoUntil: null };
    if (pick.length > 1) return { result: 'ambiguous' as const, client: null, candidates: pick.map(clientOut), contacts: [], message: `${pick.length} clients match. Ask which one.`, changeId: null, undoUntil: null };
    if (b.create !== true) {
      const contacts = await findContacts(ctx, phone.length >= 6 ? phone : name, 6);
      return { result: 'none' as const, client: null, candidates: byName.map(clientOut), contacts, changeId: null, undoUntil: null,
        message: `No client is called ${name}${phone ? ' or has that phone' : ''}. Ask the person, then call again with create true to add them${contacts.length ? ` (or they may be one of these ${contacts.length} contacts)` : ''}.` };
    }
    const made = await makeClient(ctx, b);
    return { result: 'created' as const, client: made.client, candidates: [], contacts: [], message: `Added ${made.client.name} to Clients.`, changeId: made.changeId, undoUntil: undoUntil() };
  },
});
defineV1Operation({ operationId: 'searchContacts', method: 'GET', path: '/api/v1/companies/contacts', scope: 'companies.read',
  summary: 'Find people in Contacts (leads included) by name, phone, e-mail or their client', query: object({ query: qText(120) }, []), response: list(CONTACT),
  mcp: { name: 'search_contacts', title: 'Find contacts', description: 'Finds people in Contacts (leads included) by name (case and spaces ignored), phone (last 10 digits), e-mail or their client\'s name. Up to 12.' },
  handler: async (ctx, { query }) => { await companiesReader(ctx); return { items: await findContacts(ctx, query.query ?? '') }; },
});
const LEAD = object({ id: uuid, name: str, phone: maybe, status: maybe, kind: maybe, receivedAt: str, contactId: maybe });
defineV1Operation({ operationId: 'findLeads', method: 'GET', path: '/api/v1/companies/leads', scope: 'companies.read',
  summary: 'Look up leads (Meta ads, the website, Sales X-Ray) by name or phone', query: object({ query: qText(120) }), response: list(LEAD),
  mcp: { name: 'find_leads', title: 'Look up leads', description: 'Looks up leads (from Meta ads, the website or Sales X-Ray) by the buyer\'s name (case and spaces ignored) or phone (last 10 digits), newest first, up to 20. A lead\'s contactId can go on a quotation as contactPersonId.' },
  handler: async (ctx, { query }) => {
    await companiesReader(ctx);
    if ((await readModules(ctx.client, ctx.tenantId)).off.includes('acquisition')) v1Fail(404, 'Leads are switched off for this company');
    if (!(await seesLeads(ctx))) v1Fail(403, 'Leads are for admins, leadership, the Finance role and the people on Acquisition projects');
    const sq = squash(query.query), ph = digits(query.query).slice(-10);
    const r = await rows(ctx, `select l.id,coalesce(b.display_name,'A lead') name,cp.phone,l.status,l.kind,l.created_at::text "receivedAt",b.id "contactId"
      from pulse.lead l left join pulse.person b on b.id=l.buyer_id left join pulse.contact_profile cp on cp.person_id=l.buyer_id
      where (${squashed('b.display_name', 1)} and $1<>'') or (length($2)>=6 and regexp_replace(coalesce(cp.phone,''),'\\D','','g') like '%'||$2||'%')
      order by l.created_at desc limit 20`, [sq, ph]);
    return { items: r.map(l => ({ id: String(l.id), name: String(l.name), phone: (l.phone as string) ?? null, status: (l.status as string) ?? null, kind: (l.kind as string) ?? null,
      receivedAt: String(l.receivedAt), contactId: (l.contactId as string) ?? null })) };
  },
});

// ------------------------------------------------------------------------------------------------ catalogue and stock
const ITEM = object({ id: uuid, kind: str, code: maybe, name: str, unit: maybe, price: int, gstRate: num, trackStock: bool, onHand: maybeNum, status: str });
const ITEM_COLS = `i.id,i.kind,i.code,i.name,i.unit,i.price::float8 price,i.gst_rate::float8 "gstRate",i.track_stock "trackStock",case when i.track_stock then pulse.erp_on_hand(i.id)::float8 end "onHand",i.status`;
const itemOut = (r: Row) => ({ id: String(r.id), kind: String(r.kind), code: (r.code as string) ?? null, name: String(r.name), unit: (r.unit as string) ?? null, price: int0(r.price),
  gstRate: Number(r.gstRate), trackStock: !!r.trackStock, onHand: r.onHand === null || r.onHand === undefined ? null : Number(r.onHand), status: String(r.status) });
async function findItems(ctx: V1Context, q: string, stockOnly = false) {
  return (await rows(ctx, `select ${ITEM_COLS} from pulse.erp_item i where i.status<>'archived' and ($2::boolean is false or i.track_stock)
      and ($1='' or ${squashed('i.name', 1)} or ${squashed('i.code', 1)} or ${squashed('i.description', 1)})
    order by (regexp_replace(lower(i.name),'[^a-z0-9]+','','g')=$1) desc,i.kind='package' desc,i.name limit 50`, [squash(q), stockOnly])).map(itemOut);
}
defineV1Operation({ operationId: 'listCatalogItems', method: 'GET', path: '/api/v1/billing/catalogue', scope: 'billing.read',
  summary: 'Find catalogue items by name or code (case and spaces ignored)', query: object({ query: qText(120) }, []), response: list(ITEM),
  available: seesBilling(false), authorize: billingReader,
  mcp: { name: 'search_catalogue', title: 'Find catalogue items', description: 'Finds services, products and packages in the catalogue by name, code or description; case, spaces and dots are ignored ("purepower 5", "Pure Power 5.0" and "pure power5.0" all match). Prices are paise (₹1 = 100). If nothing matches, ask the person whether to add it (add_catalog_item).' },
  handler: async (ctx, { query }) => ({ items: await findItems(ctx, query.query ?? '') }),
});
defineV1Operation({ operationId: 'addCatalogItem', method: 'POST', path: '/api/v1/billing/catalogue', scope: 'billing.write',
  summary: 'Add a service, product or consumable to the catalogue',
  body: object({ kind: { enum: ['service', 'product', 'consumable'] }, name: text(160), code: { type: 'string', pattern: '^[A-Za-z0-9._/-]{1,40}$' }, description: text(4000, 0),
    unit: text(20), price: paise, gstRate: { enum: [0, 0.1, 0.25, 1.5, 3, 5, 6, 12, 18, 28, 40] }, sac: { type: 'string', pattern: '^[0-9]{4,8}$' }, trackStock: bool, cost: paise }, ['kind', 'name', 'price']),
  response: object({ item: ITEM, ...UNDO }), available: seesBilling(true), authorize: billingWriter,
  mcp: { name: 'add_catalog_item', title: 'Add a catalogue item',
    description: 'Adds an item to the catalogue: kind service, product or consumable; price in paise (₹1 = 100); gstRate (default 18); unit (default "nos"); trackStock true for physical stock. Ask the person first: the catalogue is shared by everyone who bills. Undo with undo_change for 7 days (it is archived).' },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    const made = await createItem(ctx.client, await viewerOf(ctx), { ...b, unit: b.unit ?? 'nos', gstRate: b.gstRate ?? 18, status: 'active' });
    const item = itemOut((await ctx.client.query(`select ${ITEM_COLS} from pulse.erp_item i where i.id=$1`, [made.id])).rows[0]);
    return { item, changeId: await change(ctx, 'catalog.item.create', made.id, { name: item.name }), undoUntil: undoUntil() };
  },
});
defineV1Operation({ operationId: 'listStock', method: 'GET', path: '/api/v1/billing/stock', scope: 'billing.read',
  summary: 'Stock on hand for items that track stock', query: object({ query: qText(120) }, []), response: list(ITEM),
  available: seesBilling(false), authorize: billingReader,
  mcp: { name: 'list_stock', title: 'Stock on hand', description: 'Lists items that track stock with the quantity on hand, matching words if given (case and spaces ignored).' },
  handler: async (ctx, { query }) => ({ items: await findItems(ctx, query.query ?? '', true) }),
});
const MOVE = object({ moveId: uuid, itemId: uuid, kind: str, qty: num, onHand: num, ...UNDO });
const moveBody = (extra: Closed['properties'], required: string[]) => object({ ...extra, note: text(500, 0), onDate: day, unitCost: paise }, required);
async function move(ctx: V1Context, itemId: string, kind: 'in' | 'adjust', qty: number, b: Row) {
  const track = await one<boolean>(ctx, 'select track_stock v from pulse.erp_item where id=$1', [itemId]);
  if (track === undefined) v1Fail(404, 'Item not found');
  if (!track) v1Fail(409, 'This item does not track stock; switch on stock for it in Billing → Catalogue first');
  const r = await stockMove(ctx.client, await viewerOf(ctx), itemId, { kind, qty, note: b.note, onDate: b.onDate, unitCost: b.unitCost });
  return { moveId: r.id, itemId, kind, qty, onHand: r.onHand, changeId: await change(ctx, 'stock.move', r.id, { itemId, kind, qty }), undoUntil: undoUntil() };
}
defineV1Operation({ operationId: 'recordStockIn', method: 'POST', path: '/api/v1/billing/stock/{itemId}/in', scope: 'billing.write',
  summary: 'Record stock coming in', params: object({ itemId: uuid }), body: moveBody({ qty: { type: 'number', exclusiveMinimum: 0, maximum: 1e9 } }, ['qty']),
  response: MOVE, available: seesBilling(true), authorize: billingWriter,
  mcp: { name: 'record_stock_in', title: 'Record stock in', description: 'Adds qty units of an item to stock (stock coming in), with an optional note, date (YYYY-MM-DD) and unit cost in paise. Returns the new quantity on hand. Undo with undo_change for 7 days.' },
  handler: (ctx, { params, body }) => move(ctx, params.itemId, 'in', Number((body as Row).qty), body as Row),
});
defineV1Operation({ operationId: 'setStockCount', method: 'POST', path: '/api/v1/billing/stock/{itemId}/count', scope: 'billing.write',
  summary: 'Set the stock on hand to a counted quantity (records the difference as an adjustment)', params: object({ itemId: uuid }),
  body: moveBody({ onHand: { type: 'number', minimum: 0, maximum: 1e9 }, confirm }, ['onHand', 'confirm']),
  response: MOVE, available: seesBilling(true), authorize: billingWriter,
  mcp: { name: 'set_stock_count', title: 'Set the stock count', destructive: true,
    description: 'Sets the quantity on hand to what was counted (Akabod: "start fresh from today\'s real stock"). The difference is recorded as an adjustment with your note. Needs confirm true. Undo with undo_change for 7 days.' },
  handler: async (ctx, { params, body }) => {
    const b = body as Row, now = await one<number>(ctx, 'select pulse.erp_on_hand($1)::float8 v', [params.itemId]) ?? 0;
    const diff = Number(b.onHand) - Number(now);
    confirmed(b, `the stock on hand goes from ${now} to ${b.onHand}`);
    if (diff === 0) v1Fail(409, `The stock on hand is already ${now}`);
    return move(ctx, params.itemId, 'adjust', diff, { ...b, note: String(b.note ?? '') || `Counted: ${b.onHand}` });
  },
});

// ------------------------------------------------------------------------------------------------ quotations, invoices, payments
const LINE_IN = object({ itemId: uuid, description: text(300), details: text(1000, 0), qty: { type: 'number', exclusiveMinimum: 0, maximum: 1e9 }, rate: paise,
  gstRate: { enum: [0, 0.1, 0.25, 1.5, 3, 5, 6, 12, 18, 28, 40] }, unit: text(20), sac: { type: 'string', pattern: '^[0-9]{4,8}$' }, discountPercent: { type: 'number', minimum: 0, maximum: 100 } }, []);
const BUYER = object({ name: text(200), phone: text(40, 0), email: text(200, 0), gstin: text(15, 0), contactName: text(120, 0), address: { type: 'array', items: text(160), maxItems: 6 } }, ['name']);
const LINE_OUT = object({ itemId: maybe, description: str, qty: num, rate: int, gstRate: num, total: int });
const PAYMENT = object({ id: uuid, receivedOn: str, amount: int, method: maybe, reference: maybe, voided: bool });
const DOC = object({ id: uuid, docType: str, status: str, number: maybe, revision: int, buyer: object({ name: str, phone: maybe, email: maybe, gstin: maybe }),
  clientId: maybe, contactPersonId: maybe, issueDate: maybe, validUntil: maybe, dueDate: maybe, taxable: int, tax: int, total: int, paid: int, due: int,
  needsOwnerApproval: bool, approvalTaskId: maybe, lines: { type: 'array', items: LINE_OUT }, payments: { type: 'array', items: PAYMENT }, url: str });
async function readDoc(ctx: V1Context, id: string, type?: string) {
  const d = (await ctx.client.query(`select ${DOC_COLS} from pulse.erp_document d where d.id=$1`, [id])).rows[0];
  if (!d || (type && d.docType !== type)) v1Fail(404, `${type === 'invoice' ? 'Invoice' : type === 'quotation' ? 'Quotation' : 'Document'} not found`);
  const lines = await rows(ctx, `select ${LINE_COLS} from pulse.erp_line where document_id=$1 and not not_needed order by position`, [id]);
  const pays = await rows(ctx, `select id,to_char(received_on,'YYYY-MM-DD') "receivedOn",amount::float8 amount,method,reference,voided_at is not null voided from pulse.erp_payment where document_id=$1 order by received_on`, [id]);
  const b = (d.buyer ?? {}) as Row;
  return { id: String(d.id), docType: String(d.docType), status: String(d.status), number: d.number ?? null, revision: Number(d.revision ?? 0),
    buyer: { name: String(b.name ?? ''), phone: (b.phone as string) ?? null, email: (b.email as string) ?? null, gstin: (b.gstin as string) ?? null },
    clientId: d.clientId ?? null, contactPersonId: d.contactPersonId ?? null, issueDate: d.issueDate ?? null, validUntil: d.validUntil ?? null, dueDate: d.dueDate ?? null,
    taxable: int0(d.taxable), tax: int0(Number(d.cgst) + Number(d.sgst) + Number(d.igst)), total: int0(d.total), paid: int0(d.paid),
    due: Math.max(0, int0(d.total) - int0(d.paid) - int0(d.credited)), needsOwnerApproval: d.ownerApproval === 'needed', approvalTaskId: d.taskId ?? null,
    lines: lines.map(l => ({ itemId: (l.itemId as string) ?? null, description: String(l.description), qty: Number(l.qty), rate: int0(l.rate), gstRate: Number(l.gstRate), total: int0(l.total) })),
    payments: pays.map(p => ({ id: String(p.id), receivedOn: String(p.receivedOn), amount: int0(p.amount), method: (p.method as string) ?? null, reference: (p.reference as string) ?? null, voided: !!p.voided })),
    url: `${origin()}/erp/documents/${d.id}` };
}
/** A line from the catalogue takes the item's name, unit, SAC, GST and price unless the call says otherwise. */
async function linesFrom(ctx: V1Context, raw: Row[]) {
  const out: Row[] = [];
  for (const [n, l] of raw.entries()) {
    let base: Row = { description: '', details: '', unit: 'nos', sac: null, rate: 0, gstRate: 18 };
    if (l.itemId) {
      const i = (await ctx.client.query(`select id,name,description,unit,sac,price::float8 price,gst_rate::float8 gst,status,kind from pulse.erp_item where id=$1`, [l.itemId])).rows[0];
      if (!i || i.status === 'archived') v1Fail(400, `Line ${n + 1}: that catalogue item is not available (search_catalogue)`);
      base = { itemId: i.id, description: i.name, details: '', unit: i.unit, sac: i.sac, rate: Number(i.price), gstRate: Number(i.gst) };
    } else if (!l.description) v1Fail(400, `Line ${n + 1}: give a catalogue itemId or a description`);
    out.push({ ...base, ...Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)), qty: Number(l.qty ?? 1), discount: 0, discountPercent: l.discountPercent ?? null,
      parentIndex: null, open: false, notNeeded: false });
  }
  return out;
}
/** Saves fields onto a draft, keeping everything else the draft has (as the issue screen does). */
async function patchDraft(ctx: V1Context, id: string, patch: Row) {
  const v = await viewerOf(ctx);
  const cur = (await ctx.client.query(`select ${DOC_COLS} from pulse.erp_document d where d.id=$1`, [id])).rows[0];
  const lines = patch.lines ?? (await rows(ctx, `select ${LINE_COLS} from pulse.erp_line where document_id=$1 order by position`, [id]));
  const buyer = patch.buyer ? { ...(cur.buyer ?? {}), ...(patch.buyer as Row) } : cur.buyer;
  const fig = await saveDraft(ctx.client, v, id, { ...cur, ...patch, buyer, lines });
  return fig;
}
const QUOTE_IN = { clientId: uuid, contactPersonId: uuid, buyer: BUYER, lines: { type: 'array', items: LINE_IN, minItems: 1, maxItems: 100 }, notes: text(2000, 0),
  validUntil: day, siteLocation: text(300, 0) };
defineV1Operation({ operationId: 'listQuotations', method: 'GET', path: '/api/v1/billing/quotations', scope: 'billing.read',
  summary: 'Quotations, newest first, by status or matching the buyer or number',
  query: object({ status: { enum: ['draft', 'issued', 'sent', 'accepted', 'declined', 'cancelled', 'all'] }, query: qText(120), clientId: uuid }, []),
  response: list(object({ id: uuid, number: maybe, status: str, buyer: str, total: int, revision: int, needsOwnerApproval: bool, updatedAt: str, url: str })),
  available: seesBilling(false), authorize: billingReader,
  mcp: { name: 'list_quotations', title: 'List quotations', description: 'Lists up to 50 quotations, newest first: status draft (not approved yet), issued (approved), sent, accepted, declined, cancelled or all (default); query matches the buyer\'s name or the number (case and spaces ignored); clientId keeps one client\'s.' },
  handler: async (ctx, { query }) => ({ items: (await rows(ctx, `select d.id,d.number,d.status,coalesce(d.buyer->>'name','') buyer,d.total::float8 total,d.revision,d.owner_approval='needed' "needsOwnerApproval",d.updated_at::text "updatedAt"
      from pulse.erp_document d where d.doc_type='quotation' and ($1='all' or d.status=$1) and ($2::uuid is null or d.client_id=$2)
        and ($3='' or ${squashed("d.buyer->>'name'", 3)} or ${squashed('d.number', 3)}) order by d.updated_at desc limit 50`,
      [query.status ?? 'all', query.clientId ?? null, squash(query.query ?? '')])).map(r => ({ id: String(r.id), number: (r.number as string) ?? null, status: String(r.status),
      buyer: String(r.buyer), total: int0(r.total), revision: Number(r.revision ?? 0), needsOwnerApproval: !!r.needsOwnerApproval, updatedAt: String(r.updatedAt), url: `${origin()}/erp/documents/${r.id}` })) }),
});
defineV1Operation({ operationId: 'getDocument', method: 'GET', path: '/api/v1/billing/documents/{documentId}', scope: 'billing.read',
  summary: 'Read a quotation, proforma, invoice or credit note with its lines and payments', params: object({ documentId: uuid }), response: DOC,
  available: seesBilling(false), authorize: billingReader,
  mcp: { name: 'get_billing_document', title: 'Read a quotation or invoice', description: 'Reads one quotation, proforma, invoice or credit note: status, number, revision, buyer, lines, totals, payments and what is still due (paise). needsOwnerApproval: a price differs from the catalogue and the owner must approve it.' },
  handler: async (ctx, { params }) => readDoc(ctx, params.documentId),
});
defineV1Operation({ operationId: 'createQuotation', method: 'POST', path: '/api/v1/billing/quotations', scope: 'billing.write',
  summary: 'Draft a quotation for a client, a contact (leads included) or a buyer typed in, from catalogue items or lines',
  body: object(QUOTE_IN, ['lines']), response: object({ quotation: DOC, ...UNDO }), available: seesBilling(true), authorize: billingWriter,
  mcp: { name: 'create_quotation', title: 'Draft a quotation',
    description: 'Drafts a quotation (not numbered or sent yet). Name the buyer with clientId (find_or_create_client), contactPersonId (a contact or lead) or buyer {name, phone, email, gstin}. Each line is a catalogue itemId (search_catalogue; its name, GST and price fill in) and qty, optionally rate in paise (₹1 = 100) to quote a different price (the owner must then approve it), or a description and rate for a line not in the catalogue. Next: submit_quotation to ask for approval. Undo with undo_change for 7 days while it is a draft.' },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    if (!b.clientId && !b.contactPersonId && !b.buyer) v1Fail(400, 'Name the buyer: clientId, contactPersonId or buyer {name}');
    const made = await createDraft(ctx.client, await viewerOf(ctx), { docType: 'quotation', clientId: b.clientId, contactPersonId: b.contactPersonId, siteLocation: b.siteLocation,
      buyer: b.buyer }) as { id: string };
    const lines = await linesFrom(ctx, b.lines as Row[]);
    await patchDraft(ctx, made.id, { lines, ...(b.buyer && (b.clientId || b.contactPersonId) ? { buyer: b.buyer } : {}), ...(b.notes !== undefined ? { notes: b.notes } : {}),
      ...(b.validUntil ? { validUntil: b.validUntil } : {}) });
    return { quotation: await readDoc(ctx, made.id), changeId: await change(ctx, 'quotation.create', made.id, { lines: lines.length }), undoUntil: undoUntil() };
  },
});
defineV1Operation({ operationId: 'reviseQuotation', method: 'POST', path: '/api/v1/billing/quotations/{documentId}/revise', scope: 'billing.write',
  summary: 'Change a quotation: a draft is edited; an approved one is revised (same number, the approved copy kept as a version)',
  params: object({ documentId: uuid }), body: object({ reason: text(500, 0), lines: QUOTE_IN.lines, buyer: BUYER, notes: text(2000, 0), validUntil: day }, []),
  response: object({ quotation: DOC, revised: bool, ...UNDO }), available: seesBilling(true), authorize: billingWriter,
  mcp: { name: 'revise_quotation', title: 'Revise a quotation',
    description: 'Changes a quotation after negotiation. A draft is simply edited. An approved (issued or sent) quotation is revised: the approved copy is kept as a version, it reopens as a draft with the same number (R2, R3 …) and must be approved again. lines replace all lines (same shape as create_quotation); buyer fields merge. Undo with undo_change for 7 days restores the approved copy.' },
  handler: async (ctx, { params, body }) => {
    const b = body as Row, before = await readDoc(ctx, params.documentId, 'quotation');
    let revised = false;
    if (['issued', 'sent', 'accepted', 'declined'].includes(before.status)) {
      await one(ctx, 'select pulse.erp_quote_revise($1,$2) v', [params.documentId, (b.reason as string)?.trim() || null]);
      revised = true;
    } else if (before.status !== 'draft') v1Fail(409, `A ${before.status} quotation is not revised; re-issue it from Billing`);
    const patch: Row = {};
    if (b.lines) patch.lines = await linesFrom(ctx, b.lines as Row[]);
    if (b.buyer) patch.buyer = b.buyer;
    if (b.notes !== undefined) patch.notes = b.notes;
    if (b.validUntil) patch.validUntil = b.validUntil;
    if (Object.keys(patch).length) await patchDraft(ctx, params.documentId, patch);
    const after = await readDoc(ctx, params.documentId);
    return { quotation: after, revised, changeId: await change(ctx, 'quotation.revise', params.documentId, { revised, from: before.total, to: after.total, lines: before.lines }), undoUntil: undoUntil() };
  },
});
defineV1Operation({ operationId: 'submitQuotation', method: 'POST', path: '/api/v1/billing/quotations/{documentId}/submit', scope: 'billing.write',
  summary: 'Send a draft quotation for approval: a task for the owner or a manager who approves quotations',
  params: object({ documentId: uuid }), body: object({ approverId: uuid, dueOn: day, note: text(500, 0) }, []),
  response: object({ quotation: DOC, taskId: uuid, approver: str, ...UNDO }), available: seesBilling(true), authorize: billingWriter,
  mcp: { name: 'submit_quotation', title: 'Send a quotation for approval',
    description: 'Asks for approval of a draft quotation: approverId (leadership or Finance; omit it to ask the company\'s first leader) gets a task "Approve quotation …" linking the draft and is told. When they approve it in Pulse the quotation is numbered and the task is done; then send_quotation. Undo with undo_change for 7 days withdraws the request.' },
  handler: async (ctx, { params, body }) => {
    const b = body as Row, d = await readDoc(ctx, params.documentId, 'quotation');
    if (d.status !== 'draft') v1Fail(409, 'Only a draft is sent for approval; this one is approved already');
    if (d.approvalTaskId) v1Fail(409, 'This draft is already waiting for approval (approvalTaskId)');
    if (!d.lines.length) v1Fail(400, 'Add a line before asking for approval');
    // LAND-Q2 (5 Nov 2026): the approvers are Billing's own (erp_approvers: leadership, Finance, an admin who plans money),
    // and the request goes through erp_approval_ask below, so the screen, its notice and the approval gate see it too.
    const me = (await viewerOf(ctx)).person;
    const people = (await rows<{ id: string; name: string }>(ctx, 'select id,name from pulse.erp_approvers()')).filter(p => p.id !== me);
    const leaders = await rows(ctx, `select p.id from pulse.person p join pulse.role_assignment r on r.person_id=p.id where r.role_key='leadership' and p.status='active'
      and current_date between r.valid_from and coalesce(r.valid_to,'infinity') order by p.display_name`);
    const to = (b.approverId as string) ?? people.find(p => leaders.some(l => l.id === p.id))?.id ?? people[0]?.id ?? v1Fail(409, 'Nobody here approves quotations yet (leadership or the Finance role)');
    const approver = people.find(p => p.id === to) ?? v1Fail(400, 'Choose leadership or someone with the Finance role to approve');
    await ctx.client.query('select pulse.erp_approval_ask($1,$2,$3)', [params.documentId, approver.id, (b.note as string)?.trim() || null]);
    const total = `₹${(d.total / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    const title = `Approve quotation for ${d.buyer.name || 'a client'} (${total})`.slice(0, 300);
    const reviewerId = await aiReviewer(ctx);
    const taskId = await one<string>(ctx, 'select pulse.task_save(null,$1) v', [JSON.stringify({ title, assigneeId: approver.id, ...(reviewerId ? { reviewerId } : {}), ...(b.dueOn ? { dueOn: b.dueOn } : {}), priority: 'high',
      notes: `Open the draft in Billing, check the client, lines and prices, then approve it. ${d.needsOwnerApproval ? 'A price differs from the catalogue, so the owner approves it. ' : ''}The task is done when the quotation is approved.${b.note ? `\n\n${String(b.note).trim()}` : ''}` })]);
    await ctx.client.query('select pulse.task_proof_add($1,$2,$3)', [taskId, 'Quotation draft', `${origin()}/erp/documents/${params.documentId}`]);
    await ctx.client.query('update pulse.erp_document set task_id=$2 where id=$1', [params.documentId, taskId]);
    await ctx.client.query('select pulse.erp_log($1,$2,$3,$4)', ['document', params.documentId, 'task', { taskId, assignee: approver.id, approval: true }]);
    return { quotation: await readDoc(ctx, params.documentId), taskId, approver: approver.name, changeId: await change(ctx, 'quotation.submit', params.documentId, { taskId }), undoUntil: undoUntil() };
  },
});
defineV1Operation({ operationId: 'approveQuotation', method: 'POST', path: '/api/v1/billing/quotations/{documentId}/approve', scope: 'billing.write',
  summary: 'Approve a draft quotation: it is numbered, its PDF filed and it can be sent (a person only)', params: object({ documentId: uuid }), body: object({ confirm }),
  response: object({ quotation: DOC }), available: seesBilling(true), authorize: billingWriter,
  mcp: { name: 'approve_quotation', title: 'Approve a quotation', destructive: true,
    description: 'Approves a draft quotation as you: it gets its number (a revision keeps its number), its PDF is filed and the approval task is done. Approved quotations cannot be edited, only revised. Needs confirm true and a person\'s own connection; a price that differs from the catalogue needs the owner (leadership). Not undoable.' },
  handler: async (ctx, { params, body }) => {
    human(ctx, 'Approving a quotation');
    const d = await readDoc(ctx, params.documentId, 'quotation');
    if (d.status !== 'draft') v1Fail(409, 'Only a draft is approved; this quotation is approved already');
    confirmed(body, `quotation for ${d.buyer.name || 'the client'} for ₹${(d.total / 100).toLocaleString('en-IN')} will be numbered and filed`);
    if (d.needsOwnerApproval && !(await viewerIs(ctx, 'leadership'))) v1Fail(403, 'A price differs from the catalogue: the owner (leadership) approves this one');
    await issueDocument(ctx.client, await viewerOf(ctx), params.documentId);
    const after = await readDoc(ctx, params.documentId);
    await change(ctx, 'quotation.approve', params.documentId, { number: after.number, total: after.total });
    return { quotation: after };
  },
});
defineV1Operation({ operationId: 'sendQuotation', method: 'POST', path: '/api/v1/billing/quotations/{documentId}/send', scope: 'billing.write',
  summary: 'Mark an approved quotation sent and get the client\'s link to view and accept it',
  params: object({ documentId: uuid }), body: object({ confirm, days: { type: 'integer', minimum: 1, maximum: 90 }, note: text(500, 0) }, ['confirm']),
  response: object({ quotation: DOC, acceptUrl: str, expiresInDays: int }), available: seesBilling(true), authorize: billingWriter,
  mcp: { name: 'send_quotation', title: 'Send a quotation', destructive: true,
    description: 'For an approved quotation: makes the client\'s private link (they see it, download the PDF and accept or decline; days 1 to 90, default 30) and records it as sent by you. Pulse does not message the client itself: deliver acceptUrl yourself (WhatsApp, e-mail). Needs confirm true. Not undoable.' },
  handler: async (ctx, { params, body }) => {
    const b = body as Row, d = await readDoc(ctx, params.documentId, 'quotation');
    if (d.status === 'draft') v1Fail(409, 'This quotation is not approved yet: submit_quotation, then a person approves it');
    if (['cancelled', 'declined'].includes(d.status)) v1Fail(409, `A ${d.status} quotation is not sent`);
    confirmed(b, `quotation ${d.number} goes to ${d.buyer.name || 'the client'} and is recorded as sent`);
    const token = randomBytes(32).toString('base64url'), days = Number(b.days ?? 30);
    await ctx.client.query('select pulse.erp_accept_link_create($1,$2,$3)', [params.documentId, createHash('sha256').update(token).digest('hex'), days]);
    if (d.status === 'issued') await ctx.client.query('select pulse.erp_document_mark($1,$2,$3)', [params.documentId, 'sent', (b.note as string)?.trim() || 'Sent through an app']);
    await change(ctx, 'quotation.send', params.documentId, { number: d.number });
    const host = await one<string | null>(ctx, 'select pulse.org_public_host() v', []);
    return { quotation: await readDoc(ctx, params.documentId), acceptUrl: `${companyLinkOrigin(host)}/accept/${token}`, expiresInDays: days };
  },
});
defineV1Operation({ operationId: 'listInvoices', method: 'GET', path: '/api/v1/billing/invoices', scope: 'billing.read',
  summary: 'Invoices, newest first, by status or matching the buyer or number',
  query: object({ status: { enum: ['draft', 'issued', 'sent', 'part_paid', 'paid', 'cancelled', 'unpaid', 'all'] }, query: qText(120), clientId: uuid }, []),
  response: list(object({ id: uuid, number: maybe, status: str, buyer: str, total: int, due: int, issueDate: maybe, dueDate: maybe, url: str })),
  available: seesBilling(false), authorize: billingReader,
  mcp: { name: 'list_invoices', title: 'List invoices', description: 'Lists up to 50 invoices, newest first, with what is still due (paise): status draft, issued, sent, part_paid, paid, cancelled, unpaid (anything not paid) or all (default); query matches the buyer or number.' },
  handler: async (ctx, { query }) => ({ items: (await rows(ctx, `select d.id,d.number,d.status,coalesce(d.buyer->>'name','') buyer,d.total::float8 total,greatest(d.total-d.paid-d.credited,0)::float8 due,
      to_char(d.issue_date,'YYYY-MM-DD') "issueDate",to_char(d.due_date,'YYYY-MM-DD') "dueDate" from pulse.erp_document d where d.doc_type='invoice'
        and ($1='all' or d.status=$1 or ($1='unpaid' and d.status not in ('draft','paid','cancelled'))) and ($2::uuid is null or d.client_id=$2)
        and ($3='' or ${squashed("d.buyer->>'name'", 3)} or ${squashed('d.number', 3)}) order by d.issue_date desc,d.updated_at desc limit 50`,
      [query.status ?? 'all', query.clientId ?? null, squash(query.query ?? '')])).map(r => ({ id: String(r.id), number: (r.number as string) ?? null, status: String(r.status), buyer: String(r.buyer),
      total: int0(r.total), due: int0(r.due), issueDate: (r.issueDate as string) ?? null, dueDate: (r.dueDate as string) ?? null, url: `${origin()}/erp/documents/${r.id}` })) }),
});
defineV1Operation({ operationId: 'createInvoice', method: 'POST', path: '/api/v1/billing/invoices', scope: 'billing.write',
  summary: 'Draft an invoice from an approved quotation, or with its own buyer and lines',
  body: object({ quotationId: uuid, ...QUOTE_IN }, []), response: object({ invoice: DOC, ...UNDO }), available: seesBilling(true), authorize: billingWriter,
  mcp: { name: 'create_invoice', title: 'Draft an invoice',
    description: 'Drafts an invoice. With quotationId (an approved quotation) it copies the client and lines (a retry opens the one already made). Otherwise name the buyer and lines as in create_quotation. A person issues it (issue_invoice). Undo with undo_change for 7 days while it is a draft.' },
  handler: async (ctx, { body }) => {
    const b = body as Row, v = await viewerOf(ctx);
    if (!b.quotationId && !b.lines) v1Fail(400, 'Give quotationId, or the buyer and lines');
    const made = await createDraft(ctx.client, v, b.quotationId ? { docType: 'invoice', sourceId: b.quotationId }
      : { docType: 'invoice', clientId: b.clientId, contactPersonId: b.contactPersonId, siteLocation: b.siteLocation, buyer: b.buyer }) as { id: string; existing?: boolean };
    if (!made.existing && b.lines) await patchDraft(ctx, made.id, { lines: await linesFrom(ctx, b.lines as Row[]), ...(b.notes !== undefined ? { notes: b.notes } : {}) });
    const changeId = made.existing ? null : await change(ctx, 'invoice.create', made.id, { from: b.quotationId ?? null });
    return { invoice: await readDoc(ctx, made.id), changeId, undoUntil: changeId ? undoUntil() : null };
  },
});
defineV1Operation({ operationId: 'issueInvoice', method: 'POST', path: '/api/v1/billing/invoices/{documentId}/issue', scope: 'billing.write',
  summary: 'Issue a draft invoice: numbered, filed and booked in Clients (a person only)', params: object({ documentId: uuid }), body: object({ confirm }),
  response: object({ invoice: DOC }), available: seesBilling(true), authorize: billingWriter,
  mcp: { name: 'issue_invoice', title: 'Issue an invoice', destructive: true,
    description: 'Issues a draft invoice as you: it gets the next invoice number, its PDF is filed and the client is booked in Clients and Contacts. Issued invoices are kept (cancel or credit note in Billing). Needs confirm true and a person\'s own connection. Not undoable.' },
  handler: async (ctx, { params, body }) => {
    human(ctx, 'Issuing an invoice');
    const d = await readDoc(ctx, params.documentId, 'invoice');
    if (d.status !== 'draft') v1Fail(409, 'Only a draft invoice is issued');
    confirmed(body, `invoice for ${d.buyer.name || 'the client'} for ₹${(d.total / 100).toLocaleString('en-IN')} gets the next number`);
    await issueDocument(ctx.client, await viewerOf(ctx), params.documentId);
    const after = await readDoc(ctx, params.documentId);
    await change(ctx, 'invoice.issue', params.documentId, { number: after.number, total: after.total });
    return { invoice: after };
  },
});
defineV1Operation({ operationId: 'recordPayment', method: 'POST', path: '/api/v1/billing/invoices/{documentId}/payments', scope: 'billing.write',
  summary: 'Record money received against an issued invoice', params: object({ documentId: uuid }),
  body: object({ amount: { type: 'integer', minimum: 1, maximum: 100_000_000_000 }, tds: paise, receivedOn: day, method: { enum: ['bank', 'upi', 'cash', 'cheque', 'card', 'other'] },
    reference: text(120, 0), note: text(500, 0), confirm }, ['amount', 'confirm']),
  response: object({ paymentId: uuid, invoice: DOC, ...UNDO }), available: seesBilling(true), authorize: billingWriter,
  mcp: { name: 'record_payment', title: 'Record a payment', destructive: true,
    description: 'Records a payment received on an issued invoice: amount in paise (₹1 = 100), optional TDS withheld (paise), receivedOn (YYYY-MM-DD, default today), method (bank, upi, cash, cheque, card, other) and reference (UTR, cheque number). The first money in starts the client\'s project. Needs confirm true. Undo with undo_change for 7 days voids it.' },
  handler: async (ctx, { params, body }) => {
    const b = body as Row, d = await readDoc(ctx, params.documentId, 'invoice');
    if (['draft', 'cancelled'].includes(d.status)) v1Fail(409, `A ${d.status} invoice takes no payment`);
    confirmed(b, `₹${(Number(b.amount) / 100).toLocaleString('en-IN')} received on invoice ${d.number} (${d.buyer.name}), ₹${(d.due / 100).toLocaleString('en-IN')} due now`);
    const paymentId = await one<string>(ctx, 'select pulse.erp_payment_add($1,$2) v', [params.documentId, { amount: Number(b.amount), tds: Number(b.tds ?? 0),
      receivedOn: b.receivedOn ?? await one<string>(ctx, `select (now() at time zone ${ORG_TZ})::date::text v`),
      method: b.method ?? 'bank', reference: b.reference ?? '', bankLineKey: null, note: b.note ?? '' }]);
    return { paymentId, invoice: await readDoc(ctx, params.documentId), changeId: await change(ctx, 'payment.record', paymentId, { documentId: params.documentId, amount: Number(b.amount) }), undoUntil: undoUntil() };
  },
});
