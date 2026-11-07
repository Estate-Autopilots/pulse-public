// What the map and its analysis panel compute from the locations Pulse holds. Everything here is plain arithmetic
// on the rows the API sent, so every number on the screen can be traced to the projects behind it.
import { cellToBoundary, cellToLatLng, cellsToMultiPolygon, gridDisk, latLngToCell } from "h3-js";
import type { MoneyMap, Price, Shoot } from "./intel";

export type Precision = "exact" | "building" | "street" | "locality" | "city";
export type Engagement = { projectId: string; title: string; month: string | null; clientId: string | null; clientName: string | null; clientType: string | null; pod: string | null; segment: string | null; stage: string; deliveries: number; lastDeliveredAt: string | null };
export type MapLocation = { id: string; key: string; name: string | null; clientLabel: string | null; locality: string | null; city: string | null; lat: number | null; lng: number | null; precision: Precision | null; sourceKind: "pulse" | "document" | "osm" | "other" | null; pinned: boolean; flags: string[]; rera: number; mapsLinks: number; engagements: Engagement[] };
export type Locality = { id: string; name: string; city: string; lat: number | null; lng: number | null; precision: string | null; source: string | null; aliases: string[] };
export type Money = MoneyMap;
export type ReviewItem = { id: string; title: string; entityType: "location" | "locality"; entityId: string; confidence: number;
  proposed: { rule: string; lat: number | null; lng: number | null; precision: string | null; place: string | null; km: number | null; name: string | null; projects: number; search: string };
  evidence: { why: string; from: { lat: number | null; lng: number | null; precision: string | null; city: string | null; locality: string | null; source: string | null } } };
export type MapData = { locations: MapLocation[]; localities: Locality[]; clients: { id: string; name: string; type: string; engagements: number }[]; pods: string[];
  joins?: { sourceEngagements: number | null; linkedEngagements: number; unmatchedEngagements: number | null };
  provenance: { fileName: string; sha256: string; rows: number; builtAt: string | null; importedAt: string; note: string | null }[]; pins: { moved: number; lastAt: string | null };
  canEdit: boolean; leadership: boolean; money?: Money; generatedAt: string;
  shoots?: Shoot[]; prices?: Price[]; office?: { name: string; lat: number; lng: number }[]; review?: number | null };
export type LocationDetail = { id: string; key: string; name: string | null; clientLabel: string | null; locality: string | null; city: string | null; lat: number | null; lng: number | null; precision: Precision | null;
  source: string | null; sourceKind: MapLocation["sourceKind"]; reraNumbers: string[]; mapsLinks: string[]; flags: string[]; seedLat: number | null; seedLng: number | null; seedPrecision: string | null; seedSource: string | null;
  addresses?: {address:string;editedBy:string|null}[];manualLinks?:{kind:string;label:string;value:string;editedBy:string|null}[];
  pinnedAt: string | null; pinnedBy: string | null; importFile: string | null; importBuiltAt: string | null; importedAt: string | null; importSha: string | null; engagements: Engagement[];
  clients: { id: string; name: string; companyName: string | null; type: string; engagements: number; locations: number }[];
  contacts: { id: string; name: string; type: string | null; designation: string | null; email: string | null; phone: string | null; via: string }[];
  deliveries: { total: number; finals: number; drafts: number; first: string | null; last: string | null; latest: { fileId: string; fileName: string; mime: string | null; kind: string; deliveredAt: string; projectName: string }[] };
  campaigns: { id: string; name: string; platform: string | null; objective: string | null }[]; campaignsDetail: string;
  history: { action: "pin" | "reset"; oldLat: number | null; oldLng: number | null; oldPrecision: string | null; newLat: number | null; newLng: number | null; newPrecision: string | null; note: string | null; at: string; by: string | null }[];
  money?: { connected: boolean; detail: string }; canEdit: boolean };

export const PRECISIONS: { key: Precision; label: string; meaning: string; confirmed: boolean }[] = [
  { key: "exact", label: "Exact", meaning: "Coordinates from a project document or Maps link, or a pin placed in Pulse.", confirmed: true },
  { key: "building", label: "Building", meaning: "A named site or building matched on OpenStreetMap.", confirmed: true },
  { key: "street", label: "Street", meaning: "The named road; the entrance is not confirmed.", confirmed: false },
  { key: "locality", label: "Locality", meaning: "Somewhere in this micro-market; shown around its centre.", confirmed: false },
  { key: "city", label: "City", meaning: "Only the city is known; shown around the city centre.", confirmed: false },
];
export const PRECISION_LABEL: Record<string, string> = Object.fromEntries(PRECISIONS.map((p) => [p.key, p.label]));
export const STAGES: Record<string, string> = { delivering: "Delivering", new: "New", quiet: "Quiet", dormant: "Dormant", paused: "Paused", done: "Done", cancelled: "Cancelled" };
export const STAGE_HINT = "Delivering: a file in the last 14 days. Quiet: none for 14 to 56 days. Dormant: none for longer. New: started in the last 60 days, nothing delivered yet.";
export const CLIENT_TYPES: Record<string, string> = { developer: "Developer", channel_partner: "Channel partner", other: "Other", none: "No client set" };
export const FLAGS: Record<string, string> = {
  locality_reference_centroid_not_boundary_centroid: "The locality point is an average of named local references, not a boundary centre.",
  project_name_missing: "The project has no name in the source folder.",
  multiple_rera_numbers_verify_phases_or_mixed_material: "Several RERA numbers were found; check phases or mixed material.",
  city_unresolved: "The city could not be worked out from the folder or its documents.",
  folder_and_document_locality_conflict: "The folder and its documents name different localities.",
  maps_link_without_extractable_coordinates: "A Maps link exists but exposes no coordinates.",
  ambiguous_or_corrupted_folder_location: "The location in the folder name is ambiguous.",
  nested_multiple_project_material_verify_identity: "The folder holds material from more than one project.",
  maps_plus_code_recovered_from_city_reference: "A short Plus Code was resolved against the city; confirm the pin.",
  document_pin_conflicts_with_locality_reference: "A document pin disagrees with the locality.",
  project_name_is_contact_not_submitted_to_geocoder: "The name is a person's, so it was not sent to the geocoder.",
  nominatim_no_accepted_result: "OpenStreetMap returned no acceptable match.",
  nominatim_project_candidate_too_far_from_locality: "The OpenStreetMap match was too far from the locality.",
  folder_omitted_from_projects_export_identity_unassigned: "The folder was missing from the project export; identity not confirmed.",
  conflicting_document_coordinates: "Documents give conflicting coordinates.",
  document_pin_in_mixed_project_folder_requires_review: "The pin comes from a folder with mixed project material.",
  single_word_osm_match_verify_project: "Matched on a single word; verify it is this project.",
  document_coordinate_conflicts_with_expected_city: "A document coordinate lies outside the expected city.",
  map_viewport_requires_pin_confirmation: "The coordinates are a Maps camera centre, not a confirmed entrance.",
};

/** EA writes a segment code in each folder name. One code can carry two segments ("R + Lux"). */
export function segmentTags(raw: string | null): string[] {
  if (!raw) return ["Not set"];
  const s = ` ${raw.toLowerCase().replace(/[^a-z]+/g, " ")} `; const tags: string[] = [];
  if (/ (r|residential|house) /.test(s)) tags.push("Residential");
  if (/ (p|sp|plotting) /.test(s)) tags.push("Plotting");
  if (/ (l|lux|luxury) /.test(s)) tags.push("Luxury");
  if (/ (c|commercial) /.test(s)) tags.push("Commercial");
  if (/ (m|mid) /.test(s)) tags.push("Mid-segment");
  return tags.length ? tags : ["Other"];
}
export const SEGMENTS = ["Residential", "Plotting", "Luxury", "Commercial", "Mid-segment", "Other", "Not set"];
export const SEGMENT_HINT = "Read from the segment code in the project folder name: R residential, P or SP plotting, L or Lux luxury, C commercial, M or Mid mid-segment. A folder can carry two.";

export const displayName = (l: Pick<MapLocation, "name" | "clientLabel" | "engagements">) => l.name?.trim() && l.name.trim().length > 2 ? l.name.trim() : l.engagements[0]?.title ?? l.clientLabel ?? "Unnamed project";
export const placeName = (l: { locality: string | null; city: string | null }) => [l.locality, l.city].filter(Boolean).join(", ") || "Place not known";
export const marketKey = (l: { locality: string | null; city: string | null }) => l.city ? `${l.city}|${l.locality ?? ""}` : null;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
export const monthShort = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ’${m.slice(2, 4)}`;

/** Every month from the first engagement to the last, so the slider has no gaps. */
export function monthAxis(locations: MapLocation[]): string[] {
  const all = locations.flatMap((l) => l.engagements.map((e) => e.month)).filter((m): m is string => !!m).sort();
  if (!all.length) return [];
  const out: string[] = []; let [y, m] = all[0].split("-").map(Number); const last = all[all.length - 1];
  for (;;) { const key = `${y}-${String(m).padStart(2, "0")}`; out.push(key); if (key >= last) break; m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}

export type Filters = { pods: string[]; segments: string[]; clientTypes: string[]; stages: string[]; precisions: string[]; from: number; to: number; repeatOnly: boolean };
export const NO_FILTERS = (months: number): Filters => ({ pods: [], segments: [], clientTypes: [], stages: [], precisions: [], from: 0, to: Math.max(0, months - 1), repeatOnly: false });
export const filterCount = (f: Filters) => f.pods.length + f.segments.length + f.clientTypes.length + f.stages.length + f.precisions.length + (f.repeatOnly ? 1 : 0);

export type Row = { loc: MapLocation; name: string; engagements: Engagement[]; repeat: boolean; clientIds: string[]; first: string | null; last: string | null; deliveries: number; x: number | null; y: number | null };

/**
 * The locations that pass the filters. A location passes when at least one of its engagements passes all of them;
 * the row then carries only those engagements, so counts below always agree with what is on the map.
 */
export function select(data: MapData, f: Filters, months: string[]): Row[] {
  const repeat = new Set(data.clients.filter((c) => c.engagements > 1).map((c) => c.id));
  const fullRange = f.from <= 0 && f.to >= months.length - 1;
  const lo = months[f.from] ?? "", hi = months[f.to] ?? "9999";
  const plain = !f.pods.length && !f.segments.length && !f.clientTypes.length && !f.stages.length && !f.repeatOnly && fullRange;
  const rows: Row[] = [];
  for (const loc of data.locations) {
    if (f.precisions.length && !f.precisions.includes(loc.precision ?? "none")) continue;
    const engagements = loc.engagements.filter((e) =>
      (fullRange || (!!e.month && e.month >= lo && e.month <= hi))
      && (!f.pods.length || f.pods.includes(e.pod ?? "Unassigned"))
      && (!f.segments.length || segmentTags(e.segment).some((t) => f.segments.includes(t)))
      && (!f.clientTypes.length || f.clientTypes.includes(e.clientType ?? "none"))
      && (!f.stages.length || f.stages.includes(e.stage))
      && (!f.repeatOnly || (!!e.clientId && repeat.has(e.clientId))));
    if (!engagements.length && !(plain && !loc.engagements.length)) continue;
    const monthsOf = engagements.map((e) => e.month).filter((m): m is string => !!m).sort();
    const clientIds = [...new Set(engagements.map((e) => e.clientId).filter((c): c is string => !!c))];
    rows.push({ loc, name: displayName(loc), engagements, repeat: clientIds.some((c) => repeat.has(c)), clientIds, first: monthsOf[0] ?? null, last: monthsOf[monthsOf.length - 1] ?? null,
      deliveries: engagements.reduce((n, e) => n + e.deliveries, 0), x: loc.lng, y: loc.lat });
  }
  spread(rows);
  return rows;
}

/**
 * Projects known only to a locality or a city share one coordinate. Drawing them on top of each other would hide
 * all but one, so they are laid out in a sunflower spiral around that point (about 600 m wide for a busy locality,
 * a few kilometres for a city). The stored coordinate is not changed; precise pins are never moved.
 */
function spread(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.loc.lat === null || r.loc.lng === null || r.loc.precision === "exact" || r.loc.precision === "building" || r.loc.pinned) continue;
    const key = `${r.loc.lat.toFixed(5)},${r.loc.lng.toFixed(5)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const step = group[0].loc.precision === "city" ? 420 : 115;
    group.sort((a, b) => a.loc.key.localeCompare(b.loc.key)).forEach((r, i) => {
      const radius = step * Math.sqrt(i + 0.6), angle = i * 2.39996323;
      r.y = r.loc.lat! + (radius * Math.sin(angle)) / 111320;
      r.x = r.loc.lng! + (radius * Math.cos(angle)) / (111320 * Math.cos((r.loc.lat! * Math.PI) / 180));
    });
  }
}

export const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

export type Market = { key: string; name: string; city: string; isCity: boolean; lat: number | null; lng: number | null; projects: number; engagements: number; clients: number; repeatClients: number;
  topSegment: string | null; first: string | null; last: string | null; recent: number; before: number; rows: Row[] };

/** One row per micro-market (or city, when no locality is known), counted from the visible projects. */
export function markets(rows: Row[], data: MapData, months: string[]): Market[] {
  const repeat = new Set(data.clients.filter((c) => c.engagements > 1).map((c) => c.id));
  const points = new Map(data.localities.map((l) => [`${l.city}|${l.name}`, l]));
  const recentFrom = months[Math.max(0, months.length - 12)] ?? "", beforeFrom = months[Math.max(0, months.length - 24)] ?? "";
  const groups = new Map<string, Row[]>();
  for (const r of rows) { const key = marketKey(r.loc); if (key) groups.set(key, [...(groups.get(key) ?? []), r]); }
  return [...groups.entries()].map(([key, list]) => {
    const [city, name] = key.split("|"); const point = points.get(key);
    const engagements = list.flatMap((r) => r.engagements);
    const clients = new Set(engagements.map((e) => e.clientId).filter(Boolean) as string[]);
    const segments = new Map<string, number>();
    for (const e of engagements) for (const t of segmentTags(e.segment)) if (t !== "Not set") segments.set(t, (segments.get(t) ?? 0) + 1);
    const firsts = list.map((r) => r.first).filter(Boolean).sort() as string[], lasts = list.map((r) => r.last).filter(Boolean).sort() as string[];
    // Do not turn a city fallback into a claimed locality centre when the import has none.
    const located = list.filter((r) => r.loc.lat !== null && (!name || r.loc.precision !== "city"));
    const lat = point?.lat ?? (located.length ? located.reduce((n, r) => n + r.loc.lat!, 0) / located.length : null);
    const lng = point?.lng ?? (located.length ? located.reduce((n, r) => n + r.loc.lng!, 0) / located.length : null);
    return { key, name: name || city, city, isCity: !name, lat, lng, projects: list.length, engagements: engagements.length, clients: clients.size,
      repeatClients: [...clients].filter((c) => repeat.has(c)).length, topSegment: [...segments.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      first: firsts[0] ?? null, last: lasts[lasts.length - 1] ?? null,
      recent: engagements.filter((e) => e.month && e.month >= recentFrom).length, before: engagements.filter((e) => e.month && e.month >= beforeFrom && e.month < recentFrom).length, rows: list };
  }).sort((a, b) => b.projects - a.projects || a.name.localeCompare(b.name));
}

export type Belt = { name: string; markets: Market[]; projects: number; engagements: number; repeatClients: number; lat: number; lng: number; spanKm: number };
const BELT_KM = 3.5;
/** Neighbouring micro-markets whose centres lie within 3.5 km of each other, chained into one belt. */
export function belts(list: Market[], data: MapData): Belt[] {
  const repeat = new Set(data.clients.filter((c) => c.engagements > 1).map((c) => c.id));
  const nodes = list.filter((m) => !m.isCity && m.lat !== null && m.lng !== null);
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1)
    if (km({ lat: nodes[i].lat!, lng: nodes[i].lng! }, { lat: nodes[j].lat!, lng: nodes[j].lng! }) <= BELT_KM) parent[find(i)] = find(j);
  const groups = new Map<number, Market[]>();
  nodes.forEach((m, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), m]));
  return [...groups.values()].filter((g) => g.length > 1).map((g) => {
    const sorted = [...g].sort((a, b) => b.projects - a.projects); const projects = g.reduce((n, m) => n + m.projects, 0);
    const clients = new Set(g.flatMap((m) => m.rows.flatMap((r) => r.clientIds)));
    let span = 0; for (const a of g) for (const b of g) span = Math.max(span, km({ lat: a.lat!, lng: a.lng! }, { lat: b.lat!, lng: b.lng! }));
    return { name: sorted.slice(0, 3).map((m) => m.name).join(" – ") + (g.length > 3 ? ` +${g.length - 3}` : ""), markets: sorted, projects,
      engagements: g.reduce((n, m) => n + m.engagements, 0), repeatClients: [...clients].filter((c) => repeat.has(c)).length,
      lat: g.reduce((n, m) => n + m.lat! * m.projects, 0) / projects, lng: g.reduce((n, m) => n + m.lng! * m.projects, 0) / projects, spanKm: span };
  }).filter((b) => b.projects >= 5).sort((a, b) => b.projects - a.projects);
}

export type ClientSpread = { id: string; name: string; type: string; projects: number; engagements: number; markets: string[]; rows: Row[] };
/** Clients who came back: more than one engagement among the visible projects. */
export function repeatClients(rows: Row[], data: MapData): ClientSpread[] {
  const names = new Map(data.clients.map((c) => [c.id, c]));
  const by = new Map<string, { rows: Set<Row>; engagements: number }>();
  for (const r of rows) for (const e of r.engagements) if (e.clientId) {
    const entry = by.get(e.clientId) ?? { rows: new Set<Row>(), engagements: 0 }; entry.rows.add(r); entry.engagements += 1; by.set(e.clientId, entry);
  }
  return [...by.entries()].filter(([, v]) => v.engagements > 1).map(([id, v]) => ({ id, name: names.get(id)?.name ?? "Client", type: names.get(id)?.type ?? "other",
    projects: v.rows.size, engagements: v.engagements, markets: [...new Set([...v.rows].map((r) => r.loc.locality ?? r.loc.city).filter(Boolean) as string[])], rows: [...v.rows] }))
    .sort((a, b) => b.engagements - a.engagements || b.projects - a.projects || a.name.localeCompare(b.name));
}

/** H3 resolution for a zoom level. It stops at 8 (cells about 900 m across): most pins are only locality-precise. */
export const hexResolution = (zoom: number) => zoom < 6.5 ? 4 : zoom < 8.2 ? 5 : zoom < 9.8 ? 6 : zoom < 11.4 ? 7 : 8;
export const HEX_KM: Record<number, string> = { 4: "45 km", 5: "17 km", 6: "6.5 km", 7: "2.4 km", 8: "0.9 km" };
export type Hex = { cell: string; count: number; engagements: number; ring: [number, number][]; lat: number; lng: number };
export function hexbins(rows: Row[], resolution: number): Hex[] {
  const cells = new Map<string, { count: number; engagements: number }>();
  for (const r of rows) {
    if (r.loc.lat === null || r.loc.lng === null) continue;
    const cell = latLngToCell(r.loc.lat, r.loc.lng, resolution), entry = cells.get(cell) ?? { count: 0, engagements: 0 };
    entry.count += 1; entry.engagements += r.engagements.length; cells.set(cell, entry);
  }
  return [...cells.entries()].map(([cell, v]) => { const [lat, lng] = cellToLatLng(cell); const ring = cellToBoundary(cell, true) as [number, number][]; return { cell, ...v, ring: [...ring, ring[0]], lat, lng }; });
}

/** Read "18.5204, 73.8567" or a Google Maps link that carries coordinates. */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const t = text.trim();
  const m = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(t) ?? /[?&](?:q|ll|query|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/.exec(t) ?? /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(t) ?? /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** Which projects most deserve a precise pin: no point at all first, then those with evidence to pin from, then repeat work. */
export const pinPriority = (r: Row) => (r.loc.precision === null ? 1000 : r.loc.precision === "city" ? 500 : r.loc.precision === "locality" ? 200 : 100)
  + (r.loc.mapsLinks ? 60 : 0) + (r.loc.rera ? 30 : 0) + (r.repeat ? 20 : 0) + Math.min(19, r.engagements.length * 3);

export type AreaMetric = "projects" | "repeat" | "deliveries";
export const AREA_METRICS: { key: AreaMetric; label: string; one: string; many: string }[] = [
  { key: "projects", label: "Projects", one: "project", many: "projects" },
  { key: "repeat", label: "Repeat clients", one: "repeat client", many: "repeat clients" },
  { key: "deliveries", label: "Deliveries", one: "delivery", many: "deliveries" },
];
export const AREA_KM = 3;
export type Area = { key: string; name: string; city: string; lat: number; lng: number; polygon: number[][][][]; projects: number; repeat: number; deliveries: number };
export const areaValue = (a: Pick<Area, "projects" | "repeat" | "deliveries">, metric: AreaMetric) => metric === "projects" ? a.projects : metric === "repeat" ? a.repeat : a.deliveries;

/**
 * Micro-market areas for the choropleth. Pulse has a centre point per locality, not a boundary, so each H3 cell
 * (resolution 8, about 0.9 km across) within 3 km of a centre is given to the nearest centre and the cells are
 * merged. The result is a nearest-centre map on a hex grid: a guide to where each market's work sits, not a
 * surveyed boundary. City-only markets have no locality centre and are left out.
 */
export function marketAreas(list: Market[]): Area[] {
  const centres = list.filter((m) => !m.isCity && m.lat !== null && m.lng !== null);
  const best = new Map<string, { i: number; d: number }>();
  centres.forEach((m, i) => {
    for (const cell of gridDisk(latLngToCell(m.lat!, m.lng!, 8), 4)) {
      const [lat, lng] = cellToLatLng(cell), d = km({ lat: m.lat!, lng: m.lng! }, { lat, lng });
      if (d > AREA_KM) continue;
      const seen = best.get(cell); if (!seen || d < seen.d) best.set(cell, { i, d });
    }
  });
  const cells = new Map<number, string[]>();
  for (const [cell, { i }] of best) { const list = cells.get(i); if (list) list.push(cell); else cells.set(i, [cell]); }
  return [...cells.entries()].map(([i, group]) => { const m = centres[i]; return { key: m.key, name: m.name, city: m.city, lat: m.lat!, lng: m.lng!,
    polygon: cellsToMultiPolygon(group, true) as number[][][][], projects: m.projects, repeat: m.repeatClients, deliveries: m.rows.reduce((n, r) => n + r.deliveries, 0) }; });
}

/** Catchment rings around a project: how many other visible projects sit within each distance of its stored point. */
export const RINGS_KM = [2, 5, 10];
export type Nearby = { row: Row; km: number };
export function catchment(origin: { lat: number; lng: number }, rows: Row[], selfId: string) {
  const near: Nearby[] = rows.filter((r) => r.loc.id !== selfId && r.loc.lat !== null && r.loc.lng !== null)
    .map((row) => ({ row, km: km(origin, { lat: row.loc.lat!, lng: row.loc.lng! }) })).filter((n) => n.km <= RINGS_KM[RINGS_KM.length - 1]).sort((a, b) => a.km - b.km);
  const rings = RINGS_KM.map((r) => { const inside = near.filter((n) => n.km <= r); return { km: r, projects: inside.length, markets: new Set(inside.map((n) => marketKey(n.row.loc)).filter(Boolean)).size, repeat: inside.filter((n) => n.row.repeat).length }; });
  return { near, rings };
}

/** A circle of the given radius as a closed [lng, lat] ring. */
export function circle(lat: number, lng: number, radiusKm: number, steps = 120): [number, number][] {
  const out: [number, number][] = [], dLat = radiusKm / 110.574, dLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i += 1) { const a = (i / steps) * Math.PI * 2; out.push([lng + dLng * Math.sin(a), lat + dLat * Math.cos(a)]); }
  return out;
}

/** Length of a measured path in kilometres. */
export const pathKm = (points: [number, number][]) => points.reduce((sum, p, i) => i ? sum + km({ lat: points[i - 1][1], lng: points[i - 1][0] }, { lat: p[1], lng: p[0] }) : 0, 0);
export const distance = (value: number) => value < 1 ? `${Math.round(value * 1000)} m` : `${value < 10 ? value.toFixed(2) : value.toFixed(1)} km`;
