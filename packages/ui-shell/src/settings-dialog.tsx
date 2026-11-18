"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "./settings-dialog.module.css";
import { useTheme, type ThemePreference } from "./theme-provider";

const choices: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type DesktopBuild = {
  version: string; commit: string; buildDate: string; fileName: string;
  sizeBytes: number; sha256: string; noticeVersion: string; downloadUrl: string;
};

export function DesktopBuildPanel({ enabled = true }: { enabled?: boolean } = {}) {
  const [build, setBuild] = useState<DesktopBuild | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!enabled) { setAcknowledged(false); return; }
    const controller = new AbortController();
    setLoading(true);
    fetch("/api/admin/devices/desktop-build", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? "No verified Windows build is available on this Pulse deployment.");
        return value as DesktopBuild;
      })
      .then((value) => { setBuild(value); setError(""); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) { setBuild(null); setError(reason instanceof Error ? reason.message : "Build metadata could not be loaded."); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled]);

  return (
    <section className={styles.devicesPanel} role="tabpanel" aria-label="Device builds">
      <p className={styles.settingsDescription}>Internal desktop installers published to this Pulse deployment.</p>
      <div className={styles.buildWarning} role="note">
        <strong>Unsigned internal build</strong>
        <p>This Windows installer is unsigned. SmartScreen or Windows Defender may warn about the unknown publisher. Use only for controlled internal testing.</p>
      </div>
      {loading ? <p role="status" className={styles.buildStatus}>Checking the latest verified Windows build…</p> : null}
      {error ? <p role="status" className={styles.buildStatus}>{error}</p> : null}
      {build ? (
        <>
          <dl className={styles.buildDetails}>
            <div><dt>Version</dt><dd>{build.version}</dd></div>
            <div><dt>Commit</dt><dd><code>{build.commit}</code></dd></div>
            <div><dt>Build date (UTC)</dt><dd><time dateTime={build.buildDate}>{build.buildDate}</time></dd></div>
            <div><dt>Installer size</dt><dd>{new Intl.NumberFormat().format(build.sizeBytes)} bytes</dd></div>
            <div><dt>SHA-256</dt><dd><code className={styles.buildHash}>{build.sha256}</code></dd></div>
          </dl>
          <label className={styles.noticeAcknowledgement}>
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            <span>I confirm each person who will use this build has received and acknowledged staff notice v2 ({build.noticeVersion}).</span>
          </label>
          <button
            type="button"
            className={styles.downloadButton}
            disabled={!acknowledged}
            onClick={() => window.location.assign(build.downloadUrl + "&acknowledgement=" + encodeURIComponent(build.noticeVersion))}
          >
            Download unsigned Windows installer
          </button>
        </>
      ) : null}
    </section>
  );
}

export function SettingsDialog({ open, onClose, canManageDevices }: { open: boolean; onClose: () => void; canManageDevices: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { preference, setPreference } = useTheme();
  const [section, setSection] = useState<"appearance" | "devices">("appearance");

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
    if (!open) setSection("appearance");
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-label="Pulse settings"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onClose={onClose}
    >
      <section className={styles.settingsPanel}>
        <header className={styles.settingsHeader}>
          <div><p className={styles.settingsEyebrow}>PULSE SETTINGS</p><h2>{section === "devices" ? "Devices" : "Appearance"}</h2></div>
          <button type="button" className={styles.closeButton} aria-label="Close settings" onClick={onClose}><X size={18} /></button>
        </header>
        {canManageDevices ? (
          <nav className={styles.settingsTabs} role="tablist" aria-label="Settings sections">
            <button type="button" role="tab" aria-selected={section === "appearance"} onClick={() => setSection("appearance")}>Appearance</button>
            <button type="button" role="tab" aria-selected={section === "devices"} onClick={() => setSection("devices")}>Devices</button>
          </nav>
        ) : null}
        {section === "appearance" ? (
          <section role="tabpanel" aria-label="Appearance">
            <p className={styles.settingsDescription}>Choose how Pulse looks on this device.</p>
            <fieldset className={styles.themeChoices}>
              <legend>Theme</legend>
              {choices.map((choice) => (
                <label key={choice.value} className={styles.themeChoice} data-selected={preference === choice.value}>
                  <input type="radio" name="pulse-theme" value={choice.value} checked={preference === choice.value} onChange={() => setPreference(choice.value)} />
                  <span>{choice.label}</span>
                </label>
              ))}
            </fieldset>
          </section>
        ) : canManageDevices ? <DesktopBuildPanel enabled={open && section === "devices"} /> : null}
      </section>
    </dialog>
  );
}
