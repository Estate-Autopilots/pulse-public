// WORKFLOW-QA (14 Nov 2026): Kazuk's task "Set up pay for all 24 staff", walked as HR and as the founder on a scratch copy.
// Three rules People & pay follows, kept here so they are tested:
//  - setupStartDay: a first set-up records pay already being paid, so it starts on the 1st of this month (or the joining
//    day when that is later). It defaulted to today, and pay set up on the 14th paid "17 of 30 days" that month.
//  - setupWalk: nobody proposes their own pay (the API refuses it), so the person looking stays out of the walk.
//  - waitingSetups: the set-ups waiting for this founder's approval (the API's own "Review change" action), to approve
//    together instead of one person page at a time.

/** The day a first pay set-up takes effect: the 1st of today's month, or the joining day when that is later. */
export function setupStartDay(today, joinedOn) {
  const first = `${String(today).slice(0, 7)}-01`;
  return joinedOn && joinedOn > first ? joinedOn : first;
}

/** The people HR walks through "Set up pay for N people": current, no pay record yet, and not the person looking. */
export function setupWalk(people, me) {
  return (people ?? []).filter((p) => p.current && !p.hasRecord && p.id !== me).sort((a, b) => a.name.localeCompare(b.name));
}

/** The first pay set-ups proposed and waiting for this viewer (the API gives them "Review change"; never their own). */
export function waitingSetups(people) {
  return (people ?? []).filter((p) => p.action?.key === "change.approve" && p.change?.kind === "start" && p.change?.status === "proposed")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** AGREEMENTS (owner, 14 Nov 2026: "make an offer letter … it does not do anything"; BUG-SWEEP-2: "fill from the pay
 *  record"): a new offer starts from the person's pay in force (pay type, monthly pay, hourly rate and hours), so HR changes
 *  only what the offer changes. An offer being edited keeps its own figures; with no pay in force (a new hire) or figures
 *  sealed from this reader, the boxes start empty and the pay policy's structure fills the rest. Amounts are in paise.
 *  @param {{ payType?: string, figures?: { monthly?: number | null, rate?: number | null, hours?: number | null } | null } | null | undefined} inForce
 *  @param {{ payType?: string, figures?: { monthly?: number | null, rate?: number | null, hours?: number | null } | null } | null | undefined} offer */
export function offerStart(inForce, offer) {
  const src = offer ?? inForce ?? null;
  const f = src?.figures ?? null;
  const rupees = (paise) => (paise === null || paise === undefined || !Number.isFinite(Number(paise)) ? "" : String(Number(paise) / 100));
  return {
    payType: src?.payType ?? "salary",
    monthly: rupees(f?.monthly), rate: rupees(f?.rate), hours: f?.hours ? String(f.hours) : "",
    fromPay: !offer && !!inForce?.figures && (Number(inForce.figures.monthly) > 0 || Number(inForce.figures.rate) > 0),
  };
}

/** WORKFLOW-QA-2 (16 Nov 2026): "Approve all 23" sent the approvals one after another. From India each call is a ~0.5 s
 *  round trip before the server's own work (a pay letter each), so 23 took 12-20 s. They are independent (each locks one
 *  person's change), so they go `size` at a time. After the first refusal no new one starts; the ones already sent
 *  finish. Returns how many were done and the first failure (with the item it was for), in the list's order.
 *  @template T
 *  @param {T[]} items
 *  @param {(item: T) => Promise<unknown>} run
 *  @param {{ size?: number, onDone?: (done: number) => void }} [opts] */
export async function inBatches(items, run, { size = 4, onDone } = {}) {
  let next = 0, done = 0;
  /** @type {{ item: T, index: number, error: unknown } | null} */
  let failed = null;
  async function worker() {
    while (next < items.length && !failed) {
      const index = next++;
      try { await run(items[index]); done += 1; onDone?.(done); }
      catch (error) { if (!failed || index < failed.index) failed = { item: items[index], index, error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return { done, failed };
}

/** The line under "Pay set up for N of M" for someone who sets up pay and has none themselves (nobody proposes their
 *  own). WORKFLOW-QA-2: with only their own left, a founder read "You set up 0; a founder sets up yours".
 *  @param {number} others how many they set up (everyone else without pay) */
export function ownPayLine(others) {
  return others > 0 ? `You set up ${others}; a founder sets up yours.` : "Yours is the one left, and someone else sets it up.";
}

/** WORKFLOW-QA-2: the Approve-all drawer reads each person's proposed pay. On a slow line or a busy server some reads
 *  failed, and the drawer summed the rest as "pay a month in all" (₹8,13,000 shown for ₹11,64,000). Each key is read
 *  `size` at a time; the ones that gave nothing are read once more. Returns key → value for those that answered.
 *  @template K, V
 *  @param {K[]} keys
 *  @param {(key: K) => Promise<V | null | undefined>} read
 *  @param {{ size?: number, tries?: number, live?: () => boolean }} [opts] */
export async function readAll(keys, read, { size = 4, tries = 2, live = () => true } = {}) {
  /** @type {Map<K, V>} */
  const got = new Map();
  let left = [...keys];
  for (let t = 0; t < tries && left.length && live(); t++) {
    for (let i = 0; i < left.length && live(); i += size) {
      await Promise.all(left.slice(i, i + size).map(async (k) => { const v = await read(k).catch(() => null); if (v !== null && v !== undefined) got.set(k, v); }));
    }
    left = left.filter((k) => !got.has(k));
  }
  return got;
}

/** The drawer's total line: all of them, or plainly how many it covers when some pay could not be shown. */
export function setupTotalLabel(shown, all) {
  if (shown >= all) return `${all} ${all === 1 ? "person" : "people"} · pay a month in all`;
  return `Pay a month for ${shown} of ${all} people · ${all - shown} could not be shown`;
}
