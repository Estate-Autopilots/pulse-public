const teamRoles = new Set(["admin", "leadership", "manager", "pgs"]);
export const DESIGNER_DETAIL_ROLES = new Set(["person", "staff"]);
const designTypes = ["single_image_ad", "carousel", "brochure", "logo", "pitch_deck", "other"];

export function normalizeDesignerRows(rows) {
  const people = rows.filter((row) => !row.sharedLogin);
  const shared = rows.filter((row) => row.sharedLogin);
  if (shared.length) {
    const types = {};
    const claimed = {};
    for (const row of shared) {
      for (const [type, value] of Object.entries(row.types ?? {})) {
        types[type] = (types[type] ?? 0) + (Number.isFinite(value) ? value : 0);
      }
      for (const [type, value] of Object.entries(row.claimed ?? {})) {
        claimed[type] = (claimed[type] ?? 0) + (Number.isFinite(value) ? value : 0);
      }
    }
    people.push({ personId: null, name: "Shared login", sharedLogin: true, types, claimed });
  }
  return people.sort((a, b) => a.name.localeCompare(b.name));
}

export function designerRowsForViewer(rows, viewerPersonId, role) {
  if (role === "hr" || role === "privacy") return [];
  const normalized = normalizeDesignerRows(rows);
  if (teamRoles.has(role)) return normalized;
  return normalized.filter((row) => row.personId === viewerPersonId && !row.sharedLogin);
}

export function canOpenDesignerDetails(viewerPersonId, designer, role) {
  return Boolean(viewerPersonId && designer.personId === viewerPersonId && !designer.sharedLogin && DESIGNER_DETAIL_ROLES.has(role));
}

export function designerWeeklyTotals(days) {
  const totals = Object.fromEntries(designTypes.map((type) => [type, 0]));
  for (const day of days) for (const type of designTypes) {
    const value = day.types?.[type];
    if (Number.isFinite(value) && value >= 0) totals[type] += value;
  }
  return totals;
}

export function hasDesignCounts(types) {
  return Object.values(types ?? {}).some((value) => Number.isFinite(value) && value > 0);
}
