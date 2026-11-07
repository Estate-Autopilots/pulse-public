"use client";
import { PageOutline } from "../page-outline";

// UI-POLISH-3: Finance's own outline while it loads (its sections, figure tiles and panels), not the neutral one.
export default function Loading() {
  return <PageOutline title="Finance" label="Loading finance" shape="panels" tabs={6} only="/finance" />;
}
