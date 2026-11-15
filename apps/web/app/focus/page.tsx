import { api, getMe } from "../lib/api";
import { EmptyState, GamePage } from "../kit/game";
import { FocusBoard } from "./board";
import type { Board } from "./model";

export const dynamic = "force-dynamic";

/** FOCUS: every AI and cloud account on one screen, and which work goes where today (UX-GAMIFY: on the game-feel kit).
 *  SETTINGS-APPLE (owner, 13 Nov 2026, T1.4.2): in a company without the Focus module, the person's own Focus opens here
 *  (api/v0/account/focus), on this company's part, instead of switching to the company that keeps it. */
export default async function FocusPage() {
  const me = (await getMe()).data;
  const base = me?.modules?.off?.includes("focus") ? "account/focus" : "focus";
  const r = await api<Board>(base);
  if (r.error || !r.data) return <GamePage label="Focus">
    <EmptyState art="connect" title="Focus did not load" text={r.error ?? "Try again in a minute."} action={{ label: "Try again", href: "/focus" }} />
  </GamePage>;
  return <FocusBoard board={r.data} base={base} />;
}
