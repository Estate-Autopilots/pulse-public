// EST-1792: a creative sprint page's saves, kept out of React so a node test can drive them (creative-saves.test.mjs).
// Saves run one at a time, in order, and each carries the time the edit was made, so the API keeps the newest edit. An
// item's body is built when its save runs, from the newest local value of each of its fields (the item's draft): a quick
// second edit never re-sends a field from before the first. Once nothing is in flight the page shows the last good
// reply. A failed save stays "Not saved" until a later save of the same thing succeeds or Retry sends it again.

export function sprintSaves({ base, post, show, change, saved, failed: told, now = () => new Date().toISOString() }) {
  let chain = Promise.resolve(), running = 0, reply = null;
  const drafts = new Map(), intake = new Map(), failed = new Map();
  const state = () => ({ saving: running > 0, failed: failed.size, drafts: Object.fromEntries(drafts), intake: Object.fromEntries(intake) });
  function run(what, path, body, done) {
    const editedAt = now(); running += 1; change(state());
    chain = chain.then(async () => {
      try { reply = await post(path, { ...body(), editedAt }); failed.delete(what); if (done) saved(done); }
      catch (e) { failed.set(what, () => run(what, path, body, done)); told(e instanceof Error ? e.message : "Try again"); }
      running -= 1;
      if (!running) {
        if (reply) show(reply);
        reply = null; for (const k of drafts.keys()) if (!failed.has(k)) drafts.delete(k);
        for (const field of intake.keys()) if (!failed.has(`sprint:${field}`)) intake.delete(field);
      }
      change(state());
    });
    return chain;
  }
  return {
    /** An input or deliverable: `current` is what the page shows, `edit` the fields just changed. */
    item(kind, key, current, edit, done) {
      const what = `${kind}:${key}`, was = drafts.get(what) ?? { ownerPersonId: current.ownerPersonId, doneOn: current.doneOn, note: current.note };
      const next = { ...was, ...edit }; drafts.set(what, next);
      return run(what, `${base}/items`, () => ({ kind, key, ...(drafts.get(what) ?? next) }), done);
    },
    /** One intake field (package, Day 1, approver, a strategist): the API keeps the others as they are. */
    sprint(field, value, done) {
      intake.set(field, value);
      return run(`sprint:${field}`, base, () => ({ [field]: intake.get(field) ?? value }), done);
    },
    retry() { const again = [...failed.values()]; failed.clear(); for (const f of again) void f(); return chain; },
  };
}
