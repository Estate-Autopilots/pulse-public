//! The Pulse app window: the whole Pulse web app (production by default) in a native window, signed in with this
//! computer's device pairing. The device credential is exchanged for a Pulse web session cookie that Rust sets
//! directly in the window's cookie store, so no token ever appears in a URL, in page JavaScript or in history.
//! Remote Pulse pages get no native commands (no remote capability exists); only bundled pages talk to Rust.
use crate::companion::{self, Companion};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    webview::{Cookie, DownloadEvent, NewWindowResponse},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

pub const MAIN: &str = "main";
const COOKIE: &str = "pulse_session";
/// A second automatic sign-in inside this window is not attempted sooner than this, so signing out of Pulse in the
/// window (which lands on /login) is respected instead of silently signing back in.
const EXCHANGE_PAUSE: Duration = Duration::from_secs(600);

#[derive(Default)]
pub struct AppWindow {
    exchanging: AtomicBool,
    last_exchange: Mutex<Option<(String, Instant)>>,
    cookie_device: Mutex<Option<String>>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Geometry { pub x: i32, pub y: i32, pub width: u32, pub height: u32, #[serde(default)] pub maximized: bool }

pub use pulse_desktop_core::navigation::{parse_link, safe_path, Link};

/// A saved window rectangle is used only if it is still mostly on a connected screen.
pub fn usable(g: &Geometry, screens: &[(i32, i32, u32, u32)]) -> bool {
    if g.width < 600 || g.height < 400 || g.width > 20000 || g.height > 20000 { return false; }
    screens.iter().any(|&(x, y, w, h)| {
        let left = g.x.max(x); let top = g.y.max(y);
        let right = (g.x + g.width as i32).min(x + w as i32); let bottom = (g.y + g.height as i32).min(y + h as i32);
        right - left >= 200 && bottom - top >= 120
    })
}

fn geometry_file(app: &AppHandle) -> Option<PathBuf> { app.path().app_config_dir().ok().map(|d| d.join("app-window.json")) }
fn load_geometry(app: &AppHandle) -> Option<Geometry> {
    let g: Geometry = serde_json::from_slice(&std::fs::read(geometry_file(app)?).ok()?).ok()?;
    let screens: Vec<_> = app.available_monitors().ok()?.iter().map(|m| { let a = m.work_area(); (a.position.x, a.position.y, a.size.width, a.size.height) }).collect();
    usable(&g, &screens).then_some(g)
}
fn save_geometry(win: &WebviewWindow) {
    let app = win.app_handle();
    let Some(path) = geometry_file(app) else { return };
    if win.is_minimized().unwrap_or(false) || !win.is_visible().unwrap_or(false) { return; }
    let maximized = win.is_maximized().unwrap_or(false);
    let previous: Option<Geometry> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let g = if maximized {
        // Keep the last normal rectangle so un-maximizing after a restart returns to it.
        match previous { Some(p) => Geometry { maximized: true, ..p }, None => return }
    } else {
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) else { return };
        Geometry { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: false }
    };
    if previous == Some(g) { return; }
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    let _ = std::fs::write(path, serde_json::to_vec(&g).unwrap_or_default());
}

/// The Pulse site of this computer's server; none until the person enters their Pulse address.
fn site(app: &AppHandle) -> Option<url::Url> {
    app.state::<Companion>().base().and_then(|base| url::Url::parse(&companion::site(&base)).ok())
}
fn is_local(url: &url::Url) -> bool {
    url.scheme() == "tauri" || matches!(url.host_str(), Some("tauri.localhost")) || matches!(url.scheme(), "about" | "data" | "blob")
}
fn same_site(url: &url::Url, site: &url::Url) -> bool { url.origin() == site.origin() }

/// The script every page in the window gets: app classes for small layout touches and the keyboard paths that
/// work without native access (search, settings). It never reads or sends page data.
const INIT: &str = r#"(()=>{if(window.__pulseApp)return;const mac=/Mac/.test(navigator.platform);
const tag=()=>document.documentElement.classList.add('pulse-desktop-app',mac?'pulse-app-mac':'pulse-app-windows');
if(document.documentElement)tag();else document.addEventListener('DOMContentLoaded',tag);
const focusSearch=()=>{const f=document.querySelector('input[type=search],[role=search] input,input[name=q],input[placeholder*="Search" i],input[aria-label*="Search" i]');if(!f)return false;f.focus();f.select?.();return true;};
const search=()=>{if(focusSearch())return;if(!/^(tauri|about|data|blob):$/.test(location.protocol)&&location.hostname!=='tauri.localhost')location.href='/people#pulse-search';};
const focusLanding=()=>{if(location.hash!=='#pulse-search'||focusSearch())return;const observer=new MutationObserver(()=>{if(focusSearch())observer.disconnect();});observer.observe(document.documentElement,{childList:true,subtree:true});setTimeout(()=>observer.disconnect(),10000);};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',focusLanding,{once:true});else focusLanding();
window.__pulseApp=Object.freeze({search,back:()=>history.back(),forward:()=>history.forward()});
addEventListener('keydown',e=>{const mod=mac?e.metaKey:e.ctrlKey;if(!mod||e.altKey)return;const k=e.key.toLowerCase();
 if(k==='k'){e.preventDefault();search();}else if(k===','){e.preventDefault();location.href='pulse://settings';}
 else if(!mac&&k==='['){e.preventDefault();history.back();}else if(!mac&&k===']'){e.preventDefault();history.forward();}},true);})();"#;

pub fn window(app: &AppHandle) -> Option<WebviewWindow> { app.get_webview_window(MAIN) }

/// Opens (or focuses) the app window, optionally at a Pulse path.
pub fn open(app: &AppHandle, path: Option<String>) {
    let path = path.and_then(|p| safe_path(&p));
    if let Some(win) = window(app) {
        reveal(app, &win);
        if let Some(path) = path { go(app, path); }
        return;
    }
    let handle = app.clone();
    let nav_handle = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("app.html".into()))
        .title("Pulse")
        .inner_size(1280.0, 820.0)
        .min_inner_size(880.0, 600.0)
        .visible(false)
        .initialization_script(INIT)
        .on_navigation(move |url| navigation(&nav_handle, url))
        .on_new_window({ let app = app.clone(); move |url, _features| { new_window(&app, &url); NewWindowResponse::Deny } })
        .on_download({ let app = app.clone(); move |_webview, event| download(&app, event) });
    #[cfg(target_os = "macos")]
    { builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent).hidden_title(true); }
    #[cfg(windows)]
    { builder = builder.effects(tauri::utils::config::WindowEffectsConfig { effects: vec![tauri::window::Effect::Mica], ..Default::default() }); }
    let saved = load_geometry(app);
    if saved.is_none() {
        // First open: 1280×820, or 90% of a smaller screen, centred, so the title bar is always on screen.
        let (w, h) = app.primary_monitor().ok().flatten().map(|m| { let a = m.work_area(); let s = m.scale_factor(); (a.size.width as f64 / s, a.size.height as f64 / s) }).unwrap_or((1440.0, 900.0));
        builder = builder.inner_size((w * 0.9).min(1280.0).max(880.0), (h * 0.9).min(820.0).max(600.0)).center();
    }
    let Ok(win) = builder.build() else { return };
    if let Some(g) = saved {
        let _ = win.set_size(PhysicalSize::new(g.width, g.height));
        let _ = win.set_position(PhysicalPosition::new(g.x, g.y));
        if g.maximized { let _ = win.maximize(); }
    }
    paint(&win);
    let events = win.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => save_geometry(&events),
        WindowEvent::ThemeChanged(_) => paint(&events),
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            save_geometry(&events);
            let _ = events.hide();
            #[cfg(target_os = "macos")]
            { let _ = events.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory); }
        }
        _ => {}
    });
    reveal(app, &win);
    go(&handle, path.unwrap_or_else(|| "/".into()));
}

fn reveal(app: &AppHandle, win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    { let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular); }
    let _ = app;
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
}

/// Window background behind the page and, on macOS, the transparent title bar: the Pulse canvas colour.
fn paint(win: &WebviewWindow) {
    let dark = matches!(win.theme(), Ok(tauri::Theme::Dark));
    let _ = win.set_background_color(Some(if dark { tauri::window::Color(17, 17, 24, 255) } else { tauri::window::Color(246, 246, 250, 255) }));
}

/// Show a state on the bundled app.html (signed out, restoring, offline).
fn local(app: &AppHandle, state: &str, message: Option<&str>) {
    let Some(win) = window(app) else { return };
    let on_local = win.url().map(|u| is_local(&u)).unwrap_or(false);
    if !on_local {
        let state = state.to_string();
        let target = format!("app.html#{state}");
        let _ = win.navigate(tauri::Url::parse(&format!("{}{}", local_origin(), target)).unwrap_or_else(|_| tauri::Url::parse("tauri://localhost/app.html").unwrap()));
    }
    let _ = app.emit_to(MAIN, "pulse:app-state", json!({"state": state, "message": message}));
}
fn local_origin() -> &'static str { if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" } }

/// Navigate to a Pulse page, signing the window in first when this computer is paired.
pub fn go(app: &AppHandle, path: String) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let companion = app.state::<Companion>();
        for _ in 0..600 {
            if !companion.session()["restoring"].as_bool().unwrap_or(false) { break; }
            local(&app, "restoring", None);
            std::thread::sleep(Duration::from_millis(500));
        }
        let session = companion.session();
        let Some(site) = site(&app).filter(|_| session["signedIn"].as_bool().unwrap_or(false)) else { local(&app, "signed-out", None); return; };
        if !reachable(&site) { local(&app, "offline", None); return; }
        let Some(win) = window(&app) else { return };
        // Browser cookies can outlive the pairing. Establish ownership on this start rather than
        // treating any old web cookie as the current computer's sign-in.
        let owns_cookie = paired_with(&session, app.state::<AppWindow>().cookie_device.lock().unwrap().as_deref().unwrap_or(""), &site);
        let has_cookie = owns_cookie && win.cookies_for_url(site.clone()).map(|c| c.iter().any(|c| c.name() == COOKIE && !c.value().is_empty())).unwrap_or(false);
        if !has_cookie {
            if let Err(message) = exchange(&app, &win, &site) { local(&app, "error", Some(&message)); return; }
        }
        if !paired_with(&companion.session(), session["deviceId"].as_str().unwrap_or(""), &site) {
            local(&app, "error", Some("Your sign-in changed. Open Pulse again.")); return;
        }
        if let Ok(target) = site.join(&path) { let _ = win.navigate(target); }
    });
}

fn reachable(site: &url::Url) -> bool {
    let Ok(health) = site.join("/healthz") else { return false };
    reqwest::blocking::Client::builder().timeout(Duration::from_secs(8)).build()
        .and_then(|c| c.get(health).send()).map(|r| r.status().as_u16() < 500).unwrap_or(false)
}

/// Device credential → a 30-day Pulse web session for this window only (revoked with the device).
fn paired_with(session: &Value, device: &str, site: &url::Url) -> bool {
    !device.is_empty() && session["signedIn"].as_bool() == Some(true)
        && session["deviceId"].as_str() == Some(device)
        && session["site"].as_str() == Some(site.origin().ascii_serialization().as_str())
}
fn exchange(app: &AppHandle, win: &WebviewWindow, site: &url::Url) -> Result<(), String> {
    let state = app.state::<AppWindow>();
    if state.exchanging.swap(true, Ordering::SeqCst) { return Err("Signing in…".into()); }
    let result = (|| {
        let companion = app.state::<Companion>();
        let session = companion.session();
        let device = session["deviceId"].as_str().ok_or("Sign in to open Pulse.")?;
        let changed = "Your sign-in changed. Open Pulse again.";
        if !paired_with(&session, device, site) { return Err(changed.to_string()); }
        let issued = companion.request_for_device(device, "native/web-session", Some(json!({}))).map_err(|e| {
            if e.signed_out { "This computer was signed out of Pulse. Sign in again.".to_string() } else if e.offline { "You’re offline.".to_string() } else { e.message.clone() }
        })?;
        if !paired_with(&companion.session(), device, site) { return Err(changed.to_string()); }
        let token = issued["token"].as_str().filter(|t| t.len() == 43 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).ok_or("Pulse could not open your workspace here. Try again.")?;
        let max_age = issued["maxAge"].as_i64().unwrap_or(2_592_000).clamp(3600, 2_592_000);
        let host = site.host_str().ok_or("Pulse address is invalid")?.to_string();
        let cookie = Cookie::build((COOKIE, token.to_string())).domain(host).path("/").secure(site.scheme() == "https").http_only(true)
            .same_site(tauri::webview::cookie::SameSite::Lax).max_age(tauri::webview::cookie::time::Duration::seconds(max_age)).build();
        win.set_cookie(cookie.clone()).map_err(|_| "This window could not keep your Pulse sign-in.".to_string())?;
        // Sign-out may clear cookies between the pre-write check and this OS call. No other
        // exchange can write a new pairing's cookie while exchanging is true, so remove ours.
        if !paired_with(&companion.session(), device, site) {
            let _ = win.delete_cookie(cookie);
            return Err(changed.to_string());
        }
        *state.cookie_device.lock().unwrap() = Some(device.to_string());
        *state.last_exchange.lock().unwrap() = Some((device.to_string(), Instant::now()));
        Ok(())
    })();
    state.exchanging.store(false, Ordering::SeqCst);
    result
}

fn navigation(app: &AppHandle, url: &url::Url) -> bool {
    if is_local(url) { return true; }
    if url.scheme() == "pulse" { crate::deep_link(app, url.as_str()); return false; }
    if site(app).is_some_and(|origin| same_site(url, &origin)) {
        // Landing on /login while this computer is paired: sign the window in again (expired or revoked cookie),
        // unless that just happened, which means the person chose to sign out of the window.
        let session = app.state::<Companion>().session();
        if url.path() == "/login" && session["signedIn"].as_bool().unwrap_or(false) {
            let recent = app.state::<AppWindow>().last_exchange.lock().unwrap().as_ref()
                .is_some_and(|(device, time)| session["deviceId"].as_str() == Some(device.as_str()) && time.elapsed() < EXCHANGE_PAUSE);
            if !recent {
                let next = url.query_pairs().find(|(k, _)| k == "next").and_then(|(_, v)| safe_path(&v)).unwrap_or_else(|| "/".into());
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let (Some(win), Some(site)) = (window(&app), site(&app)) else { return };
                    match exchange(&app, &win, &site) {
                        Ok(()) => { if let Ok(target) = site.join(&next) { let _ = win.navigate(target); } }
                        Err(_) => { if let Ok(login) = site.join("/login?app=1") { let _ = win.navigate(login); } }
                    }
                });
                return false;
            }
        }
        return true;
    }
    if matches!(url.scheme(), "https" | "http" | "mailto" | "tel") { let _ = crate::open_url(url.as_str()); }
    false
}

/// Links that ask for a new window: Pulse pages stay in this window, everything else opens in the browser.
fn new_window(app: &AppHandle, url: &url::Url) {
    if site(app).is_some_and(|site| same_site(url, &site)) {
        if let Some(win) = window(app) { let _ = win.navigate(url.clone()); }
    } else if matches!(url.scheme(), "https" | "http" | "mailto") { let _ = crate::open_url(url.as_str()); }
}

/// Files from Pulse (chat attachments, exports) go to Downloads without overwriting anything.
fn download(app: &AppHandle, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let Ok(dir) = app.path().download_dir() else { return true };
            let name = destination.file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| !n.is_empty())
                .or_else(|| url.path_segments().and_then(|mut s| s.next_back().map(str::to_string))).unwrap_or_else(|| "Pulse download".into());
            let name: String = name.chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).take(120).collect();
            let mut target = dir.join(&name);
            let (stem, ext) = match name.rsplit_once('.') { Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")), _ => (name.clone(), String::new()) };
            let mut n = 1;
            while target.exists() && n < 1000 { target = dir.join(format!("{stem} ({n}){ext}")); n += 1; }
            *destination = target;
            true
        }
        DownloadEvent::Finished { success, path, .. } => {
            if success {
                let what = path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Your file".into());
                let _ = crate::notify_now(app, "Download finished", &format!("{what} is in your Downloads folder."));
            }
            true
        }
        _ => true,
    }
}

/// After signing this computer out: the window forgets its web session and shows the sign-in screen.
pub fn signed_out(app: &AppHandle) {
    *app.state::<AppWindow>().cookie_device.lock().unwrap() = None;
    let Some(win) = window(app) else { return };
    if let Some(Ok(cookies)) = site(app).map(|site| win.cookies_for_url(site)) {
        for c in cookies.into_iter().filter(|c| c.name() == COOKIE) { let _ = win.delete_cookie(c); }
    }
    *app.state::<AppWindow>().last_exchange.lock().unwrap() = None;
    local(app, "signed-out", None);
}

/// Back, forward, reload, zoom and search for the menus (remote pages need no native access for these).
pub fn command(app: &AppHandle, what: &str) {
    if what == "search" && window(app).is_none() { open(app, Some("/people#pulse-search".into())); return; }
    let Some(win) = window(app) else { return };
    if what == "search" { reveal(app, &win); }
    let script = match what {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "search" => "window.__pulseApp?.search()",
        _ => return,
    };
    let _ = win.eval(script);
}
pub fn zoom(app: &AppHandle, step: i32) {
    let Some(win) = window(app) else { return };
    let state = app.state::<Zoom>();
    let mut level = state.0.lock().unwrap();
    *level = if step == 0 { 1.0 } else { (*level + step as f64 * 0.1).clamp(0.5, 2.0) };
    let _ = win.set_zoom(*level);
}
pub struct Zoom(pub Mutex<f64>);
impl Default for Zoom { fn default() -> Self { Self(Mutex::new(1.0)) } }

/// The dock (macOS) or taskbar (Windows) unread badge on the app window.
pub fn badge(app: &AppHandle, unread: u64) {
    let Some(win) = window(app) else { return };
    #[cfg(target_os = "macos")]
    { let _ = win.set_badge_count(if unread > 0 { Some(unread.min(999) as i64) } else { None }); }
    #[cfg(windows)]
    { let _ = win.set_overlay_icon(if unread > 0 { Some(crate::pings::overlay_icon(unread)) } else { None }); }
    #[cfg(not(any(windows, target_os = "macos")))]
    { let _ = (win, unread); }
}

/// The local page asks what to show; it can retry after being offline or after signing in.
#[tauri::command]
pub fn app_window_state(app: AppHandle) -> Value {
    let session = app.state::<Companion>().session();
    json!({"signedIn": session["signedIn"], "restoring": session["restoring"], "site": session["site"], "personName": session["personName"]})
}
#[tauri::command]
pub fn app_window_go(app: AppHandle, path: Option<String>) { go(&app, path.and_then(|p| safe_path(&p)).unwrap_or_else(|| "/".into())); }
#[tauri::command]
pub fn open_app(app: AppHandle, path: Option<String>) { open(&app, path); }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_window_session_belongs_to_the_pairing_and_origin_that_requested_it() {
        let site = url::Url::parse("https://pulse.example").unwrap();
        let session = json!({"signedIn":true,"deviceId":"device-a","site":"https://pulse.example"});
        assert!(paired_with(&session, "device-a", &site));
        assert!(!paired_with(&session, "device-b", &site));
        assert!(!paired_with(&session, "", &site));
        assert!(!paired_with(&json!({"signedIn":false}), "device-a", &site));
        assert!(!paired_with(&session, "device-a", &url::Url::parse("https://other.example").unwrap()));
    }
    #[test]
    fn only_plain_pulse_paths_open() {
        assert_eq!(safe_path("/chats?channel=11111111-1111-4111-8111-111111111111").as_deref(), Some("/chats?channel=11111111-1111-4111-8111-111111111111"));
        assert!(safe_path("//evil.example/x").is_none());
        assert!(safe_path("https://evil.example").is_none());
        assert!(safe_path("/me<script>").is_none());
        assert!(safe_path("/me%3Cscript%3E").is_none());
        assert!(safe_path("/%2Fevil.example").is_none());
        assert!(safe_path("/me%5Cbad").is_none());
        assert!(safe_path("/me%0Abad").is_none());
        assert_eq!(safe_path("/me?section=Your%20month").as_deref(), Some("/me?section=Your%20month"));
        assert!(safe_path("me").is_none());
    }
    #[test]
    fn pulse_links_map_to_pages_settings_and_panel() {
        assert_eq!(parse_link("pulse://chats?channel=abc"), Some(Link::Page("/chats?channel=abc".into())));
        assert_eq!(parse_link("pulse://open/me/requests"), Some(Link::Page("/me/requests".into())));
        assert_eq!(parse_link("pulse://settings/notifications"), Some(Link::Settings(Some("notifications".into()))));
        assert_eq!(parse_link("pulse://settings"), Some(Link::Settings(None)));
        assert_eq!(parse_link("pulse://panel"), Some(Link::Panel));
        assert_eq!(parse_link("pulse://"), Some(Link::Page("/".into())));
        assert_eq!(parse_link("https://pulse.example/chats"), None);
        assert_eq!(parse_link("pulse://chats/<x>"), None);
        assert_eq!(parse_link("pulse://chats/%3Cx%3E"), None);
    }
    #[test]
    fn saved_rectangles_must_be_on_a_screen() {
        let screens = [(0, 0, 1920, 1040)];
        assert!(usable(&Geometry { x: 100, y: 80, width: 1280, height: 820, maximized: false }, &screens));
        assert!(!usable(&Geometry { x: 5000, y: 80, width: 1280, height: 820, maximized: false }, &screens));
        assert!(!usable(&Geometry { x: 0, y: 0, width: 200, height: 100, maximized: false }, &screens));
    }
}
