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
