"use client";
import { PageOutline } from "../page-outline";

// UI-POLISH-3: Leadership's own outline while it loads (its six tabs, figure tiles and panels), not the neutral one.
export default function Loading() {
  return <PageOutline title="Leadership" label="Loading the leadership view" shape="panels" tabs={6} only="/leadership" />;
}
