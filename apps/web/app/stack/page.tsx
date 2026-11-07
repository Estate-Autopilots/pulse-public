import { Message } from "../ui";
import { api } from "../lib/api";
import type { StackData } from "./model";
import { StackWorkbench } from "./workbench";

export const dynamic = "force-dynamic";

/** PULSE-HQ: Stack Intelligence (?stack= opens one stack). */
export default async function StackPage({ searchParams }: { searchParams: Promise<{ stack?: string }> }) {
  const { stack } = await searchParams;
  const r = await api<StackData>("stack");
  if (r.error || !r.data) return <Message text={r.error ?? "Stack Intelligence is unavailable."} />;
  return <StackWorkbench data={r.data} openStack={stack && r.data.stacks.some((s) => s.id === stack) ? stack : null} />;
}
