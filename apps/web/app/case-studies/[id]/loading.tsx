import { GamePage, Skeleton, SkeletonRows } from "../../kit/game";

/** While a case file loads: the header, the stepper and the steps, shaped like the real ones. */
export default function Loading() {
  return <GamePage label="Case study">
    <Skeleton width={260} height={32} />
    <div style={{ height: 16 }} />
    <Skeleton height={48} radius={12} />
    <div style={{ height: 16 }} />
    <SkeletonRows rows={4} height={56} label="Loading the steps" />
  </GamePage>;
}
