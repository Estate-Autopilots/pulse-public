import { Page, PageHeader, Panel, Skeleton } from "../ui";

export default function LoadingCreative() {
  return <Page><PageHeader title="Creative Strategy" /><Panel title="Loading creative work">
    <div role="status" aria-label="Loading creative work"><Skeleton height={120} /></div>
  </Panel></Page>;
}
