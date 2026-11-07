# Local desktop views

`index.html`, `native.css` and `native.js` implement Connection (Account, Permissions, Folders & shift) and Today’s evidence. Evidence is paged in a full-screen layout with light/dark tokens and no document scrollbar. The UI never stores credentials in localStorage.

Run `pnpm --filter @pulse/desktop build` and `PULSE_DESKTOP_SCREENSHOT_DIR=/absolute/receipt/path pnpm --filter @pulse/desktop screenshots`. The browser harness checks 1920×860, 1536×730, 1366×650 and 390×760 in both themes with mocked native IPC. These are layout receipts, not physical install/login or sensor receipts.
