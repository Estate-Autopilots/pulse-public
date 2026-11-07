mod acceptance;
mod appwin;
mod companion;
mod pings;
mod presence;
mod updater;
use updater::{update_check, update_prepare, update_install, update_healthy, Updates, Gate};

use companion::Companion;
use pulse_desktop_core::{
    tracker::{Settings, Tracker},
    AgentCore, AgentStatus,
};
use serde_json::{json, Value};
use std::{
    sync::{Mutex, atomic::{AtomicBool, Ordering}},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

const ICON_IDLE: &[u8] = include_bytes!("../icons/tray.png");
const ICON_IN: &[u8] = include_bytes!("../icons/tray-in.png");
const ICON_BREAK: &[u8] = include_bytes!("../icons/tray-break.png");
const ICON_ALERT: &[u8] = include_bytes!("../icons/tray-alert.png");
#[cfg(target_os = "macos")]
const ICON_TEMPLATE: &[u8] = include_bytes!("../icons/tray-template.png");
const PANEL: &str = "panel";
const SETTINGS: &str = "settings";
const PANEL_WIDTH: f64 = 380.0;
const MARGIN: f64 = 14.0;

/// Where the panel opens: under the tray icon on a Mac, above the bottom-right corner on Windows.
#[derive(Default)]
struct Anchor {
    tray: Option<(f64, f64, f64, f64)>,
    hidden_at: Option<Instant>,
    shown_at: Option<Instant>,
    pinned: bool,
}

#[derive(Default)]
struct SecureStartup { started: AtomicBool, tracker_issue: Mutex<Option<String>> }

/// While saved credentials are restored, macOS must never show a Keychain password prompt: reads either succeed
/// silently (the item belongs to this signing identity) or fail, and the app asks for a fresh browser approval.
struct QuietKeychain(#[cfg(target_os = "macos")] Option<security_framework::os::macos::keychain::KeychainUserInteractionLock>);
fn quiet_keychain() -> QuietKeychain {
    #[cfg(target_os = "macos")]
    { QuietKeychain(security_framework::os::macos::keychain::SecKeychain::disable_user_interaction().ok()) }
    #[cfg(not(target_os = "macos"))]
    { QuietKeychain() }
}

// A Keychain approval is an OS permission wait, not an app startup failure.
// Start these only after the real WebView has rendered and acknowledged its health.
fn start_secure_stores(app: &AppHandle) {
    if app.state::<SecureStartup>().started.swap(true, Ordering::SeqCst) { return; }
    let store_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let quiet = quiet_keychain();
        store_app.state::<Companion>().restore_saved_session();
        let opened = store_app.path().app_local_data_dir().map_err(|_| "Pulse could not open saved work settings".to_string())
            .and_then(|path| Tracker::open(path.join("native-tracker.bin")));
        drop(quiet);
        match opened {
            Ok(tracker) => {
                let delegate_app = store_app.clone();
                tracker.set_delegate(std::sync::Arc::new(move |path: &str, body: Option<Value>| {
                    delegate_app.state::<Companion>().request(path, body).map_err(|e| e.message)
                }));
                let core = store_app.state::<AgentCore>().inner().clone();
                if tracker.status(&core).paused { core.set_pause("until-resumed").ok(); }
                store_app.manage(tracker.clone());
                let sync_core = core.clone();
                let _ = thread::Builder::new().name("pulse-ingest".into()).spawn(move || loop { let _ = sync_core.sync_once(); thread::sleep(Duration::from_secs(15)); });
                let (bridge_tracker, bridge_core) = (tracker.clone(), core.clone());
                let _ = thread::Builder::new().name("pulse-adobe-bridge".into()).spawn(move || { let _ = pulse_desktop_core::bridge::serve(bridge_tracker, bridge_core); });
                let _ = thread::Builder::new().name("pulse-sensors".into()).spawn(move || loop { let _ = tracker.tick(&core); thread::sleep(Duration::from_secs(5)); });
            }
            Err(issue) => { *store_app.state::<SecureStartup>().tracker_issue.lock().unwrap() = Some(issue); }
        }
    });
}

fn ready_tracker(app: &AppHandle) -> Result<Tracker, String> {
    app.try_state::<Tracker>().map(|tracker| tracker.inner().clone())
        .ok_or_else(|| "Pulse is still opening your saved work settings. Try again in a moment.".into())
}

// ------------------------------------------------------------------------------------------------ the panel
fn panel(app: &AppHandle) -> Option<WebviewWindow> { app.get_webview_window(PANEL) }

fn place(app: &AppHandle, win: &WebviewWindow) {
    let Ok(size) = win.outer_size() else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    let margin = (MARGIN * scale) as i32;
    let tray = app.state::<Mutex<Anchor>>().lock().unwrap().tray;
    let monitor = tray
        .and_then(|(x, y, _, _)| app.monitor_from_point(x, y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let area = monitor.work_area();
    let (left, top) = (area.position.x, area.position.y);
    let (right, bottom) = (left + area.size.width as i32, top + area.size.height as i32);
    let (w, h) = (size.width as i32, size.height as i32);
    let (mut x, mut y) = (right - w - margin, bottom - h - margin);
    if cfg!(target_os = "macos") {
        if let Some((tx, ty, tw, th)) = tray {
            x = (tx + tw / 2.0) as i32 - w / 2;
            y = (ty + th) as i32 + margin / 2;
        } else {
            y = top + margin / 2;
        }
    }
    x = x.clamp(left + margin, (right - w - margin).max(left + margin));
    y = y.clamp(top, (bottom - h).max(top));
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

pub(crate) fn show_panel(app: &AppHandle) {
    let Some(win) = panel(app) else { return };
    place(app, &win);
    app.state::<Mutex<Anchor>>().lock().unwrap().shown_at = Some(Instant::now());
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    let _ = win.eval("window.pulsePanel?.shown()");
}

fn hide_panel(app: &AppHandle) {
    if let Some(win) = panel(app) {
        let _=win.eval("window.pulsePanel?.hidden?.()");let _ = win.hide();
        app.state::<Mutex<Anchor>>().lock().unwrap().hidden_at = Some(Instant::now());
    }
}

fn toggle_panel(app: &AppHandle) {
    let Some(win) = panel(app) else { return };
    // A click on the tray first takes focus from the panel (which hides it); don't reopen it straight away.
    let just_hidden = app.state::<Mutex<Anchor>>().lock().unwrap().hidden_at.is_some_and(|t| t.elapsed() < Duration::from_millis(350));
    if win.is_visible().unwrap_or(false) { hide_panel(app); } else if !just_hidden { show_panel(app); }
}

pub(crate) fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let result = { use std::os::windows::process::CommandExt; std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).creation_flags(0x0800_0000).spawn() };
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result.map(|_| ()).map_err(|_| format!("Open {url} in your browser"))
}

// ------------------------------------------------------------------------------------------------ Settings
/// One Settings sheet (General, Notifications, Check-in & presence, Privacy & permissions, Account, Updates & about).
pub(crate) fn show_settings(app: &AppHandle, section: Option<String>) {
    let section = section.filter(|s| s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    if let Some(window) = app.get_webview_window(SETTINGS) {
        if let Some(s) = &section { let _ = window.eval(format!("window.pulseSettings?.go({})", json!(s))); }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let url = format!("settings.html{}", section.map(|s| format!("#{s}")).unwrap_or_default());
    let mut builder = WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App(url.into()))
        .title("Settings")
        .inner_size(820., 600.)
        .min_inner_size(700., 500.)
        .maximizable(false)
        .center()
        .visible(false);
    #[cfg(target_os = "macos")]
    { builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent).hidden_title(true); }
    #[cfg(windows)]
    { builder = builder.effects(tauri::utils::config::WindowEffectsConfig { effects: vec![tauri::window::Effect::Mica], ..Default::default() }); }
    if let Ok(window) = builder.build() {
        let dark = matches!(window.theme(), Ok(tauri::Theme::Dark));
        let _ = window.set_background_color(Some(if dark { tauri::window::Color(26, 26, 36, 255) } else { tauri::window::Color(250, 250, 252, 255) }));
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// pulse:// links from the OS, a second launch, notifications or page shortcuts.
pub(crate) fn deep_link(app: &AppHandle, raw: &str) {
    match appwin::parse_link(raw) {
        Some(appwin::Link::Page(path)) => appwin::open(app, Some(path)),
        Some(appwin::Link::Settings(section)) => show_settings(app, section),
        Some(appwin::Link::Panel) => show_panel(app),
        None => {}
    }
}

/// A launch from the Start menu, Dock, Finder or a second instance: the Pulse window, unless asked otherwise.
fn launched(app: &AppHandle, args: &[String]) {
    if let Some(link) = args.iter().find(|a| a.starts_with("pulse://")) { deep_link(app, link); return; }
    if args.iter().any(|a| a == "--panel" || a == "--pinned") { show_panel(app); return; }
    appwin::open(app, None);
}

// ------------------------------------------------------------------------------------------- companion commands
fn err(e: companion::CallError) -> String { e.text() }

#[tauri::command]
fn companion_session(state: State<'_, Companion>) -> Value { state.session() }

#[tauri::command]
async fn companion_request(app: AppHandle, path: String, body: Option<Value>) -> Result<Value, String> {
    if !path.chars().all(|c| c.is_ascii_alphanumeric() || "/-?=&%:._".contains(c)) { return Err(companion::CallError::default().text()); }
    {
        let gate_state = app.state::<Gate>(); let mut gate = gate_state.0.lock().unwrap();
        if gate.1 { return Err("Pulse is installing an update. Try again after restart.".into()); }
        gate.0 += 1;
    }
    let request_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || request_app.state::<Companion>().request(&path, body).map_err(err))
        .await.map_err(|_| "{\"message\":\"Pulse request interrupted\"}".to_string());
    app.state::<Gate>().0.lock().unwrap().0 -= 1;
    result?
}

#[tauri::command]
async fn companion_pair_start(app: AppHandle, base: String, expected_person: Option<String>) -> Result<Value, String> {
    let started = tauri::async_runtime::spawn_blocking(move || app.state::<Companion>().pair_start(&base).map_err(err))
        .await
        .map_err(|_| "{\"message\":\"Pulse request interrupted\"}".to_string())??;
    if let Some(url) = started["verifyUrl"].as_str() {
        let target=expected_person.filter(|s|s.len()==36&&s.chars().all(|c|c.is_ascii_hexdigit()||c=='-')).map(|p|format!("{url}&expected={p}")).unwrap_or_else(||url.to_string());
        let _ = open_url(&target);
    }
    Ok(started)
}

#[tauri::command]
async fn companion_pair_poll(app: AppHandle) -> Result<Value, String> {
    let poll_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || poll_app.state::<Companion>().pair_poll().map_err(err))
        .await
        .map_err(|_| "{\"message\":\"Pulse request interrupted\"}".to_string())??;
    if result["status"] == "approved" { let _ = app.emit("pulse:signed-in", json!({})); }
    Ok(result)
}

#[tauri::command]
fn companion_pair_cancel(state: State<'_, Companion>) { state.pair_cancel(); }

/// The session with the company the saved Pulse names before pairing ("Join <company>'s Pulse?").
#[tauri::command]
async fn companion_about(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Companion>().about())
        .await
        .map_err(|_| "{\"message\":\"Pulse request interrupted\"}".to_string())
}

#[tauri::command]
async fn companion_password(app: AppHandle, base: String, username: String, password: String, code: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let c = app.state::<Companion>();
        match code.filter(|c| !c.trim().is_empty()) { Some(code) => c.two_step(code.trim()), None => c.password(&base, &username, &password) }.map_err(err)
    })
    .await
    .map_err(|_| "{\"message\":\"Pulse request interrupted\"}".to_string())?
}

/// "Your Pulse address" on first run or in Settings. Moving to another server drops the old server's queued work,
/// then signs this computer and the Pulse window out of it, before the new address is saved.
#[tauri::command]
async fn companion_address_set(app: AppHandle, address: String) -> Result<Value, String> {
    if app.state::<Gate>().0.lock().unwrap().1 { return Err("Wait for Pulse to finish installing".into()); }
    let work = app.clone();
    let (session, left) = tauri::async_runtime::spawn_blocking(move || {
        let mut left = false;
        let session = work.state::<Companion>().set_address(&address, || {
            if let Some(tracker) = work.try_state::<Tracker>() { let _ = tracker.sign_out(); }
            work.state::<Companion>().sign_out();
            appwin::signed_out(&work);
            left = true;
        }).map_err(err)?;
        Ok::<_, String>((session, left))
    })
    .await
    .map_err(|_| "{\"message\":\"Pulse request interrupted\"}".to_string())??;
    if left { let _ = app.emit("pulse:signed-out", json!({})); }
    let _ = app.emit("pulse:address", json!({}));
    Ok(session)
}

#[tauri::command]
async fn companion_sign_out(app: AppHandle) -> Result<Value, String> {
    if app.state::<Gate>().0.lock().unwrap().1 { return Err("Wait for Pulse to finish installing".into()); }
    let out_app = app.clone();
    let session = tauri::async_runtime::spawn_blocking(move || out_app.state::<Companion>().sign_out())
        .await
        .map_err(|_| "Sign-out interrupted".to_string())?;
    appwin::signed_out(&app);
    let _ = app.emit("pulse:signed-out", json!({}));
    Ok(session)
}

/// "Open in Pulse" links open in the Pulse window; the browser stays available from the menus.
#[tauri::command]
fn open_pulse(app: AppHandle, path: String) -> Result<(), String> {
    appwin::open(&app, Some(appwin::safe_path(&path).unwrap_or_else(|| "/me".into())));
    Ok(())
}
#[tauri::command]
fn open_in_browser(state: State<'_, Companion>, path: String) -> Result<(), String> {
    let path = appwin::safe_path(&path).unwrap_or_else(|| "/me".into());
    let base = state.base().ok_or_else(|| "Enter your Pulse address first".to_string())?;
    open_url(&format!("{}{}", companion::site(&base), path))
}

#[tauri::command]
fn panel_fit(app: AppHandle, height: f64) {
    let Some(win) = panel(&app) else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    let height = height.clamp(220.0, 680.0);
    let _ = win.set_size(PhysicalSize::new((PANEL_WIDTH * scale) as u32, (height * scale) as u32));
    if win.is_visible().unwrap_or(false) { place(&app, &win); }
}

#[tauri::command]
fn panel_show(app: AppHandle) { show_panel(&app); }

#[tauri::command]
fn panel_hide(app: AppHandle) { hide_panel(&app); }

#[tauri::command]
fn panel_pin(app: AppHandle, pinned: bool) { app.state::<Mutex<Anchor>>().lock().unwrap().pinned = pinned; }

/// The tray mirrors the day: icon tone, tooltip, and on a Mac the timer next to the icon. The Pulse window's dock or
/// taskbar badge shows the unread count.
#[tauri::command]
fn set_tray(app: AppHandle, text: String, tone: String, title: String) {
    let unread=pings::unread(&app);
    appwin::badge(&app, unread);
    let Some(tray) = app.tray_by_id("pulse") else { return };
    let (text,tone,title)=if title=="Pulse"&&text.is_empty()&&tone=="neutral"{
        app.state::<pings::Pings>().tray.lock().unwrap().clone()
    }else{
        *app.state::<pings::Pings>().tray.lock().unwrap()=(text.clone(),tone.clone(),title.clone());
        (text,tone,title)
    };
    #[cfg(target_os = "macos")]
    {
        let text=if unread>0{unread.to_string()}else{text};
        let _ = tray.set_title(if text.is_empty() { None } else { Some(text.chars().take(8).collect::<String>()) });
        let _ = tone;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &text;
        let bytes = match tone.as_str() { "success" => ICON_IN, "info" => ICON_BREAK, "warning" => ICON_ALERT, _ => ICON_IDLE };
        if let Ok(icon) = Image::from_bytes(bytes) { let _ = tray.set_icon(Some(if unread>0{pings::badge_icon(icon,unread)}else{icon})); }
    }
    let title=if unread>0{format!("Pulse · {unread} unread")}else{title};
    let _ = tray.set_tooltip(Some(title.chars().take(120).collect::<String>()));
}

/// A local notification (reminders, finished downloads).
pub(crate) fn notify_now(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    app.notification().builder().title(title.chars().take(80).collect::<String>()).body(body.chars().take(200).collect::<String>()).show().map_err(|_| "Notifications are turned off for Pulse".to_string())
}
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> { notify_now(&app, &title, &body) }

#[tauri::command]
fn autostart_get(app: AppHandle) -> bool { app.autolaunch().is_enabled().unwrap_or(false) }

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    if enabled { manager.enable() } else { manager.disable() }.map_err(|_| "Your computer did not allow Pulse to change this".to_string())?;
    Ok(manager.is_enabled().unwrap_or(enabled))
}

/// Launch options for demos and runner screenshots: --demo, --tab=inbox|chats|conversation, --theme=light|dark.
fn launch_options() -> Value {
    let args: Vec<String> = std::env::args().collect();
    let value = |name: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{name}="))).filter(|v| v.len() <= 20 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).map(str::to_string);
    serde_json::json!({"demo": args.iter().any(|a| a == "--demo"), "tab": value("tab"), "theme": value("theme")})
}
#[tauri::command]
fn app_info() -> Value {
    serde_json::json!({"version": env!("CARGO_PKG_VERSION"), "platform": companion::platform(), "shortcut": if cfg!(target_os = "macos") { "⌃⌥P" } else { "Ctrl+Alt+P" }, "launch": launch_options()})
}

#[tauri::command]
fn open_settings(app: AppHandle, section: Option<String>) { show_settings(&app, section); }
/// The exact OS settings page a permission lives on (only these two).
#[tauri::command]
fn open_os_settings(page: String) -> Result<(), String> {
    let url = match (page.as_str(), cfg!(target_os = "macos")) {
        ("location", true) => "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices",
        ("location", false) => "ms-settings:privacy-location",
        ("notifications", true) => "x-apple.systempreferences:com.apple.preference.notifications",
        ("notifications", false) => "ms-settings:notifications",
        _ => return Err("Unknown settings page".into()),
    };
    open_url(url)
}
/// Older panels call this; the old Settings & privacy window is gone.
#[tauri::command]
fn open_privacy(app: AppHandle) { show_settings(&app, Some("privacy".into())); }

/// Settings changed something the panel shows (Pip, reminders, theme): tell every Pulse page.
#[tauri::command]
fn prefs_changed(app: AppHandle) { let _ = app.emit("pulse:prefs", json!({})); }

// ------------------------------------------------- optional focus/idle metadata (off unless the notice is accepted)
#[tauri::command]
fn agent_status(state: State<'_, AgentCore>) -> AgentStatus { state.status() }

#[tauri::command]
fn tracker_status(app: AppHandle, core: State<'_, AgentCore>) -> Value {
    match ready_tracker(&app) {
        Ok(tracker) => serde_json::to_value(tracker.status(&core)).unwrap_or(Value::Null),
        Err(waiting) => {
            let issue = app.state::<SecureStartup>().tracker_issue.lock().unwrap().clone().unwrap_or(waiting);
            serde_json::json!({"configured":false,"connected":false,"personName":"","paused":true,"captureEnd":"","queued":0,"seen":[],"issue":issue,"breakWarning":null,"purposes":[],"deviceId":"","folders":[]})
        }
    }
}
/// Work activity on or off in Settings, through this computer's existing pairing (no second sign-in).
#[tauri::command]
async fn activity_set(app: AppHandle, enabled: bool) -> Result<Value, String> {
    let tracker = ready_tracker(&app)?;
    let device = app.state::<Companion>().session()["deviceId"].as_str().map(str::to_owned).ok_or("Sign in to Pulse on this computer first")?;
    let core = app.state::<AgentCore>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        tracker.configure_delegated(&device, if enabled { vec!["activity_context".into()] } else { vec![] })?;
        core.set_pause(if enabled { "resume" } else { "until-resumed" })?;
        Ok(serde_json::to_value(tracker.status(&core)).unwrap_or(Value::Null))
    })
    .await
    .map_err(|_| "Native request interrupted".to_string())?
}
#[tauri::command]
async fn tracker_configure(app: AppHandle, settings: Settings) -> Result<(), String> {
    let tracker = ready_tracker(&app)?;
    tauri::async_runtime::spawn_blocking(move || tracker.configure(settings))
        .await
        .map_err(|_| "Native request interrupted".to_string())?
}
#[tauri::command]
fn tracker_pause(app: AppHandle, core: State<'_, AgentCore>, paused: bool) -> Result<(), String> {
    ready_tracker(&app)?.pause(paused)?;
    core.set_pause(if paused { "until-resumed" } else { "resume" })?;
    Ok(())
}
#[tauri::command]
fn bridge_info(app: AppHandle) -> Result<Value, String> {
    Ok(serde_json::json!({"url":"http://127.0.0.1:47831/commands","token":ready_tracker(&app)?.bridge_token()}))
}
#[tauri::command]
async fn tracker_sign_out(app: AppHandle) -> Result<(), String> {
    let tracker = ready_tracker(&app)?;
    tauri::async_runtime::spawn_blocking(move || tracker.sign_out())
        .await
        .map_err(|_| "Native request interrupted".to_string())?
}
#[tauri::command]
fn open_workspace(app: AppHandle) -> Result<(), String> { appwin::open(&app, Some("/me".into())); Ok(()) }

// ------------------------------------------------------------------------------------------------ menus
/// The macOS menu bar for the Pulse window: app, Edit (copy/paste need it), View, Go, Window and Help.
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, id, text, true, accel);
    let about = PredefinedMenuItem::about(app, Some("About Pulse"), Some(tauri::menu::AboutMetadata { name: Some("Pulse".into()), version: Some(env!("CARGO_PKG_VERSION").into()), copyright: Some("© 2026 Estate Autopilots".into()), ..Default::default() }))?;
    let pulse = Submenu::with_items(app, "Pulse", true, &[
        &about, &PredefinedMenuItem::separator(app)?,
        &item("settings", "Settings…", Some("Cmd+,"))?, &item("check-updates", "Check for Updates…", None)?,
        &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::services(app, None)?, &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, Some("Hide Pulse"))?, &PredefinedMenuItem::hide_others(app, None)?, &PredefinedMenuItem::show_all(app, None)?,
        &PredefinedMenuItem::separator(app)?, &item("quit", "Quit Pulse", Some("Cmd+Q"))?,
    ])?;
    let edit = Submenu::with_items(app, "Edit", true, &[
        &PredefinedMenuItem::undo(app, None)?, &PredefinedMenuItem::redo(app, None)?, &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::cut(app, None)?, &PredefinedMenuItem::copy(app, None)?, &PredefinedMenuItem::paste(app, None)?, &PredefinedMenuItem::select_all(app, None)?,
    ])?;
    let view = Submenu::with_items(app, "View", true, &[
        &item("reload", "Reload", Some("Cmd+R"))?, &PredefinedMenuItem::separator(app)?,
        &item("zoom-reset", "Actual Size", Some("Cmd+0"))?, &item("zoom-in", "Zoom In", Some("Cmd+="))?, &item("zoom-out", "Zoom Out", Some("Cmd+-"))?,
        &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::fullscreen(app, None)?,
    ])?;
    let go = Submenu::with_items(app, "Go", true, &[
        &item("back", "Back", Some("Cmd+["))?, &item("forward", "Forward", Some("Cmd+]"))?, &PredefinedMenuItem::separator(app)?,
        &item("search", "Search…", Some("Cmd+K"))?, &PredefinedMenuItem::separator(app)?,
        &item("go:/", "Home", Some("Cmd+Shift+H"))?, &item("go:/me", "My desk", Some("Cmd+1"))?, &item("go:/inbox", "Inbox", Some("Cmd+2"))?, &item("go:/chats", "Chats", Some("Cmd+3"))?,
    ])?;
    let window = Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, Some("Zoom"))?, &PredefinedMenuItem::separator(app)?,
        &item("panel", "Quick panel  ⌃⌥P", None)?, &item("main", "Pulse window", None)?,
    ])?;
    let help = Submenu::with_items(app, "Help", true, &[&item("feedback", "Send feedback…", None)?, &item("web", "Open Pulse in the browser", None)?])?;
    Menu::with_items(app, &[&pulse, &edit, &view, &go, &window, &help])
}

/// The tray's menu. PRESENCE-ONBOARD: the day's status line and its one-click actions (Check in, Break, Back,
/// Check out) come first; a click is handed to the panel, which runs it through the same saved queue as its buttons.
fn tray_menu(app: &AppHandle, status: Option<&str>, actions: &[TrayAction]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    if let Some(status) = status.filter(|s| !s.is_empty()) {
        menu.append(&MenuItem::with_id(app, "att:status", status.chars().take(60).collect::<String>(), false, None::<&str>)?)?;
    }
    for action in actions.iter().filter(|a| ATTENDANCE_ACTIONS.contains(&a.id.as_str())).take(4) {
        menu.append(&MenuItem::with_id(app, format!("att:{}", action.id), action.label.chars().take(30).collect::<String>(), true, None::<&str>)?)?;
    }
    if status.is_some() || !actions.is_empty() { menu.append(&PredefinedMenuItem::separator(app)?)?; }
    menu.append(&MenuItem::with_id(app, "main", "Open Pulse", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "panel", "Quick panel", true, Some("CmdOrCtrl+Alt+P"))?)?;
    menu.append(&MenuItem::with_id(app, "web", "Open Pulse in the browser", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "feedback", "Send feedback…", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Pulse", true, None::<&str>)?)?;
    Ok(menu)
}
const ATTENDANCE_ACTIONS: [&str; 4] = ["check-in", "break-start", "break-end", "check-out"];
#[derive(serde::Deserialize)]
struct TrayAction { id: String, label: String }

/// The panel keeps the tray menu in step with the day (status and the actions that make sense now).
#[tauri::command]
fn set_tray_actions(app: AppHandle, status: String, actions: Vec<TrayAction>) {
    let Some(tray) = app.tray_by_id("pulse") else { return };
    if let Ok(menu) = tray_menu(&app, Some(&status), &actions) { let _ = tray.set_menu(Some(menu)); }
}

fn menu_action(app: &AppHandle, id: &str) {
    match id {
        "att:status" => show_panel(app),
        att if att.starts_with("att:") && ATTENDANCE_ACTIONS.contains(&&att[4..]) => { let _ = app.emit_to(PANEL, "pulse:tray-action", json!({ "action": &att[4..] })); }
        "panel" => show_panel(app),
        "main" => appwin::open(app, None),
        "web" => match app.state::<Companion>().base() {
            Some(base) => { let _ = open_url(&format!("{}/me", companion::site(&base))); }
            None => appwin::open(app, None),
        },
        "settings" | "privacy" => show_settings(app, None),
        "check-updates" => { show_settings(app, Some("updates".into())); }
        "feedback" => show_settings(app, Some("feedback".into())),
        "quit" => app.exit(0),
        "back" | "forward" | "reload" | "search" => appwin::command(app, id),
        "zoom-in" => appwin::zoom(app, 1),
        "zoom-out" => appwin::zoom(app, -1),
        "zoom-reset" => appwin::zoom(app, 0),
        go if go.starts_with("go:") => appwin::open(app, Some(go[3..].to_string())),
        _ => {}
    }
}

pub fn run() {
    if acceptance::run() { return; }
    let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyP);
    let register = toggle.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| launched(app, &args)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Updates::default())
        .manage(Gate::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &toggle && event.state() == ShortcutState::Pressed { toggle_panel(app); }
                })
                .build(),
        )
        .manage(Companion::new())
        .manage(SecureStartup::default())
        .manage(pings::Pings::default())
        .manage(appwin::AppWindow::default())
        .manage(appwin::Zoom::default())
        .manage(presence::Presence::default())
        .manage(Mutex::new(Anchor::default()))
        .on_menu_event(|app, event| menu_action(app, event.id().as_ref()))
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                let menu = app_menu(app.handle())?;
                app.set_menu(menu)?;
            }
            let local_data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&local_data_dir)?;
            app.state::<Companion>().open_address(local_data_dir.join("pulse-address.json"));
            // Optional activity metadata: starts paused and stays off unless the person accepts the published notice.
            let core = AgentCore::from_environment(local_data_dir.join("outbox.bin")).map_err(std::io::Error::other)?;
            app.manage(core.clone());

            // The quick panel: small, frameless, above other windows, out of the taskbar.
            let win = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("index.html".into()))
                .title("Pulse")
                .inner_size(PANEL_WIDTH, 460.0)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(true)
                .visible(false)
                .build()?;
            let handle = app.handle().clone();
            win.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    // Windows can report a focus change while the web view first appears; give the panel a moment.
                    let (pinned, settling) = { let a = handle.state::<Mutex<Anchor>>(); let a = a.lock().unwrap(); (a.pinned, a.shown_at.is_some_and(|t| t.elapsed() < Duration::from_millis(1200))) };
                    if !pinned && !settling { hide_panel(&handle); }
                }
                if let WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); hide_panel(&handle); }
            });

            let menu = tray_menu(app.handle(), None, &[])?;
            #[cfg(target_os = "macos")]
            let icon = Image::from_bytes(ICON_TEMPLATE)?;
            #[cfg(not(target_os = "macos"))]
            let icon = Image::from_bytes(ICON_IDLE)?;
            TrayIconBuilder::with_id("pulse")
                .icon(icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("Pulse")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                        let app = tray.app_handle();
                        let scale = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
                        let (p, s) = (rect.position.to_physical::<f64>(scale), rect.size.to_physical::<f64>(scale));
                        app.state::<Mutex<Anchor>>().lock().unwrap().tray = Some((p.x, p.y, s.width, s.height));
                        toggle_panel(app);
                    }
                })
                // Menu clicks (tray and menu bar) go through the app-wide handler on the builder.
                .build(app)?;
            pings::start(app.handle().clone());
            presence::start(app.handle().clone());
            let _ = app.global_shortcut().register(register);
            // --pinned keeps the panel open (screenshots on build runners and demos); --autostart stays in the tray;
            // an update restart and the updater acceptance show the panel as before; any other launch opens the
            // Pulse window (or the pulse:// link it was opened with).
            let args: Vec<String> = std::env::args().collect();
            if args.iter().any(|a| a == "--pinned") { app.state::<Mutex<Anchor>>().lock().unwrap().pinned = true; }
            if let Some(section) = args.iter().find_map(|a| a.strip_prefix("--settings=")) {
                show_settings(app.handle(), Some(section.to_string()));
            } else if args.iter().any(|a| a == "--autostart") {
            } else if args.iter().any(|a| a == "--pinned" || a == "--update-boot" || a == "--updater-acceptance" || a == "--panel") {
                show_panel(app.handle());
            } else {
                launched(app.handle(), &args);
            }
            updater::hosted_acceptance(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            update_check,
            update_prepare,
            update_install,
            update_healthy,
            companion_session,
            companion_request,
            pings::companion_ping_state,
            pings::companion_ping_enable,
            pings::companion_ping_fix,
            companion_pair_start,
            companion_pair_poll,
            companion_pair_cancel,
            companion_about,
            companion_password,
            companion_address_set,
            companion_sign_out,
            open_pulse,
            open_in_browser,
            panel_fit,
            panel_show,
            panel_hide,
            panel_pin,
            set_tray,
            set_tray_actions,
            notify,
            autostart_get,
            autostart_set,
            app_info,
            open_settings,
            open_os_settings,
            open_privacy,
            prefs_changed,
            appwin::open_app,
            appwin::app_window_state,
            appwin::app_window_go,
            presence::presence_status,
            presence::presence_check,
            agent_status,
            tracker_status,
            activity_set,
            tracker_configure,
            tracker_pause,
            tracker_sign_out,
            bridge_info,
            open_workspace
        ])
        .build(tauri::generate_context!())
        .expect("error while building Pulse")
        .run(|app, event| match event {
            // Closing the last window keeps Pulse in the tray.
            tauri::RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
            // Dock icon or a second open from Finder: the Pulse window.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => appwin::open(app, None),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => { for url in urls { deep_link(app, url.as_str()); } }
            _ => { let _ = app; }
        });
}

#[cfg(test)]
mod tests {
    use pulse_desktop_core::AgentCore;
    use std::path::PathBuf;

    #[test]
    fn unconfigured_agent_starts_paused_gate_closed_and_disconnected() {
        let core = AgentCore::from_environment(PathBuf::from("unused-test-outbox.bin")).unwrap();
        let status = core.status();
        assert!(!status.paused);
        assert!(!status.connected);
        assert_eq!(status.queued_events, 0);
    }
}
