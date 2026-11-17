export type InvestorSeriesKey = "contractsSigned" | "companiesViaDeal" | "quotes" | "bills" | "chatUsers" | "chatUsersClient" | "activeUsers" | "employees" | "aiAgents" | "companies" | "funnelViewed" | "funnelClicked" | "funnelOrgCreated";
export type InvestorData = {
  asOf: string;
  weeks: string[];
  series: Record<InvestorSeriesKey, number[]>;
  totals: Record<InvestorSeriesKey, number>;
};
export type InvestorMetric = { key: string; label: string; kind: "flow" | "level"; parts?: InvestorSeriesKey[]; how: string };
export type InvestorChange = { n: number; text: string; tone: "up" | "down" | "flat" };

export function num(n: number): string;
export function weekLabel(iso: string): string;
export const METRICS: InvestorMetric[];
export function series(data: InvestorData, metric: InvestorMetric): number[];
export function total(data: InvestorData, metric: InvestorMetric): number;
export function change(data: InvestorData, metric: InvestorMetric): InvestorChange;
export function headline(data: InvestorData): string;
export function deckText(data: InvestorData): string;
export function sparkPoints(values: number[]): string;
export function funnel(data: InvestorData): { viewed: number; clicked: number; made: number; clickRate: string; madeRate: string };
