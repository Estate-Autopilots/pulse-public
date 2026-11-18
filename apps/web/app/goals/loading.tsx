import { Page, PageHeader } from "../ui";
import { GoalsSkeleton } from "./states";

// GOALS-2: while the goals load, the shape of the list (never a blank page or the dashboard's tiles).
export default function Loading() {
  return <Page><PageHeader title="Goals" /><GoalsSkeleton /></Page>;
}
