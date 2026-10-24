import { Message } from "../../ui";
import { FeaturePage } from "../../hq/feature-sheet";
import { HqFrame } from "../../hq/frame";
import { api } from "../../lib/api";
import type { Feature } from "../../hq/model";

export const dynamic = "force-dynamic";

/** PULSE-HQ: one feature of what Pulse can do, on its own page, for every organisation (read only). */
export default async function WhatPulseCanDoFeature({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const r = await api<{ features: Feature[] }>("features");
  const feature = r.data?.features.find((f) => f.key === key);
  if (!feature) return <Message text={r.error ?? "That feature is not in the catalogue."} />;
  return <HqFrame><FeaturePage feature={feature} canEdit={false} offers={[]} ideas={[]} base="/features" /></HqFrame>;
}
