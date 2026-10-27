import { Why } from "../ui";

const detail = "Counts are eligible design exports last modified in Drive during this week. Pulse groups them by the configured folder rules, with file-name rules as a fallback; unclassified exports count as Other only in a delivery folder.";
const more = "Pulse credits files using qualified attribution or the last-modifying account. Files from a shared login stay together in one Shared login row and receive no personal credit.";

export function DesignersWhy() {
  return <Why detail={detail} more={more} />;
}
