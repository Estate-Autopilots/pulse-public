import { Page, Skeleton } from "./ui/kit";

export default function Loading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      id="route-loading-boundary"
    >
      <Page>
        <Skeleton width={220} height={24} />
        <Skeleton width={320} height={14} />
        <p hidden>
          No operational record is shown until the server route resolves.
        </p>
      </Page>
    </div>
  );
}
