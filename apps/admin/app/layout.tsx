import type { Metadata } from "next";

import "./styles.css";
import "./ui/tokens.css";
import "./ui/sx-tokens.css";
import { adminConfig } from "./lib/config";
import { ThemeScript } from "./ui/theme-script";

export function generateMetadata(): Metadata {
  const config = adminConfig();
  return {
    title: `${config.product} · Admin`,
    icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
    robots: { index: false, follow: false },
  };
}

// PULSE-ADMIN: the Pulse admin site (company back office), ported from the Sales X-Ray admin console.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-console="" data-theme="light" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <a className="skip-link" href="#admin-content">Skip to admin content</a>
        {children}
      </body>
    </html>
  );
}
