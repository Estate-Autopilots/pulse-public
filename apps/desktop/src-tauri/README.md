# Tauri shell

The shell exposes enrollment, source pause, sign-out, receipt inspection and the optional bounded plug-in bridge. Tray pause closes intervals and clears unsent metadata. Resume opens setup and cannot bypass a new receipt/window. The existing authorized Pulse workspace opens in a separate remote webview without native IPC capabilities.

Pinned Tauri 2.12.1 / tauri-build 2.7.1. Build with Windows MSVC/WebView2 or macOS prerequisites after `pnpm --filter @pulse/desktop build`. Default bundle targets are Windows MSI/NSIS; macOS needs explicit DMG bundling on its supported runner.

Round 14 has no signed release or physical-device verification. Windows signing and macOS signing/notarization are independent of updater signatures. Linux shell compilation also requires GLib/GTK/WebKitGTK development libraries. See [status](../../../docs/native-apps/round-14.md).
