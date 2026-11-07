import { Message } from "../ui";
import { Catalogue } from "../hq/catalogue";
import { HqFrame } from "../hq/frame";
import { api } from "../lib/api";
import type { Feature } from "../hq/model";

export const dynamic = "force-dynamic";
export const metadata = { title: "What Pulse can do" };

/** PULSE-HQ (owner, 23 Oct 2026): what Pulse can do, for every organisation: the catalogue the Pulse organisation keeps
 *  (0947), read only. Settings → What Pulse can do. */
export default async function WhatPulseCanDo() {
  const r = await api<{ features: Feature[] }>("features");
  if (r.error || !r.data) return <Message text={r.error ?? "The catalogue is unavailable."} />;
  return <HqFrame><Catalogue features={r.data.features} base="/features" title="What Pulse can do" /></HqFrame>;
}
