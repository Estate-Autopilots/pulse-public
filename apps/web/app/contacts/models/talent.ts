// R55: the talent board and a model's profile, as the API sends them (services/api/src/talent.ts).
export type Confidence = "high" | "medium" | "low" | "too_new";
export type ModelRow = {
  id: string; name: string; aliases: string[]; rank: number | null; score: number | null; confidence: Confidence; why: string;
  shootDays: number; shootLines: number; scripts: number; first: string | null; last: string | null; languages: string[];
  projects: number; clients: number; clientsFollowed: number; clientsBack: number; returnRate: number | null; returnShrunk: number | null; lift: number | null;
  videos: number; delivered: number; portfolio: number; videosPerDay: number | null;
  cost?: { total: number; paidLines: number; perDay: number | null; perScript: number | null; travelShare: number | null; perClientBack: number | null };
  ads: { spend: number; leads: number; cpl: number | null; ctr: number | null } | null;
};
export type WhatWorks = { dimension: string; label: string; value: string; shootDays: number; clientsFollowed: number; returnRate: number | null; note: string }[];
export type TalentBoard = {
  models: ModelRow[]; baseline: { clientsFollowed: number; clientsBack: number; returnRate: number | null }; whatWorks: WhatWorks; costVisible: boolean;
  method: string[]; run: { finishedAt: string; ok: boolean; counts: Record<string, number>; sources: { file: string; status: string; rows?: number }[] } | null;
  review: number; unresolved: number; coverage: { shoots: number; linked: number; placed: number }; adsConnected: boolean; canReview: boolean;
};
export type TalentShoot = { key: string; shootOn: string | null; month: string; clientLabel: string | null; projectId: string | null; projectName: string | null;
  projectBasis: string | null; projectConfidence: number | null; clientId: string | null; clientName: string | null; place: string | null; locality: string | null;
  placeBasis: string | null; deliverable: string | null; segment: string | null; language: string | null; scripts: number | null; crew: string[]; status: string | null;
  sources: string[]; source: { file?: string; sheet?: string; row?: number } };
export type TalentMedia = { fileId: string; name: string; mime: string | null; kind: string; basis: string; link: string | null; createdOn: string | null; projectId: string | null; projectName: string | null; delivered: boolean };
export type TalentFee = { key: string; shootOn: string | null; month: string; charges: number | null; travel: number | null; extra: number | null; total: number | null; paid: string | null; shootKeys: string[] };
export type TalentProfile = {
  id: string; name: string; source: string | null; row: ModelRow | null; aliases: { alias: string; key: string; basis: string; status: string; confidence: number; seen: number }[];
  shoots: TalentShoot[]; media: TalentMedia[]; projects: { id: string; title: string; location: string | null; month: string | null; clientId: string | null; clientName: string | null; shoots: number; lastShoot: string | null; videos: number }[];
  fees?: TalentFee[]; costVisible: boolean; baseline: TalentBoard["baseline"]; method: string[]; adsConnected: boolean;
  review: { id: string; title: string; proposed: Record<string, unknown>; confidence: number }[];
};

export const CONFIDENCE: Record<Confidence, { label: string; tone: "success" | "accent" | "warning" | "neutral"; hint: string }> = {
  high: { label: "High confidence", tone: "success", hint: "10+ shoot days and 6+ clients followed for 90 days" },
  medium: { label: "Medium confidence", tone: "accent", hint: "4+ shoot days and 3+ clients followed" },
  low: { label: "Low confidence", tone: "warning", hint: "A small sample: read the numbers, not the rank" },
  too_new: { label: "Too new", tone: "neutral", hint: "One shoot day or none: not ranked yet" },
};
export const BASIS: Record<string, string> = {
  client_name: "the client written in the shoot sheet", dated_video: "a model video in the project folder dated that day",
  shoot_day_upload: "raw footage uploaded to the project that day", place_month: "the place and the month", review: "chosen in Review data", none: "not linked",
};
export const MEDIA_BASIS: Record<string, string> = {
  portfolio_folder: "Portfolio folder", file_name: "Named for the model", shoot_date: "Shot that day", shoot_project: "From a project only they shot",
};
export const pct = (x: number | null | undefined) => x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`;
// UI-POLISH-3: lakh and crore as Finance writes them ("₹12.5 L", "₹1.2 Cr"), one format across Pulse.
export const inr = (n: number | null | undefined) => n === null || n === undefined ? "–" : n >= 1e7 ? `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, "")} Cr` : n >= 100000 ? `₹${(n / 100000).toFixed(n >= 1000000 ? 1 : 2).replace(/\.?0+$/, "")} L` : `₹${Math.round(n).toLocaleString("en-IN")}`;
export const monthName = (m: string | null) => { if (!m) return "–"; const d = new Date(`${m.slice(0, 7)}-01T00:00:00Z`); return d.toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }); };
