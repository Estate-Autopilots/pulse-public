"use client";
import { PageOutline } from "../page-outline";

// EST-1203: this page's own outline while it loads (not the dashboard's).
export default function Loading() {
  return <PageOutline title="My desk" label="Loading your desk" shape="desk" tabs={6} only="/me" />;
}
