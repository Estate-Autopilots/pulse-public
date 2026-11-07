import { NeutralOutline } from "./page-outline";

// EST-1203: the fallback for a page with no loading screen of its own, and for a move inside the app before the page's
// own is known, is neutral (no title, one panel), never the dashboard's tiles; those are in dashboard/loading.tsx.
export default function Loading() {
  return <NeutralOutline />;
}
