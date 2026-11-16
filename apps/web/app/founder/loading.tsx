import { GamePage, Skeleton, SkeletonRows } from "../kit/game";

export default function Loading() {
  return <GamePage label="Loading your companies">
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-busy="true"><Skeleton width={220} height={32} /><Skeleton width={200} height={14} /></div>
    <SkeletonRows rows={2} height={84} label="Loading your companies" />
    <SkeletonRows rows={2} height={260} label="Loading your companies" />
  </GamePage>;
}
