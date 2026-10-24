//! Pure navigation rules used by the native window and checked by ordinary core CI.

/// Only plain Pulse paths open in the window, never another origin or encoded markup.
pub fn safe_path(path: &str) -> Option<String> {
    let path = path.trim();
    if !path.starts_with('/') || path.starts_with("//") || path.len() > 600
        || !path.chars().all(|c| c.is_ascii_alphanumeric() || "/-_.~?=&%:+,#".contains(c)) {
        return None;
    }
    // Url::parse escapes markup before this check. Permit escaped identifier characters,
    // but reject markup, controls, separators and nested escaping just like their plain form.
    let bytes = path.as_bytes();
    let query_start = path.find('?');
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = (*bytes.get(i + 1)? as char).to_digit(16)?;
            let lo = (*bytes.get(i + 2)? as char).to_digit(16)?;
            let decoded = (hi * 16 + lo) as u8;
            let query_space = decoded == b' ' && query_start.is_some_and(|start| i > start);
            if !decoded.is_ascii_alphanumeric() && !b"-_.~".contains(&decoded) && !query_space { return None; }
            i += 3;
        } else { i += 1; }
    }
    Some(path.to_string())
}

#[derive(Debug, PartialEq)]
pub enum Link { Page(String), Settings(Option<String>), Panel }

pub fn parse_link(raw: &str) -> Option<Link> {
    if raw.chars().any(|c| c.is_control()) { return None; }
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "pulse" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() { return None; }
    if !url.path().is_empty() { safe_path(url.path())?; }
    let host = url.host_str().unwrap_or("");
    let rest = url.path().trim_matches('/');
    match host {
        "settings" => Some(Link::Settings((!rest.is_empty()).then(|| rest.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(32).collect()))),
        "panel" => Some(Link::Panel),
        "" | "open" | "home" if rest.is_empty() => Some(Link::Page("/".into())),
        _ => {
            let base = if host == "open" { format!("/{rest}") } else if rest.is_empty() { format!("/{host}") } else { format!("/{host}/{rest}") };
            let full = match url.query() { Some(q) => format!("{base}?{q}"), None => base };
            safe_path(&full).map(Link::Page)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pulse_pages_settings_and_panel_keep_their_routes() {
        assert_eq!(parse_link("pulse://chats?channel=abc"), Some(Link::Page("/chats?channel=abc".into())));
        assert_eq!(parse_link("pulse://open/me/requests"), Some(Link::Page("/me/requests".into())));
        assert_eq!(parse_link("pulse://settings/notifications"), Some(Link::Settings(Some("notifications".into()))));
        assert_eq!(parse_link("pulse://settings"), Some(Link::Settings(None)));
        assert_eq!(parse_link("pulse://panel"), Some(Link::Panel));
        assert_eq!(parse_link("pulse://"), Some(Link::Page("/".into())));
        assert_eq!(safe_path("/chats?channel=%61bc").as_deref(), Some("/chats?channel=%61bc"));
        assert_eq!(safe_path("/me?section=Your%20month").as_deref(), Some("/me?section=Your%20month"));
        assert_eq!(safe_path("/me%20path"), None);
    }
    #[test]
    fn encoded_markup_controls_and_other_origins_are_rejected() {
        for raw in ["https://pulse.example/chats", "pulse://chats/<x>", "pulse://chats/%3cx%3e", "pulse://chats/%253Cx%253E", "pulse://chats/%00", "pulse://chats/%0a", "pulse://chats/\nabc", "pulse://open/%2f%2fevil.example", "pulse://chats/%5c", "pulse://chats/%", "pulse://chats/%xy", "pulse://user@chats", "pulse://chats:80", "pulse://settings/%3cx%3e"] {
            assert_eq!(parse_link(raw), None, "{raw}");
        }
        for path in ["//evil.example/x", "https://evil.example", "/me<script>", "me"] { assert_eq!(safe_path(path), None, "{path}"); }
    }
}
