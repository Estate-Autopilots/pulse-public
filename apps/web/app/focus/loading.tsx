import { GamePage, Skeleton, SkeletonRows } from "../kit/game";

/** Focus loading, shaped like the board (PULSE-POLISH: the header, one next step, two rows, the folded sections). */
export default function FocusLoading() {
  return <GamePage label="Loading Focus">
    <Skeleton width={180} height={32} />
    <Skeleton width="50%" height={16} />
    <Skeleton height={168} radius={16} />
    <SkeletonRows rows={2} height={64} label="Loading today's work" />
    <SkeletonRows rows={3} height={48} label="Loading" />
  </GamePage>;
}
