# packages/ui-shell · Pulse shared shell

The Pulse shell is a port of Sales Xray's lightbox shell. Its navigation geometry, workspace switcher, account popover, notice centre, and keyboard-accessible interactions reuse the original owner-authored source; the product-specific views and identity contract are Pulse-owned.

The app receives its account identity from the server. This package displays the supplied identity and role in the account menu; it never reads Cloudflare headers in the browser.

Import `PulseShell` from `@pulse/ui-shell` and `@pulse/ui-shell/styles.css` once in the app root. Theme tokens come from `@pulse/design-system/tokens.css`.
