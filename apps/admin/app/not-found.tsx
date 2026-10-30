import Link from "next/link";

import { Page, kitStyles } from "./ui/kit";

export default function NotFound() {
  return (
    <main id="admin-content" tabIndex={-1}>
      <Page>
        <section className={kitStyles.panel} aria-labelledby="not-found-title">
          <div className={kitStyles.empty}>
            <h1 id="not-found-title" className={kitStyles.emptyTitle}>
              There’s no admin page here
            </h1>
            <p className={kitStyles.emptyText}>
              The link may be old. Nothing was changed.
            </p>
            <Link className={kitStyles.button} href="/">
              Go to admin home
            </Link>
          </div>
        </section>
      </Page>
    </main>
  );
}
