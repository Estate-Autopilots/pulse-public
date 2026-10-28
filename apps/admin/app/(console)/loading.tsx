import { Page, Skeleton, kitStyles } from "@/app/ui/kit";

/** Mirrors a console page (header, tiles, one panel) so nothing moves when it arrives. */
export default function ConsoleLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <Page>
        <div style={{ display: "grid", gap: 6 }}>
          <Skeleton width={220} height={24} />
          <Skeleton width={320} height={14} />
        </div>
        <div className={kitStyles.panel} style={{ padding: 14, gap: 12 }}>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} height={20} width={`${90 - index * 8}%`} />
          ))}
        </div>
      </Page>
    </div>
  );
}
