import { Compass } from "lucide-react";
import { Empty, Page, PageHeader, styles } from "./ui";

/** POLISH-2: an old or mistyped link showed Next's bare "404 | This page could not be found." inside the app frame. */
export default function NotFound() {
  return (
    <Page>
      <PageHeader title="Page not found" />
      <section className={styles.panel}>
        <Empty icon={Compass} first title="This page isn’t here" text="The link may be old, or the page has moved. Everything is still reachable from the menu." action={{ href: "/", label: "Open the dashboard" }} />
      </section>
    </Page>
  );
}
