//! Pulse's saved secrets on macOS, kept in the login Keychain through Apple's own `/usr/bin/security` tool.
//!
//! Why not the app's own Keychain item: since macOS 10.12 a Keychain item is also partitioned by the creating app's
//! Team ID, or — for apps without an Apple Developer Team ID, like Pulse's self-signed builds — by its exact code hash.
//! Every update has a new code hash, so the updated app could only read its own item after a Keychain password prompt
//! (proved on the hosted macOS runner: same signing identity, same designated requirement, read refused).
//! Items written by Apple's `security` tool belong to that tool, so any Pulse build reads them without a prompt.
//! They stay encrypted in the login Keychain. Secrets never appear on a command line: they are passed on stdin.
use crate::startup::Lookup;
use std::{io::Write, process::{Command, Stdio}};

const TOOL: &str = "/usr/bin/security";
/// `security` exits with errSecItemNotFound's low byte (44) when there is no such item.
const NOT_FOUND: i32 = 44;

fn encode(secret: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(secret)
}
fn decode(stored: &str) -> Option<String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(stored.trim()).ok().and_then(|b| String::from_utf8(b).ok())
}

/// Interpret `security find-generic-password -w` output.
pub fn parse_find(status: Option<i32>, stdout: &[u8]) -> Lookup<String> {
    match status {
        Some(0) => match std::str::from_utf8(stdout).ok().and_then(decode) { Some(s) => Lookup::Found(s), None => Lookup::Unreadable },
        Some(NOT_FOUND) => Lookup::Missing,
        _ => Lookup::Unreadable,
    }
}
/// The one interactive-mode command that stores an item; the value is base64, so it needs no quoting.
pub fn add_command(service: &str, account: &str, secret: &str) -> String {
    format!("add-generic-password -U -s {service} -a {account} -w {}\n", encode(secret))
}

pub fn read(service: &str, account: &str) -> Lookup<String> {
    match Command::new(TOOL).args(["find-generic-password", "-s", service, "-a", account, "-w"]).stdin(Stdio::null()).stderr(Stdio::null()).output() {
        Ok(out) => parse_find(out.status.code(), &out.stdout),
        Err(_) => Lookup::Unreadable,
    }
}
pub fn write(service: &str, account: &str, secret: &str) -> Result<(), String> {
    let mut child = Command::new(TOOL).arg("-i").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_| "Keychain unavailable".to_string())?;
    child.stdin.take().ok_or("Keychain unavailable")?.write_all(add_command(service, account, secret).as_bytes()).map_err(|_| "Keychain unavailable".to_string())?;
    let status = child.wait().map_err(|_| "Keychain unavailable".to_string())?;
    // Interactive mode reports a failed command on stderr but exits 0; read back to be sure.
    match (status.success(), read(service, account)) { (true, Lookup::Found(s)) if s == secret => Ok(()), _ => Err("The Keychain refused to keep the Pulse sign-in".into()) }
}
pub fn delete(service: &str, account: &str) {
    let _ = Command::new(TOOL).args(["delete-generic-password", "-s", service, "-a", account]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn found_missing_and_locked_are_told_apart() {
        let stored = encode("{\"deviceId\":\"d\"}");
        assert_eq!(parse_find(Some(0), format!("{stored}\n").as_bytes()), Lookup::Found("{\"deviceId\":\"d\"}".into()));
        assert_eq!(parse_find(Some(44), b""), Lookup::Missing);
        assert_eq!(parse_find(Some(51), b""), Lookup::Unreadable);
        assert_eq!(parse_find(Some(0), b"not base64 !"), Lookup::Unreadable);
    }
    #[test]
    fn secrets_go_to_stdin_as_base64_never_as_arguments() {
        let line = add_command("com.pulse.work", "companion-device-v3", "a \"quoted\" secret; with spaces");
        assert!(line.starts_with("add-generic-password -U -s com.pulse.work -a companion-device-v3 -w "));
        assert!(!line.contains("quoted"));
        assert_eq!(line.trim_end().split(' ').count(), 8, "no unquoted spaces from the secret");
    }
}
