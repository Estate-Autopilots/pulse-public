import { Message } from "../../ui";
import { loadHq } from "../load";
import { IdeaBoard } from "./board";

export const dynamic = "force-dynamic";

/** PULSE-HQ: the ideas board (?open= opens one idea). */
export default async function IdeasPage({ searchParams }: { searchParams: Promise<{ open?: string }> }) {
  const { open } = await searchParams;
  const r = await loadHq();
  if (r.error || !r.data) return <Message text={r.error ?? "Ideas are unavailable."} />;
  return <IdeaBoard hq={r.data} initialOpen={open && r.data.ideas.some((i) => i.id === open) ? open : null} />;
}
