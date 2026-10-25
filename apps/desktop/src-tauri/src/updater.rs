use crate::companion::Companion;
use pulse_desktop_core::update_recovery::{copy_tree, Journal};
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, process::{Command, Stdio}, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct Pending { update: Update, bytes: Option<Vec<u8>>, device: Option<String> }
#[derive(Default)]
pub struct Updates(pub tauri::async_runtime::Mutex<Option<Pending>>);
#[derive(Default)]
pub struct Gate(pub Mutex<(u32, bool)>);
fn err(_: impl std::fmt::Display) -> String { "Pulse could not prepare this update. Please try again.".into() }
fn endpoint(channel: &str) -> Result<url::Url, String> {
    if !matches!(channel, "test" | "stable") { return Err("Unknown update channel".into()); }
    format!("https://github.com/Estate-Autopilots/pulse-companion/releases/download/companion-{channel}/latest-desktop.json").parse().map_err(err)
}
fn device(app: &AppHandle) -> Option<String> { app.state::<Companion>().session()["deviceId"].as_str().map(str::to_owned) }
fn journal_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(app.path().app_local_data_dir().map_err(err)?.join("update-journal.json")) }
fn blocked(app: &AppHandle, version: &str) -> bool {
    journal_path(app).ok().and_then(|p| Journal::load(&p).ok()).is_some_and(|j| j.target == version && matches!(j.stage.as_str(), "rolled-back" | "install-failed"))
}
fn valid_manifest(update: &Update, channel: &str) -> bool {
    let url = &update.download_url;
    update.raw_json["channel"].as_str() == Some(channel)
        && url.scheme() == "https" && url.host_str() == Some("github.com")
        && url.path().starts_with("/Estate-Autopilots/pulse-companion/releases/download/companion-v")
        && url.query().is_none() && url.fragment().is_none()
        && update.body.as_ref().is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 2000)
}
#[tauri::command]
pub async fn update_check(app: AppHandle, channel: String) -> Result<Value, String> {
    let updates = app.state::<Updates>(); let mut slot = updates.0.lock().await;
    *slot = None;
    let updater = app.updater_builder().endpoints(vec![endpoint(&channel)?, format!("https://pulse.estateautopilots.com/api/app-updates/{channel}/latest.json").parse().map_err(err)?]).map_err(err)?.timeout(Duration::from_secs(30)).restart_after_install(false).build().map_err(err)?;
    let Some(mut update) = updater.check().await.map_err(err)? else { return Ok(Value::Null) };
    if !valid_manifest(&update, &channel) { return Err("Pulse rejected an invalid update manifest".into()); }
    if blocked(&app, &update.version) { return Err("That update did not start correctly. Waiting for a newer Pulse.".into()); }
    update.timeout = Some(Duration::from_secs(300));
    let info = json!({"version":update.version,"notes":update.body,"channel":channel});
    *slot = Some(Pending { update, bytes: None, device: device(&app) });
    Ok(info)
}
#[tauri::command]
pub async fn update_prepare(app: AppHandle) -> Result<(), String> {
    let updates = app.state::<Updates>(); let mut slot = updates.0.lock().await;
    let p = slot.as_mut().ok_or("Check for updates first")?;
    let Some(who) = device(&app) else { return Err("Sign in before downloading an update".into()) };
    if p.device.as_ref() != Some(&who) { return Err("Your sign-in changed. Check again.".into()); }
    // The Tauri updater verifies the bundle with the embedded public key before returning bytes.
    let data = p.update.download(|_, _| {}, || {}).await.map_err(err)?;
    if device(&app).as_ref() != Some(&who) { return Err("Your sign-in changed. Check again.".into()); }
    p.bytes = Some(data); Ok(())
}
fn backup(app: &AppHandle, target: &str) -> Result<(Journal, PathBuf), String> {
    let exe = std::env::current_exe().map_err(err)?;
    #[cfg(target_os = "macos")]
    let install = exe.parent().and_then(Path::parent).and_then(Path::parent).ok_or("Pulse app bundle missing")?.to_path_buf();
    #[cfg(not(target_os = "macos"))]
    let install = exe.parent().ok_or("Pulse install folder missing")?.to_path_buf();
    let marker = install.join(format!(".pulse-update-write-check-{}", uuid_suffix()));
    std::fs::OpenOptions::new().write(true).create_new(true).open(&marker).map_err(|_| if cfg!(target_os = "macos") { "Move Pulse from the disk image to a writable Applications folder before updating.".to_string() } else { "Pulse needs a writable installation folder for safe updates. Use the per-user Windows installer.".to_string() })?;
    let _ = std::fs::remove_file(marker); // only our empty permission probe, never an app-data file
    let relative_exe = exe.strip_prefix(&install).map_err(err)?.to_path_buf();
    let base = app.path().app_local_data_dir().map_err(err)?.join("previous-builds").join(format!("{}-{}", env!("CARGO_PKG_VERSION"), uuid_suffix()));
    let backup = base.join(install.file_name().ok_or("Pulse install folder missing")?);
    copy_tree(&install, &backup).map_err(err)?;
    let path = journal_path(app)?;
    let j = Journal { previous:env!("CARGO_PKG_VERSION").into(), target:target.into(), install, backup, relative_exe, stage:"installing".into(), attempts:0 };
    j.save(&path).map_err(err)?; Ok((j, path))
}
fn uuid_suffix() -> String { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis().to_string() }
#[tauri::command]
pub async fn update_install(app: AppHandle, safe: bool) -> Result<(), String> {
    if !safe { return Err("Finish your current action before installing".into()); }
    let updates = app.state::<Updates>(); let mut slot = updates.0.lock().await;
    let p = slot.as_mut().ok_or("Check for updates first")?;
    if !acceptance_active() && (p.device.is_none() || p.device != device(&app)) { return Err("Sign in before installing an update".into()); }
    let bytes = p.bytes.as_ref().ok_or("The update is still downloading")?;
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).map_err(err)?;
    pulse_desktop_core::update_signature::verify_bundle(bytes, config["plugins"]["updater"]["pubkey"].as_str().ok_or("Updater key missing")?, &p.update.signature, &p.update.version)?;
    {
        let gate_state = app.state::<Gate>(); let mut gate = gate_state.0.lock().map_err(err)?;
        if gate.0 > 0 || gate.1 { return Err("Finish your current action before installing".into()); }
        gate.1 = true;
    }
    let result = (|| {
        let (mut j, path) = backup(&app, &p.update.version)?;
        let mut watchdog = Command::new(j.backup.join(&j.relative_exe));
        watchdog.arg("--pulse-update-watchdog").arg(&path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; watchdog.creation_flags(0x08000000); }
        watchdog.spawn().map_err(err)?;
        if let Err(error) = p.update.install(bytes) { j.stage="cancelled".into();let _=j.save(&path);return Err(err(error)); }
        // macOS installation returns; Windows installer exits this process itself. Watchdog launches the new app.
        app.exit(0); Ok(())
    })();
    if result.is_err() { if let Ok(mut gate)=app.state::<Gate>().0.lock() { gate.1=false; } }
    result
}
#[tauri::command]
pub fn update_healthy(app: AppHandle) -> Result<Value, String> {
    let result = record_startup_health(&app);
    super::start_secure_stores(&app);
    result
}
fn record_startup_health(app: &AppHandle) -> Result<Value, String> {
    let path = journal_path(app)?;
    let Ok(mut j) = Journal::load(&path) else { return Ok(Value::Null) };
    if j.acknowledge(env!("CARGO_PKG_VERSION")) { j.save(&path).map_err(err)?; }
    let result = json!({"stage":j.stage,"version":env!("CARGO_PKG_VERSION"),"attempts":j.attempts,"processId":std::process::id()});
    if acceptance_env() && j.stage == "healthy" { proof_receipt("healthy.json", &result)?; }
    if acceptance_env() && j.stage == "rolled-back" { proof_receipt("rolled-back.json", &result)?; }
    Ok(result)
}

// An explicit hosted-runner CLI exercises released native installers without using a staff identity.
// This path never pairs, creates attendance, stores a credential, or accepts an unsigned bundle.
fn acceptance_env() -> bool {
    std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true")
        && std::env::var("GITHUB_REPOSITORY").as_deref() == Ok("Estate-Autopilots/pulse-companion")
        && std::env::var_os("PULSE_UPDATER_ACCEPTANCE_DIR").is_some()
}
fn acceptance_active() -> bool { acceptance_env() && std::env::args().any(|a| a == "--updater-acceptance") }
fn proof_receipt(name: &str, data: &Value) -> Result<(), String> {
    if !acceptance_env() { return Err("Not a hosted acceptance run".into()); }
    let base = PathBuf::from(std::env::var_os("PULSE_UPDATER_ACCEPTANCE_DIR").ok_or("Proof folder missing")?);
    if !base.is_absolute() { return Err("Proof folder must be absolute".into()); }
    std::fs::write(base.join(name), serde_json::to_vec(data).map_err(err)?).map_err(err)
}
pub fn hosted_acceptance(app: &AppHandle) {
    if !acceptance_active() { return; }
    let args: Vec<_> = std::env::args().collect();
    let Some(endpoint) = args.iter().position(|a| a == "--updater-acceptance").and_then(|i| args.get(i + 1)).and_then(|s| s.parse::<url::Url>().ok()) else { return; };
    if endpoint.scheme() != "https" || endpoint.host_str() != Some("github.com") || !endpoint.path().starts_with("/Estate-Autopilots/pulse-companion/releases/download/companion-v") || !endpoint.path().ends_with("/latest.json") { return; }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result: Result<(), String> = async {
            let updater = app.updater_builder().endpoints(vec![endpoint]).map_err(err)?.restart_after_install(false).timeout(Duration::from_secs(60)).build().map_err(err)?;
            let mut update = updater.check().await.map_err(err)?.ok_or("No newer update")?;
            update.timeout = Some(Duration::from_secs(300));
            if !valid_manifest(&update,"test") { return Err("Acceptance manifest invalid".into()); }
            proof_receipt("detected.json", &json!({"previous":env!("CARGO_PKG_VERSION"),"target":update.version}))?;
            let bytes = update.download(|_,_|{},||{}).await.map_err(err)?;
            let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).map_err(err)?;
            let public_key = config["plugins"]["updater"]["pubkey"].as_str().ok_or("Updater key missing")?;
            let mut tampered = bytes.clone(); if let Some(first) = tampered.first_mut() { *first ^= 1; }
            if pulse_desktop_core::update_signature::verify_bundle(&tampered,public_key,&update.signature,&update.version).is_ok() { return Err("Tampered bundle was accepted".into()); }
            proof_receipt("verified.json", &json!({"target":update.version,"signatureVerified":true,"tamperedBundleRejected":true}))?;
            *app.state::<Updates>().0.lock().await = Some(Pending { update, bytes:Some(bytes), device:None });
            update_install(app.clone(), true).await
        }.await;
        if let Err(e) = result { let _ = proof_receipt("error.json", &json!({"error":e})); }
    });
}

#[cfg(test)]
mod tests {
    use super::endpoint;
    // QA-E2E: the desktop asks for its own manifest (latest-desktop.json) on its channel; phones read latest.json.
    #[test]
    fn desktop_reads_its_own_manifest_on_its_channel() {
        for channel in ["test", "stable"] {
            let url = endpoint(channel).expect("known channel");
            assert_eq!(url.scheme(), "https");
            assert_eq!(url.host_str(), Some("github.com"));
            assert_eq!(url.path(), format!("/Estate-Autopilots/pulse-companion/releases/download/companion-{channel}/latest-desktop.json"));
        }
        assert!(endpoint("beta").is_err());
        assert!(endpoint("../test").is_err());
    }
}
