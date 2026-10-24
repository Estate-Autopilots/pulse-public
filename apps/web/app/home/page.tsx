import { loadCalm } from "./load";
import { CalmHome } from "./view";

export const dynamic = "force-dynamic";

/** OWNER-HOME: Focus mode on its own address; the dashboard shows the same view when Focus is chosen. */
export default async function Home() {
  return <CalmHome {...await loadCalm()} />;
}
