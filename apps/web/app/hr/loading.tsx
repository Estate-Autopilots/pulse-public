"use client";
import { PageOutline } from "../page-outline";

// EST-1203: this page's own outline while it loads (not the dashboard's).
export default function Loading() {
  return <PageOutline title="HR desk" label="Loading the HR desk" shape="panels" tabs={6} only="/hr" />;
}
