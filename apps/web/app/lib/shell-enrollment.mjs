// One enrollment at a time: foreground/online retries share the native single-use pairing request.
let tail = Promise.resolve();
export function enrollShell(person, native, request, current = () => true) {
  const task = tail.catch(() => {}).then(async () => {
    if (!current()) return;
    const info = await native.info();
    if (!current() || (info.enrolled && info.personId === person)) return;
    if (info.enrolled) await native.signOut();
    if (!current()) return;
    const { code, replaces } = await native.startEnrollment();
    if (!current()) return;
    const r = await request('/api/v0/native/shell/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, replaces, expectedPersonId: person }) });
    if (!r.ok) throw Error('Phone registration is waiting. Retry from Devices when connected.');
    if (!current()) return;
    await native.finishEnrollment();
    if (current()) void native.checkInbox().catch(() => {});
  });
  tail = task; return task;
}
