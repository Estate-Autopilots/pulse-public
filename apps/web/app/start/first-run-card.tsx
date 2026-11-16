import { api } from "../lib/api";
import { FirstRun, type Guide } from "./first-run";

/** ONBOARD-SELF: the first-run guide on the home page of a company that started itself (nothing anywhere else). */
export async function FirstRunCard() {
  const g = (await api<{ guide: Guide | null }>("account/onboarding")).data?.guide;
  return g && !g.dismissed ? <FirstRun initial={g} /> : null;
}
