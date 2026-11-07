pub mod update_signature;
pub mod update_recovery;
pub mod bridge;
pub mod release;
pub mod sensors;
pub mod tracker;
pub mod startup;
pub mod wifi;
pub mod mac_keychain;
pub mod navigation;
pub mod server;
pub mod pairing;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    XChaCha20Poly1305, XNonce,
};
use ed25519_dalek::{Signer, SigningKey};
use rand_core::RngCore;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use time::{format_description::well_known::Rfc3339, Duration as TimeDuration, OffsetDateTime};
use ulid::Ulid;
use url::Url;
use uuid::Uuid;

const RETENTION: TimeDuration = TimeDuration::days(7);
const MAX_QUEUE_EVENTS: usize = 10_000;
const MAX_BATCH_EVENTS: usize = 100;
const MAX_RETRY: Duration = Duration::from_secs(5 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const OUTBOX_NONCE_BYTES: usize = 24;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EnqueueResult {
    Queued,
    Suppressed(PauseReason),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PauseReason {
    Paused,
    NoticeNotAcknowledged,
    AfterHoursNotConsented,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub paused: bool,
    pub pause_label: Option<String>,
    pub pause_expires_in_seconds: Option<u64>,
    pub connected: bool,
    pub queued_events: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CategoryTotals {
    pub editing: u32,
    pub design: u32,
    pub audio: u32,
    pub ai_tools: u32,
    pub communication: u32,
    pub browser: u32,
    pub office_docs: u32,
    pub other: u32,
}

impl CategoryTotals {
    fn sum(&self) -> u64 {
        u64::from(self.editing)
            + u64::from(self.design)
            + u64::from(self.audio)
            + u64::from(self.ai_tools)
            + u64::from(self.communication)
            + u64::from(self.browser)
            + u64::from(self.office_docs)
            + u64::from(self.other)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UsageHour {
    pub hour_start: String,
    pub active_s: u32,
    pub idle_s: u32,
    pub categories: CategoryTotals,
    pub after_hours: bool,
}

impl UsageHour {
    fn validate(&self) -> Result<(), String> {
        let start = OffsetDateTime::parse(&self.hour_start, &Rfc3339)
            .map_err(|_| "hour_start must be RFC3339")?;
        if start.minute() != 0 || start.second() != 0 || start.nanosecond() != 0 {
            return Err("hour_start must begin on an hour boundary".into());
        }
        if self.active_s > 3600
            || self.idle_s > 3600
            || self.active_s + self.idle_s > 3600
            || self.categories.sum() > u64::from(self.active_s)
        {
            return Err("hour totals are outside the allowed range".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UsageEvent {
    specversion: String,
    id: String,
    source: String,
    #[serde(rename = "type")]
    event_type: String,
    time: String,
    subject: String,
    orgid: String,
    actor: String,
    actorkind: String,
    purpose: String,
    consentref: String,
    sensitivity: u8,
    visibility: String,
    collectorver: String,
    data: UsageHour,
}

#[derive(Clone)]
struct EventIdentity {
    org_id: Uuid,
    device_id: Uuid,
}

impl UsageEvent {
    fn new(identity: &EventIdentity, data: UsageHour) -> Result<Self, String> {
        data.validate()?;
        let device = identity.device_id;
        let now = OffsetDateTime::now_utc();
        Ok(Self {
            specversion: "1.0".into(),
            id: Ulid::new().to_string(),
            source: format!("/agent/{device}"),
            event_type: "agent.usage.hourly".into(),
            time: now
                .format(&Rfc3339)
                .map_err(|_| "could not format event time")?,
            subject: format!("device:pulse:{device}"),
            orgid: identity.org_id.to_string(),
            actor: format!("device:pulse:{device}"),
            actorkind: "device".into(),
            purpose: "activity_context".into(),
            consentref: "notice:2026-11-staff-v2".into(),
            sensitivity: 1,
            visibility: "person".into(),
            collectorver: "0.1.0".into(),
            data,
        })
    }
}

#[derive(Clone)]
struct IngestClient {
    endpoint: Url,
    health_endpoint: Url,
    identity: EventIdentity,
    signing_key: SigningKey,
    access_client_id: Option<String>,
    access_client_secret: Option<String>,
    client: Client,
}

impl IngestClient {
    fn new(
        endpoint: Url,
        identity: EventIdentity,
        signing_key: SigningKey,
        access_client_id: Option<String>,
        access_client_secret: Option<String>,
    ) -> Result<Self, String> {
        let health_endpoint = endpoint
            .join("/healthz")
            .map_err(|_| "invalid health endpoint")?;
        if access_client_id.is_some() != access_client_secret.is_some() {
            return Err("both Cloudflare Access credentials are required".into());
        }
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| "could not initialize the ingest client")?;
        Ok(Self {
            endpoint,
            health_endpoint,
            identity,
            signing_key,
            access_client_id,
            access_client_secret,
            client,
        })
    }

    fn add_access_headers(
        &self,
        request: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        match (&self.access_client_id, &self.access_client_secret) {
            (Some(id), Some(secret)) => request
                .header("CF-Access-Client-Id", id)
                .header("CF-Access-Client-Secret", secret),
            _ => request,
        }
    }

    fn healthy(&self) -> bool {
        self.add_access_headers(self.client.get(self.health_endpoint.clone()))
            .send()
            .is_ok_and(|response| response.status().is_success())
    }

    fn upload_request(&self, events: &[UsageEvent]) -> Result<reqwest::blocking::Request, String> {
        let body = serde_json::to_vec(events).map_err(|_| "could not encode the event batch")?;
        let timestamp = OffsetDateTime::now_utc().unix_timestamp().to_string();
        let mut nonce = [0_u8; 16];
        OsRng.fill_bytes(&mut nonce);
        let nonce = URL_SAFE_NO_PAD.encode(nonce);
        let digest = Sha256::digest(&body);
        let digest_hex = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let signed = format!(
            "{}\n{}\n{}\n{}",
            self.identity.device_id, timestamp, nonce, digest_hex
        );
        let signature = STANDARD.encode(self.signing_key.sign(signed.as_bytes()).to_bytes());
        let request = self
            .client
            .post(self.endpoint.clone())
            .header("Content-Type", "application/json")
            .header("X-Pulse-Device", self.identity.device_id.to_string())
            .header("X-Pulse-Timestamp", timestamp)
            .header("X-Pulse-Nonce", nonce)
            .header("X-Pulse-Signature", signature)
            .body(body);
        self.add_access_headers(request)
            .build()
            .map_err(|_| "could not build the ingest request".to_string())
    }

    fn upload(&self, events: &[UsageEvent]) -> Result<HashMap<String, String>, String> {
        let request = self.upload_request(events)?;
        let response = self
            .client
            .execute(request)
            .map_err(|_| "could not reach the ingest endpoint")?;
        if !response.status().is_success() {
            return Err("ingest endpoint rejected the batch".into());
        }
        let body = response
            .bytes()
            .map_err(|_| "could not read the ingest response")?;
        let receipts: Vec<Receipt> = serde_json::from_slice(&body)
            .or_else(|_| serde_json::from_slice::<ReceiptBatch>(&body).map(|batch| batch.results))
            .map_err(|_| "ingest response did not contain per-event statuses")?;
        Ok(receipts
            .into_iter()
            .map(|receipt| (receipt.id, receipt.status))
            .collect())
    }
}

trait IngestTransport: Send + Sync {
    fn healthy(&self) -> bool;
    fn upload(&self, events: &[UsageEvent]) -> Result<HashMap<String, String>, String>;
}

impl IngestTransport for IngestClient {
    fn healthy(&self) -> bool {
        IngestClient::healthy(self)
    }

    fn upload(&self, events: &[UsageEvent]) -> Result<HashMap<String, String>, String> {
        IngestClient::upload(self, events)
    }
}

#[derive(Deserialize)]
struct Receipt {
    id: String,
    status: String,
}

#[derive(Deserialize)]
struct ReceiptBatch {
    results: Vec<Receipt>,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PauseState {
    deadline_unix: Option<i64>,
    until_resumed: bool,
}

impl PauseState {
    fn paused(&mut self) -> bool {
        if !self.until_resumed
            && self
                .deadline_unix
                .is_some_and(|deadline| deadline <= OffsetDateTime::now_utc().unix_timestamp())
        {
            *self = Self::default();
        }
        self.until_resumed || self.deadline_unix.is_some()
    }

    fn label(&self) -> Option<String> {
        if self.until_resumed {
            Some("until you resume".into())
        } else {
            self.deadline_unix.map(|deadline| {
                let seconds = deadline
                    .saturating_sub(OffsetDateTime::now_utc().unix_timestamp())
                    .max(0) as u64;
                format!("{} minutes", seconds.div_ceil(60))
            })
        }
    }

    fn expires_in(&self) -> Option<u64> {
        self.deadline_unix.map(|deadline| {
            deadline
                .saturating_sub(OffsetDateTime::now_utc().unix_timestamp())
                .max(0) as u64
        })
    }

    fn set(&mut self, period: &str) -> Result<(), String> {
        let duration = match period {
            "30m" => Some(Duration::from_secs(30 * 60)),
            "1h" => Some(Duration::from_secs(60 * 60)),
            "tomorrow" => Some(until_local_tomorrow()),
            "until-resumed" => {
                *self = Self {
                    deadline_unix: None,
                    until_resumed: true,
                };
                return Ok(());
            }
            "resume" => {
                *self = Self::default();
                return Ok(());
            }
            _ => return Err("Choose a listed pause duration".into()),
        };
        *self = Self {
            deadline_unix: duration.map(|duration| {
                OffsetDateTime::now_utc().unix_timestamp() + duration.as_secs() as i64
            }),
            until_resumed: false,
        };
        Ok(())
    }

    fn is_default(&self) -> bool {
        self.deadline_unix.is_none() && !self.until_resumed
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PersistedOutbox {
    queue: VecDeque<UsageEvent>,
    pause: PauseState,
}

fn until_local_tomorrow() -> Duration {
    let now = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
    let seconds = now
        .date()
        .next_day()
        .and_then(|date| date.with_hms(0, 0, 0).ok())
        .map(|midnight| {
            (midnight.assume_offset(now.offset()) - now)
                .whole_seconds()
                .max(1) as u64
        })
        .unwrap_or(24 * 60 * 60);
    Duration::from_secs(seconds)
}

struct RuntimeState {
    pause: PauseState,
    notice_acknowledged: bool,
    after_hours_consented: bool,
    connected: bool,
    queue: VecDeque<UsageEvent>,
    failed_attempts: u32,
    retry_at: Option<Instant>,
}

#[derive(Clone)]
pub struct AgentCore {
    state: Arc<Mutex<RuntimeState>>,
    queue_path: PathBuf,
    queue_key: [u8; 32],
    persistent: bool,
    identity: Option<EventIdentity>,
    ingest: Option<Arc<dyn IngestTransport>>,
}

impl AgentCore {
    pub fn from_environment(queue_path: PathBuf) -> Result<Self, String> {
        let device = env::var("PULSE_DEVICE_ID").ok();
        let org = env::var("PULSE_ORG_ID").ok();
        let seed = env::var("PULSE_DEVICE_SIGNING_KEY_B64")
            .ok()
            .map(|encoded| {
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|_| "invalid desktop signing key")?;
                bytes
                    .try_into()
                    .map_err(|_| "desktop signing key must be 32 bytes")
            })
            .transpose()?;
        let identity = match (device, org) {
            (Some(device), Some(org)) => Some(EventIdentity {
                device_id: Uuid::parse_str(&device).map_err(|_| "invalid PULSE_DEVICE_ID")?,
                org_id: Uuid::parse_str(&org).map_err(|_| "invalid PULSE_ORG_ID")?,
            }),
            (None, None) => None,
            _ => return Err("both PULSE_DEVICE_ID and PULSE_ORG_ID are required".into()),
        };
        let endpoint = env::var("PULSE_INGEST_URL").ok();
        let ingest = match (endpoint, identity.clone(), seed) {
            (Some(endpoint), Some(identity), Some(seed)) => {
                let endpoint = Url::parse(&endpoint).map_err(|_| "invalid PULSE_INGEST_URL")?;
                if endpoint.scheme() != "https" && endpoint.host_str() != Some("127.0.0.1") {
                    return Err("PULSE_INGEST_URL must use HTTPS".into());
                }
                let access_id = env::var("CF_ACCESS_CLIENT_ID").ok();
                let access_secret = env::var("CF_ACCESS_CLIENT_SECRET").ok();
                Some(Arc::new(IngestClient::new(
                    endpoint,
                    identity,
                    SigningKey::from_bytes(&seed),
                    access_id,
                    access_secret,
                )?) as Arc<dyn IngestTransport>)
            }
            _ => None,
        };
        let (queue_key, persistent) = match seed {
            Some(seed) => (derive_queue_key(&seed), true),
            None if queue_path.exists() => {
                return Err(
                    "local outbox key is unavailable; refusing to discard queued events".into(),
                )
            }
            None => {
                let ephemeral = SigningKey::generate(&mut OsRng).to_bytes();
                (derive_queue_key(&ephemeral), false)
            }
        };
        Self::open(queue_path, queue_key, persistent, identity, ingest)
    }

    fn open(
        queue_path: PathBuf,
        queue_key: [u8; 32],
        persistent: bool,
        identity: Option<EventIdentity>,
        ingest: Option<Arc<dyn IngestTransport>>,
    ) -> Result<Self, String> {
        let (mut queue, mut pause) = read_outbox(&queue_path, &queue_key, persistent)?;
        prune_expired(&mut queue);
        pause.paused();
        let core = Self {
            state: Arc::new(Mutex::new(RuntimeState {
                pause,
                notice_acknowledged: false,
                after_hours_consented: false,
                connected: false,
                queue,
                failed_attempts: 0,
                retry_at: None,
            })),
            queue_path,
            queue_key,
            persistent,
            identity,
            ingest,
        };
        core.persist()?;
        Ok(core)
    }

    pub fn set_pause(&self, period: &str) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "desktop state is unavailable")?;
        let previous = state.pause;
        state.pause.set(period)?;
        if let Err(error) = self.persist_outbox(&state.queue, &state.pause) {
            state.pause = previous;
            return Err(error);
        }
        Ok(())
    }

    pub fn set_collection_policy(&self, notice_acknowledged: bool, after_hours_consented: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.notice_acknowledged = notice_acknowledged;
            state.after_hours_consented = after_hours_consented;
        }
    }

    pub fn status(&self) -> AgentStatus {
        let mut state = self.state.lock().expect("desktop state poisoned");
        let paused = state.pause.paused();
        AgentStatus {
            paused,
            pause_label: if paused { state.pause.label() } else { None },
            pause_expires_in_seconds: if paused {
                state.pause.expires_in()
            } else {
                None
            },
            connected: state.connected,
            queued_events: state.queue.len(),
        }
    }

    pub fn enqueue_usage(&self, data: UsageHour) -> Result<EnqueueResult, String> {
        data.validate()?;
        let identity = self.identity.as_ref().ok_or("desktop is not enrolled")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "desktop state is unavailable")?;
        if state.pause.paused() {
            return Ok(EnqueueResult::Suppressed(PauseReason::Paused));
        }
        if !state.notice_acknowledged {
            return Ok(EnqueueResult::Suppressed(
                PauseReason::NoticeNotAcknowledged,
            ));
        }
        if data.after_hours {
            return Ok(EnqueueResult::Suppressed(
                PauseReason::AfterHoursNotConsented,
            ));
        }
        if state.queue.len() >= MAX_QUEUE_EVENTS {
            return Err("offline event queue is full".into());
        }
        state.queue.push_back(UsageEvent::new(identity, data)?);
        if let Err(error) = self.persist_outbox(&state.queue, &state.pause) {
            state.queue.pop_back();
            return Err(error);
        }
        Ok(EnqueueResult::Queued)
    }

    pub fn sync_once(&self) -> Result<(), String> {
        let Some(ingest) = self.ingest.as_ref().cloned() else {
            if let Ok(mut state) = self.state.lock() {
                state.connected = false;
            }
            return Ok(());
        };
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "desktop state is unavailable")?;
            if state
                .retry_at
                .is_some_and(|retry_at| retry_at > Instant::now())
            {
                return Ok(());
            }
            prune_expired(&mut state.queue);
            self.persist_outbox(&state.queue, &state.pause)?;
        }
        if !ingest.healthy() {
            self.record_failure();
            return Err("ingest endpoint is unavailable".into());
        }
        let batch = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "desktop state is unavailable")?;
            state.connected = true;
            state
                .queue
                .iter()
                .take(MAX_BATCH_EVENTS)
                .cloned()
                .collect::<Vec<_>>()
        };
        if batch.is_empty() {
            return Ok(());
        }
        match ingest.upload(&batch) {
            Ok(receipts) => {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "desktop state is unavailable")?;
                state
                    .queue
                    .retain(|event| !receipts.contains_key(&event.id));
                state.failed_attempts = 0;
                state.retry_at = None;
                state.connected = true;
                self.persist_outbox(&state.queue, &state.pause)
            }
            Err(error) => {
                self.record_failure();
                Err(error)
            }
        }
    }

    fn record_failure(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.connected = false;
            state.failed_attempts = state.failed_attempts.saturating_add(1).min(8);
            let seconds = 2_u64.pow(state.failed_attempts).min(MAX_RETRY.as_secs());
            state.retry_at = Some(Instant::now() + Duration::from_secs(seconds));
        }
    }

    fn persist(&self) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "desktop state is unavailable")?;
        self.persist_outbox(&state.queue, &state.pause)
    }

    fn persist_outbox(
        &self,
        queue: &VecDeque<UsageEvent>,
        pause: &PauseState,
    ) -> Result<(), String> {
        if !self.persistent {
            return Ok(());
        }
        write_outbox(&self.queue_path, &self.queue_key, queue, pause)
    }
}

fn derive_queue_key(seed: &[u8; 32]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"pulse-desktop-outbox-v1");
    hash.update(seed);
    hash.finalize().into()
}

fn prune_expired(queue: &mut VecDeque<UsageEvent>) {
    let cutoff = OffsetDateTime::now_utc() - RETENTION;
    queue.retain(|event| {
        OffsetDateTime::parse(&event.time, &Rfc3339).is_ok_and(|time| time >= cutoff)
    });
}

fn read_outbox(
    path: &Path,
    key: &[u8; 32],
    persistent: bool,
) -> Result<(VecDeque<UsageEvent>, PauseState), String> {
    if !path.exists() {
        return Ok((VecDeque::new(), PauseState::default()));
    }
    if !persistent {
        return Err("local outbox key is unavailable; refusing to discard queued events".into());
    }
    let encrypted = fs::read(path).map_err(|_| "could not read local outbox")?;
    if encrypted.len() <= OUTBOX_NONCE_BYTES {
        return Err("local outbox is invalid".into());
    }
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| "invalid local outbox key")?;
    let nonce = XNonce::from_slice(&encrypted[..OUTBOX_NONCE_BYTES]);
    let plain = cipher
        .decrypt(nonce, &encrypted[OUTBOX_NONCE_BYTES..])
        .map_err(|_| "local outbox could not be decrypted")?;
    match serde_json::from_slice::<PersistedOutbox>(&plain) {
        Ok(outbox) => Ok((outbox.queue, outbox.pause)),
        Err(_) => serde_json::from_slice::<VecDeque<UsageEvent>>(&plain)
            .map(|queue| (queue, PauseState::default()))
            .map_err(|_| "local outbox is invalid".into()),
    }
}

fn write_outbox(
    path: &Path,
    key: &[u8; 32],
    queue: &VecDeque<UsageEvent>,
    pause: &PauseState,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "could not create local outbox directory")?;
    }
    if queue.is_empty() && pause.is_default() {
        if path.exists() {
            fs::remove_file(path).map_err(|_| "could not clear local outbox")?;
        }
        return Ok(());
    }
    let plain = serde_json::to_vec(&PersistedOutbox {
        queue: queue.clone(),
        pause: *pause,
    })
    .map_err(|_| "could not encode local outbox")?;
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| "invalid local outbox key")?;
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let encrypted = cipher
        .encrypt(&nonce, plain.as_ref())
        .map_err(|_| "could not encrypt local outbox")?;
    let temp = path.with_extension(format!("{}.tmp", Ulid::new()));
    let mut file = fs::File::create(&temp).map_err(|_| "could not write local outbox")?;
    file.write_all(nonce.as_slice())
        .and_then(|_| file.write_all(&encrypted))
        .and_then(|_| file.sync_all())
        .map_err(|_| "could not write local outbox")?;
    fs::rename(&temp, path).map_err(|_| "could not replace local outbox".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    fn test_core(path: PathBuf) -> AgentCore {
        let seed = [7_u8; 32];
        let identity = EventIdentity {
            org_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            device_id: Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
        };
        AgentCore::open(path, derive_queue_key(&seed), true, Some(identity), None).unwrap()
    }

    struct FakeIngest {
        is_healthy: bool,
        receipt_statuses: Mutex<VecDeque<&'static str>>,
        uploads: Mutex<Vec<Vec<String>>>,
    }

    impl IngestTransport for FakeIngest {
        fn healthy(&self) -> bool {
            self.is_healthy
        }

        fn upload(&self, events: &[UsageEvent]) -> Result<HashMap<String, String>, String> {
            let ids = events.iter().map(|event| event.id.clone()).collect();
            self.uploads.lock().unwrap().push(ids);
            let mut receipts = HashMap::new();
            if let (Some(status), Some(event)) = (
                self.receipt_statuses.lock().unwrap().pop_front(),
                events.first(),
            ) {
                receipts.insert(event.id.clone(), status.into());
            }
            Ok(receipts)
        }
    }

    fn usage(after_hours: bool) -> UsageHour {
        UsageHour {
            hour_start: "2026-10-05T05:00:00Z".into(),
            active_s: 600,
            idle_s: 300,
            categories: CategoryTotals {
                editing: 600,
                ..CategoryTotals::default()
            },
            after_hours,
        }
    }

    fn temp_outbox() -> PathBuf {
        env::temp_dir().join(format!("pulse-outbox-{}.bin", Ulid::new()))
    }

    #[test]
    fn pause_gates_core_collection_and_resume_reopens_it() {
        let path = temp_outbox();
        let core = test_core(path.clone());
        core.set_collection_policy(true, false);
        core.set_pause("until-resumed").unwrap();
        assert_eq!(
            core.enqueue_usage(usage(false)).unwrap(),
            EnqueueResult::Suppressed(PauseReason::Paused)
        );
        assert_eq!(core.status().queued_events, 0);
        core.set_pause("resume").unwrap();
        assert_eq!(
            core.enqueue_usage(usage(false)).unwrap(),
            EnqueueResult::Queued
        );
        assert_eq!(core.status().queued_events, 1);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn notice_and_after_hours_consent_gate_collection() {
        let path = temp_outbox();
        let core = test_core(path.clone());
        assert_eq!(
            core.enqueue_usage(usage(false)).unwrap(),
            EnqueueResult::Suppressed(PauseReason::NoticeNotAcknowledged)
        );
        core.set_collection_policy(true, false);
        assert_eq!(
            core.enqueue_usage(usage(true)).unwrap(),
            EnqueueResult::Suppressed(PauseReason::AfterHoursNotConsented)
        );
        assert_eq!(
            core.enqueue_usage(usage(false)).unwrap(),
            EnqueueResult::Queued
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn offline_queue_is_encrypted_and_survives_restart() {
        let path = temp_outbox();
        let core = test_core(path.clone());
        core.set_collection_policy(true, false);
        core.enqueue_usage(usage(false)).unwrap();
        drop(core);
        let bytes = fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("editing"));
        let reopened = test_core(path.clone());
        assert_eq!(reopened.status().queued_events, 1);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn pause_survives_reopening_agent_core() {
        let path = temp_outbox();
        let core = test_core(path.clone());
        core.set_pause("until-resumed").unwrap();
        drop(core);

        let reopened = test_core(path.clone());
        assert!(reopened.status().paused);
        assert_eq!(
            reopened.status().pause_label.as_deref(),
            Some("until you resume")
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn timed_pause_deadline_survives_reopening_agent_core() {
        let path = temp_outbox();
        let core = test_core(path.clone());
        core.set_pause("1h").unwrap();
        drop(core);

        let reopened = test_core(path.clone());
        let remaining = reopened.status().pause_expires_in_seconds.unwrap();
        assert!((3590..=3600).contains(&remaining));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn signed_ingest_request_contains_only_the_typed_envelope() {
        let seed = [7_u8; 32];
        let identity = EventIdentity {
            org_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            device_id: Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
        };
        let ingest = IngestClient::new(
            Url::parse("https://ingest.example.test/v1/events").unwrap(),
            identity.clone(),
            SigningKey::from_bytes(&seed),
            None,
            None,
        )
        .unwrap();
        let event = UsageEvent::new(&identity, usage(false)).unwrap();
        let request = ingest.upload_request(&[event]).unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        let headers = request.headers();
        let timestamp = headers.get("X-Pulse-Timestamp").unwrap().to_str().unwrap();
        let nonce = headers.get("X-Pulse-Nonce").unwrap().to_str().unwrap();
        let signature = STANDARD
            .decode(headers.get("X-Pulse-Signature").unwrap())
            .unwrap();
        let body = request.body().unwrap().as_bytes().unwrap();
        let digest = Sha256::digest(body);
        let digest_hex = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let signed = format!(
            "{}\n{}\n{}\n{}",
            identity.device_id, timestamp, nonce, digest_hex
        );
        SigningKey::from_bytes(&seed)
            .verifying_key()
            .verify(
                signed.as_bytes(),
                &ed25519_dalek::Signature::from_slice(&signature).unwrap(),
            )
            .unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(!body.contains("window_title"));
        assert!(!body.contains("editing_app_name"));
        assert!(body.contains("\"agent.usage.hourly\""));
    }

    #[test]
    fn after_hours_envelope_uses_the_registry_allowed_purpose() {
        let identity = EventIdentity {
            org_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            device_id: Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
        };
        let event = UsageEvent::new(&identity, usage(true)).unwrap();

        assert!(event.data.after_hours);
        assert_eq!(event.purpose, "activity_context");
    }

    #[test]
    fn sync_drops_rejected_receipt_and_retries_only_unreceipted_event() {
        let seed = [7_u8; 32];
        let identity = EventIdentity {
            org_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            device_id: Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
        };
        let path = temp_outbox();
        let ingest = Arc::new(FakeIngest {
            is_healthy: true,
            receipt_statuses: Mutex::new(VecDeque::from(["rejected", "accepted"])),
            uploads: Mutex::new(Vec::new()),
        });
        let core = AgentCore::open(
            path.clone(),
            derive_queue_key(&seed),
            true,
            Some(identity),
            Some(ingest.clone()),
        )
        .unwrap();
        core.set_collection_policy(true, false);
        core.enqueue_usage(usage(false)).unwrap();
        core.enqueue_usage(usage(false)).unwrap();
        let queued_ids = core
            .state
            .lock()
            .unwrap()
            .queue
            .iter()
            .map(|event| event.id.clone())
            .collect::<Vec<_>>();

        core.sync_once().unwrap();
        assert!(core.status().connected);
        assert_eq!(core.status().queued_events, 1);
        core.sync_once().unwrap();
        assert_eq!(core.status().queued_events, 0);

        let uploads = ingest.uploads.lock().unwrap();
        assert_eq!(uploads.len(), 2);
        assert_eq!(uploads[0], queued_ids);
        assert_eq!(uploads[1], vec![queued_ids[1].clone()]);
        let _ = fs::remove_file(path);
    }
}
