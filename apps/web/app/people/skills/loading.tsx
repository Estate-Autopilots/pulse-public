import { Page, Skeleton } from "../../ui";

export default function Loading() {
  return <Page><Skeleton height={28} width={240} /><Skeleton height={160} /><Skeleton height={220} /></Page>;
}
