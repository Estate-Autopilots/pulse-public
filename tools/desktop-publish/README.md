# Desktop build publisher

The eadev user timer pulls the newest successful `desktop-windows.yml` run from `main`, checks every installer against
`pulse-desktop-manifest.json`, and atomically publishes verified files under `~/pulse-downloads/desktop/<version>-<sha7>/`.
`latest.json` points at the published manifest; only the newest three release directories are kept. A mismatched or
missing manifest/hash fails closed and leaves the current `latest.json` unchanged.

The web app reads `PULSE_DESKTOP_DOWNLOADS_DIR`. `tools/pulse-dev/pulse-dev-web.service` points that variable at
`%h/pulse-downloads/desktop`; staging receives the corresponding read-only mount from the ea-infrastructure deploy.
If the latest main artifact predates the manifest, the timer leaves the current publication untouched until a newer
successful run includes it.

Install or update the user timer on the VPS with `tools/desktop-publish/install.sh`. It uses the existing eadev `gh`
login and requires no GitHub secret. To inspect it, run `systemctl --user status pulse-desktop-publish.timer` and
`journalctl --user -u pulse-desktop-publish.service -n 30`. Local verification tests create synthetic installers.
