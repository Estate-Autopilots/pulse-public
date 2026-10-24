"use client";

// The MapLibre canvas. Base maps and their terms are listed in docs/design/pulse-map.md; every provider's
// attribution stays on the map. Pulse draws its own sources on top, in colours read from the design tokens.
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl, { type GeoJSONSource, type LayerSpecification, type Map as GlMap, type MapLayerMouseEvent, type MapMouseEvent, type Marker, type StyleSpecification } from "maplibre-gl";
import type * as GeoJSON from "geojson";
import { useEffect, useRef, type MutableRefObject } from "react";
import { areaValue, circle, distance, hexbins, hexResolution, pathKm, placeName, PRECISION_LABEL, RINGS_KM, AREA_METRICS, type Area, type AreaMetric, type Market, type Row } from "./geo";
import css from "./map.module.css";

export type Mode = "points" | "heat" | "hex" | "areas" | "markets" | "money" | "shoots" | "clients" | "prices";
type FC = GeoJSON.FeatureCollection;
/** R55: layers prepared by the workspace (money, shoots, clients, prices) and overlays (a shoot route, travel time, white space). */
export type Extra = { money: FC; shoots: FC; clients: FC; prices: FC; route: FC; travel: FC; gaps: FC };
export type Base = "light" | "dark" | "relief" | "satellite";
export type MapApi = { fly: (lng: number, lat: number, zoom?: number) => void; fit: (rows?: Row[]) => void; home: () => void; ring: (lat: number, lng: number, km: number) => void; zoom: (by: number) => void; north: () => void; centre: () => { lat: number; lng: number } };
export type Pad = { top: number; right: number; bottom: number; left: number };
type Props = {
  orgName: string; rows: Row[]; markets: Market[]; areas: Area[]; areaMetric: AreaMetric; mode: Mode; base: Base; dark: boolean; selected: string | null;
  repeatOverlay: boolean; extrude: boolean; rings: { lat: number; lng: number; counts: number[] } | null; links: Row[] | null;
  fix: { id: string; lat: number; lng: number } | null; measure: [number, number][] | null; pad: Pad; extra: Extra;
  api: MutableRefObject<MapApi | null>;
  onSelect: (id: string) => void; onMarket: (key: string) => void; onFixMove: (lat: number, lng: number) => void; onHexResolution: (resolution: number) => void;
  onMeasure: (at: [number, number]) => void; onReady: () => void; onError: (message: string) => void;
};

const OFM = "https://tiles.openfreemap.org";
const STYLE = { light: `${OFM}/styles/positron`, dark: `${OFM}/styles/dark` };
/** Mapzen/Tilezen terrain tiles on AWS Open Data: free to use with attribution of the elevation sources. */
const DEM = { tiles: ["https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"], attribution: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noreferrer">Terrain Tiles: Mapzen and its sources</a>' };
/** Satellite imagery is only offered when a provider allows commercial use without an account. See pulse-map.md. */
export const SATELLITE = null as { tiles: string[]; attribution: string; maxzoom: number } | null;
const FONT = ["Noto Sans Bold"], FONT_REGULAR = ["Noto Sans Regular"];
const SOURCES = ["areas", "areaLabel", "hex", "hexLabel", "raw", "rings", "ringLabel", "links", "mk", "pts", "measure", "money", "shoots", "clients", "prices", "route", "travel", "gaps"] as const;
const EXTRA = ["money", "shoots", "clients", "prices", "route", "travel", "gaps"] as const;
const empty = (): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: [] });
const MODE_LAYERS: Record<Mode, string[]> = {
  points: ["clusters", "cluster-count", "pt-approx", "pt-precise", "pt-label"],
  heat: ["heat", "heat-points"],
  hex: ["hex-fill", "hex-3d", "hex-line", "hex-label"],
  areas: ["area-fill", "area-line", "area-count", "area-name"],
  markets: ["mk-circle", "mk-count", "mk-label"],
  money: ["money-circle", "money-label"],
  shoots: ["shoot-cluster", "shoot-count", "shoot-pt"],
  clients: ["client-pt", "client-label"],
  prices: ["price-circle", "price-label"],
};
const dark = (base: Base, theme: boolean) => base === "dark" || base === "satellite" || (base === "relief" && theme);
const styleOf = (base: Base, theme: boolean): string | StyleSpecification => base === "satellite" && SATELLITE
  ? { version: 8, glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`, sources: { sat: { type: "raster", tiles: SATELLITE.tiles, tileSize: 256, maxzoom: SATELLITE.maxzoom, attribution: SATELLITE.attribution } }, layers: [{ id: "sat", type: "raster", source: "sat" }] }
  : STYLE[dark(base, theme) ? "dark" : "light"];
const styleKey = (base: Base, theme: boolean) => base === "satellite" && SATELLITE ? "satellite" : dark(base, theme) ? "dark" : "light";

// ---- Colours: defined once in map.module.css from the theme tokens, read here so the map and legend agree. ----
let probe: CanvasRenderingContext2D | null = null;
function rgb(value: string): string {
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return value;
  probe.clearRect(0, 0, 1, 1); probe.fillStyle = "#000"; probe.fillStyle = value; probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}
const NAMES = ["accent", "ink", "halo", "exact", "building", "street", "locality", "city", "repeat", "r0", "r1", "r2", "r3", "r4", "h1", "h2", "h3", "h4", "h5", "ring", "shade", "light"] as const;
type Colors = Record<(typeof NAMES)[number], string>;
function colors(box: HTMLElement): Colors {
  const out = {} as Colors, el = document.createElement("span"); el.style.display = "none"; box.append(el);
  for (const name of NAMES) { el.style.color = `var(--map-${name})`; out[name] = rgb(getComputedStyle(el).color); }
  el.remove(); return out;
}

/** Five classes for the choropleth, from the distinct non-zero values: the legend reads the same breaks. */
export function breaks(values: number[]): number[] {
  const v = [...new Set(values.filter((x) => x > 0))].sort((a, b) => a - b);
  if (v.length <= 5) return v;
  const out: number[] = []; for (let i = 0; i < 5; i += 1) { const x = v[Math.floor((i * v.length) / 5)]; if (!out.includes(x)) out.push(x); }
  return out;
}

function layers(c: Colors, steps: number[]): LayerSpecification[] {
  const byPrecision = ["match", ["get", "precision"], "exact", c.exact, "building", c.building, "street", c.street, "locality", c.locality, c.city] as unknown as string;
  const ramp = ["interpolate", ["linear"], ["get", "t"], 0, c.r0, 0.3, c.r1, 0.6, c.r2, 0.85, c.r3, 1, c.r4] as unknown as string;
  const bins = [c.r0, c.r1, c.r2, c.r3, c.r4].slice(5 - Math.max(1, steps.length));
  const choropleth = (steps.length ? ["step", ["get", "v"], "rgba(0,0,0,0)", ...steps.flatMap((s, i) => [s, bins[i]])] : "rgba(0,0,0,0)") as unknown as string;
  const label = { "text-color": c.ink, "text-halo-color": c.halo, "text-halo-width": 1.6 };
  return [
    { id: "area-fill", type: "fill", source: "areas", paint: { "fill-color": choropleth, "fill-opacity": 0.78 } },
    { id: "area-line", type: "line", source: "areas", paint: { "line-color": ["case", [">", ["get", "v"], 0], c.halo, c.city] as unknown as string, "line-width": ["case", [">", ["get", "v"], 0], 1.2, 1] as unknown as number, "line-dasharray": [2, 1.5], "line-opacity": 0.85 } },
    { id: "hex-fill", type: "fill", source: "hex", paint: { "fill-color": ramp, "fill-opacity": 0.78 } },
    { id: "hex-3d", type: "fill-extrusion", source: "hex", paint: { "fill-extrusion-color": ramp, "fill-extrusion-height": ["get", "height"], "fill-extrusion-opacity": 0.92, "fill-extrusion-vertical-gradient": true } },
    { id: "hex-line", type: "line", source: "hex", paint: { "line-color": c.halo, "line-width": 1.2, "line-opacity": 0.8 } },
    { id: "heat", type: "heatmap", source: "raw", paint: {
      "heatmap-weight": 1,
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 12, 1.5],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 5, 10, 9, 22, 13, 46],
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.88, 15, 0.5],
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.15, c.h1, 0.4, c.h2, 0.65, c.h3, 0.85, c.h4, 1, c.h5] } },
    { id: "heat-points", type: "circle", source: "raw", minzoom: 11.5, paint: { "circle-radius": 3.5, "circle-color": c.ink, "circle-opacity": 0.6, "circle-stroke-width": 1, "circle-stroke-color": c.halo } },
    { id: "rings-fill", type: "fill", source: "rings", paint: { "fill-color": c.ring, "fill-opacity": 0.06 } },
    { id: "rings-line", type: "line", source: "rings", paint: { "line-color": c.ring, "line-width": 2, "line-opacity": 0.9, "line-dasharray": [3, 2] } },
    { id: "links", type: "line", source: "links", layout: { "line-cap": "round" }, paint: { "line-color": c.repeat, "line-width": 2, "line-opacity": 0.8, "line-dasharray": [1.5, 1.5] } },
    { id: "mk-circle", type: "circle", source: "mk", paint: {
      "circle-radius": ["interpolate", ["exponential", 1.6], ["zoom"], 6, ["*", 0.45, ["get", "r"]], 10, ["get", "r"], 13, ["*", 2.1, ["get", "r"]]],
      "circle-color": ramp, "circle-opacity": 0.55, "circle-stroke-color": ramp, "circle-stroke-width": 1.5 } },
    { id: "clusters", type: "circle", source: "pts", filter: ["has", "point_count"], paint: {
      "circle-color": c.accent, "circle-opacity": 0.92, "circle-radius": ["step", ["get", "point_count"], 15, 10, 19, 30, 24, 80, 30, 200, 36],
      "circle-stroke-width": 6, "circle-stroke-color": c.accent, "circle-stroke-opacity": 0.22 } },
    // Approximate pins are hollow rings; confirmed pins are solid. The ring also marks a repeat client when that overlay is on.
    { id: "pt-approx", type: "circle", source: "pts", filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "approx"], 1]], paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4.5, 14, 7], "circle-color": byPrecision, "circle-opacity": 0.18,
      "circle-stroke-width": ["case", ["==", ["get", "ring"], 1], 3, 2], "circle-stroke-color": ["case", ["==", ["get", "ring"], 1], c.repeat, byPrecision] } },
    { id: "pt-precise", type: "circle", source: "pts", filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "approx"], 0]], paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5.5, 14, 8.5], "circle-color": byPrecision,
      "circle-stroke-width": ["case", ["==", ["get", "ring"], 1], 3, 2], "circle-stroke-color": ["case", ["==", ["get", "ring"], 1], c.repeat, c.halo] } },
    // Labels: never below 12 px on the map either.
    { id: "hex-label", type: "symbol", source: "hexLabel", layout: { "text-field": ["to-string", ["get", "count"]], "text-font": FONT, "text-size": 13, "text-allow-overlap": true }, paint: label },
    { id: "area-count", type: "symbol", source: "areaLabel", minzoom: 10, filter: [">", ["get", "v"], 0], layout: { "text-field": ["to-string", ["get", "v"]], "text-font": FONT, "text-size": 13, "symbol-sort-key": ["-", 0, ["get", "v"]] }, paint: label },
    { id: "area-name", type: "symbol", source: "areaLabel", minzoom: 11, layout: { "text-field": ["get", "name"], "text-font": FONT_REGULAR, "text-size": 12, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true, "text-max-width": 8 }, paint: label },
    { id: "mk-count", type: "symbol", source: "mk", layout: { "text-field": ["to-string", ["get", "projects"]], "text-font": FONT, "text-size": ["interpolate", ["linear"], ["get", "projects"], 1, 12, 30, 16], "symbol-sort-key": ["-", 0, ["get", "projects"]] }, paint: label },
    { id: "mk-label", type: "symbol", source: "mk", minzoom: 9.5, layout: { "text-field": ["get", "name"], "text-font": FONT_REGULAR, "text-size": 12, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true, "symbol-sort-key": ["-", 0, ["get", "projects"]] }, paint: label },
    { id: "cluster-count", type: "symbol", source: "pts", filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": FONT, "text-size": 13, "text-allow-overlap": true }, paint: { "text-color": c.halo } },
    { id: "pt-label", type: "symbol", source: "pts", minzoom: 12.2, filter: ["!", ["has", "point_count"]], layout: { "text-field": ["get", "name"], "text-font": FONT_REGULAR, "text-size": 12, "text-offset": [0, 0.95], "text-anchor": "top", "text-optional": true, "text-max-width": 9 }, paint: label },
    { id: "ring-label", type: "symbol", source: "ringLabel", layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 12.5, "text-allow-overlap": true, "text-anchor": "bottom", "text-offset": [0, -0.2] }, paint: { "text-color": c.ring, "text-halo-color": c.halo, "text-halo-width": 2 } },
    // R55 layers. Money: circle area follows the amount invoiced; colour is the collection state (overdue, open, paid, or
    // an active client with nothing invoiced yet). Clients: colour is the kind of client. Prices: the ramp follows the price.
    { id: "money-circle", type: "circle", source: "money", paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, ["*", 0.5, ["get", "r"]], 11, ["get", "r"], 14, ["*", 1.6, ["get", "r"]]],
      "circle-color": ["match", ["get", "state"], "overdue", c.repeat, "open", c.locality, "paid", c.exact, c.accent] as unknown as string,
      "circle-opacity": ["case", ["==", ["get", "state"], "pipeline"], 0.12, 0.55] as unknown as number, "circle-stroke-width": 2,
      "circle-stroke-color": ["match", ["get", "state"], "overdue", c.repeat, "open", c.locality, "paid", c.exact, c.accent] as unknown as string } },
    { id: "shoot-cluster", type: "circle", source: "shoots", filter: ["has", "point_count"], paint: {
      "circle-color": c.street, "circle-opacity": 0.85, "circle-radius": ["step", ["get", "point_count"], 13, 10, 17, 30, 22], "circle-stroke-width": 5, "circle-stroke-color": c.street, "circle-stroke-opacity": 0.2 } },
    { id: "shoot-pt", type: "circle", source: "shoots", filter: ["!", ["has", "point_count"]], paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4.5, 14, 7], "circle-color": c.street, "circle-stroke-width": 2, "circle-stroke-color": c.halo } },
    { id: "client-pt", type: "circle", source: "clients", paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, ["*", 0.6, ["get", "r"]], 12, ["get", "r"]],
      "circle-color": ["match", ["get", "type"], "developer", c.street, "channel_partner", c.locality, c.city] as unknown as string, "circle-opacity": 0.7,
      "circle-stroke-width": 1.5, "circle-stroke-color": c.halo } },
    { id: "price-circle", type: "circle", source: "prices", paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 9, 11, 18], "circle-color": ramp, "circle-opacity": 0.75, "circle-stroke-width": 1.5, "circle-stroke-color": c.halo } },
    { id: "travel-fill", type: "fill", source: "travel", paint: { "fill-color": c.ring, "fill-opacity": ["get", "o"] as unknown as number } },
    { id: "travel-line", type: "line", source: "travel", paint: { "line-color": c.ring, "line-width": 1.5, "line-opacity": 0.8, "line-dasharray": [2, 2] } },
    { id: "gap-pt", type: "circle", source: "gaps", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 9, 12, 16], "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-width": 2.5, "circle-stroke-color": c.repeat, "circle-stroke-opacity": 0.9 } },
    { id: "route-line", type: "line", source: "route", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": c.ink, "line-width": 3, "line-opacity": 0.85 } },
    { id: "route-stop", type: "circle", source: "route", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 11, "circle-color": c.accent, "circle-stroke-width": 2, "circle-stroke-color": c.halo } },
    { id: "money-label", type: "symbol", source: "money", minzoom: 10, filter: ["!=", ["get", "state"], "pipeline"], layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 12, "text-offset": [0, 1.4], "text-anchor": "top", "text-optional": true, "symbol-sort-key": ["-", 0, ["get", "v"]] }, paint: label },
    { id: "shoot-count", type: "symbol", source: "shoots", filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": FONT, "text-size": 12, "text-allow-overlap": true }, paint: { "text-color": c.halo } },
    { id: "client-label", type: "symbol", source: "clients", minzoom: 11.5, layout: { "text-field": ["get", "name"], "text-font": FONT_REGULAR, "text-size": 12, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true, "text-max-width": 9 }, paint: label },
    { id: "price-label", type: "symbol", source: "prices", layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 12, "text-offset": [0, 1.6], "text-anchor": "top", "text-optional": true, "symbol-sort-key": ["-", 0, ["get", "n"]] }, paint: label },
    { id: "travel-label", type: "symbol", source: "travel", layout: { "symbol-placement": "line", "text-field": ["get", "label"], "text-font": FONT, "text-size": 12 }, paint: { "text-color": c.ring, "text-halo-color": c.halo, "text-halo-width": 2 } },
    { id: "gap-label", type: "symbol", source: "gaps", minzoom: 9, layout: { "text-field": ["get", "name"], "text-font": FONT, "text-size": 12, "text-offset": [0, 1.5], "text-anchor": "top", "text-optional": true }, paint: { "text-color": c.repeat, "text-halo-color": c.halo, "text-halo-width": 1.8 } },
    { id: "route-no", type: "symbol", source: "route", filter: ["==", ["geometry-type"], "Point"], layout: { "text-field": ["get", "no"], "text-font": FONT, "text-size": 12, "text-allow-overlap": true }, paint: { "text-color": c.halo } },
    { id: "measure-line", type: "line", source: "measure", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": c.ink, "line-width": 2.5, "line-dasharray": [2, 1.4] } },
    { id: "measure-pt", type: "circle", source: "measure", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 5.5, "circle-color": c.halo, "circle-stroke-color": c.ink, "circle-stroke-width": 2.5 } },
    { id: "measure-label", type: "symbol", source: "measure", filter: ["all", ["==", ["geometry-type"], "Point"], ["has", "label"]], layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 13, "text-offset": [0, -1.2], "text-anchor": "bottom", "text-allow-overlap": true }, paint: label },
  ];
}
const OWN = layers({} as Colors, []).map((l) => l.id);

export default function MapCanvas(props: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<GlMap | null>(null);
  const live = useRef(props);
  useEffect(() => { live.current = props; });
  const state = useRef({ ready: false, loaded: false, resolution: 0, style: "", theme: props.dark, steps: "", marker: null as Marker | null, sel: null as Marker | null, selId: null as string | null, fixId: null as string | null, framed: false, rise: 0 });

  // One function draws everything from the current props. It runs after each style load and whenever the props change.
  const draw = useRef(() => {});
  const install = useRef(() => {});
  useEffect(() => { draw.current = () => {
    const m = map.current, p = live.current, s = state.current;
    if (!m || !s.ready || !m.getSource("pts")) return;
    const located = p.rows.filter((r) => r.x !== null && r.y !== null);
    const set = (id: string, data: GeoJSON.FeatureCollection) => (m.getSource(id) as GeoJSONSource | undefined)?.setData(data);
    const point = (r: Row, at: [number, number]): GeoJSON.Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: at }, properties: {
      id: r.loc.id, name: r.name, place: placeName(r.loc), precision: r.loc.precision, approx: r.loc.precision === "exact" || r.loc.precision === "building" ? 0 : 1,
      ring: p.repeatOverlay && r.repeat ? 1 : 0, n: Math.max(1, r.engagements.length), pinned: r.loc.pinned ? 1 : 0 } });
    set("pts", { type: "FeatureCollection", features: located.map((r) => point(r, [r.x!, r.y!])) });
    set("raw", { type: "FeatureCollection", features: located.map((r) => point(r, [r.loc.lng!, r.loc.lat!])) });

    const resolution = hexResolution(m.getZoom());
    if (resolution !== s.resolution) { s.resolution = resolution; p.onHexResolution(resolution); }
    const cells = p.mode === "hex" ? hexbins(p.rows, resolution) : [];
    const most = Math.max(1, ...cells.map((h) => h.count));
    const span = 40075000 / 2 ** m.getZoom() / 40;      // extrusion height follows the zoom so towers keep their look
    set("hex", { type: "FeatureCollection", features: cells.map((h) => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [h.ring] }, properties: { count: h.count, t: Math.sqrt(h.count / most), height: Math.sqrt(h.count / most) * span * 12, lat: h.lat, lng: h.lng } })) });
    set("hexLabel", { type: "FeatureCollection", features: p.extrude ? [] : cells.map((h) => ({ type: "Feature", geometry: { type: "Point", coordinates: [h.lng, h.lat] }, properties: { count: h.count, t: Math.sqrt(h.count / most) } })) });

    // The choropleth's classes depend on the values in view; the fill expression is rebuilt when they change.
    const values = p.mode === "areas" ? p.areas.map((a) => areaValue(a, p.areaMetric)) : [];
    const steps = breaks(values), key = steps.join(",");
    if (key !== s.steps && m.getLayer("area-fill")) { s.steps = key; const fill = layers(colors(box.current!), steps).find((l) => l.id === "area-fill") as { paint: { "fill-color": unknown } }; m.setPaintProperty("area-fill", "fill-color", fill.paint["fill-color"]); }
    set("areas", { type: "FeatureCollection", features: p.mode === "areas" ? p.areas.map((a) => ({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: a.polygon }, properties: { key: a.key, name: a.name, v: areaValue(a, p.areaMetric) } })) : [] });
    set("areaLabel", { type: "FeatureCollection", features: p.mode === "areas" ? p.areas.map((a) => ({ type: "Feature", geometry: { type: "Point", coordinates: [a.lng, a.lat] }, properties: { key: a.key, name: a.name, v: areaValue(a, p.areaMetric) } })) : [] });

    const placed = p.markets.filter((k) => k.lat !== null && k.lng !== null), top = Math.max(1, ...placed.map((k) => k.projects));
    set("mk", { type: "FeatureCollection", features: placed.map((k) => ({ type: "Feature", geometry: { type: "Point", coordinates: [k.lng!, k.lat!] }, properties: { key: k.key, name: k.name, projects: k.projects, r: 9 + 5 * Math.sqrt(k.projects), t: Math.sqrt(k.projects / top) } })) });

    const chain = (p.links ?? []).filter((r) => r.x !== null).sort((a, b) => (a.first ?? "").localeCompare(b.first ?? ""));
    set("links", chain.length > 1 ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: chain.map((r) => [r.x!, r.y!]) }, properties: {} }] } : empty());

    const rings = p.rings && !p.fix ? p.rings : null;
    set("rings", { type: "FeatureCollection", features: rings ? [...RINGS_KM].reverse().map((r) => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [circle(rings.lat, rings.lng, r)] }, properties: { km: r } })) : [] });
    set("ringLabel", { type: "FeatureCollection", features: rings ? RINGS_KM.map((r, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [rings.lng, rings.lat + r / 110.574] }, properties: { label: `${r} km · ${rings.counts[i]} ${rings.counts[i] === 1 ? "project" : "projects"}` } })) : [] });

    const path = p.measure ?? [];
    let run = 0;
    set("measure", { type: "FeatureCollection", features: [
      ...(path.length > 1 ? [{ type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: path }, properties: {} }] : []),
      ...path.map((at, i) => { run = i ? run + pathKm([path[i - 1], at]) : 0; return { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: at }, properties: i ? { label: distance(run) } : {} }; }),
    ] });

    for (const id of EXTRA) set(id, p.extra[id]);

    for (const [mode, ids] of Object.entries(MODE_LAYERS)) for (const id of ids) {
      const on = mode === p.mode && (id !== "hex-3d" || p.extrude) && (id !== "hex-fill" || !p.extrude);
      if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    }

    // The chosen project pulses where it is drawn.
    const chosen = located.find((r) => r.loc.id === p.selected);
    if (!chosen || p.fix) { s.sel?.remove(); s.sel = null; s.selId = null; }
    else {
      const at: [number, number] = p.mode === "points" ? [chosen.x!, chosen.y!] : [chosen.loc.lng!, chosen.loc.lat!];
      if (!s.sel) { const el = document.createElement("div"); el.className = css.selMarker; el.setAttribute("aria-hidden", "true"); s.sel = new maplibregl.Marker({ element: el }).setLngLat(at).addTo(m); }
      else s.sel.setLngLat(at);
      if (s.selId !== chosen.loc.id) { s.selId = chosen.loc.id; const el = s.sel.getElement(); el.removeAttribute("data-on"); void el.offsetWidth; el.setAttribute("data-on", ""); }
    }
  }; });

  useEffect(() => {
    if (!box.current) return;
    const s = state.current;
    s.style = styleKey(live.current.base, live.current.dark); s.theme = live.current.dark;
    const m = new maplibregl.Map({ container: box.current, style: styleOf(live.current.base, live.current.dark), center: [73.82, 18.56], zoom: 9.6, minZoom: 3, maxZoom: 18,
      attributionControl: false, dragRotate: true, pitchWithRotate: true, fadeDuration: 150, doubleClickZoom: true });
    map.current = m;
    m.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: "metric" }), "bottom-left");
    m.on("error", () => { if (!s.loaded) live.current.onError("The base map could not load. Check your connection and try again."); });

    install.current = () => {
      const p = live.current;
      for (const id of OWN) if (m.getLayer(id)) m.removeLayer(id);
      if (p.base === "relief" && !m.getSource("dem")) m.addSource("dem", { type: "raster-dem", tiles: DEM.tiles, encoding: "terrarium", tileSize: 256, maxzoom: 15, attribution: DEM.attribution });
      const c = colors(box.current!);
      if (p.base === "relief" && !m.getLayer("relief")) {
        const below = m.getStyle().layers.find((l) => l.type === "symbol" || l.type === "line" && /road|highway|transportation/.test(l.id))?.id;
        m.addLayer({ id: "relief", type: "hillshade", source: "dem", paint: { "hillshade-exaggeration": 0.55, "hillshade-shadow-color": c.shade, "hillshade-highlight-color": c.light, "hillshade-accent-color": c.shade, "hillshade-illumination-direction": 315 } }, below);
      }
      for (const id of SOURCES) if (!m.getSource(id)) m.addSource(id, id === "pts" || id === "shoots"
        ? { type: "geojson", data: empty(), cluster: true, clusterRadius: id === "pts" ? 46 : 36, clusterMaxZoom: 12 } : { type: "geojson", data: empty() });
      s.steps = "";
      for (const layer of layers(c, [])) m.addLayer(layer);
      m.setLight({ anchor: "viewport", color: "white", intensity: 0.3, position: [1.4, 210, 35] });
      s.ready = true; s.loaded = true; draw.current();
      if (!s.framed) { s.framed = true; api.fit(home(p.rows)); p.onReady(); }
    };
    // The panel's room is the camera's own padding (kept in step below); fits add a margin on top of it.
    m.setPadding(live.current.pad);
    const margin = { top: 24, bottom: 24, left: 32, right: 32 };
    // The opening frame is the busiest city, where most of the work is; "Fit all" shows everything.
    const home = (rows: Row[]) => { const counts = new Map<string, number>(); for (const r of rows) if (r.loc.city && r.x !== null) counts.set(r.loc.city, (counts.get(r.loc.city) ?? 0) + 1);
      const city = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; return rows.filter((r) => r.loc.city === city); };
    const api: MapApi = {
      fly: (lng, lat, zoom) => m.flyTo({ center: [lng, lat], zoom: zoom ?? Math.max(m.getZoom(), 13.5), padding: live.current.pad, speed: 1.2, curve: 1.42, essential: true }),
      fit: (rows) => {
        const pts = (rows ?? live.current.rows).filter((r) => r.x !== null);
        if (!pts.length) return;
        const b = new maplibregl.LngLatBounds(); for (const r of pts) b.extend([r.x!, r.y!]);
        m.fitBounds(b, { padding: margin, maxZoom: 14, duration: 1100, essential: true });
      },
      home: () => api.fit(home(live.current.rows)),
      ring: (lat, lng, km) => { const b = new maplibregl.LngLatBounds(); for (const p of circle(lat, lng, km * 1.08, 24)) b.extend(p); m.fitBounds(b, { padding: margin, duration: 1000, essential: true }); },
      zoom: (by) => m.easeTo({ zoom: m.getZoom() + by, duration: 260 }),
      north: () => m.easeTo({ bearing: 0, pitch: live.current.extrude && live.current.mode === "hex" ? 55 : 0, duration: 500 }),
      centre: () => { const c = m.getCenter(); return { lat: c.lat, lng: c.lng }; },
    };
    live.current.api.current = api;
    m.on("style.load", () => install.current());
    m.on("zoomend", () => { if (live.current.mode === "hex") draw.current(); });

    const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, className: css.tip, maxWidth: "300px" });
    const hover = (e: MapLayerMouseEvent) => {
      if (live.current.measure) return;
      const f = e.features?.[0]; if (!f) return; m.getCanvas().style.cursor = "pointer";
      const el = document.createElement("div"), title = document.createElement("b"), sub = document.createElement("span"), badge = document.createElement("i");
      const g = f.properties ?? {};
      if (f.layer.id.startsWith("hex")) { title.textContent = `${g.count} ${g.count === 1 ? "project" : "projects"}`; sub.textContent = "in this cell. Click to zoom in."; }
      else if (f.layer.id.startsWith("area")) { const metric = AREA_METRICS.find((x) => x.key === live.current.areaMetric)!; title.textContent = g.name; sub.textContent = g.v ? `${g.v} ${g.v === 1 ? metric.one : metric.many}. Click to open.` : `No ${metric.many} recorded here.`; }
      else if (f.layer.id.startsWith("mk")) { title.textContent = g.name; sub.textContent = `${g.projects} ${g.projects === 1 ? "project" : "projects"}. Click to open.`; }
      else if (g.tip) { title.textContent = g.tipTitle ?? g.name ?? ""; sub.textContent = g.tip; }
      else { title.textContent = g.name; sub.textContent = g.place; badge.textContent = g.pinned ? "Pinned in Pulse" : PRECISION_LABEL[g.precision] ?? ""; badge.dataset.precision = g.precision; }
      el.append(title, sub); if (badge.textContent) el.append(badge);
      tip.setDOMContent(el).setLngLat(f.geometry.type === "Point" ? (f.geometry.coordinates as [number, number]) : e.lngLat).addTo(m);
    };
    const leave = () => { m.getCanvas().style.cursor = live.current.measure ? "crosshair" : ""; tip.remove(); };
    for (const id of ["pt-approx", "pt-precise", "heat-points", "hex-fill", "hex-3d", "mk-circle", "area-fill", "money-circle", "shoot-pt", "client-pt", "price-circle", "gap-pt", "route-stop"]) { m.on("mousemove", id, hover); m.on("mouseleave", id, leave); }
    const measuring = () => !!live.current.measure;
    for (const id of ["pt-approx", "pt-precise", "heat-points", "money-circle", "client-pt", "shoot-pt", "route-stop"]) m.on("click", id, (e) => { if (measuring()) return; const id = e.features?.[0]?.properties?.id; if (id) live.current.onSelect(id); });
    for (const id of ["price-circle", "gap-pt"]) m.on("click", id, (e) => { if (measuring()) return; const key = e.features?.[0]?.properties?.key; if (key) live.current.onMarket(key); });
    m.on("mouseenter", "shoot-cluster", () => { if (!measuring()) m.getCanvas().style.cursor = "pointer"; }); m.on("mouseleave", "shoot-cluster", leave);
    m.on("click", "shoot-cluster", async (e) => {
      if (measuring()) return;
      const f = e.features?.[0]; if (!f || f.geometry.type !== "Point") return;
      const zoom = await (m.getSource("shoots") as GeoJSONSource).getClusterExpansionZoom(f.properties?.cluster_id);
      m.easeTo({ center: f.geometry.coordinates as [number, number], zoom: zoom + 0.4, duration: 600 });
    });
    m.on("mouseenter", "clusters", () => { if (!measuring()) m.getCanvas().style.cursor = "pointer"; }); m.on("mouseleave", "clusters", leave);
    m.on("click", "clusters", async (e) => {
      if (measuring()) return;
      const f = e.features?.[0]; if (!f || f.geometry.type !== "Point") return;
      const zoom = await (m.getSource("pts") as GeoJSONSource).getClusterExpansionZoom(f.properties?.cluster_id);
      m.easeTo({ center: f.geometry.coordinates as [number, number], zoom: zoom + 0.4, duration: 600 });
    });
    for (const id of ["hex-fill", "hex-3d"]) m.on("click", id, (e) => { if (measuring()) return; const g = e.features?.[0]?.properties; if (g) m.easeTo({ center: [g.lng, g.lat], zoom: Math.min(13, m.getZoom() + 1.6), duration: 700 }); });
    for (const id of ["mk-circle", "area-fill"]) m.on("click", id, (e) => { if (measuring()) return; const key = e.features?.[0]?.properties?.key; if (key) live.current.onMarket(key); });
    m.on("click", (e: MapMouseEvent) => { if (measuring()) live.current.onMeasure([e.lngLat.lng, e.lngLat.lat]); });

    const watch = new ResizeObserver(() => m.resize()); watch.observe(box.current);
    return () => { watch.disconnect(); tip.remove(); s.ready = false; s.sel?.remove(); s.sel = null; live.current.api.current = null; m.remove(); map.current = null; };
  }, []);

  useEffect(() => { draw.current(); }, [props.rows, props.markets, props.areas, props.areaMetric, props.mode, props.selected, props.repeatOverlay, props.extrude, props.rings, props.links, props.fix, props.measure, props.extra]);

  // A base map is a style of its own; Pulse's layers are put back when it has loaded. A theme change without a new
  // base still re-reads the colours (the accent follows the theme).
  useEffect(() => {
    const m = map.current, s = state.current; if (!m) return;
    const next = styleKey(props.base, props.dark);
    const frame = requestAnimationFrame(() => {
      if (next !== s.style) { s.style = next; s.ready = false; m.setStyle(styleOf(props.base, props.dark), { diff: false }); }
      else if (s.ready) {
        if (props.base !== "relief" && m.getLayer("relief")) m.removeLayer("relief");
        install.current();
      }
      s.theme = props.dark;
    });
    return () => cancelAnimationFrame(frame);
  }, [props.base, props.dark]);

  useEffect(() => { map.current?.getCanvasContainer().setAttribute("data-measure", props.measure ? "on" : "off"); if (map.current) map.current.getCanvas().style.cursor = props.measure ? "crosshair" : ""; }, [props.measure]);

  // 3D: the camera tilts while the towers rise from the ground.
  useEffect(() => {
    const m = map.current, s = state.current; if (!m) return;
    const on = props.extrude && props.mode === "hex";
    m.easeTo({ pitch: on ? 55 : 0, bearing: on ? -18 : 0, duration: on ? 1600 : 900, easing: (t) => 1 - (1 - t) ** 3 });
    if (!on || !m.getLayer("hex-3d")) return;
    cancelAnimationFrame(s.rise); const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / 1300), eased = 1 - (1 - k) ** 3;
      if (m.getLayer("hex-3d")) m.setPaintProperty("hex-3d", "fill-extrusion-height", ["*", ["get", "height"], eased]);
      if (k < 1) s.rise = requestAnimationFrame(step);
    };
    s.rise = requestAnimationFrame(step);
    return () => cancelAnimationFrame(s.rise);
  }, [props.extrude, props.mode]);

  // The map's centre follows the room left by the panel and sheet.
  const { top, right, bottom, left } = props.pad;
  useEffect(() => {
    const m = map.current; if (!m || !state.current.framed) return;
    m.easeTo({ padding: { top, right, bottom, left }, duration: 420, easing: (t) => 1 - (1 - t) ** 3 });
  }, [top, right, bottom, left]);

  // Fix pin: a marker to drag to the site. It follows coordinates typed or pasted in the bar as well.
  const fix = props.fix;
  useEffect(() => {
    const m = map.current, s = state.current; if (!m) return;
    if (!fix) { s.marker?.remove(); s.marker = null; s.fixId = null; return; }
    if (!s.marker) {
      const el = document.createElement("div"); el.className = css.fixPin; el.setAttribute("aria-label", "Drag to the site");
      s.marker = new maplibregl.Marker({ element: el, draggable: true, anchor: "bottom" }).setLngLat([fix.lng, fix.lat]).addTo(m);
      s.marker.on("dragend", () => { const at = s.marker!.getLngLat(); live.current.onFixMove(at.lat, at.lng); });
    }
    const at = s.marker.getLngLat();
    if (Math.abs(at.lat - fix.lat) > 1e-7 || Math.abs(at.lng - fix.lng) > 1e-7) s.marker.setLngLat([fix.lng, fix.lat]);
    if (s.fixId !== fix.id || !m.getBounds().contains([fix.lng, fix.lat])) m.flyTo({ center: [fix.lng, fix.lat], zoom: Math.max(m.getZoom(), s.fixId !== fix.id ? 14.5 : m.getZoom()), speed: 1.4, essential: true });
    s.fixId = fix.id;
  }, [fix]);

  return <div ref={box} className={css.canvas} role="application" aria-label={`Map of ${props.orgName} projects`} />;
}
