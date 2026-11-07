// PR-STUDIO-2: what GET /api/v0/pr/flow sends (services/api/src/pr-flow.ts).
import type { Channel, ChannelPlan, Stage } from "../lib/pr-flow.mjs";

export type FlowBrand = { id: string; kind: "company" | "personal" | "client"; name: string; byline: string; archived: boolean; role: "manager" | "editor" | "approver" | null; status: "draft" | "on"; assets: number; posts: number };
export type Pillar = { key: string; name: string; about: string; share: number };
export type Kpi = { label: string; metric: string; target: number; actual?: number | null };
export type Strategy = {
  status: "draft" | "on"; positioning: string; audiences: { name: string; need: string }[]; pillars: Pillar[]; channels: ChannelPlan[]; kpis: Kpi[];
  months: { month: string; theme: string; focus: string }[]; weeks: { start: string; theme: string; note: string }[]; rules: string[]; timeZone: string; switchedAt: string | null; updatedAt: string;
};
export type Slide = { file: string; thumb?: string | null; name: string; alt: string; variant?: "B" | "safe" | null };
export type Asset = {
  id: string; key: string | null; title: string; collection: string; kind: "single" | "carousel" | "story" | "header" | "card"; size: string; pillar: string; channel: Channel | null; format: string;
  caption: string; captionSafe: string; hashtags: string[]; why: string; hooks: { A?: string; B?: string; first?: string; why?: string }; brief: { audience?: string; goal?: string; kpi?: string };
  slides: Slide[]; pdfFileId: string | null; pdfSafeFileId: string | null; okState: "ready" | "check" | "needs_ok"; okWho: string; okNote: string; okGivenAt: string | null; okGivenNote: string; archived: boolean;
};
export type Metrics = Partial<Record<"impressions" | "reactions" | "comments" | "shares" | "saves" | "clicks" | "followers", number>>;
export type Post = {
  id: string; brandId: string; assetId: string | null; title: string; stage: Stage; channel: Channel; pillar: string; format: string; slotAt: string | null; day: string | null; time: string | null;
  caption: string; note: string; postedAt: string | null; postedDay: string | null; postedUrl: string | null; metrics: Metrics; measuredAt: string | null; updatedAt: string;
};
export type Insights = {
  plan: number; weeks: { week: string; planned: number; posted: number; started: boolean }[]; streak: number;
  top: { id: string; title: string; channel: Channel; pillar: string; postedAt: string; postedUrl: string | null; metrics: Metrics; assetId: string | null; engagement: number }[];
  kpis: Kpi[]; byChannel: { channel: Channel; planned: number; posted: number }[]; last28: Record<string, number>;
};
export type FlowData = {
  brands: FlowBrand[]; brand: FlowBrand | null; strategy: Strategy | null; assets: Asset[]; posts: Post[]; insights: Insights | null;
  today: string | null; now: string | null; tz?: string; me: string | null; side: string | null;
};
