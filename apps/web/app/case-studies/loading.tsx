import { GamePage, Skeleton, SkeletonRows } from "../kit/game";

/** While the case studies load: the header, the tiles and rows shaped like the real ones. */
export default function Loading() {
  return <GamePage label="Case studies">
    <Skeleton width={220} height={32} />
    <div style={{ height: 16 }} />
    <SkeletonRows rows={1} height={88} label="Loading the numbers" />
    <div style={{ height: 16 }} />
    <SkeletonRows rows={5} height={72} label="Loading the companies" />
  </GamePage>;
}
