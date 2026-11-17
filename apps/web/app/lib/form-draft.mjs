// KAZUK-GAPS (A12, 6 Nov 2026): unfinished forms kept on the server (pulse.form_draft, migration 1853) so "Resume where
// you left off" works on any device. The pure parts, unit-tested in form-draft.test.mjs.

const KEY = /^[a-z][a-z0-9-]{1,80}$/;

/** A draft's key: a form's kind and, for an existing record, its id ("erp-<uuid>", "new-project"). Null when invalid. */
export function draftKey(kind, id) {
  const k = `${String(kind ?? "").toLowerCase()}${id ? `-${String(id).toLowerCase()}` : ""}`;
  return KEY.test(k) ? k : null;
}

/** Offer a kept draft back only when it is newer than what the record itself last saved (and is not empty). */
export function offerDraft(draft, recordSavedAt) {
  if (!draft || !draft.data || typeof draft.data !== "object" || !Object.keys(draft.data).length) return false;
  const kept = Date.parse(draft.updatedAt ?? "");
  if (!Number.isFinite(kept)) return false;
  const saved = Date.parse(recordSavedAt ?? "");
  return !Number.isFinite(saved) || kept > saved;
}

/** "Saved 5 minutes ago": how long ago a draft was kept, in plain words. */
export function keptAgo(at, now = Date.now()) {
  const t = Date.parse(at ?? "");
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** The newest few things to resume: kept forms and Billing drafts in one list, newest first, without duplicates. */
export function resumeList(items, billing, labels, max = 5) {
  const rows = [
    ...(items ?? []).map((x) => ({ key: `form:${x.key}`, title: x.title, href: x.href, at: x.updatedAt, what: "Unfinished form" })),
    ...(billing ?? []).map((x) => ({ key: `doc:${x.id}`, title: [x.number ?? `New ${labels?.[x.docType] ?? "document"}`, x.buyer].filter(Boolean).join(" · "),
      href: `/erp/documents/${x.id}`, at: x.updatedAt, what: `${(labels?.[x.docType] ?? "document").replace(/^./, (c) => c.toUpperCase())} draft` })),
  ];
  // A quotation's unsaved changes ("erp-<id>") and the quotation's own draft are one thing to resume: keep the form's.
  const seen = new Set();
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).filter((r) => {
    const id = r.key.startsWith("form:erp-") ? r.key.slice(9) : r.key.startsWith("doc:") ? r.key.slice(4) : r.key;
    if (seen.has(id)) return false;
    seen.add(id); return true;
  }).slice(0, max);
}
