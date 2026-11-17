//! The Pulse server this computer belongs to. Nothing defaults to one company: on first run (or in Settings) the
//! person enters their company's Pulse address, it is checked with the signed-out admission probe, and its gateway
//! URL is kept in a small file in the app's data folder.
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Mutex};
use url::Url;

/// Where the native gateway lives on every Pulse site.
pub const GATEWAY_PATH: &str = "/api/native/v0";
/// The address shown in hints and error messages.
pub const EXAMPLE: &str = "https://pulse.example.com";

/// Why an address was not saved, in words the person can act on.
#[derive(Debug, PartialEq, Eq)]
pub enum AddressError { NotWebAddress, NotHttps, Unreachable, NotPulse }
impl AddressError {
    pub fn message(&self) -> String {
        match self {
            Self::NotWebAddress => format!("That isn’t a web address. Enter your Pulse address, like {EXAMPLE}"),
            Self::NotHttps => "Use the secure address that starts with https://".into(),
            Self::Unreachable => "Pulse can’t reach that address. Check the spelling and that this computer is online.".into(),
            Self::NotPulse => "That address answered, but it isn’t Pulse, or its front door doesn’t let apps in yet. Check the address with your admin.".into(),
        }
    }
}

/// `pulse.example.com`, `https://pulse.example.com` or the full `…/api/native/v0` → the gateway URL. Only https is
/// accepted (plain http only for a test server on this computer), and never a user name, password, query or fragment.
pub fn gateway(input: &str) -> Result<String, AddressError> {
    let input = input.trim();
    let full = if input.contains("://") { input.to_owned() } else { format!("https://{input}") };
    let url = Url::parse(&full).map_err(|_| AddressError::NotWebAddress)?;
    let local = url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    if url.scheme() != "https" && !local { return Err(AddressError::NotHttps); }
    if url.host_str().is_none_or(str::is_empty) || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(AddressError::NotWebAddress);
    }
    let path = url.path().trim_end_matches('/');
    Ok(format!("{}{}{GATEWAY_PATH}", url.origin().ascii_serialization(), path.strip_suffix(GATEWAY_PATH).unwrap_or(path)))
}

/// What the signed-out probe means: a Pulse gateway answers `GET …/companion` with 401 and JSON. No answer: it can't
/// be reached. Anything else (a redirect to an outer sign-in page, a web page, another answer): it isn't Pulse, or its
/// front door blocks apps.
pub fn verdict(reply: Option<(u16, bool)>) -> Result<(), AddressError> {
    match reply {
        None => Err(AddressError::Unreachable),
        Some((401, true)) => Ok(()),
        Some(_) => Err(AddressError::NotPulse),
    }
}

/// Checks an address with the signed-out probe before anything is saved; returns its gateway URL. Pass a client that
/// does not follow redirects.
pub fn probe(client: &Client, input: &str) -> Result<String, AddressError> {
    let gateway = gateway(input)?;
    let reply = client.get(format!("{gateway}/companion")).send().ok().map(|r| {
        let json = r.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("json"));
        (r.status().as_u16(), json)
    });
    verdict(reply).map(|()| gateway)
}

/// The saved gateway URL (none until the person enters one).
#[derive(Default)]
pub struct SavedAddress(Mutex<(Option<PathBuf>, Option<String>)>);
impl SavedAddress {
    /// Reads the saved address; a missing, unreadable or invalid file means none, and the person enters it again.
    pub fn open(&self, path: PathBuf) {
        let saved = fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v["gateway"].as_str().and_then(|g| gateway(g).ok()));
        *self.0.lock().unwrap() = (Some(path), saved);
    }
    pub fn get(&self) -> Option<String> { self.0.lock().unwrap().1.clone() }
    /// Keeps a checked gateway URL, through a temporary file so a crash never leaves half an address.
    pub fn set(&self, gateway: &str) -> Result<(), String> {
        let mut saved = self.0.lock().unwrap();
        if let Some(path) = &saved.0 {
            let temp = path.with_extension("tmp");
            path.parent().map_or(Ok(()), fs::create_dir_all)
                .and_then(|()| fs::write(&temp, json!({"gateway": gateway}).to_string()))
                .and_then(|()| fs::rename(&temp, path))
                .map_err(|_| "This computer could not keep the Pulse address. Free some storage, then try again.".to_string())?;
        }
        saved.1 = Some(gateway.into());
        Ok(())
    }
    /// After an update a restored sign-in keeps working: its gateway becomes the saved address, so nobody pairs again.
    pub fn adopt(&self, signed_in: Option<&str>) -> Result<(), String> {
        match signed_in {
            Some(base) if self.get().as_deref() != Some(base) => self.set(base),
            _ => Ok(()),
        }
    }
    /// Saves a probed gateway. Moving to another server first runs `leave` (sign this computer out and drop the old
    /// server's unsent work), so a different pairing never replays earlier work. Returns whether the server changed.
    pub fn switch(&self, gateway: &str, signed_in: Option<&str>, leave: impl FnOnce()) -> Result<bool, String> {
        let current = signed_in.map(str::to_owned).or_else(|| self.get());
        if current.as_deref() == Some(gateway) { return Ok(false); }
        if current.is_some() { leave(); }
        self.set(gateway).map(|()| true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn site_and_gateway_input_become_the_gateway() {
        for input in ["https://pulse.example.com", "pulse.example.com", " https://pulse.example.com/ ", "https://pulse.example.com/api/native/v0", "https://pulse.example.com/api/native/v0/"] {
            assert_eq!(gateway(input).as_deref(), Ok("https://pulse.example.com/api/native/v0"), "{input}");
        }
        assert_eq!(gateway("https://Pulse.Example.com:8443/team").as_deref(), Ok("https://pulse.example.com:8443/team/api/native/v0"));
        assert_eq!(gateway("http://127.0.0.1:3200").as_deref(), Ok("http://127.0.0.1:3200/api/native/v0"));
        assert_eq!(gateway("http://localhost:3200/api/native/v0").as_deref(), Ok("http://localhost:3200/api/native/v0"));
    }

    #[test]
    fn insecure_or_decorated_addresses_are_refused() {
        assert_eq!(gateway("http://pulse.example.com"), Err(AddressError::NotHttps));
        assert_eq!(gateway("http://127.0.0.1.example.com"), Err(AddressError::NotHttps));
        assert_eq!(gateway("ftp://pulse.example.com"), Err(AddressError::NotHttps));
        for input in ["", "pulse example com", "https://", "https://a:b@pulse.example.com", "https://a@pulse.example.com", "https://pulse.example.com/?team=1", "https://pulse.example.com/#me"] {
            assert_eq!(gateway(input), Err(AddressError::NotWebAddress), "{input}");
        }
        for e in [AddressError::NotWebAddress, AddressError::NotHttps] { assert!(!e.message().contains("estateautopilots")); }
        assert!(AddressError::NotWebAddress.message().contains(EXAMPLE));
    }

    #[test]
    fn only_a_json_401_is_a_pulse_gateway() {
        assert_eq!(verdict(Some((401, true))), Ok(()));
        assert_eq!(verdict(None), Err(AddressError::Unreachable));
        for reply in [(302, false), (200, false), (404, false), (401, false), (200, true), (403, true), (502, false)] {
            assert_eq!(verdict(Some(reply)), Err(AddressError::NotPulse), "{reply:?}");
        }
    }

    fn answer_once(status: &'static str, content_type: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let n = stream.read(&mut request).unwrap();
            let path = if String::from_utf8_lossy(&request[..n]).starts_with("GET /api/native/v0/companion ") { "ok" } else { "wrong path" };
            let body = format!(r#"{{"error":"{path}"}}"#);
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        format!("http://{address}")
    }

    #[test]
    fn the_probe_asks_the_gateway_signed_out() {
        let client = Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let pulse = answer_once("401 Unauthorized", "application/json");
        assert_eq!(probe(&client, &pulse), Ok(format!("{pulse}/api/native/v0")));
        assert_eq!(probe(&client, &answer_once("302 Found", "text/html")), Err(AddressError::NotPulse));
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        assert_eq!(probe(&client, &format!("http://{closed}")), Err(AddressError::Unreachable));
        assert_eq!(probe(&client, "http://pulse.example.com"), Err(AddressError::NotHttps));
    }

    #[test]
    fn the_address_is_kept_across_restarts() {
        let path = std::env::temp_dir().join(format!("pulse-address-{}.json", uuid::Uuid::new_v4()));
        let saved = SavedAddress::default();
        saved.open(path.clone());
        assert_eq!(saved.get(), None, "a fresh profile has no address");
        saved.set("https://pulse.example.com/api/native/v0").unwrap();
        let reopened = SavedAddress::default();
        reopened.open(path.clone());
        assert_eq!(reopened.get().as_deref(), Some("https://pulse.example.com/api/native/v0"));
        fs::write(&path, r#"{"gateway":"http://pulse.example.com"}"#).unwrap();
        reopened.open(path.clone());
        assert_eq!(reopened.get(), None, "an edited, insecure address is not trusted");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn an_upgraded_signed_in_install_keeps_its_base() {
        let path = std::env::temp_dir().join(format!("pulse-address-{}.json", uuid::Uuid::new_v4()));
        let saved = SavedAddress::default();
        saved.open(path.clone());
        let mut left = false;
        saved.adopt(Some("https://pulse.example.com/api/native/v0")).unwrap();
        assert_eq!(saved.get().as_deref(), Some("https://pulse.example.com/api/native/v0"));
        assert!(!saved.switch("https://pulse.example.com/api/native/v0", Some("https://pulse.example.com/api/native/v0"), || left = true).unwrap());
        assert!(!left, "the same server keeps the sign-in");
        saved.adopt(None).unwrap();
        assert_eq!(saved.get().as_deref(), Some("https://pulse.example.com/api/native/v0"), "signing out keeps the address");
        fs::remove_file(path).unwrap();
    }
}
