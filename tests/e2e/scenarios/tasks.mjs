// Work between synthetic people: create, assign inside and outside your reach (asks, never a refusal), join a project,
// claim from the pool, review and accept (no value points since INTEGRITY 0910), and what each person's notification panel and Pip's island
// feed show with the actions they can take right there.
import { asWorker, istDate, addDays, tick } from './lib/harness.mjs';
import { summarizeNotices } from './attendance.mjs';

const card = async (p, re) => ((await p.get('/api/v0/notices')).data.rows ?? []).find((x) => re.test(x.title ?? ''));

export async function tasks({ rec, P, stack, seed }) {
  rec.section('tasks');
  const rila = P.rila, ahoro = P.ahoro, kabir = P.kabir, meera = P.meera, dev = P.dev, neha = P.neha, vikram = P.vikram;
  const opts = await kabir.get('/api/v0/work/options', { expect: 200 });
  rec.note('how', 'what the Create dialog offers a member', { keys: Object.keys(opts.data), people: opts.data.people?.length, projects: opts.data.projects?.length });

  // A member's own task; then the pod head gives one inside the pod (direct).
  const own = await kabir.post('/api/v0/work/tasks', { title: 'Export the teaser in 4K', dueOn: addDays(istDate(), 1) }, { expect: 200 });
  rec.note('how', 'a member creating a task for themself', own.data);
  const t0 = performance.now();
  const given = await ahoro.post('/api/v0/work/tasks', { title: 'Colour pass on the lobby shots', assigneeId: kabir.id, dueOn: addDays(istDate(), 2), priority: 'high' }, { expect: 200 });
  rec.check(!given.data.asked, 'a pod head assigns inside the pod directly', given.data);
  const kn = await asWorker(stack, (c) => c.query("select event_type,title,created_at from pulse.notification where person_id=$1 and subject_id=$2", [kabir.id, given.data.id]));
  rec.check(kn.rows.some((n) => n.event_type === 'task.assigned'), 'the assignee is notified (task.assigned)', kn.rows);
  rec.timing('assign → notification row exists', performance.now() - t0);

  // A member gives a colleague work: an ask ("Take it?"), never a refusal.
  const asked = await kabir.post('/api/v0/work/tasks', { title: 'Pick up the gimbal from the store', assigneeId: dev.id, note: 'Can you grab it on the way?' }, { expect: 200 });
  rec.check(!!asked.data.asked, 'a member giving a colleague a task creates an ask', asked.data);
  const devAsk = await card(dev, /gimbal|Take|asks|wants you/i);
  rec.check(devAsk && devAsk.actions?.length >= 2, "the colleague's panel has the ask with its buttons", devAsk && { title: devAsk.title, actions: devAsk.actions.map((a) => a.label) });
  // Answer through the card's own action, as the panel does.
  const accept = devAsk?.actions.find((a) => /accept|take/i.test(a.label));
  if (accept) {
    const r = await dev.call(accept.method ?? 'POST', accept.path, accept.body ?? {});
    rec.check(r.status === 200, `answering the ask from the panel ("${accept.label}") works`, r.data);
    const owner = await asWorker(stack, (c) => c.query('select assignee_person_id from pulse.task where id=$1', [asked.data.id]));
    rec.check(owner.rows[0]?.assignee_person_id === dev.id, 'after accepting, the task is the colleague\'s', owner.rows[0]);
    await tick(stack, rec);
    const back = await card(kabir, /gimbal|accepted|took/i);
    rec.note('how', 'the asker is told the answer', back && { title: back.title, group: back.group });
  }
  // Across pods: Kabir (Pod 1) to Meera (Pod 2) → an ask; Meera declines with a note.
  const cross = await kabir.post('/api/v0/work/tasks', { title: 'Share the Lakeview reel in 9:16', assigneeId: meera.id }, { expect: 200 });
  rec.check(!!cross.data.asked, 'across pods it is an ask', cross.data);
  const decline = await meera.post(`/api/v0/work/asks/${cross.data.asked?.id}/decline`, { note: 'On the Lakeview ads till Friday' });
  rec.check(decline.status === 200, 'the other pod can decline with a note', decline.data);
  const status = await kabir.get(`/api/v0/work/asks/${cross.data.asked?.id}`, { expect: 200 });
  rec.note('how', 'a declined ask, as the asker sees it', { status: status.data.status, note: status.data.note ?? status.data.answerNote });
  const crossTask = await asWorker(stack, (c) => c.query('select assignee_person_id,owner_id from pulse.task where id=$1', [cross.data.id]));
  rec.note('how', 'after a decline the task stays with', crossTask.rows[0]?.assignee_person_id === kabir.id ? 'the asker' : crossTask.rows[0]);
  // A pod head assigning to another pod: also an ask. HR assigns anyone.
  const headOut = await ahoro.post('/api/v0/work/tasks', { title: 'Outside my pod', assigneeId: meera.id });
  rec.check(headOut.status === 200 && !!headOut.data.asked, 'a pod head outside the pod asks too', headOut.data);
  const hrGive = await neha.post('/api/v0/work/tasks', { title: 'Confirm your bank details', assigneeId: meera.id }, { expect: 200 });
  rec.note('how', 'HR giving a task to anyone', { asked: hrGive.data.asked ?? null, assigned: hrGive.data.assigned });

  // Join a project: Meera asks to join "Website relaunch" (seeded ask exists); the owner (Rila) accepts.
  const asks = await rila.get('/api/v0/work/asks', { expect: 200 });
  const join = asks.data.incoming.find((a) => a.kind === 'join');
  rec.check(!!join, "the project owner sees Meera's ask to join", asks.data.incoming.map((a) => a.kind));
  if (join) {
    const ok = await rila.post(`/api/v0/work/asks/${join.id}/accept`, {}, { expect: 200 });
    rec.note('how', 'accepting a join ask', ok.data);
    const projects = await meera.get('/api/v0/work/projects', { expect: 200 });
    rec.check(JSON.stringify(projects.data).includes('Website relaunch'), 'after accepting, the project is in her projects');
  }

  // ----------------------------------------------------------------------------------------------------- the pool
  rec.section('tasks: pool');
  const pooled = await ahoro.post('/api/v0/work/tasks', { title: 'Edit a 15-second teaser for Northstar', pool: { scope: 'pod', ref: 'Pod 1' }, dueOn: addDays(istDate(), 3) });
  rec.check(pooled.status === 200, 'a pod head puts a task in the pod pool', pooled.data);
  const value = await rila.post(`/api/v0/work/tasks/${pooled.data.id}/value`, { valuePoints: 8 });
  rec.check(value.status === 400, 'a value on a task is refused (INTEGRITY: tasks carry no value)', value.data);
  const pool = await kabir.get('/api/v0/work/pool', { expect: 200 });
  const row = pool.data.rows.find((t) => t.id === pooled.data.id);
  rec.check(row && row.canClaim, 'a pod member sees it in the pool and may claim it', row && { title: row.title, canClaim: row.canClaim, valuePoints: row.valuePoints });
  const outsiderPool = await meera.get('/api/v0/work/pool', { expect: 200 });
  rec.check(!outsiderPool.data.rows.find((t) => t.id === pooled.data.id)?.canClaim, 'someone in another pod cannot claim a pod task');
  const claims = await Promise.all([kabir.post(`/api/v0/work/pool/${pooled.data.id}/claim`), dev.post(`/api/v0/work/pool/${pooled.data.id}/claim`)]);
  const winners = claims.filter((r) => r.status === 200 && (r.data?.claimed ?? r.data?.ok ?? true) !== false);
  rec.note('how', 'two people claim the same pooled task at once', claims.map((r) => ({ status: r.status, data: r.data })));
  const holder = await asWorker(stack, (c) => c.query('select assignee_person_id,claimed_by,claimed_at from pulse.task where id=$1', [pooled.data.id]));
  rec.check(!!holder.rows[0]?.claimed_by && [kabir.id, dev.id].includes(holder.rows[0].assignee_person_id), 'the first claim wins, the task is assigned to the claimant', holder.rows[0]);
  void winners;
  const doer = holder.rows[0]?.assignee_person_id === dev.id ? dev : kabir;
  // The doer finishes; the reviewer (pod head) accepts; nothing is credited.
  await doer.post(`/api/v0/tasks/${pooled.data.id}/move`, { status: 'in_progress' }, { expect: 200 });
  const self = await doer.post(`/api/v0/work/tasks/${pooled.data.id}/value`, { valuePoints: 40 });
  rec.check(self.status >= 400, 'nobody sets a value on their own work', { status: self.status, error: self.data?.error });
  const doneR = await doer.post(`/api/v0/tasks/${pooled.data.id}/move`, { status: 'done' });
  rec.note('how', 'the doer marks it done', { status: doneR.status, data: doneR.data });
  await tick(stack, rec);
  const reviewCard = await card(ahoro, /review|teaser|done/i);
  rec.note('how', "the reviewer's panel after the doer finishes", reviewCard && { title: reviewCard.title, actions: reviewCard.actions?.map((a) => a.label) });
  const acc = await ahoro.post(`/api/v0/tasks/${pooled.data.id}/accept`, { effort: 3, impact: 4, note: 'Clean cut' });
  rec.note(acc.status === 200 ? 'how' : 'P1', `the pod head accepts the finished pooled task: ${acc.status}`, acc.data);
  const credit = await asWorker(stack, (c) => c.query('select person_id,points,basis from pulse.work_credit where task_id=$1 and reversed_at is null', [pooled.data.id]));
  rec.check(credit.rows.length === 0, 'no value points are credited for accepted work', credit.rows);
  const mineValue = await doer.get('/api/v0/value/mine');
  rec.note('how', "the doer's value page", { status: mineValue.status, keys: mineValue.status === 200 ? Object.keys(mineValue.data) : mineValue.data });

  // --------------------------------------------------------------------------------- comments, mentions, Pip
  rec.section('tasks: mentions and the panel');
  const comment = await rila.post('/api/v0/work/comments', { taskId: given.data.id, body: `@${kabir.name ?? 'Kabir Shah'} the client wants warmer windows`, mentions: [kabir.id] });
  rec.check(comment.status === 200, 'a comment with a mention is saved', comment.data);
  const mn = await asWorker(stack, (c) => c.query("select event_type from pulse.notification where person_id=$1 and event_type='task.mention'", [kabir.id]));
  rec.check(mn.rows.length >= 1, 'the mentioned person gets task.mention');
  const kabirPanel = await kabir.get('/api/v0/notices', { expect: 200 });
  rec.note('how', "Kabir's panel (Needs your action / Mentions / Updates)", summarizeNotices(kabirPanel.data));
  rec.note('how', "Pip's hover summary for Kabir (due today, overdue)", kabirPanel.data.today);
  const workNotices = await kabir.get('/api/v0/work/notices');
  rec.note('how', 'the Work notices feed', { status: workNotices.status, count: (workNotices.data?.rows ?? workNotices.data?.notices ?? []).length });
  const readAll = await kabir.post('/api/v0/notices/read-all', {}, { expect: 200 });
  const after = await kabir.get('/api/v0/notices');
  rec.check(after.data.counts.unread === 0, 'Mark all read clears the unread count', { before: kabirPanel.data.counts, after: after.data.counts, readAll: readAll.data });
  const chatsAfter = (await kabir.get('/api/v0/chats')).data.channels.reduce((n, c) => n + c.unread, 0);
  rec.note('how', 'after "Mark all read" in the panel, unread chat messages left in the chat list', chatsAfter);

  // Due-soon reminder from the minute tick (task_due_tick): a task due within a day tells its doer once.
  const dueSoon = await ahoro.post('/api/v0/work/tasks', { title: 'Upload the final to the client folder', assigneeId: kabir.id, dueOn: istDate() }, { expect: 200 });
  await tick(stack, rec); await tick(stack, rec);
  const due = await asWorker(stack, (c) => c.query("select event_type,title from pulse.notification where person_id=$1 and subject_id=$2", [kabir.id, dueSoon.data.id]));
  rec.note('how', 'a task due today, after two minute ticks', due.rows);
  void seed; void vikram;
}
