import assert from "node:assert/strict";
import test from "node:test";
import { select, NO_FILTERS, monthAxis, markets, hexbins, parseCoordinates } from "./geo.ts";

const engagement = (overrides = {}) => ({ projectId: "folder1", title: "Moshi project", month: "2025-01", clientId: "client1", clientType: "developer", pod: "Pod 1", segment: "R", stage: "done", deliveries: 3, ...overrides });
const location = (overrides = {}) => ({ id: "location1", key: "project1", name: "Moshi project", clientLabel: "Client 1", city: "Pune", locality: "Moshi", lat: 18.67, lng: 73.85, precision: "locality", pinned: false, engagements: [engagement()], ...overrides });
const dataset = (locations) => ({ locations, clients: [{ id: "client1", name: "Client 1", engagements: 2 }], localities: [{ city: "Pune", name: "Moshi", lat: 18.67, lng: 73.85 }] });

test("filters must match the same engagement; an unlinked development stays in the full view", () => {
  const data = dataset([location({ engagements: [engagement(), engagement({ projectId: "folder2", pod: "Pod 2", clientType: "channel_partner" })] }), location({ id: "unlinked", engagements: [] })]);
  const months = monthAxis(data.locations), all = NO_FILTERS(months.length);
  assert.equal(select(data, all, months).length, 2);
  assert.equal(select(data, { ...all, pods: ["Pod 1"], clientTypes: ["channel_partner"] }, months).length, 0);
  const selected = select(data, { ...all, pods: ["Pod 1"] }, months);
  assert.equal(selected.length, 1); assert.equal(selected[0].engagements.length, 1);
});

test("time axis fills missing months and the date filter retains only engagements started in range", () => {
  const data = dataset([location({ engagements: [engagement(), engagement({ projectId: "folder2", month: "2025-03" })] })]);
  const months = monthAxis(data.locations); assert.deepEqual(months, ["2025-01", "2025-02", "2025-03"]);
  assert.equal(select(data, { ...NO_FILTERS(3), from: 1, to: 1 }, months).length, 0);
  const rows = select(data, { ...NO_FILTERS(3), from: 2, to: 2 }, months);
  assert.equal(rows.length, 1); assert.equal(rows[0].engagements.length, 1);
});

test("H3 concentration counts each development once using stored coordinates, unaffected by display spreading", () => {
  const data = dataset([location(), location({ id: "location2", key: "project2", engagements: [engagement(), engagement({ projectId: "folder2" })] })]);
  const rows = select(data, NO_FILTERS(1), ["2025-01"]);
  assert.notEqual(rows[0].x, rows[0].loc.lng);
  const cells = hexbins(rows, 8); assert.equal(cells.length, 1); assert.equal(cells[0].count, 2);
  const places = markets(rows, data, ["2025-01"]); assert.equal(places[0].projects, 2); assert.equal(places[0].engagements, 3); assert.equal(places[0].repeatClients, 1);
  const precise = select(dataset([location({ precision: "exact" }), location({ id: "b", precision: "building" })]), NO_FILTERS(1), ["2025-01"]);
  assert.ok(precise.every((r) => r.x === r.loc.lng && r.y === r.loc.lat));
});

test("pin input accepts coordinate URLs and refuses malformed or out-of-range coordinates", () => {
  assert.deepEqual(parseCoordinates("18.5204, 73.8567"), { lat: 18.5204, lng: 73.8567 });
  assert.deepEqual(parseCoordinates("https://maps.google.com/?q=18.5204%2C73.8567"), { lat: 18.5204, lng: 73.8567 });
  assert.deepEqual(parseCoordinates("https://maps.google.com/place/x/!3d18.5204!4d73.8567"), { lat: 18.5204, lng: 73.8567 });
  for (const value of ["91, 70", "18, 181", "", "https://maps.app.goo.gl/unknown", "NaN,73", "18,73 trailing"]) assert.equal(parseCoordinates(value), null);
});

test("a city fallback does not fabricate a locality centre or a neighbouring-market belt", () => {
  const data = dataset([location({ locality: "Unresolved market", precision: "city" })]);
  const rows = select(data, NO_FILTERS(1), ["2025-01"]);
  const places = markets(rows, data, ["2025-01"]);
  assert.equal(places[0].projects, 1); assert.equal(places[0].lat, null); assert.equal(places[0].lng, null);
});
