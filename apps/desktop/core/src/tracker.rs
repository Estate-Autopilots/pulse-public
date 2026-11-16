use crate::{sensors, AgentCore};
#[cfg(any(windows, target_os = "macos"))]
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use chrono::Timelike;
use rand_core::{OsRng, RngCore};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub api: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(skip_serializing, default)]
    pub session: String,
    #[serde(skip_serializing, default)]
    pub refresh_token: String,
    #[serde(default)]
    pub receipts: BTreeMap<String,String>,
    #[serde(default)]
    pub allow_tools: Vec<String>,
    #[serde(default)]
    pub capture_end: String,
    pub person_id: String,
    #[serde(default)]
    pub person_name: String,
    pub device_id: String,
    pub purposes: Vec<String>,
    pub folders: Vec<String>,
    #[serde(default)]
    pub work_timezone: String,
    #[serde(default)]
    pub start_minutes: u16,
    #[serde(default)]
    pub end_minutes: u16,
    pub work_start: u8,
    pub work_end: u8,
    pub break_tools: Vec<String>,
}
#[derive(Default, Serialize, Deserialize)]
struct Store {
    settings: Settings,
    outbox: VecDeque<Value>,
    today: Vec<Value>,
    seen: BTreeSet<String>,
    pause: bool,
    #[serde(default)]
    sequence: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub configured: bool,
    pub connected: bool,
    pub person_name: String,
    pub paused: bool,
    pub capture_end: String,
    pub queued: usize,
    pub seen: Vec<Value>,
    pub issue: Option<String>,
    pub break_warning: Option<String>,
    pub purposes: Vec<String>,
    pub device_id: String,
    pub folders: Vec<String>,
}
struct Runtime {
    generation: u64,
    boot_id: String,
    store: Store,
    issue: Option<String>,
    connected: bool,
    break_warning: Option<String>,
    files: BTreeMap<PathBuf, (u64, SystemTime, Instant)>,
    projects: BTreeMap<PathBuf, sensors::ProjectSnapshot>,
    processed: BTreeMap<PathBuf, (u64, SystemTime)>,
    seeded: BTreeSet<String>,
    last_policy_check: Instant,
    usage: BTreeMap<(String, bool), u32>,
    last_flush: Instant,
    last_tick: Instant,
}
/// Settings.api value for a tracker that uses the companion's device pairing instead of its own sign-in.
pub const DELEGATED: &str = "pulse-device";
/// Sends one native API call with the companion's device credential (shared single-flight refresh).
pub type Delegate = Arc<dyn Fn(&str, Option<Value>) -> Result<Value, String> + Send + Sync>;
#[derive(Clone)]
pub struct Tracker {
    runtime: Arc<Mutex<Runtime>>,
    path: PathBuf,
    key: [u8; 32],
    client: Client,
    refresh_lock: Arc<Mutex<()>>,
    delegate: Arc<Mutex<Option<Delegate>>>,
}

#[cfg(any(windows,target_os="macos"))]
fn store_credentials(s:&Settings)->Result<(),String>{keyring::Entry::new("com.pulse.work","native-tokens").map_err(|_|"OS secure store unavailable")?.set_password(&json!({"deviceId":s.device_id,"accessToken":s.session,"refreshToken":s.refresh_token}).to_string()).map_err(|_|"OS secure store denied".into())}
#[cfg(not(any(windows,target_os="macos")))]
fn store_credentials(_s:&Settings)->Result<(),String>{Err("Native secure credential storage unavailable on this OS".into())}
fn clear_credentials(){#[cfg(any(windows,target_os="macos"))] if let Ok(e)=keyring::Entry::new("com.pulse.work","native-tokens"){let _=e.delete_credential();}}

fn within_notice(settings:&Settings)->bool{let Ok(zone)=settings.work_timezone.parse::<chrono_tz::Tz>() else{return false;};let now=chrono::Utc::now().with_timezone(&zone);let minute=(now.hour()*60+now.minute()) as u16;if settings.start_minutes<settings.end_minutes{minute>=settings.start_minutes&&minute<settings.end_minutes}else{settings.start_minutes!=settings.end_minutes&&(minute>=settings.start_minutes||minute<settings.end_minutes)}}
fn now() -> String {
    OffsetDateTime::now_utc().format(&Rfc3339).unwrap()
}
#[cfg(any(windows, target_os = "macos"))]
fn key() -> Result<[u8; 32], String> {
    use crate::startup::{restore_choice, Lookup};
    // The store key lives in the entry the current (stably signed) app owns. An older build's key is reused when it
    // can be read silently; otherwise a fresh key starts a fresh local store, and nothing locked is ever prompted for.
    let lookup = |name: &str| -> Lookup<String> {
        match keyring::Entry::new("com.pulse.work", name).map(|e| e.get_password()) {
            Ok(Ok(s)) => Lookup::Found(s),
            Ok(Err(keyring::Error::NoEntry)) => Lookup::Missing,
            _ => Lookup::Unreadable,
        }
    };
    let decode = |s: &str| -> Option<[u8; 32]> { STANDARD.decode(s).ok()?.try_into().ok() };
    // macOS: the current key is kept through Apple's security tool (readable by every Pulse build, see mac_keychain);
    // Windows: Credential Manager, which already survives updates.
    #[cfg(target_os = "macos")]
    let (current, store) = (crate::mac_keychain::read("com.pulse.work", "tracker-key-v3"), |k: &str| crate::mac_keychain::write("com.pulse.work", "tracker-key-v3", k));
    #[cfg(windows)]
    let (current, store) = (lookup("tracker-key-v2"), |k: &str| keyring::Entry::new("com.pulse.work", "tracker-key-v2").and_then(|e| e.set_password(k)).map_err(|_| "Cannot save tracker key".to_string()));
    let (found, migrate, _) = restore_choice(current, || match lookup("tracker-key-v2") { Lookup::Missing => lookup("tracker-key"), other => other });
    if let Some(k) = found.as_deref().and_then(decode) {
        if migrate { let _ = store(&STANDARD.encode(k)); }
        return Ok(k);
    }
    let mut k = [0u8; 32];
    OsRng.fill_bytes(&mut k);
    store(&STANDARD.encode(k)).map_err(|_| "Cannot save tracker key".to_string())?;
    Ok(k)
}
#[cfg(not(any(windows, target_os = "macos")))]
fn key() -> Result<[u8; 32], String> {
    Err("Native tracker supports Windows and Mac".into())
}
impl Tracker {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let key = key()?;
        match Self::with_key(path.clone(), key) {
            // Sealed with a key this build cannot read (an older build's locked key): set it aside, unread and
            // unsent, and start clean. Work activity then stays off until the person turns it on again.
            Err(e) if e == "Cannot unlock tracker state" || e == "Invalid tracker state" => {
                let _ = fs::rename(&path, path.with_extension("sealed"));
                Self::with_key(path, key)
            }
            other => other,
        }
    }
    fn with_key(path: PathBuf, key: [u8; 32]) -> Result<Self, String> {
        let mut store: Store = if path.exists() {
            let b = fs::read(&path).map_err(|_| "Cannot read tracker state")?;
            if b.len() < 12 {
                return Err("Invalid tracker state".into());
            }
            let plain = ChaCha20Poly1305::new((&key).into())
                .decrypt(Nonce::from_slice(&b[..12]), &b[12..])
                .map_err(|_| "Cannot unlock tracker state")?;
            serde_json::from_slice(&plain).map_err(|_| "Invalid tracker state")?
        } else {
            Store::default()
        };
        // OS-backed credentials are never serialized with metadata. A tracker on the companion's pairing has none.
        if store.settings.api == DELEGATED { store.settings.session = DELEGATED.into(); }
        #[cfg(any(windows,target_os="macos"))]
        if store.settings.api != DELEGATED { if let Ok(entry)=keyring::Entry::new("com.pulse.work","native-tokens") {
            if let Ok(value)=entry.get_password(){if let Ok(tokens)=serde_json::from_str::<Value>(&value){
                if tokens["deviceId"]==store.settings.device_id {store.settings.session=tokens["accessToken"].as_str().unwrap_or("").into();store.settings.refresh_token=tokens["refreshToken"].as_str().unwrap_or("").into();}
            }}
        } }
        store.pause=true; // Restart/process gaps require a fresh capture handshake.
        Ok(Self {
            refresh_lock: Arc::new(Mutex::new(())),
            delegate: Arc::new(Mutex::new(None)),
            runtime: Arc::new(Mutex::new(Runtime {
                generation: 0,
                boot_id: uuid::Uuid::new_v4().to_string(),
                store,
                issue: None,
                connected: false,
                break_warning: None,
                files: BTreeMap::new(),
                projects: BTreeMap::new(),
                processed: BTreeMap::new(),
                seeded: BTreeSet::new(),
                last_policy_check: Instant::now() - Duration::from_secs(60),
                usage: BTreeMap::new(),
                last_flush: Instant::now(),
                last_tick: Instant::now(),
            })),
            path,
            key,
            client: Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| "Cannot create uploader")?,
        })
    }
    fn persist(&self, r: &Runtime) -> Result<(), String> {
        let b = serde_json::to_vec(&r.store).map_err(|_| "Cannot encode tracker state")?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let cipher = ChaCha20Poly1305::new((&self.key).into())
            .encrypt(Nonce::from_slice(&nonce), b.as_slice())
            .map_err(|_| "Cannot encrypt tracker state")?;
        let mut out = nonce.to_vec();
        out.extend(cipher);
        let tmp = self.path.with_extension("new");
        fs::write(&tmp, out).map_err(|_| "Cannot save tracker state")?;
        fs::rename(tmp, &self.path).map_err(|_| "Cannot save tracker state".to_string())
    }
    pub fn status(&self, core: &AgentCore) -> Status {
        let r = self.runtime.lock().unwrap();
        Status {
            configured: !r.store.settings.session.is_empty(),
            connected: r.connected,
            person_name: r.store.settings.person_name.clone(),
            paused: r.store.pause || core.status().paused || !within_notice(&r.store.settings) || OffsetDateTime::parse(&r.store.settings.capture_end,&Rfc3339).map(|end|end<=OffsetDateTime::now_utc()).unwrap_or(true),
            capture_end: r.store.settings.capture_end.clone(),
            queued: r.store.outbox.len(),
            seen: r.store.today.clone(),
            issue: r.issue.clone(),
            break_warning: r.break_warning.clone(),
            purposes: r.store.settings.purposes.clone(),
            device_id: r.store.settings.device_id.clone(),
            folders: r.store.settings.folders.clone(),
        }
    }
    pub fn pause(&self, paused: bool) -> Result<(), String> {
        let mut r = self.runtime.lock().unwrap();
        r.generation = r.generation.wrapping_add(1);
        if !paused { return Err("Confirm a new purpose receipt and shift window in connection setup before resuming".into()); }
        r.store.pause = paused;
        if paused { r.store.outbox.clear(); }
        r.seeded.clear();
        r.usage.clear();
        r.files.clear();
        r.projects.clear();
        let settings=r.store.settings.clone();
        self.persist(&r)?;drop(r);
        let _=self.call(&settings,&format!("devices/{}/pause",settings.device_id),Some(json!({"paused":true})));
        Ok(())
    }
    pub fn set_delegate(&self, delegate: Delegate) { *self.delegate.lock().unwrap() = Some(delegate); }
    /// Work activity on (purposes) or off (none) for this computer's existing Pulse pairing: no second sign-in,
    /// no separate device and no tracker credential in the OS store.
    pub fn configure_delegated(&self, device_id: &str, purposes: Vec<String>) -> Result<(), String> {
        if device_id.is_empty() { return Err("Sign in to Pulse on this computer first".into()); }
        let current = self.runtime.lock().unwrap().store.settings.clone();
        let break_tools = if current.api == DELEGATED { current.break_tools } else { vec![] };
        self.configure(Settings { api: DELEGATED.into(), session: DELEGATED.into(), device_id: device_id.into(), purposes, work_start: 9, work_end: 19, break_tools, ..Default::default() })
    }
    pub fn configure(&self, mut s: Settings) -> Result<(), String> {
        let generation = self.runtime.lock().unwrap().generation;
        let delegated = s.api == DELEGATED;
        if delegated {
            s.session = DELEGATED.into();
            s.refresh_token.clear();
        } else {
            let url = url::Url::parse(&s.api).map_err(|_| "Invalid API address")?;
            if url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("Use a secure native API address".into());
            }
            s.api = s.api.trim_end_matches('/').into();
        }
        if s.work_start == s.work_end
            || s.work_end > 24
            || s.folders.len() > 20
            || s.folders.iter().any(|p| !PathBuf::from(p).is_absolute())
            || s.break_tools.iter().any(|t| {
                !matches!(
                    t.as_str(),
                    "premiere"
                        | "photoshop"
                        | "after_effects"
                        | "resolve"
                        | "figma"
                        | "browser"
                        | "office"

                )
            })
        {
            return Err("Check work hours, folders and break tools".into());
        }
        let me = self.call(&s, "me", None)?;
        if me["mustChange"] == true {
            return Err(
                "Change your issued password in Pulse before enrolling this tracker".into(),
            );
        }
        s.person_id = me["person"]
            .as_str()
            .ok_or("Individual sign-in required")?
            .into();
        s.person_name = me["name"].as_str().unwrap_or("Pulse account").into();
        let devices = self.call(&s, "devices", None)?;
        if !devices["devices"].as_array().is_some_and(|d| {
            d.iter()
                .any(|x| x["id"] == s.device_id && x["revokedAt"].is_null())
        }) {
            if delegated { return Err("This computer’s Pulse sign-in was removed. Sign in again, then turn this on.".into()); }
            s.device_id.clear();
        }
        if s.device_id.is_empty() {
            let d=self.call(&s,"devices",Some(json!({"name":"Pulse desktop","platform":if cfg!(windows){"windows"}else{"macos"}})))?;
            s.device_id = d["id"].as_str().ok_or("Device enrollment failed")?.into();
        }
        if let Some(pr)=&s.project_id {let policy=self.call(&s,&format!("delivery?project={pr}"),None)?;if policy["project"]["id"]!=*pr{return Err("Confirm an authorized project locally".into());}}
        if s.purposes.iter().any(|p| {
            !matches!(
                p.as_str(),
                "activity_context" | "work_evidence" | "command_counts"
            )
        }) {
            return Err("Invalid tracking purpose".into());
        }
        if !delegated && s.refresh_token.is_empty(){let issued=self.call(&s,"native/exchange",Some(json!({"deviceId":s.device_id})))?;
            s.session=issued["accessToken"].as_str().ok_or("Device exchange failed")?.into();s.refresh_token=issued["refreshToken"].as_str().ok_or("Refresh credential unavailable")?.into();}
        if !s.purposes.is_empty(){
        let policy=self.call(&s,"devices/policy",None)?;
        let notice=policy["notices"].as_array().and_then(|items|items.first()).ok_or("No EA-approved purpose notice; sensing stays off")?;
        let window=&notice["body"]["workWindow"];
        s.work_timezone=window["timezone"].as_str().ok_or("Approved timezone required")?.into();
        s.work_timezone.parse::<chrono_tz::Tz>().map_err(|_|"Timezone unavailable; no capture")?;
        let minute=|key:&str|->Result<u16,String>{let text=window[key].as_str().ok_or("Work window required")?;let (hour,min)=text.split_once(':').ok_or("Invalid work time")?;let h:u16=hour.parse().map_err(|_|"Invalid hour")?;let m:u16=min.parse().map_err(|_|"Invalid minute")?;if h>23||m>59{return Err("Invalid work window".into());}Ok(h*60+m)};
        s.start_minutes=minute("start")?;s.end_minutes=minute("end")?;
        s.allow_tools=notice["body"]["apps"].as_array().map(|items|items.iter().filter_map(|x|x.as_str().map(String::from)).collect()).unwrap_or_default();
        self.call(&s,&format!("devices/{}/consent",s.device_id),Some(json!({"purposes":s.purposes,"notice":notice["id"]})))?;
        let end=(OffsetDateTime::now_utc()+time::Duration::hours(8)).format(&Rfc3339).unwrap();
        let capture=self.call(&s,&format!("devices/{}/resume",s.device_id),Some(json!({"endsAt":end})))?;
        s.capture_end=capture["endsAt"].as_str().unwrap_or("").into();
        s.receipts=capture["receipts"].as_array().map(|items|items.iter().filter_map(|r|Some((r["purpose"].as_str()?.to_string(),r["id"].as_str()?.to_string()))).collect()).unwrap_or_default();
        } else {self.call(&s,&format!("devices/{}/consent",s.device_id),Some(json!({"purposes":[]})))?;s.receipts.clear();s.capture_end.clear();}
        let mut r = self.runtime.lock().unwrap();
        if r.generation != generation {
            return Err("Connection cancelled. Sign in again when ready.".into());
        }
        if r.store.settings.person_id != s.person_id || r.store.settings.api != s.api {
            if !delegated { clear_credentials(); }
            r.store = Store::default();
        }
        r.store
            .outbox
            .retain(|e| s.purposes.iter().any(|p| e["purpose"] == p.as_str()));
        r.store
            .today
            .retain(|e| s.purposes.iter().any(|p| e["purpose"] == p.as_str()));
        r.generation = r.generation.wrapping_add(1);
        if !delegated { store_credentials(&s)?; }
        r.store.outbox.clear();
        r.store.pause=s.purposes.is_empty();
        r.store.settings = s;
        r.connected = true;
        let health_settings=r.store.settings.clone();
        r.processed.clear();
        r.seeded.clear();
        r.usage.clear();
        r.projects.clear();
        r.files.clear();
        self.persist(&r)?;drop(r);
        let _=self.call(&health_settings,&format!("devices/{}/health",health_settings.device_id),Some(json!({"health":"healthy","appVersion":std::env::var("PULSE_COMPILED_VERSION").unwrap_or_else(|_|"0.0.0".into()),"capabilities":{"focus":"unknown","idle":"unknown","export":"healthy","parser":"unsupported","commands":"unknown"}})));
        Ok(())
    }
    fn call(&self, s: &Settings, path: &str, body: Option<Value>) -> Result<Value, String> {
        if s.api == DELEGATED {
            let delegate = self.delegate.lock().unwrap().clone().ok_or("Sign in to Pulse on this computer first")?;
            return delegate(path, body);
        }
        let request=|settings:&Settings| {
            let mut req=if body.is_some(){self.client.post(format!("{}/{path}",settings.api))}else{self.client.get(format!("{}/{path}",settings.api))};
            req=if settings.refresh_token.is_empty(){req.header("x-pulse-session",&settings.session)}else{req.bearer_auth(&settings.session)};
            if let Some(b)=body.clone(){req=req.json(&b)}
            req.send().map_err(|_|"Offline · readings stay on this computer".to_string())
        };
        let mut response=request(s)?;
        if response.status().as_u16()==401 && !s.refresh_token.is_empty(){
            let _guard=self.refresh_lock.lock().unwrap();
            let mut current=self.runtime.lock().unwrap().store.settings.clone();
            if current.device_id!=s.device_id || current.api!=s.api{return Err("Sign-in changed".into());}
            if current.session==s.session{
                let reply=self.client.post(format!("{}/native/refresh",s.api)).json(&json!({"refreshToken":current.refresh_token})).send().map_err(|_|"Offline refresh")?;
                if !reply.status().is_success(){return Err("Device expired or revoked · sensing stopped".into());}
                let tokens:Value=reply.json().map_err(|_|"Invalid refresh receipt")?;
                current.session=tokens["accessToken"].as_str().ok_or("Access token unavailable")?.into();current.refresh_token=tokens["refreshToken"].as_str().ok_or("Refresh unavailable")?.into();
                let mut r=self.runtime.lock().unwrap();if r.store.settings.device_id!=s.device_id{return Err("Sign-in changed".into());}store_credentials(&current)?;r.store.settings.session=current.session.clone();r.store.settings.refresh_token=current.refresh_token.clone();
            }
            response=request(&current)?;
        }
        let status=response.status();let d:Value=response.json().map_err(|_|"Native API unavailable or requires outer-gate admission")?;
        if !status.is_success(){return Err(d["error"].as_str().unwrap_or("Pulse refused this request").into());}Ok(d)
    }
    pub fn login(&self, api: String, username: String, password: String) -> Result<Value, String> {
        let url = url::Url::parse(&api).map_err(|_| "Invalid API address")?;
        if url.scheme() != "https" {
            return Err("Use HTTPS".into());
        }
        let s = Settings {
            api: api.trim_end_matches('/').into(),
            ..Default::default()
        };
        self.call(
            &s,
            "auth/sign-in",
            Some(json!({"username":username,"password":password})),
        )
    }
    pub fn verify_login(&self, api: String, challenge: String, code: String) -> Result<Value, String> {
        let url = url::Url::parse(&api).map_err(|_| "Invalid API address")?;
        if url.scheme() != "https" { return Err("Use HTTPS".into()); }
        let settings = Settings { api: api.trim_end_matches('/').into(), ..Default::default() };
        self.call(&settings, "auth/two-step", Some(json!({"challenge":challenge,"code":code})))
    }
    pub fn sign_out(&self) -> Result<(), String> {
        let (s, generation) = {
            let mut r = self.runtime.lock().unwrap();
            let settings = r.store.settings.clone();
            r.generation = r.generation.wrapping_add(1);
            if settings.api != DELEGATED { clear_credentials(); }
            r.store = Store::default();
            r.connected = false;
            r.issue = None;
            r.break_warning = None;
            r.usage.clear();
            r.files.clear();
            r.projects.clear();
            r.processed.clear();
            r.seeded.clear();
            self.persist(&r)?;
            (settings, r.generation)
        };
        // Collection and local credentials stop before any network request can fail or wait.
        if s.api == DELEGATED {
            // The device belongs to the companion's sign-in: withdraw consent only.
            if !s.device_id.is_empty() && self.call(&s, &format!("devices/{}/consent", s.device_id), Some(json!({"purposes":[]}))).is_err() {
                let mut current = self.runtime.lock().unwrap();
                if current.generation == generation { current.issue = Some("Work activity is off here. Pulse will confirm when you are back online.".into()); }
            }
            return Ok(());
        }
        if !s.device_id.is_empty()
            && self
                .call(
                    &s,
                    &format!("devices/{}/revoke", s.device_id),
                    Some(json!({})),
                )
                .is_err()
        {
            let mut current = self.runtime.lock().unwrap();
            if current.generation == generation {
                current.issue = Some(
                    "Signed out locally. Revoke this device in Pulse Settings when online.".into(),
                );
            }
        }
        if !s.session.is_empty() {
            let _ = self.call(&s, "auth/sign-out", Some(json!({})));
        }
        Ok(())
    }
    fn enqueue(r: &mut Runtime, kind: &str, purpose: &str, data: Value) -> Result<(), String> {
        if !r.store.settings.purposes.iter().any(|p| p == purpose) {
            return Ok(());
        }
        if r.store.outbox.len() >= 20000 || r.store.outbox.iter().map(|e|e.to_string().len()).sum::<usize>()>=8*1024*1024 {
            return Err("Offline queue full · collection stopped".into());
        }
        let receipt=r.store.settings.receipts.get(purpose).cloned();
        if receipt.is_none(){return Ok(());}let sequence=r.store.sequence;r.store.sequence+=1;
        let at=now();let seconds=if kind=="usage" {data["activeSeconds"].as_i64().unwrap_or(0)+data["idleSeconds"].as_i64().unwrap_or(0)}else{0};
        let start=(OffsetDateTime::now_utc()-time::Duration::seconds(seconds)).format(&Rfc3339).unwrap();
        let e = json!({"consentReceipt":receipt,"sourceSession":r.boot_id,"sequence":sequence,"intervalStart":start,"id":uuid::Uuid::new_v4().to_string(),"personId":r.store.settings.person_id,"deviceId":r.store.settings.device_id,"kind":kind,"purpose":purpose,"at":at,"projectId":r.store.settings.project_id,"data":data});
        r.store.outbox.push_back(e.clone());
        r.store.today.push(e);
        if r.store.today.len() > 2000 {
            r.store.today.remove(0);
        }
        Ok(())
    }
    pub fn tick(&self, core: &AgentCore) -> Result<(), String> {
        let mut r = self.runtime.lock().unwrap();
        let gap=r.last_tick.elapsed().as_secs();
        if gap>10 {r.generation=r.generation.wrapping_add(1);r.usage.clear();r.files.clear();r.projects.clear();r.seeded.clear();r.issue=Some("Sleep or process gap · interval remains unknown".into());}
        let elapsed=if gap>10 {0}else{gap as u32};
        r.last_tick = Instant::now();
        let mut s = r.store.settings.clone();
        if s.session.is_empty() {
            return Ok(());
        }
        if r.last_policy_check.elapsed() >= Duration::from_secs(60) {
            r.last_policy_check = Instant::now();
            drop(r);
            let result = self.call(&s, "devices", None);
            r = self.runtime.lock().unwrap();
            if r.store.settings.person_id != s.person_id
                || r.store.settings.device_id != s.device_id
                || r.store.settings.session != s.session
            {
                return Ok(());
            }
            match result {
                Ok(d) => {
                    r.connected = true;
                    let device = d["devices"].as_array().and_then(|items| {
                        items
                            .iter()
                            .find(|x| x["id"] == s.device_id && x["revokedAt"].is_null())
                    });
                    let granted: Vec<String> = device
                        .and_then(|x| x["purposes"].as_array())
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    r.store.settings.purposes.retain(|p| granted.contains(p));
                    let valid = r.store.settings.purposes.clone();
                    r.store
                        .outbox
                        .retain(|e| valid.iter().any(|p| e["purpose"] == p.as_str()));
                    r.store
                        .today
                        .retain(|e| valid.iter().any(|p| e["purpose"] == p.as_str()));
                    if device.is_none() || device.is_some_and(|d|d["paused"]==true) {
                        r.store.outbox.clear();
                        r.store.pause = true;
                        r.issue = Some("Device revoked · tracking stopped".into());
                    }
                }
                Err(e) => {
                    r.connected = false;
                    if !e.starts_with("Offline") {
                        r.store.pause = true;
                    }
                    r.issue = Some(e);
                }
            }
        }
        s.purposes = r.store.settings.purposes.clone();
        let cutoff = OffsetDateTime::now_utc() - time::Duration::days(7);
        r.store.outbox.retain(|e| {
            e["at"]
                .as_str()
                .and_then(|at| OffsetDateTime::parse(at, &Rfc3339).ok())
                .is_some_and(|at| at >= cutoff)
        });
        let paused = r.store.pause || core.status().paused || OffsetDateTime::parse(&s.capture_end,&Rfc3339).map(|end|end<=OffsetDateTime::now_utc()).unwrap_or(true);
        let focus = sensors::focus();
        r.break_warning = if paused {
            focus
                .as_ref()
                .filter(|(t, _)| s.break_tools.contains(t))
                .map(|(t, _)| format!("Break mode · {t} is on your reminder list"))
        } else {
            None
        };

        let allowed =
            !paused && within_notice(&s) && r.store.outbox.len() < 20000;
        r.store.today.retain(|e| {
            e["at"]
                .as_str()
                .is_some_and(|at| at.starts_with(&now()[..10]))
        });
        if allowed {
            if s.purposes.iter().any(|x| x == "activity_context") {
                if let Some((tool, idle)) = focus.filter(|(tool,_)|s.allow_tools.contains(tool)&&tool!="browser"&&tool!="other") {
                    *r.usage.entry((tool, idle)).or_default() += elapsed;
                }
            }
            if r.last_flush.elapsed() >= Duration::from_secs(60) {
                let usage = std::mem::take(&mut r.usage);
                for ((tool, idle), secs) in usage {
                    Self::enqueue(
                        &mut r,
                        "usage",
                        "activity_context",
                        json!({"tool":tool,"activeSeconds":if idle{0}else{secs},"idleSeconds":if idle{secs}else{0}}),
                    )?;
                }
                r.last_flush = Instant::now();
            }
            if s.purposes.iter().any(|x| x == "work_evidence") {
                for folder in &s.folders {
                    let entries = match fs::read_dir(folder) {
                        Ok(e) => e,
                        Err(_) => {
                            r.issue = Some("An export folder is unavailable".into());
                            continue;
                        }
                    };
                    let initial = !r.seeded.contains(folder);
                    r.seeded.insert(folder.clone());
                    for e in entries.take(1000).flatten() {
                        let path = e.path();
                        if !path.is_file() {
                            continue;
                        }
                        let ext = path
                            .extension()
                            .and_then(|x| x.to_str())
                            .unwrap_or("")
                            .to_lowercase();
                        if !matches!(
                            ext.as_str(),
                            "mp4" | "mov" | "mxf" | "wav" | "png" | "jpg" | "pdf" | "prproj"
                        ) {
                            continue;
                        }
                        if ext=="prproj" {r.issue=Some("Premiere parser capability unavailable: supported host-version pilot required".into());continue;}
                        let meta = match e.metadata() {
                            Ok(m) => m,
                            Err(_) => continue,
                        };
                        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                        let size = meta.len();
                        if r.processed.get(&path) == Some(&(size, modified)) {
                            continue;
                        }
                        if initial && ext != "prproj" {
                            r.processed.insert(path.clone(), (size, modified));
                            continue;
                        }
                        let entry =
                            r.files
                                .entry(path.clone())
                                .or_insert((size, modified, Instant::now()));
                        if entry.0 != size || entry.1 != modified {
                            *entry = (size, modified, Instant::now())
                        }
                        if entry.2.elapsed()
                            < Duration::from_secs(if ext == "prproj" { 60 } else { 30 })
                        {
                            continue;
                        }
                        let generation = r.generation;
                        drop(r);
                        let scanned = sensors::fingerprints_with_gate(&path, || {
                            let current = self.runtime.lock().unwrap();
                            current.generation == generation
                                && !current.store.pause
                                && !core.status().paused
                        });
                        let snapshot = if scanned.is_ok() && ext == "prproj" {
                            Some(sensors::project_snapshot(&path))
                        } else {
                            None
                        };
                        let after = fs::metadata(&path);
                        r = self.runtime.lock().unwrap();
                        if r.generation != generation || r.store.pause || core.status().paused {
                            return Ok(());
                        }
                        let (sha, md, bytes) = match scanned {
                            Ok(value) => value,
                            Err(issue) => {
                                r.issue = Some(issue);
                                continue;
                            }
                        };
                        let after = match after {
                            Ok(value) => value,
                            Err(_) => continue,
                        };
                        if after.len() != size
                            || after.modified().unwrap_or(SystemTime::UNIX_EPOCH) != modified
                        {
                            r.files.remove(&path);
                            continue;
                        }
                        let key = format!("{}:{sha}", s.device_id);
                        r.processed.insert(path.clone(), (size, modified));
                        if ext != "prproj" && r.store.seen.contains(&key) {
                            continue;
                        }
                        if ext == "prproj" {
                            match snapshot.expect("Project snapshot was requested") {
                                Ok(snapshot) => {
                                    let baseline = !r.projects.contains_key(&path);
                                    let empty = sensors::ProjectSnapshot::default();
                                    let (a, b, c) = sensors::delta(
                                        r.projects.get(&path).unwrap_or(&empty),
                                        &snapshot,
                                    );
                                    let zeros = sensors::Counts::default();
                                    Self::enqueue(
                                        &mut r,
                                        "work_delta",
                                        "work_evidence",
                                        json!({"fingerprint":sha,"baseline":baseline,"added":if baseline{&zeros}else{&a},"removed":b,"changed":c}),
                                    )?;
                                    r.projects.insert(path.clone(), snapshot);
                                }
                                Err(e) => {
                                    r.issue = Some(e);
                                    continue;
                                }
                            }
                        } else {
                            let cid: Option<String> = None; // Filenames cannot establish project/person attribution.
                            Self::enqueue(
                                &mut r,
                                "render",
                                "work_evidence",
                                json!({"sha256":sha,"md5":md,"bytes":bytes,"cid":cid}),
                            )?;
                        }
                        r.store.seen.insert(key);
                        if r.store.seen.len() > 20000 {
                            r.store.seen.pop_first();
                        }
                    }
                }
            }
        } else {
            r.seeded.clear();
            r.usage.clear();
            r.projects.clear();
            r.files.clear();
        }
        self.persist(&r)?;
        let event = r.store.outbox.front().cloned();
        drop(r);
        if let Some(e) = event {
            match self.call(&s, "native/batches", Some(json!({"batchId":e["id"],"events":[e.clone()]}))) {
                Ok(ack) => {
                    if !ack["acknowledged"].as_array().is_some_and(|ids|ids.contains(&e["id"])){return Err("No event acknowledgement; queue retained".into());}
                    let mut r = self.runtime.lock().unwrap();
                    if r.store.settings.session != s.session
                        || r.store.settings.device_id != s.device_id
                    {
                        return Ok(());
                    }
                    if r.store.outbox.front() == Some(&e) {
                        r.store.outbox.pop_front();
                    }
                    r.issue = None;
                    r.connected = true;
                    self.persist(&r)?;
                }
                Err(e) => {
                    let mut r = self.runtime.lock().unwrap();
                    if r.store.settings.session != s.session
                        || r.store.settings.device_id != s.device_id
                    {
                        return Ok(());
                    }
                    r.connected = false;
                    r.issue = Some(e);
                }
            }
        }
        Ok(())
    }
    /// Accepts category counts from authenticated Adobe app-event plug-ins, never keys.
    pub fn work_logs(&self) -> Result<Value, String> {
        let (s, generation) = {
            let r = self.runtime.lock().unwrap();
            (r.store.settings.clone(), r.generation)
        };
        let result = self.call(&s, "work-logs", None)?;
        if self.runtime.lock().unwrap().generation != generation {
            return Err("Sign-in changed. Open the current person's logs again.".into());
        }
        Ok(result)
    }
    pub fn save_log(&self, mut body: Value) -> Result<Value, String> {
        let (s, generation) = {
            let r = self.runtime.lock().unwrap();
            (r.store.settings.clone(), r.generation)
        };
        body["deviceId"] = json!(s.device_id);
        let result = self.call(&s, "work-logs", Some(body))?;
        if self.runtime.lock().unwrap().generation != generation {
            return Err("Sign-in changed. Open the current person's logs again.".into());
        }
        Ok(result)
    }
    pub fn bridge_state(&self, core: &AgentCore) -> Value {
        let r = self.runtime.lock().unwrap();

        let s = &r.store.settings;
        json!({"epoch":format!("{}:{}", r.boot_id, r.generation),
            "allowed":!s.session.is_empty() && !r.store.pause && !core.status().paused
                && within_notice(s)
                && s.purposes.iter().any(|p| p == "command_counts")
                && sensors::focus().is_some_and(|(tool, _)| tool == "photoshop")})
    }
    pub fn bridge_token(&self) -> String {
        let r = self.runtime.lock().unwrap();
        self.bridge_token_for(&r.store.settings)
    }
    fn bridge_token_for(&self, settings: &Settings) -> String {
        let mut h = Sha256::new();
        h.update(self.key);
        h.update(b"pulse-adobe-bridge-v2");
        h.update(settings.person_id.as_bytes());
        h.update(b"\0");
        h.update(settings.device_id.as_bytes());
        format!("{:x}", h.finalize())
    }
    pub fn commands(
        &self,
        core: &AgentCore,
        token: &str,
        epoch: &str,
        app: &str,
        counts: BTreeMap<String, u32>,
    ) -> Result<(), String> {
        let mut r = self.runtime.lock().unwrap();
        if token != self.bridge_token_for(&r.store.settings)
            || epoch != format!("{}:{}", r.boot_id, r.generation)
        {
            return Err("Bridge enrollment changed".into());
        }
        if sensors::focus().as_ref().map(|x| x.0.as_str()) != Some(app) {
            return Ok(());
        }
        if r.store.pause || core.status().paused || OffsetDateTime::parse(&r.store.settings.capture_end,&Rfc3339).map(|end|end<=OffsetDateTime::now_utc()).unwrap_or(true) {
            return Ok(());
        }

        if !within_notice(&r.store.settings) {
            return Ok(());
        }
        if !matches!(app, "premiere" | "photoshop" | "after_effects")
            || counts.keys().any(|k| {
                !matches!(
                    k.as_str(),
                    "cut_trim"
                        | "select_move"
                        | "playback_navigate"
                        | "effects_colour"
                        | "audio"
                        | "titles_graphics"
                        | "markers"
                        | "undo_redo"
                        | "export_render"
                        | "other_edit"
                )
            })
            || counts.values().any(|v| *v > 1000000)
        {
            return Err("Only editing command categories are accepted".into());
        }
        let mut out = BTreeMap::new();
        let mut other = 0;
        for (k, n) in counts {
            if n < 5 {
                other += n
            } else {
                out.insert(k, n);
            }
        }
        *out.entry("other_edit".into()).or_default() += other;
        Self::enqueue(
            &mut r,
            "commands",
            "command_counts",
            json!({"app":app,"counts":out}),
        )?;
        self.persist(&r)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_token_changes_with_identity_and_device() {
        let path = std::env::temp_dir().join(format!("pulse-{}.bin", uuid::Uuid::new_v4()));
        let t = Tracker::with_key(path, [7; 32]).unwrap();
        let initial = t.bridge_token();
        t.runtime.lock().unwrap().store.settings.person_id = "person-one".into();
        let person = t.bridge_token();
        assert_ne!(initial, person);
        t.runtime.lock().unwrap().store.settings.device_id = "device-one".into();
        assert_ne!(person, t.bridge_token());
    }
    #[test]
    fn bridge_epoch_invalidates_hourly_counts_after_pause_and_restart() {
        let path = std::env::temp_dir().join(format!("pulse-{}.bin", uuid::Uuid::new_v4()));
        let t = Tracker::with_key(path.clone(), [7; 32]).unwrap();
        let core = AgentCore::from_environment(path.with_extension("core")).unwrap();
        let first = t.bridge_state(&core)["epoch"].as_str().unwrap().to_owned();
        t.pause(true).unwrap();
        assert!(t.pause(false).is_err());
        assert_ne!(first, t.bridge_state(&core)["epoch"]);
        assert!(t
            .commands(
                &core,
                &t.bridge_token(),
                &first,
                "photoshop",
                BTreeMap::new()
            )
            .is_err());
        let restarted = Tracker::with_key(path.clone(), [7; 32]).unwrap();
        assert_ne!(
            t.bridge_state(&core)["epoch"],
            restarted.bridge_state(&core)["epoch"]
        );
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn offline_sign_out_clears_identity_and_collection_before_server_revocation() {
        let path = std::env::temp_dir().join(format!("pulse-{}.bin", uuid::Uuid::new_v4()));
        let t = Tracker::with_key(path.clone(), [7; 32]).unwrap();
        {
            let mut r = t.runtime.lock().unwrap();
            r.store.settings.api = "https://127.0.0.1:9".into();
            r.store.settings.person_id = "person-one".into();
            r.store.settings.device_id = "device-one".into();
            r.store.settings.session = "private-token".into();
            r.store.settings.purposes = vec!["work_evidence".into()];
            r.store.settings.receipts.insert("work_evidence".into(),"synthetic-receipt".into());
            Tracker::enqueue(&mut r, "render", "work_evidence", json!({})).unwrap();
        }
        t.sign_out().unwrap();
        let r = t.runtime.lock().unwrap();
        assert!(r.store.settings.session.is_empty());
        assert!(r.store.outbox.is_empty());
        assert!(r.issue.as_ref().unwrap().starts_with("Signed out locally"));
        drop(r);
        assert!(Tracker::with_key(path.clone(), [7; 32])
            .unwrap()
            .runtime
            .lock()
            .unwrap()
            .store
            .settings
            .session
            .is_empty());
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn changing_the_server_clears_the_session_and_the_queue() {
        let path = std::env::temp_dir().join(format!("pulse-{}.bin", uuid::Uuid::new_v4()));
        let t = Tracker::with_key(path.clone(), [7; 32]).unwrap();
        {
            let mut r = t.runtime.lock().unwrap();
            r.store.settings.purposes = vec!["work_evidence".into()];
            r.store.settings.receipts.insert("work_evidence".into(), "synthetic-receipt".into());
            Tracker::enqueue(&mut r, "render", "work_evidence", json!({})).unwrap();
        }
        let (old, new) = ("https://old.example.com/api/native/v0", "https://new.example.com/api/native/v0");
        let address = crate::server::SavedAddress::default();
        address.open(path.with_extension("address"));
        address.set(old).unwrap();
        let session = crate::startup::DeferredCredentials::<String>::default();
        session.finish_restore(Some(old.into()));
        let signed_in = session.lock().unwrap().clone();
        let changed = address.switch(new, signed_in.as_deref(), || { t.sign_out().unwrap(); session.lock().unwrap().take(); }).unwrap();
        assert!(changed);
        assert!(session.lock().unwrap().is_none(), "the old server's sign-in is gone");
        assert!(t.runtime.lock().unwrap().store.outbox.is_empty(), "the old server's queued work is dropped");
        assert_eq!(address.get().as_deref(), Some(new));
        fs::remove_file(path.with_extension("address")).unwrap();
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn encrypted_queue_survives_restart_and_pause() {
        let path = std::env::temp_dir().join(format!("pulse-{}.bin", uuid::Uuid::new_v4()));
        let key = [7; 32];
        let t = Tracker::with_key(path.clone(), key).unwrap();
        {
            let mut r = t.runtime.lock().unwrap();
            r.store.settings.purposes = vec!["work_evidence".into()];
            r.store.settings.receipts.insert("work_evidence".into(),"synthetic-receipt".into());
            r.store.settings.session = "private-token".into();
            Tracker::enqueue(
                &mut r,
                "render",
                "work_evidence",
                json!({"sha256":"fingerprint"}),
            )
            .unwrap();
            t.persist(&r).unwrap();
        }
        assert!(!String::from_utf8_lossy(&fs::read(&path).unwrap()).contains("private-token"));
        let t2 = Tracker::with_key(path.clone(), key).unwrap();
        assert_eq!(t2.runtime.lock().unwrap().store.outbox.len(), 1);
        t2.pause(true).unwrap();
        assert!(
            Tracker::with_key(path.clone(), key)
                .unwrap()
                .runtime
                .lock()
                .unwrap()
                .store
                .pause
        );
        assert_eq!(t2.runtime.lock().unwrap().store.outbox.len(),0);
        assert!(Tracker::with_key(path.clone(), [8; 32]).is_err());
        fs::remove_file(path).unwrap();
    }
}
