// Chats end to end between synthetic people: direct messages, a group, the pod and the department; replies, quotes,
// reactions, edits, deletes and files; @mentions and their notifications; "Make a task" and /task; read receipts,
// unread counts and presence; live delivery timed from send to the other person's live update and refetch.
import { asWorker, randomUUID, tick } from './lib/harness.mjs';
import { summarizeNotices } from './attendance.mjs';

const msgs = async (p, ch, q = 'flat=1') => (await p.get(`/api/v0/chats/${ch}/messages?${q}`)).data;
const chan = async (p, id) => (await p.get('/api/v0/chats')).data.channels.find((c) => c.id === id);

export async function chats({ rec, P, stack }) {
  rec.section('chats');
  const kabir = P.kabir, ahoro = P.ahoro, meera = P.meera, dev = P.dev, sana = P.sana, vikram = P.vikram;
  const list = await kabir.get('/api/v0/chats', { expect: 200 });
  const kinds = {}; for (const c of list.data.channels) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
  rec.note('how', "Kabir's conversation list: kinds, people, retention", { kinds, people: list.data.people.length, retentionDays: list.data.retentionDays, policy: list.data.policy });
  rec.check(list.data.channels.some((c) => c.kind === 'pod' && c.name === 'Pod 1') && list.data.channels.some((c) => c.kind === 'team'), 'pod and department conversations exist automatically', kinds);
  rec.timing('chat list load (Kabir)', list.ms);

  // ------------------------------------------------------------------------- direct message, delivered live
  const dm = (await kabir.post('/api/v0/chats/direct', { personId: ahoro.id }, { expect: 200 })).data.id;
  const again = (await ahoro.post('/api/v0/chats/direct', { personId: kabir.id }, { expect: 200 })).data.id;
  rec.check(dm === again, 'a DM is one conversation whoever opens it', { dm, again });
  const live = ahoro.listen();
  await new Promise((r) => setTimeout(r, 600));
  const before = (await chan(ahoro, dm)).unread;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now(); const waiting = live.wait(dm);
    const sent = await kabir.post(`/api/v0/chats/${dm}/messages`, { body: `Live check ${i + 1}: the Sunrise cut is on Drive`, clientId: randomUUID() }, { expect: 200 });
    const evAt = await waiting;
    rec.check(evAt !== null, `Ahoro's live stream announces message ${i + 1}`, null);
    if (evAt) {
      const got = await msgs(ahoro, dm); const seenAt = performance.now();
      rec.check(got.messages.some((m) => m.id === sent.data.id), `Ahoro's refetch shows message ${i + 1}`);
      rec.timing(`DM send → recipient's live event (${i + 1})`, evAt - t0); rec.timing(`DM send → recipient has it on screen (${i + 1})`, seenAt - t0);
    }
  }
  live.close();
  const after = (await chan(ahoro, dm)).unread;
  rec.check(after - before === 3, 'three new messages add three to the unread count', { before, after });
  const mid = (await msgs(kabir, dm)).messages.at(-1);
  // Idempotent send (a retry after a lost answer) and a changed retry.
  const key = randomUUID();
  const s1 = await kabir.post(`/api/v0/chats/${dm}/messages`, { body: 'Retry-safe hello', clientId: key }, { expect: 200 });
  const s2 = await kabir.post(`/api/v0/chats/${dm}/messages`, { body: 'Retry-safe hello', clientId: key }, { expect: 200 });
  rec.check(s1.data.id === s2.data.id, 'resending with the same client id stores one message');
  await kabir.post(`/api/v0/chats/${dm}/messages`, { body: 'Different text', clientId: key }, { expect: 400 });

  // ------------------------------------------------------------------------- receipts: delivered, read, unread
  const r0 = await msgs(kabir, dm);
  rec.note('how', 'ticks before Ahoro opens the chat', r0.receipts);
  // POLISH-2 (QA-E2E P1-3): the writer's open conversation hears about "Delivered" and "Read" live, every time.
  const writer = kabir.listen();
  await new Promise((r) => setTimeout(r, 600));
  let t0 = performance.now(), heard = writer.wait(dm, 8000);
  await ahoro.get('/api/v0/chats');   // loading the list marks delivered
  const deliveredLive = await heard;
  const r1 = await msgs(kabir, dm);
  rec.check(Date.parse(r1.receipts.deliveredThrough ?? 0) >= Date.parse(s1.data.message.createdAt), 'loading the list marks messages delivered (grey double tick)', r1.receipts);
  rec.check(deliveredLive !== null, "Kabir's live stream announces the delivery (his ticks turn grey without a reload)", null);
  if (deliveredLive) rec.timing('delivered → writer\'s live event', deliveredLive - t0);
  t0 = performance.now(); heard = writer.wait(dm, 8000);
  await ahoro.post(`/api/v0/chats/${dm}/read`, { through: new Date().toISOString() }, { expect: 200 });
  const readLive = await heard;
  const r2 = await msgs(kabir, dm);
  rec.check(Date.parse(r2.receipts.readThrough ?? 0) >= Date.parse(s1.data.message.createdAt), 'reading moves the read tick (blue)', r2.receipts);
  rec.check(readLive !== null, "Kabir's live stream announces the read (blue ticks without a reload)", null);
  if (readLive) rec.timing('read → writer\'s live event', readLive - t0);
  t0 = performance.now(); heard = writer.wait(dm, 5000);
  await ahoro.post(`/api/v0/chats/${dm}/read`, { through: new Date().toISOString() }, { expect: 200 });
  rec.check(await heard === null, 'reading again with nothing new raises no live event (no refetch loops)', null);
  writer.close();
  rec.check((await chan(ahoro, dm)).unread === 0, "after reading, Ahoro's unread count is 0");

  // ---------------------------------------------------- replies, quotes, reactions, edits, deletes, files
  const root = s1.data.id;
  const thread = await ahoro.post(`/api/v0/chats/${dm}/messages`, { body: 'Thread reply from Ahoro', parentId: root, clientId: randomUUID() }, { expect: 200 });
  const quote = await ahoro.post(`/api/v0/chats/${dm}/messages`, { body: 'Quoting you', quoteId: root, clientId: randomUUID() }, { expect: 200 });
  rec.check(quote.data.message.quote?.id === root, 'a quote reply carries the quoted message');
  const flat = await msgs(kabir, dm);
  rec.check(flat.messages.find((m) => m.id === thread.data.id)?.quote?.id === root, 'in the WhatsApp view a thread reply shows as quoting its root');
  await ahoro.post(`/api/v0/chats/messages/${root}/react`, { emoji: '👍' }, { expect: 200 });
  await kabir.post(`/api/v0/chats/messages/${root}/react`, { emoji: '👍' }, { expect: 200 });
  const reacted = (await msgs(kabir, dm)).messages.find((m) => m.id === root);
  rec.check(reacted.reactions.find((r) => r.emoji === '👍')?.count === 2, 'two people reacting 👍 count 2', reacted.reactions);
  await kabir.post(`/api/v0/chats/messages/${root}/react`, { emoji: '👍' }, { expect: 200 });
  rec.check((await msgs(kabir, dm)).messages.find((m) => m.id === root).reactions.find((r) => r.emoji === '👍')?.count === 1, 'reacting again with the same emoji takes it back');
  await ahoro.post(`/api/v0/chats/messages/${root}/edit`, { body: 'Not mine' }, { expect: 403 });
  await kabir.post(`/api/v0/chats/messages/${root}/edit`, { body: 'Retry-safe hello (edited)' }, { expect: 200 });
  rec.check((await msgs(ahoro, dm)).messages.find((m) => m.id === root).editedAt, 'an edit is marked edited for the other person');
  // The 15-minute edit window: an older message cannot be edited.
  await asWorker(stack, (c) => c.query("update pulse.chat_message set created_at=now()-interval '16 minutes' where id=$1", [mid.id]));
  const late = await kabir.post(`/api/v0/chats/messages/${mid.id}/edit`, { body: 'Too late' });
  rec.check(late.status >= 400, 'after 15 minutes a message can no longer be edited', { status: late.status, error: late.data?.error });
  // Delete for everyone.
  const gone = await kabir.post(`/api/v0/chats/${dm}/messages`, { body: 'Oops, wrong chat', clientId: randomUUID() }, { expect: 200 });
  await kabir.post(`/api/v0/chats/messages/${gone.data.id}/remove`, { reason: 'Removed in Chats' }, { expect: 200 });
  const removed = (await msgs(ahoro, dm)).messages.find((m) => m.id === gone.data.id);
  rec.check(removed?.removed === true && removed.body === '', 'a deleted message shows as removed, its text gone, for the other person', removed);
  // Files: upload, send, download by the other side; nobody else.
  const bytes = Buffer.from('%PDF-1.4\n% synthetic brief\n').toString('base64');
  const up = await kabir.post(`/api/v0/chats/${dm}/files`, { name: 'brief.pdf', mime: 'application/pdf', bytes }, { expect: 200 });
  const withFile = await kabir.post(`/api/v0/chats/${dm}/messages`, { body: 'Brief attached', attachments: [up.data], clientId: randomUUID() }, { expect: 200 });
  const dl = await ahoro.get(`/api/v0/chats/files/${up.data.id}`, { expect: 200 });
  rec.check(String(dl.data).startsWith('%PDF'), 'the other person downloads the file');
  rec.check(dl.headers.get('content-disposition')?.startsWith('attachment'), 'a PDF downloads as an attachment, sandboxed', dl.headers.get('content-disposition'));
  await vikram.get(`/api/v0/chats/files/${up.data.id}`, { expect: 404 });
  const img = await kabir.post(`/api/v0/chats/${dm}/files`, { name: 'still.png', mime: 'image/png', bytes: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') }, { expect: 200 });
  const unsent = await ahoro.get(`/api/v0/chats/files/${img.data.id}?inline=1`);
  rec.check(unsent.status === 404, 'a file uploaded but not yet sent is not readable by the other person', unsent.status);
  await kabir.post(`/api/v0/chats/${dm}/messages`, { body: '', attachments: [img.data], clientId: randomUUID() }, { expect: 200 });
  const inline = await ahoro.get(`/api/v0/chats/files/${img.data.id}?inline=1`);
  rec.check(inline.headers.get('content-disposition')?.startsWith('inline'), 'an image previews inline', inline.headers.get('content-disposition'));
  const big = await kabir.post(`/api/v0/chats/${dm}/files`, { name: 'big.bin', mime: 'application/octet-stream', bytes: Buffer.alloc(5_400_000).toString('base64') });
  rec.check(big.status === 400 || big.status === 413, 'a file over 5 MB is refused', { status: big.status, error: big.data?.error });
  void withFile;

  // ------------------------------------------------------------------- the pod, the department and mentions
  const pod1 = list.data.channels.find((c) => c.kind === 'pod' && c.name === 'Pod 1').id;
  const creative = list.data.channels.find((c) => c.kind === 'team').id;
  const podMembers = (await msgs(kabir, pod1)).members.map((m) => m.name);
  rec.note('how', 'Pod 1 members (automatic, from HR pods)', podMembers);
  const mention = await kabir.post(`/api/v0/chats/${pod1}/messages`, { body: `@${sana.username} can you take the drone permit today?`, clientId: randomUUID() }, { expect: 200 });
  rec.check(mention.data.message.body.includes('@'), 'a mention is sent as text with @username');
  const sanaNote = await asWorker(stack, (c) => c.query("select event_type,title,href from pulse.notification where person_id=$1 and message_id=$2", [sana.id, mention.data.id]));
  rec.check(sanaNote.rows.some((n) => n.event_type === 'chat.mention'), 'the mentioned person gets a chat.mention notification', sanaNote.rows);
  const sanaList = await chan(sana, pod1);
  rec.check(sanaList.mentions >= 1, "the pod chat shows an @ badge in Sana's list", { unread: sanaList.unread, mentions: sanaList.mentions });
  const devNote = await asWorker(stack, (c) => c.query("select event_type from pulse.notification where person_id=$1 and message_id=$2", [dev.id, mention.data.id]));
  rec.note('how', 'other pod members (not mentioned) get for a pod message', devNote.rows.map((r) => r.event_type));
  // Someone outside the pod cannot read or post there.
  await meera.get(`/api/v0/chats/${pod1}/messages`, { expect: 404 });
  const post = await meera.post(`/api/v0/chats/${pod1}/messages`, { body: 'Can I post here?', clientId: randomUUID() });
  rec.check(post.status >= 400, 'someone outside the pod cannot post in it', { status: post.status, error: post.data?.error });
  const dept = await dev.post(`/api/v0/chats/${creative}/messages`, { body: 'Creative: new brand kit is live', clientId: randomUUID() });
  rec.check(dept.status === 200, 'department members post in the department chat', dept.data?.error);
  // Mention someone outside the conversation: are they told? (They cannot read it.)
  const outside = await kabir.post(`/api/v0/chats/${pod1}/messages`, { body: `@${meera.username} FYI`, clientId: randomUUID() }, { expect: 200 });
  const meeraNote = await asWorker(stack, (c) => c.query('select event_type from pulse.notification where person_id=$1 and message_id=$2', [meera.id, outside.data.id]));
  rec.note('how', 'mentioning someone who is not in the conversation', { notified: meeraNote.rows.map((r) => r.event_type), mentions: outside.data.message.mentions ?? null });

  // -------------------------------------------------------------------------------------------- a group
  const group = await ahoro.post('/api/v0/chats/groups', { name: 'QA shoot crew', memberIds: [kabir.id, sana.id] }, { expect: 200 });
  const g = group.data.id;
  rec.check((await chan(kabir, g))?.kind === 'custom', 'a group people make appears for its members');
  await kabir.post(`/api/v0/chats/groups/${g}`, { name: 'Taken over' }, { expect: 403 });
  await ahoro.post(`/api/v0/chats/groups/${g}/members`, { add: [dev.id] }, { expect: 200 });
  rec.check(!!(await chan(dev, g)), 'an added member sees the group');
  const devJoinHistory = (await msgs(dev, g)).messages.map((m) => m.kind);
  rec.note('how', 'what a newly added member sees in the group', devJoinHistory);
  await dev.post(`/api/v0/chats/groups/${g}/leave`, {}, { expect: 200 });
  rec.check(!(await chan(dev, g)), 'a member who leaves no longer sees the group');
  await dev.get(`/api/v0/chats/${g}/messages`, { expect: 404 });
  const groupMsg = await sana.post(`/api/v0/chats/${g}/messages`, { body: 'Gimbal packed', clientId: randomUUID() }, { expect: 200 });
  const groupNotes = await asWorker(stack, (c) => c.query("select person_id,event_type from pulse.notification where message_id=$1", [groupMsg.data.id]));
  rec.note('how', 'a group message notifies', groupNotes.rows.map((r) => r.event_type));

  // ---------------------------------------------------------------- tasks from chat: Make a task and /task
  const ask = await ahoro.post(`/api/v0/chats/${dm}/messages`, { body: 'Client wants a 30-second cut for Instagram by Friday', clientId: randomUUID() }, { expect: 200 });
  const made = await kabir.post('/api/v0/work/tasks', { title: '30-second Instagram cut', assigneeId: kabir.id, chatChannelId: dm, chatMessageId: ask.data.id, chatFollow: true }, { expect: 200 });
  const card = (await msgs(ahoro, dm)).messages.at(-1);
  rec.check(card.attachments?.[0]?.task === made.data.id && card.quote?.id === ask.data.id, '"Make a task" posts a task card in the chat, quoting the message', card);
  const notes = (await kabir.get(`/api/v0/tasks/${made.data.id}`)).data;
  rec.check(JSON.stringify(notes).includes(`/chats?channel=${dm}`), 'the task links back to the message');
  await kabir.post(`/api/v0/tasks/${made.data.id}/move`, { status: 'in_progress' }, { expect: 200 });
  const ev = (await msgs(ahoro, dm)).messages.at(-1);
  rec.check(ev.kind === 'event', "a followed task's updates arrive in the chat", { kind: ev.kind, body: ev.body });
  const slash = await kabir.post('/api/v0/work/tasks', { title: 'Book the drone pilot', assigneeId: sana.id, chatChannelId: pod1, chatFollow: false });
  rec.note('how', '/task in a pod chat: the task for a pod colleague', { status: slash.status, asked: slash.data?.asked ?? null, mode: slash.data?.mode ?? null });
  const cards = await ahoro.get(`/api/v0/chats/task-cards?ids=${made.data.id}`, { expect: 200 });
  rec.check(cards.data.tasks[0]?.statusLabel, 'a task card shows its live status', cards.data.tasks[0]);

  // -------------------------------------------------------------------------------------- presence and status
  await kabir.get('/api/v0/presence?touch=1', { expect: 200 });
  const seenActive = (await ahoro.get('/api/v0/presence')).data.people[kabir.id];
  rec.check(seenActive && Date.now() - Date.parse(seenActive.activeAt) < 60000, 'opening Pulse marks you active now for others', seenActive);
  rec.note('how', 'presence state of someone checked in at the office who has Pulse open', seenActive?.state);
  await kabir.post('/api/v0/presence', { text: 'Editing, back at 4', emoji: '🎬', until: new Date(Date.now() + 2 * 3600e3).toISOString(), dndUntil: new Date(Date.now() + 3600e3).toISOString() }, { expect: 200 });
  const seen = (await ahoro.get('/api/v0/presence')).data.people[kabir.id];
  rec.check(seen.text === 'Editing, back at 4' && seen.dnd === true, 'a status line and do-not-disturb are visible to others', seen);
  const states = Object.values((await ahoro.get('/api/v0/presence')).data.people).reduce((a, p) => ({ ...a, [p.state]: (a[p.state] ?? 0) + 1 }), {});
  rec.note('how', 'presence states across the agency', states);
  // Do not disturb: is a DM to Kabir still pushed?
  const dnd = await ahoro.post(`/api/v0/chats/${dm}/messages`, { body: 'Ping during DND', clientId: randomUUID() }, { expect: 200 });
  const dndNote = await asWorker(stack, (c) => c.query("select n.id,n.event_type,(select count(*)::int from pulse.notification_delivery d where d.notification_id=n.id) deliveries from pulse.notification n where n.person_id=$1 and n.message_id=$2", [kabir.id, dnd.data.id]));
  rec.note('how', 'a DM while the recipient is on do-not-disturb (chat status)', dndNote.rows);
  await kabir.post('/api/v0/presence', { text: null, emoji: null, until: null, dndUntil: null }, { expect: 200 });

  // ------------------------------------------------------------------------------------------ search and scope
  const found = await kabir.get('/api/v0/chats/search?q=Sunrise%20cut', { expect: 200 });
  rec.check(found.data.messages.length >= 1, 'search finds your own conversations');
  const notFound = await vikram.get('/api/v0/chats/search?q=Sunrise%20cut', { expect: 200 });
  rec.check(notFound.data.messages.length === 0, "search never shows other people's conversations");
  const panel = await sana.get('/api/v0/notices', { expect: 200 });
  rec.note('how', "Sana's notification panel after chat activity", summarizeNotices(panel.data));
  await tick(stack, rec);
}
