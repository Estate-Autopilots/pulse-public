//! Which Wi-Fi this laptop is on, read from the operating system's own tools. Only the network name (SSID) and the
//! access point (BSSID) are kept, and only to compare with the offices HR registered; nothing else is read.
use serde::Serialize;

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wifi {
    pub ssid: Option<String>,
    pub bssid: Option<String>,
    /// The OS hides Wi-Fi names until Pulse may use Location (Windows 11 24H2+, macOS 14.4+).
    pub needs_location: bool,
}

fn clean_ssid(value: &str) -> Option<String> {
    let v = value.trim();
    (!v.is_empty() && v.len() <= 64 && !v.eq_ignore_ascii_case("<redacted>") && !v.chars().any(char::is_control)).then(|| v.to_string())
}
/// "AA-BB-CC-DD-EE-FF" or "aa:bb:cc:dd:ee:ff" → "aa:bb:cc:dd:ee:ff"; anything else is ignored.
pub fn clean_bssid(value: &str) -> Option<String> {
    let v = value.trim().to_ascii_lowercase().replace('-', ":");
    let parts: Vec<&str> = v.split(':').collect();
    let ok = parts.len() == 6 && parts.iter().all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit())) && v != "00:00:00:00:00:00";
    ok.then_some(v)
}

/// `netsh wlan show interfaces` (first connected interface).
pub fn parse_netsh(output: &str) -> Wifi {
    let mut wifi = Wifi::default();
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim();
        // BSSID values contain ':' themselves, so rebuild the value from the first separator.
        if key.eq_ignore_ascii_case("SSID") && wifi.ssid.is_none() { wifi.ssid = clean_ssid(value); }
        else if (key.eq_ignore_ascii_case("BSSID") || key.eq_ignore_ascii_case("AP BSSID")) && wifi.bssid.is_none() { wifi.bssid = clean_bssid(value); }
    }
    let lower = output.to_ascii_lowercase();
    wifi.needs_location = wifi.ssid.is_none() && lower.contains("location");
    wifi
}

/// `ipconfig getsummary en0` on macOS: SSID only; the BSSID needs Location Services and CoreWLAN.
pub fn parse_ipconfig_summary(output: &str) -> Wifi {
    let mut wifi = Wifi::default();
    for line in output.lines() {
        let Some((key, value)) = line.split_once(" : ") else { continue };
        match key.trim() {
            "SSID" if wifi.ssid.is_none() => {
                if value.trim().eq_ignore_ascii_case("<redacted>") { wifi.needs_location = true; } else { wifi.ssid = clean_ssid(value); }
            }
            "BSSID" if wifi.bssid.is_none() => wifi.bssid = clean_bssid(value),
            _ => {}
        }
    }
    wifi
}

#[cfg(test)]
mod tests {
    use super::*;
    const NETSH: &str = "\nThere is 1 interface on the system:\n\n    Name                   : Wi-Fi\n    Description            : Intel(R) Wi-Fi 6 AX201 160MHz\n    GUID                   : 1b2c3d4e-0000-0000-0000-000000000000\n    Physical address       : 11:22:33:44:55:66\n    State                  : connected\n    SSID                   : EA Office 5G\n    AP BSSID               : A4-CF-12-9B-00-01\n    Network type           : Infrastructure\n    Radio type             : 802.11ax\n    Signal                 : 92%\n";
    #[test]
    fn windows_name_and_access_point() {
        let w = parse_netsh(NETSH);
        assert_eq!(w.ssid.as_deref(), Some("EA Office 5G"));
        assert_eq!(w.bssid.as_deref(), Some("a4:cf:12:9b:00:01"));
        assert!(!w.needs_location);
    }
    #[test]
    fn windows_older_bssid_label_and_physical_address_is_not_the_access_point() {
        let w = parse_netsh("    Physical address : 11:22:33:44:55:66\n    SSID : Home\n    BSSID : aa:bb:cc:dd:ee:ff\n");
        assert_eq!(w.bssid.as_deref(), Some("aa:bb:cc:dd:ee:ff"));
    }
    #[test]
    fn windows_location_gate_is_reported_not_guessed() {
        let w = parse_netsh("Network shell commands need location permission to access WLAN information.\n");
        assert_eq!(w, Wifi { ssid: None, bssid: None, needs_location: true });
        assert_eq!(parse_netsh("There is no wireless interface on the system."), Wifi::default());
    }
    #[test]
    fn mac_summary_and_redaction() {
        let w = parse_ipconfig_summary("<dictionary> {\n  InterfaceType : WiFi\n  SSID : EA Office\n  Security : WPA2_PSK\n}");
        assert_eq!(w.ssid.as_deref(), Some("EA Office"));
        let hidden = parse_ipconfig_summary("  SSID : <redacted>\n");
        assert!(hidden.needs_location && hidden.ssid.is_none());
    }
    #[test]
    fn junk_values_are_dropped() {
        assert_eq!(clean_bssid("00:00:00:00:00:00"), None);
        assert_eq!(clean_bssid("zz:bb:cc:dd:ee:ff"), None);
        assert_eq!(clean_bssid("AA-BB-CC-DD-EE-FF").as_deref(), Some("aa:bb:cc:dd:ee:ff"));
    }
}
