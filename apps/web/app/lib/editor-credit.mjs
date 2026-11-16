const HOW_LABELS = {
  "account map": "The uploaded account is linked to a person",
  confirmation: "The delivery was confirmed for a person",
  fingerprint: "A matching file fingerprint supports the attribution",
  "folder owner": "Drive folder ownership supports the attribution",
  shared: "The delivery came through a shared login; no person is credited",
};

/** @param {import("./api").DeliveryAttributionSummary} summary */
export function attributionBuckets(summary) {
  return [
    {
      key: "person",
      label: "Credited to a person",
      count: summary.credited_to_person,
      share: `${Math.round(summary.credited_to_person_share * 100)}%`,
    },
    {
      key: "shared",
      label: "Shared login",
      count: summary.shared_login,
      share: `${Math.round(summary.shared_login_share * 100)}%`,
    },
  ];
}

/** @param {import("./api").AttributionHow | null | undefined} how @param {string | null | undefined} creditedTo */
export function deliveryHowLabel(how, creditedTo) {
  if (how && HOW_LABELS[how]) return HOW_LABELS[how];
  if (creditedTo === "shared login") return HOW_LABELS.shared;
  if (creditedTo && creditedTo !== "unresolved") return "Person credit was recorded, but its explanation is unavailable";
  return "No individual uploader was identified";
}

/** @param {string | null | undefined} creditedTo @param {import("./api").AttributionHow | null | undefined} how @param {string | null | undefined} viewerPersonId */
export function deliveryCreditExplanation(creditedTo, how, viewerPersonId) {
  if (!viewerPersonId) return null;
  if (creditedTo === viewerPersonId || creditedTo === "shared login" || creditedTo === "unresolved") {
    return deliveryHowLabel(how, creditedTo);
  }
  return "This delivery isn't credited to this person";
}
