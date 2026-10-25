// PULSE-HQ: the licence register lives in Pulse HQ, the platform owner's home (0946); /orgs/licences shows the same.
import { KeyRound } from "lucide-react";
import { getMe } from "../../lib/api";
import Licences from "../../orgs/licences/page";
import { Empty, Page, styles } from "../../ui";

export const dynamic = "force-dynamic";

export default async function HqLicences() {
  const me = (await getMe()).data;
  if (me?.orgHandle !== "pulsehq") return <Page><section className={styles.panel}>
    <Empty icon={KeyRound} first title="Licences are managed in Pulse HQ"
      text="Your organisation's other HQ pages are available as usual."
      action={{ href: "/hq/features", label: "Go to Feature catalogue" }} />
  </section></Page>;
  return <Licences />;
}
