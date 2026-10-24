//! Laptop office presence. With the person's opt-in, this computer reports which Wi-Fi it is on (name and access
//! point only) to the same presence endpoint phones use; Pulse's gateway adds whether the request came from the
//! office public IP. The server applies triangulation and dwell confirmation, HR policy and the person's own
//! auto-check-in choice. Nothing is sent while the opt-in is off; no location, history or other networks are read.
//! ATT: each report also says whether the laptop was in use in the last five minutes (yes/no only).
use crate::companion::Companion;
use pulse_desktop_core::wifi::{self, Wifi};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::Mutex, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice { pub consent: bool, pub auto_consent: bool }

#[derive(Default)]
pub struct Presence { last: Mutex<Value>, sent: Mutex<Option<(Instant, Option<String>)>>, operation: Mutex<()> }

fn choice_file(app: &AppHandle) -> Option<std::path::PathBuf> { app.path().app_config_dir().ok().map(|d| d.join("presence.json")) }
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedChoice {
    #[serde(default)] device_id: String,
    #[serde(flatten)] choice: Choice,
}
impl SavedChoice {
    fn for_device(&self, device: Option<&str>) -> Choice {
        if !self.device_id.is_empty() && device == Some(self.device_id.as_str()) { self.choice } else { Choice::default() }
    }
}
fn current_device(app: &AppHandle) -> Option<String> { app.state::<Companion>().session()["deviceId"].as_str().map(str::to_owned) }
fn choice(app: &AppHandle, device: Option<&str>) -> Choice {
    choice_file(app).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<SavedChoice>(&b).ok()).unwrap_or_default().for_device(device)
}
fn save_choice(app: &AppHandle, device: &str, c: Choice) {
    let saved = SavedChoice { device_id: device.into(), choice: c };
    if let Some(p) = choice_file(app) { if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); } let _ = std::fs::write(p, serde_json::to_vec(&saved).unwrap_or_default()); }
}

/// Reads the current Wi-Fi with the OS's own tool, without a console window.
pub fn current_wifi() -> Wifi {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("netsh").args(["wlan", "show", "interfaces"]).creation_flags(0x0800_0000).output();
        out.map(|o| wifi::parse_netsh(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default()
    }
    #[cfg(target_os = "macos")]
    {
        for interface in ["en0", "en1"] {
            if let Ok(o) = std::process::Command::new("/usr/sbin/ipconfig").args(["getsummary", interface]).output() {
                let w = wifi::parse_ipconfig_summary(&String::from_utf8_lossy(&o.stdout));
                if w.ssid.is_some() || w.needs_location { return w; }
            }
        }
        Wifi::default()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    { let _ = wifi::clean_bssid; Wifi::default() }
}

fn send(app: &AppHandle, device: &str, c: Choice, w: &Wifi) -> Result<Value, String> {
    // ATT: whether someone used this laptop in the last five minutes (a yes or no, never what they did): with the Wi-Fi it
    // tells "still at the desk" from "the laptop went home and is busy there".
    let active = pulse_desktop_core::sensors::idle_seconds().map(|idle| idle < 300);
    let body = if c.consent {
        json!({"consent": true, "autoConsent": c.auto_consent, "wifi": {"ssid": w.ssid, "bssid": w.bssid}, "active": active})
    } else {
        json!({"consent": false, "autoConsent": false})
    };
    app.state::<Companion>().request_for_device(device, "companion/presence", Some(body)).map_err(|e| e.message)
}

fn record(app: &AppHandle, device: &str, c: Choice, w: &Wifi, result: Result<Value, String>) -> Value {
    if current_device(app).as_deref() != Some(device) { return json!({"consent":false,"autoConsent":false,"wifi":{},"server":null,"error":"Your Pulse sign-in changed. Try again."}); }
    let checked_in = result.as_ref().ok().and_then(|r| r["checkedIn"].as_bool()).unwrap_or(false);
    let status = json!({
        "deviceId": device, "consent": c.consent, "autoConsent": c.auto_consent,
        "wifi": {"ssid": w.ssid, "connected": w.ssid.is_some(), "accessPoint": w.bssid.is_some(), "needsLocation": w.needs_location},
        "server": result.as_ref().ok(), "error": result.as_ref().err(), "at": time_now(),
    });
    *app.state::<Presence>().last.lock().unwrap() = status.clone();
    if checked_in { let _ = app.emit("pulse:presence", status.clone()); }
    status
}
fn time_now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

/// What Settings → Devices shows for this computer: the app version, whether pings can arrive and whether office
/// presence is on. Sent every 30 minutes while signed in; never activity or location.
fn report_health(app: &AppHandle) {
    let session = app.state::<Companion>().session();
    let Some(device) = session["deviceId"].as_str() else { return };
    let push = crate::pings::permission().is_ok();
    let caps = json!({"push": if push { "healthy" } else { "denied" }, "work_sites": if choice(app, Some(device)).consent { "healthy" } else { "unknown" }});
    let _ = app.state::<Companion>().request_for_device(device, &format!("devices/{device}/health"), Some(json!({"health": if push { "healthy" } else { "permission_missing" }, "appVersion": env!("CARGO_PKG_VERSION"), "capabilities": caps})));
}

/// Every 90 seconds while opted in (sooner when the Wi-Fi changes); one opt-out message when turned off.
pub fn start(app: AppHandle) {
    let mut last_health: Option<(Instant, String)> = None;
    let _ = std::thread::Builder::new().name("pulse-presence".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(15));
        if !app.state::<Companion>().session()["signedIn"].as_bool().unwrap_or(false) { continue; }
        let device = app.state::<Companion>().session()["deviceId"].as_str().unwrap_or_default().to_string();
        if last_health.as_ref().map_or(true, |(at, d)| at.elapsed() >= Duration::from_secs(1800) || *d != device) {
            last_health = Some((Instant::now(), device.clone()));
            report_health(&app);
        }
        // Finish an earlier presence report before applying an opt-out, so it cannot arrive after withdrawal.
        let presence = app.state::<Presence>();
        let _operation = presence.operation.lock().unwrap();
        let c = choice(&app, Some(&device));
        if !c.consent { continue; }
        let w = current_wifi();
        let due = {
            let presence = app.state::<Presence>();
            let sent = presence.sent.lock().unwrap();
            sent.as_ref().map_or(true, |(at, ssid)| at.elapsed() >= Duration::from_secs(90) || *ssid != w.ssid)
        };
        if !due { continue; }
        *app.state::<Presence>().sent.lock().unwrap() = Some((Instant::now(), w.ssid.clone()));
        let result = send(&app, &device, c, &w);
        record(&app, &device, c, &w, result);
    });
}

#[tauri::command]
pub fn presence_status(app: AppHandle) -> Value {
    let device = current_device(&app);
    let last = app.state::<Presence>().last.lock().unwrap().clone();
    if device.is_some() && last["deviceId"].as_str() == device.as_deref() { return last; }
    let c = choice(&app, device.as_deref());
    let w = if c.consent { current_wifi() } else { Wifi::default() };
    json!({"consent": c.consent, "autoConsent": c.auto_consent, "wifi": {"ssid": w.ssid, "connected": w.ssid.is_some(), "accessPoint": w.bssid.is_some(), "needsLocation": w.needs_location}, "server": null, "error": null})
}

/// Settings → Check-in & presence: save the person's choice and check right away.
#[tauri::command]
pub async fn presence_check(app: AppHandle, consent: Option<bool>, auto_consent: Option<bool>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let presence = app.state::<Presence>();
        let _operation = presence.operation.lock().unwrap();
        let device = current_device(&app).ok_or("Sign in to choose office presence")?;
        let mut c = choice(&app, Some(&device));
        let was = c.consent;
        if let Some(v) = consent { c.consent = v; }
        if let Some(v) = auto_consent { c.auto_consent = v && c.consent; }
        if !c.consent { c.auto_consent = false; }
        save_choice(&app, &device, c);
        let w = if c.consent { current_wifi() } else { Wifi::default() };
        if !c.consent && !was { return Ok(record(&app, &device, c, &w, Ok(json!({"enabled": false})))); }
        *app.state::<Presence>().sent.lock().unwrap() = Some((Instant::now(), w.ssid.clone()));
        let result = send(&app, &device, c, &w);
        Ok(record(&app, &device, c, &w, result))
    })
    .await
    .map_err(|_| "Presence check interrupted".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_pairing_cannot_inherit_another_pairings_presence_permission() {
        let saved = SavedChoice { device_id: "paired-a".into(), choice: Choice { consent: true, auto_consent: true } };
        assert!(saved.for_device(Some("paired-a")).auto_consent);
        for next in [None, Some("paired-b"), Some("")] {
            let choice = saved.for_device(next);
            assert!(!choice.consent && !choice.auto_consent);
        }
        let restored: SavedChoice = serde_json::from_slice(&serde_json::to_vec(&saved).unwrap()).unwrap();
        assert!(restored.for_device(Some("paired-a")).consent);
    }
    #[test]
    fn legacy_unbound_opt_in_needs_a_new_explicit_choice() {
        let legacy: SavedChoice = serde_json::from_value(json!({"consent":true,"autoConsent":true})).unwrap();
        assert!(!legacy.for_device(Some("paired-a")).consent);
        assert!(!legacy.for_device(None).auto_consent);
    }
}
