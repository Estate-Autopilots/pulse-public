import { Message } from "../ui";
import { api } from "../lib/api";
import type { StoryData } from "./model";
import { StoryWorkbench } from "./workbench";

export const dynamic = "force-dynamic";

/** FEATURES-1024 (owner, 23 Oct 2026): Product Story (?product= picks a product, ?version= opens a version). */
export default async function StoryPage({ searchParams }: { searchParams: Promise<{ product?: string; version?: string }> }) {
  const { product, version } = await searchParams;
  const r = await api<StoryData>("story");
  if (r.error || !r.data) return <Message text={r.error ?? "Product Story is unavailable."} />;
  const v = version ? r.data.versions.find((x) => x.id === version) : undefined;
  const p = v?.productId ?? (product && r.data.products.some((x) => x.id === product) ? product : r.data.products[0]?.id ?? null);
  return <StoryWorkbench data={r.data} initialProduct={p} initialVersion={v?.id ?? null} />;
}
