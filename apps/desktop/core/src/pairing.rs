//! Browser pairing per company (EST-658): before the code is requested the app names the company it joins
//! (`GET …/native/about`), and a company may require its admin to approve every new computer. Such a wait survives a
//! restart for at most a day, the time the server gives the admin.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How long a pairing waits for the company's admin after the person's own approval.
pub const ADMIN_WAIT_MS: u64 = 24 * 60 * 60 * 1000;

/// The company name from `native/about`; none from an older Pulse (no such call) or any other answer, so the app shows
/// the site's host instead.
pub fn company(status: u16, about: &Value) -> Option<String> {
    if status != 200 || about["product"] != "Pulse" { return None; }
    let name: String = about["company"]["name"].as_str()?.chars().filter(|c| !c.is_control()).collect();
    let name: String = name.trim().chars().take(80).collect();
    (!name.is_empty()).then_some(name)
}

/// A started pairing. `until` is set once the person approved and the company's admin has to decide.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending { pub base: String, pub pair_id: String, pub poll_secret: String, pub code: String, pub interval: u64, pub until: Option<u64> }
impl Pending {
    /// A saved wait is resumed after a restart only for the same Pulse address and within the admin's day.
    pub fn resumable(&self, address: Option<&str>, now_ms: u64) -> bool {
        address == Some(self.base.as_str()) && self.until.is_some_and(|until| now_ms < until)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_company_name_comes_only_from_a_pulse_about_answer() {
        let about = json!({"product": "Pulse", "company": {"name": "  Northwind\u{7} Studio "}, "pairing": {"approval": "admin"}});
        assert_eq!(company(200, &about).as_deref(), Some("Northwind Studio"));
        assert_eq!(company(200, &json!({"product": "Pulse", "company": {"name": "N".repeat(200)}})).map(|n| n.len()), Some(80));
        for (status, reply) in [(404, about.clone()), (200, json!({"error": "Not found"})), (200, json!({"product": "Other", "company": {"name": "X"}})), (200, json!({"product": "Pulse", "company": {"name": "  "}}))] {
            assert_eq!(company(status, &reply), None, "{status} {reply}");
        }
    }

    #[test]
    fn a_wait_for_the_admin_resumes_for_one_day_on_the_same_address() {
        let base = "https://pulse.example.com/api/native/v0";
        let mut p = Pending { base: base.into(), pair_id: "p".into(), poll_secret: "s".into(), code: "KQ7M-4TXA".into(), interval: 3, until: None };
        assert!(!p.resumable(Some(base), 0), "a code nobody approved yet is not kept");
        p.until = Some(1_000 + ADMIN_WAIT_MS);
        assert!(p.resumable(Some(base), 1_000));
        assert!(!p.resumable(Some(base), 1_000 + ADMIN_WAIT_MS), "after a day the admin's time is over");
        assert!(!p.resumable(Some("https://other.example.com/api/native/v0"), 1_000), "another address drops the wait");
        assert!(!p.resumable(None, 1_000));
        let saved: Pending = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(saved, p);
    }
}
