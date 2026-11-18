// BHARATA-2 (16 Nov 2026, owner: "Bharata works every time, by text and voice, at low token cost"): one call drafts a
// quotation from the words of the request. The AI employee says who it is for and what was asked, in short words
// ("5 kW system", "10-year warranty", "transport" at the stated price); Pulse finds the client (a sound-alike name is
// taken when only one fits and nobody said "new"), matches each thing against the catalogue (quote-words.ts), copies the
// client's last approved quotation for "same as last time", reuses an open draft with the same lines, changes a named
// draft, and asks for approval when told. Whatever it is not sure of (which client, a new client's name heard in a voice
// note, a price the catalogue does not have, a size it does not sell) comes back as one question, and nothing is
// written. The answer is ready to post in the asker's language, so a quotation costs one model round, not four to six.
// Runs as the caller (row security; Billing writers only), through the same code as createQuotation and submitQuotation.
import { createDraft, issueDocument } from './erp.js';
import { defineV1Operation, v1Fail, type V1Context } from './v1.js';
import { bool, change, digits, int, maybe, maybeNum, num, object, one, rows, RUNTIME_CHAT, squash, str, text, undoUntil, uuid, viewerOf, type Row } from './v1-kit.js';
import * as money from './v1-money.js';
import { colleagueNamed, draftReply, langOf, parseWords, pickItem, sizesOf, submitsAtOnce, words, type CatItem, type DocView } from './quote-words.js';

const ITEM_WORDS = object({ words: text(200), qty: { type: 'number', exclusiveMinimum: 0, maximum: 1e6 }, priceRupees: { type: 'number', minimum: 0, maximum: 1e9 },
  discountPercent: { type: 'number', minimum: 0, maximum: 100 }, gstPercent: { enum: [0, 0.1, 0.25, 1.5, 3, 5, 6, 12, 18, 28, 40] } }, ['words']);
const VIEW_LINE = object({ code: maybe, description: str, qty: num, rate: int, gstRate: num, discountPercent: maybeNum, total: int });
const VIEW = object({ id: uuid, url: str, status: str, number: maybe, buyer: str, taxable: int, tax: int, roundOff: int, total: int, needsOwnerApproval: bool, waitingFor: maybe,
  lines: { type: 'array', items: VIEW_LINE } });
const CLIENT_VIEW = object({ id: uuid, name: str, created: bool });

type Client = { id: string; name: string; created: boolean };
const strip = (s: unknown) => String(s ?? '').trim();

/** The quotation as the answer shows it (rupee amounts stay paise in the fields; the reply says them in rupees). */
async function view(ctx: V1Context, id: string): Promise<DocView & Row> {
  const d = await money.readDoc(ctx, id, 'quotation');
  const codes = new Map((await rows<{ id: string; code: string | null }>(ctx, 'select id::text,code from pulse.erp_item where id=any($1::uuid[])',
    [d.lines.map((l) => l.itemId).filter(Boolean)])).map((r) => [r.id, r.code]));
  const disc = await rows<{ p: number | null }>(ctx, 'select discount_percent::float8 p from pulse.erp_line where document_id=$1 and not not_needed order by position', [id]);
  const waiting = d.approvalTaskId && d.status === 'draft'
    ? (await rows<{ n: string }>(ctx, 'select p.display_name n from pulse.task t join pulse.person p on p.id=t.assignee_person_id where t.id=$1', [d.approvalTaskId]))[0]?.n ?? 'the approver' : null;
  return { id: d.id, url: String(d.url), status: d.status, number: (d.number as string) ?? null, buyer: d.buyer.name, taxable: d.taxable, tax: d.tax, roundOff: d.roundOff, total: d.total,
    needsOwnerApproval: !!d.needsOwnerApproval, waitingFor: waiting,
    lines: d.lines.map((l, i) => ({ code: (l.itemId && codes.get(String(l.itemId))) ?? null, description: l.description, qty: l.qty, rate: l.rate, gstRate: l.gstRate,
      discountPercent: disc[i]?.p ? Number(disc[i].p) : null, total: l.total })) };
}
const sameLines = (a: Row[], b: Row[]) => a.length === b.length && a.every((x, i) => String(x.itemId ?? x.description) === String(b[i].itemId ?? b[i].description)
  && Number(x.qty) === Number(b[i].qty) && Math.round(Number(x.rate)) === Math.round(Number(b[i].rate)) && Number(x.discountPercent ?? 0) === Number(b[i].discountPercent ?? 0));

defineV1Operation({ operationId: 'draftQuotationFromWords', method: 'POST', path: '/api/v1/billing/quotations/from-words', scope: 'billing.write',
  summary: 'Draft (or change, copy, submit) a quotation from the words of a request: client by name, items in short words, matched to the catalogue',
  body: object({ client: text(200, 0), clientId: uuid, newClient: bool, confirmNewClient: bool, city: text(80, 0), phone: text(40, 0),
    items: { type: 'array', items: ITEM_WORDS, maxItems: 40 }, sameAsLast: bool, draftId: uuid, submit: bool, notes: text(2000, 0), lang: { enum: ['en', 'hi', 'mr'] }, heardByVoice: bool,
    ...RUNTIME_CHAT }, []),
  response: object({ status: { enum: ['drafted', 'updated', 'existing', 'submitted', 'approved', 'ask'] }, reply: str, questions: { type: 'array', items: str }, assumed: { type: 'array', items: str },
    client: { anyOf: [CLIENT_VIEW, { type: 'null' }] }, quotation: { anyOf: [VIEW, { type: 'null' }] }, submittedTo: maybe, changeId: maybe, undoUntil: maybe,
    pdfInChat: bool }),
  // Read when a request runs, not at import (v1-money -> v1 -> routes -> here is a cycle, as v1-wl-reads notes).
  available: (ctx) => money.seesBilling(true)(ctx), authorize: (ctx) => money.billingWriter(ctx),
  mcp: { name: 'draft_quotation', title: 'Draft a quotation from the request',
    description: 'One call for a quotation: client (the name as said; clientId if known), newClient true when they say it is new, city/phone if given, items (each thing asked in short English words with its size, e.g. "5 kW system", "10-year warranty", "ACDB", "installation", "transport"; qty; priceRupees only for a price the person or your rate card gives; discountPercent), sameAsLast true for "same as last time" (copies the client\'s last approved quotation), draftId to change a draft (its id is in its link), submit true to ask for approval (a known client\'s quotation at catalogue prices goes for approval by itself; submit false keeps it a draft), notes (a discount\'s reason), lang en/hi/mr. Pulse finds the client, matches the catalogue (catalogue prices only), reuses an identical draft and returns status drafted/updated/existing/submitted/approved (the company\'s rule approved it; its PDF is in the chat) with reply (the answer to post, with the link), or status ask with the question to put to the person (nothing written). Answer with reply as it is.' },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    const lang = langOf(b.lang, `${strip(b.client)} ${JSON.stringify(b.items ?? [])}`), w = words(lang), voice = b.heardByVoice === true;
    const questions: string[] = [], assumed: string[] = [];
    const ask = () => ({ status: 'ask' as const, reply: questions.join('\n\n').slice(0, 3800), questions, assumed, client: null, quotation: null, submittedTo: null, changeId: null, undoUntil: null, pdfInChat: false });
    const numbered = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join('\n');

    // A draft named: it is changed (or only submitted); its client is the quotation's.
    const draft = b.draftId ? await money.readDoc(ctx, String(b.draftId), 'quotation') : null;
    if (draft && draft.status !== 'draft' && (b.items || b.sameAsLast)) v1Fail(409, `This quotation is approved already (${draft.number}): change it with revise_quotation`);

    // ---- the client (found, a sound-alike taken, or one to add once everything else is clear)
    let client: Client | null = null, toMake: string | null = null, mate: string | null = null;
    if (b.clientId) {
      const r = (await rows(ctx, 'select id::text,display_name from pulse.client where id=$1', [b.clientId]))[0] ?? v1Fail(404, 'Client not found');
      client = { id: String(r.id), name: String(r.display_name), created: false };
    } else if (draft?.clientId) {
      client = { id: String(draft.clientId), name: draft.buyer.name, created: false };
    } else if (strip(b.client)) {
      const name = strip(b.client), phone = digits(strip(b.phone)).slice(-10);
      const byPhone = phone.length >= 6 ? (await money.findClients(ctx, phone, 5)).filter((r) => r.phone_hit) : [];
      const byName = await money.findClients(ctx, name, 8);
      const exact = byName.filter((r) => r.name_hit || squash(String(r.company ?? '')) === squash(name));
      const pick = byPhone.length ? byPhone : exact;
      const line = (r: Row) => `${r.name}${r.city ? `, ${r.city}` : ''}${r.phone ? ` (…${digits(String(r.phone)).slice(-4)})` : ''}`;
      if (pick.length === 1) client = { id: String(pick[0].id), name: String(pick[0].name), created: false };
      else if (pick.length > 1) questions.push(`${w.whichClient}\n${numbered([...pick.slice(0, 5).map(line), w.newNamed(name)])}`);
      else if ((mate = colleagueNamed(name, await rows<{ name: string }>(ctx, "select display_name name from pulse.person where side='staff'", [])))) {
        // WL-FOLLOWUP: a colleague's name is never a new client, even when "new" was said (a task asked by voice became one).
        questions.push(w.colleague(mate));
      } else {
        const near = b.newClient === true && b.confirmNewClient === true ? [] : await money.nearClients(ctx, name);
        if (near.length === 1 && b.newClient !== true) {
          // A sound-alike of one client, nobody said "new": that client ("Desideri" heard for Desai Dairy, देसाई डेयरी).
          client = { id: String(near[0].id), name: String(near[0].name), created: false };
          assumed.push(w.took(name, client.name));
        } else if (near.length) questions.push(`${w.didYouMean(String(near[0].name))}\n${numbered([...near.map(line), w.newNamed(name)])}`);
        else if (byName.length && b.newClient !== true) questions.push(`${w.whichClient}\n${numbered([...byName.slice(0, 5).map(line), w.newNamed(name)])}`);
        else if (voice && b.confirmNewClient !== true) questions.push(w.confirmNew(name));   // a new name heard, not read: confirm it first
        else toMake = name;
      }
    } else {
      const recent = await money.findClients(ctx, '', 5);
      questions.push(`${w.whichClient}${recent.length ? `\n${numbered([...recent.map((r) => String(r.name))])}` : ''}`);
    }

    // ---- the lines: the last approved quotation's, or the items said, matched to the catalogue
    let lines: Row[] | null = null;
    if (b.sameAsLast === true && client) {
      const last = (await rows<{ id: string; number: string | null }>(ctx, `select id::text,number from pulse.erp_document where doc_type='quotation' and client_id=$1
        and status in ('issued','sent','accepted') order by issue_date desc nulls last,updated_at desc limit 1`, [client.id]))[0];
      if (!last) questions.push(w.noLast(client.name));
      else {
        const src = await rows(ctx, `select l.item_id::text "itemId",l.description,l.details,l.qty::float8 qty,l.rate::float8 rate,l.gst_rate::float8 "gstRate",l.unit,l.sac,
            l.discount_percent::float8 "discountPercent",i.price::float8 price,i.status
          from pulse.erp_line l left join pulse.erp_item i on i.id=l.item_id where l.document_id=$1 and not l.not_needed and l.parent_position is null order by l.position`, [last.id]);
        lines = src.map((l) => l.itemId && l.status !== 'archived'
          ? { itemId: l.itemId, qty: Number(l.qty), ...(Math.round(Number(l.rate)) !== Math.round(Number(l.price)) ? { rate: Math.round(Number(l.rate)) } : {}), ...(Number(l.discountPercent) ? { discountPercent: Number(l.discountPercent) } : {}) }
          : { description: String(l.description), qty: Number(l.qty), rate: Math.round(Number(l.rate)), gstRate: Number(l.gstRate), ...(l.unit ? { unit: l.unit } : {}), ...(l.sac ? { sac: l.sac } : {}) });
        assumed.push(w.sameAs(last.number ?? 'the last quotation'));
      }
    } else if (Array.isArray(b.items) && b.items.length) {
      const cat = (await rows(ctx, `select id::text,code,name,description,kind,price::float8 price,gst_rate::float8 "gstRate" from pulse.erp_item where status<>'archived' order by name limit 5000`))
        .map((r) => ({ id: String(r.id), code: (r.code as string) ?? null, name: String(r.name), description: (r.description as string) ?? null, kind: (r.kind as string) ?? null, price: Number(r.price), gstRate: Number(r.gstRate) })) as CatItem[];
      const asked = b.items as Row[];
      const picks = new Array(asked.length);
      // Sized things first ("5 kW system"): their size is the context for "warranty" or "ACDB" said without one.
      // The main product first: the first sized thing asked that is not an add-on "for" something; its size and its name
      // are the context for the rest ("warranty", "ACDB" said without a size; an add-on for that product over a part).
      const sized = [...asked.keys()].filter((i) => parseWords(String(asked[i].words)).sizes.length);
      let main: CatItem | null = null;
      for (const i of sized) {
        const p = pickItem(String(asked[i].words), cat, [], { heard: voice });
        if (p.kind === 'item' && !/\sfor\s/i.test(p.item.name)) { main = p.item; break; }
      }
      const context = main ? sizesOf(main) : [];
      for (const i of asked.keys()) picks[i] = pickItem(String(asked[i].words), cat, context, { heard: voice, main: main?.name ?? '' });
      if (!main) for (const p of picks) if (p.kind === 'item') { context.push(...sizesOf(p.item)); break; }
      if (!main && context.length) for (const i of asked.keys()) if (picks[i].kind !== 'item') picks[i] = pickItem(String(asked[i].words), cat, context, { heard: voice });
      // No prices in a question: a reply naming amounts is held as a money commitment where no draft was made.
      const choice = (c: CatItem) => `${c.name}${c.code ? ` (${c.code})` : ''}`;
      lines = [];
      for (const [i, it] of asked.entries()) {
        const p = picks[i], said = strip(it.words);
        // A count heard run into the size ("1.5 kW" for one 5 kW): that count, unless the request gave another.
        const qty = p.kind === 'item' && p.heardAs && (it.qty === undefined || Number(it.qty) === 1) ? p.heardAs.count : Number(it.qty ?? 1);
        if (p.kind === 'item' && p.heardAs) assumed.push(w.heardAs(p.heardAs.said, qty, p.heardAs.size, p.item.name));
        const price = it.priceRupees === undefined ? undefined : Math.round(Number(it.priceRupees) * 100);
        const disc = Number(it.discountPercent ?? 0) ? { discountPercent: Number(it.discountPercent) } : {};
        if (p.kind === 'item') lines.push({ itemId: p.item.id, qty, ...(price !== undefined && price !== Math.round(p.item.price) ? { rate: price } : {}), ...disc });
        else if (p.kind === 'none' && price !== undefined) lines.push({ description: said.slice(0, 300), qty, rate: price, gstRate: Number(it.gstPercent ?? 18), ...disc });
        else if (p.kind === 'none') questions.push(w.noPrice(said));
        else if (p.kind === 'size-missing') questions.push(`${w.noSize(said, p.size)}\n${numbered(p.choices.map(choice))}`);
        else questions.push(`${w.which(said)}\n${numbered(p.choices.map(choice))}`);
      }
    } else if (!draft) questions.push(w.nothing);
    if (questions.length) return ask();

    // ---- write: the new client, then the draft (made, reused or changed), then approval if asked
    if (toMake) {
      const made = await money.makeClient(ctx, { name: toMake, city: strip(b.city) || null, phone: strip(b.phone) || null });
      client = { id: made.client.id, name: made.client.name, created: true };
    }
    if (!client) return ask();
    let id = draft?.id ?? null, status: 'drafted' | 'updated' | 'existing' = 'existing', changeId: string | null = null;
    const notes = strip(b.notes) ? { notes: strip(b.notes) } : {};
    if (lines) {
      const built = await money.linesFrom(ctx, lines);
      if (draft) {
        await money.patchDraft(ctx, draft.id, { lines: built, ...notes });
        changeId = await change(ctx, 'quotation.revise', draft.id, { revised: false, from: draft.total, lines: draft.lines });
        status = 'updated';
      } else {
        // The same request again (or another salesperson's identical ask): its open draft, not a second one.
        const open = await rows<{ id: string }>(ctx, `select id::text from pulse.erp_document where doc_type='quotation' and status='draft' and client_id=$1 order by updated_at desc limit 10`, [client.id]);
        for (const o of open) {
          const have = await rows(ctx, `select item_id::text "itemId",description,qty::float8 qty,rate::float8 rate,discount_percent::float8 "discountPercent" from pulse.erp_line
            where document_id=$1 and not not_needed order by position`, [o.id]);
          if (sameLines(have, built)) { id = o.id; break; }
        }
        if (!id) {
          const made = await createDraft(ctx.client, await viewerOf(ctx), { docType: 'quotation', clientId: client.id }) as { id: string };
          await money.patchDraft(ctx, made.id, { lines: built, ...notes });
          id = made.id; status = 'drafted';
          changeId = await change(ctx, 'quotation.create', made.id, { lines: built.length });
        }
      }
    } else if (draft && notes.notes) await money.patchDraft(ctx, draft.id, notes);
    let submittedTo: string | null = null;
    let q = await view(ctx, id!);
    // QUOTE-FAST (18 Nov 2026): the chat it was asked in gets the PDF once approved (an AI employee's call; its runtime names
    // the chat). With the company's rule on (leadership's setting, off by default), an AI employee's quotation at catalogue
    // prices within the limit is approved at once: erp_quote_auto_ok checks it in the database and lets this transaction
    // through the approval gate; it is numbered and filed as any other, and its trail says the rule approved it. This is the
    // company's standing decision, not the AI deciding: the person-only approve_quotation stays person-only.
    const ai = ctx.principal.kind === 'ai', inChat = q.status === 'draft' ? await money.keepQuoteChat(ctx, id!, b, lang) : false;
    let byRule: number | null = null, pdfInChat = false;
    if (ai && q.status === 'draft' && !q.waitingFor && b.submit !== false && !client.created && !assumed.length) {
      const rule = await one<Row>(ctx, 'select pulse.erp_quote_auto_ok($1) v', [id]);
      if (rule?.ok === true) {
        const issued = await issueDocument(ctx.client, await viewerOf(ctx), id!);
        await ctx.client.query('select pulse.erp_log($1,$2,$3,$4)', ['document', id, 'approved_by_rule', { rule: 'catalogue prices, no discount', limit: rule.limit, total: rule.total }]);
        byRule = Number(rule.limit); pdfInChat = Number(issued.toChats ?? 0) > 0; changeId = null; q = await view(ctx, id!);
      }
    }
    if (!byRule && q.status === 'draft' && !q.waitingFor && submitsAtOnce({ ai, submit: b.submit, created: client.created, assumed: assumed.length, lines })) {
      // Asked for (submit true), a refusal is the answer as before. Sent by itself, a refusal (no approver here, or an AI
      // employee whose access cannot give the approver a task) leaves the draft as it was, with the offer to submit.
      const own = b.submit !== true;
      if (own) await ctx.client.query('savepoint quote_fast_submit');
      try {
        const s = await money.submitDraft(ctx, id!, {});
        submittedTo = s.approver; changeId = s.changeId; q = await view(ctx, id!);
        if (own) await ctx.client.query('release savepoint quote_fast_submit');
      } catch (e) {
        if (!own) throw e;
        await ctx.client.query('rollback to savepoint quote_fast_submit');
      }
    }
    const reply = draftReply(lang, q, { status, reused: !!lines && status === 'existing', created: client.created, submittedTo, notes: assumed,
      pdfLater: inChat && !!(submittedTo || q.waitingFor), pdfHere: pdfInChat, byRule });
    return { status: byRule ? 'approved' as const : submittedTo ? 'submitted' as const : status, reply, questions: [], assumed, client, quotation: q, submittedTo, changeId,
      undoUntil: changeId ? undoUntil() : null, pdfInChat };
  },
});
