export type Import = {
  dataset: string;
  n: number;
  asOf: string;
  importedAt: string;
};
export type Rate = {
  value: number | null;
  low: number | null;
  high: number | null;
  n: number;
  sufficiency: string;
  priorWeight: number;
};
export type Count = { key: string; n: number };
export type LeadData = {
  imports: Import[];
  coverage?: { engagements: number; linked: number };
  scope?: string;
  keys?: string[];
  canWrite?: boolean;
  summary: {
    leads: number;
    dated: number;
    noted: number;
    interested: number;
    plannedPlus: number;
    visited: number;
    booked: number;
    unreachable: number;
    mapped: number;
    first: string | null;
    last: string | null;
    today: number;
    last7: number;
  };
  daily: { day: string; n: number }[];
  creative: (Count & { noted: number; visits: number; rate: Rate })[];
  hooks: Count[];
  languages: Count[];
  platforms: Count[];
  intent: Count[];
  touches: (Count & { visits: number })[];
  hours: { dow: number; hour: number; n: number }[];
  budget: Count[];
  queues: {
    untouched: number;
    oneTouch: number;
    weekend: number;
    night: number;
  };
  notices?: {
    kind: string;
    total: number;
    recent: number | null;
    last: string;
  }[];
};
export type GrowthData = {
  imports: Import[];
  growth: ({ month: string } & Record<string, number | string>)[];
  deltas: Record<string, number | null>;
  pipelineDeltas?: Record<string, number | null>;
  alarm: boolean;
  finance: boolean;
  window: string;
};
export type AdData = {
  permissions: { ok: boolean; write: boolean };
  imports: Import[];
  disclaimer: string;
  totals: {
    currency: string;
    n: number;
    amount: number;
    first: string;
    last: string;
  }[];
  months: {
    month: string;
    kind: string;
    currency: string;
    amount: number;
    n: number;
  }[];
  accounts: {
    accountId: string;
    name: string;
    projectKey: string | null;
    projectId: string | null;
    clientId: string | null;
    projectName: string | null;
    clientName: string | null;
    manual: boolean;
    receipts: number;
    months: number;
    last: string | null;
    amount: number;
    inrReceipts: number;
    alerts: number;
  }[];
  projects: { id: string; name: string }[];
  clients: { id: string; name: string }[];
  benchmark: number;
  segments: { key: string; cpl: number; leads: number; n: number }[];
  cpl: {
    project_key: string;
    projectId: string | null;
    segment: string;
    spend: number;
    leads: number;
    noted: number;
    visits: number;
    planned: number;
    cpl: number;
    estimate: {
      value: number;
      low: number;
      high: number;
      n: number;
      priorLeads: number;
    } | null;
    rate: Rate;
    visitCost: number | null;
  }[];
};
export type CallsData = {
  rows: {
    id: string;
    created: string | null;
    touches: number;
    outcome: string | null;
    intent: string | null;
    platform: string | null;
    sheetRef: string;
    manual: boolean;
  }[];
  total: number;
  page: number;
  queue: string;
  canWrite: boolean;
};
