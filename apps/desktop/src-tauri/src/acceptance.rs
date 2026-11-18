//! Hosted-runner proofs for the public build repository only (GitHub Actions on Estate-Autopilots/pulse-companion
//! with an absolute PULSE_ACCEPTANCE_DIR). They never pair, use a staff identity or touch attendance.
//!   --admission-acceptance        signed-out native admission at PULSE_ACCEPTANCE_ADDRESS (the app has no default)
//!   --keychain-acceptance write   store a synthetic sign-in the way a real sign-in is stored
//!   --keychain-acceptance read    read it back with Keychain prompts disabled (an update must not prompt)
//!   --ping-acceptance             show one real OS notification through Pulse's registered identity
use serde_json::{json, Value};
use std::path::PathBuf;

fn dir() -> Option<PathBuf> {
    let hosted = std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true")
        && std::env::var("GITHUB_REPOSITORY").as_deref() == Ok("Estate-Autopilots/pulse-companion");
    let dir = PathBuf::from(std::env::var_os("PULSE_ACCEPTANCE_DIR")?);
    (hosted && dir.is_absolute()).then_some(dir)
}
fn receipt(dir: &std::path::Path, name: &str, value: Value) {
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(dir.join(name), serde_json::to_vec_pretty(&value).unwrap_or_default());
}

/// Runs a requested proof and returns true when the process should exit instead of starting the app.
pub fn run() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let Some(dir) = dir() else { return false };
    if args.iter().any(|a| a == "--admission-acceptance") {
        let address = std::env::var("PULSE_ACCEPTANCE_ADDRESS").unwrap_or_default();
        let result = crate::companion::Companion::new().admission_acceptance(&address);
        receipt(&dir, "admission.json", json!({"version":env!("CARGO_PKG_VERSION"),"result":result}));
        return true;
    }
    if let Some(op) = args.iter().position(|a| a == "--keychain-acceptance").and_then(|i| args.get(i + 1)) {
        let result = crate::companion::keychain_acceptance(op);
        receipt(&dir, &format!("keychain-{op}.json"), json!({"version": env!("CARGO_PKG_VERSION"), "operation": op, "result": result}));
        return true;
    }
    if args.iter().any(|a| a == "--ping-acceptance") {
        crate::pings::register_aumid();
        let shown = toast();
        receipt(&dir, "ping.json", json!({"version": env!("CARGO_PKG_VERSION"), "aumid": crate::pings::AUMID, "shown": shown.is_ok(), "error": shown.err(), "permission": crate::pings::permission().err()}));
        std::thread::sleep(std::time::Duration::from_secs(8));
        return true;
    }
    false
}

fn toast() -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri_winrt_notification::Toast::new(crate::pings::AUMID).title("Pulse").text1(crate::pings::ping_text("chat"))
            .sound(Some(tauri_winrt_notification::Sound::Default)).show().map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let status = mac_usernotifications::blocking::get_notification_settings().map(|s| format!("{:?}", s.authorization_status)).unwrap_or_else(|_| "unknown".into());
        let sent = tauri::async_runtime::block_on(async {
            mac_usernotifications::Notification::new().title("Pulse").message(crate::pings::ping_text("chat")).send().await.map(|_| ()).map_err(|e| format!("{e:?}"))
        });
        sent.map_err(|e| format!("{e} (authorization: {status})"))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    { Err("Unsupported OS".into()) }
}
