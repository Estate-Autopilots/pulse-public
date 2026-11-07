//! Counts and fingerprints only. Never queries window titles or keyboard input.
use flate2::read::GzDecoder;
use md5::Md5;
use quick_xml::{events::Event as XmlEvent, Reader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufReader, Read},
    path::Path,
};
#[derive(Default, Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Counts {
    pub clips: u32,
    pub effects: u32,
    pub markers: u32,
    pub keyframes: u32,
    pub sequences: u32,
}
fn category(tag: &[u8]) -> Option<&'static str> {
    match tag {
        b"VideoClipTrackItem" | b"AudioClipTrackItem" => Some("clips"),
        b"VideoFilterComponent" | b"AudioFilterComponent" => Some("effects"),
        b"Marker" => Some("markers"),
        b"Keyframe" => Some("keyframes"),
        b"Sequence" => Some("sequences"),
        _ => None,
    }
}
#[derive(Default, Clone, Debug)]
pub struct ProjectSnapshot {
    pub elements: BTreeMap<String, (String, String)>,
}
/// Bounded decompression. Object IDs and structural fingerprints stay on this device.
pub fn project_snapshot(path: &Path) -> Result<ProjectSnapshot, String> {
    let file = File::open(path).map_err(|_| "Cannot read project")?;
    let decoded = GzDecoder::new(file).take(64 * 1024 * 1024 + 1);
    parse_project(BufReader::new(decoded))
}
pub fn parse_project(input: impl std::io::BufRead) -> Result<ProjectSnapshot, String> {
    let mut reader = Reader::from_reader(input);
    let mut buf = Vec::new();
    let mut out = ProjectSnapshot::default();
    let mut stack: Vec<(usize, String, String, Sha256)> = Vec::new();
    let mut depth: usize = 0;
    let mut bytes = 0usize;
    let mut anonymous = 0usize;
    loop {
        let e = reader
            .read_event_into(&mut buf)
            .map_err(|_| "Unsupported Premiere project")?
            .into_owned();
        bytes += buf.len();
        if bytes > 64 * 1024 * 1024 {
            return Err("Project exceeds parser budget".into());
        }
        for (_, _, _, h) in &mut stack {
            h.update(&buf);
        }
        match e {
            XmlEvent::Start(ref e) | XmlEvent::Empty(ref e) => {
                let name = e.name();
                if let Some(kind) = category(name.as_ref()) {
                    let object = e
                        .attributes()
                        .filter_map(Result::ok)
                        .find(|a| a.key.as_ref() == b"ObjectID")
                        .map(|a| String::from_utf8_lossy(&a.value).to_string())
                        .unwrap_or_else(|| {
                            anonymous += 1;
                            format!("anonymous:{anonymous}")
                        });
                    let mut h = Sha256::new();
                    h.update(&buf);
                    stack.push((depth, format!("{kind}:{object}"), kind.into(), h));
                }
            }
            XmlEvent::Eof => break,
            _ => {}
        }
        // Separate discriminants avoid borrowing attribute values beyond this iteration.
        match e {
            XmlEvent::Start(_) => depth += 1,
            XmlEvent::Empty(_) => {
                while stack.last().is_some_and(|x| x.0 == depth) {
                    let (_, id, k, h) = stack.pop().unwrap();
                    out.elements.insert(id, (k, format!("{:x}", h.finalize())));
                }
            }
            XmlEvent::End(_) => {
                depth = depth.saturating_sub(1);
                while stack.last().is_some_and(|x| x.0 == depth) {
                    let (_, id, k, h) = stack.pop().unwrap();
                    out.elements.insert(id, (k, format!("{:x}", h.finalize())));
                }
            }
            _ => {}
        }
        buf.clear();
    }
    if out.elements.is_empty() {
        return Err("No supported Premiere structures found".into());
    }
    Ok(out)
}
fn add(c: &mut Counts, k: &str) {
    match k {
        "clips" => c.clips += 1,
        "effects" => c.effects += 1,
        "markers" => c.markers += 1,
        "keyframes" => c.keyframes += 1,
        "sequences" => c.sequences += 1,
        _ => {}
    }
}
pub fn delta(old: &ProjectSnapshot, new: &ProjectSnapshot) -> (Counts, Counts, Counts) {
    let (mut a, mut r, mut c) = (Counts::default(), Counts::default(), Counts::default());
    for (id, (k, h)) in &new.elements {
        match old.elements.get(id) {
            None => add(&mut a, k),
            Some((_, before)) if before != h => add(&mut c, k),
            _ => {}
        }
    }
    for (id, (k, _)) in &old.elements {
        if !new.elements.contains_key(id) {
            add(&mut r, k)
        }
    }
    (a, r, c)
}
pub fn fingerprints(path: &Path) -> Result<(String, String, u64), String> {
    fingerprints_with_gate(path, || true)
}
/// Checks cancellation between chunks so pause does not wait for a large export.
pub fn fingerprints_with_gate(
    path: &Path,
    mut allowed: impl FnMut() -> bool,
) -> Result<(String, String, u64), String> {
    let mut f = File::open(path).map_err(|_| "Cannot read export")?;
    let (mut sha, mut md) = (Sha256::new(), Md5::new());
    let mut buf = [0u8; 65536];
    let mut bytes = 0;
    loop {
        if !allowed() {
            return Err("Export scan cancelled".into());
        }
        let n = f.read(&mut buf).map_err(|_| "Cannot hash export")?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
        md.update(&buf[..n]);
        bytes += n as u64;
    }
    Ok((
        format!("{:x}", sha.finalize()),
        format!("{:x}", md.finalize()),
        bytes,
    ))
}
pub fn tool(app: &str) -> &'static str {
    // Exact executable/bundle identities. Unknown/personal applications leave no identity in evidence.
    let lower=app.to_lowercase();let name=lower.rsplit(['/', '\\']).next().unwrap_or("");
    match name {
      "adobe premiere pro.exe"|"com.adobe.premierepro"=>"premiere",
      "photoshop.exe"|"com.adobe.photoshop"=>"photoshop",
      "afterfx.exe"|"com.adobe.aftereffects"=>"after_effects",
      "resolve.exe"|"com.blackmagic-design.davinciresolve"=>"resolve",
      "figma.exe"|"com.figma.desktop"=>"figma",
      "chrome.exe"|"firefox.exe"|"msedge.exe"|"com.google.chrome"|"org.mozilla.firefox"|"com.apple.safari"=>"browser",
      "excel.exe"|"winword.exe"|"powerpnt.exe"|"com.microsoft.word"|"com.microsoft.excel"|"com.apple.iwork.pages"|"com.apple.iwork.numbers"=>"office",
      _=>"other"
    }
}
#[cfg(windows)]
pub fn focus() -> Option<(String, bool)> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            SystemInformation::GetTickCount,
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
            WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
        },
    };
    unsafe {
        let win = GetForegroundWindow();
        if win.is_null() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(win, &mut pid);
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut name = [0u16; 1024];
        let mut len = name.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, name.as_mut_ptr(), &mut len);
        CloseHandle(process);
        if ok == 0 {
            return None;
        }
        let mut input = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut input) == 0 {
            return None;
        }
        let idle = GetTickCount().wrapping_sub(input.dwTime) >= 180000;
        Some((
            tool(&String::from_utf16_lossy(&name[..len as usize])).into(),
            idle,
        ))
    }
}
#[cfg(target_os = "macos")]
pub fn focus() -> Option<(String, bool)> {
    // NSWorkspace needs no Accessibility/Input Monitoring/Screen Recording grant.
    use std::ffi::{c_void,c_char,CStr};
    #[link(name="AppKit",kind="framework")] extern "C" {}
    #[link(name="objc")] extern "C" {fn objc_getClass(name:*const c_char)->*mut c_void;fn sel_registerName(name:*const c_char)->*mut c_void;fn objc_msgSend();}
    let bundle=unsafe {
        let send:unsafe extern "C" fn(*mut c_void,*mut c_void)->*mut c_void=std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let pool=send(objc_getClass(b"NSAutoreleasePool\0".as_ptr().cast()),sel_registerName(b"new\0".as_ptr().cast()));
        let workspace=send(objc_getClass(b"NSWorkspace\0".as_ptr().cast()),sel_registerName(b"sharedWorkspace\0".as_ptr().cast()));
        let application=send(workspace,sel_registerName(b"frontmostApplication\0".as_ptr().cast()));
        let identifier=send(application,sel_registerName(b"bundleIdentifier\0".as_ptr().cast()));
        let utf8=send(identifier,sel_registerName(b"UTF8String\0".as_ptr().cast()));
        let value=if utf8.is_null(){None}else{Some(CStr::from_ptr(utf8.cast()).to_string_lossy().into_owned())};
        send(pool,sel_registerName(b"drain\0".as_ptr().cast()));value?
    };
    let idle = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-c", "IOHIDSystem", "-d", "1"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&idle.stdout);
    let nanos = text
        .lines()
        .find(|s| s.contains("HIDIdleTime"))?
        .split('=')
        .next_back()?
        .trim()
        .parse::<u64>()
        .ok()?;
    Some((
        tool(&bundle).into(),
        nanos >= 180_000_000_000,
    ))
}
/// ATT: seconds since the last keyboard or mouse input, for office presence's "this laptop is in use". It never reads
/// which application is in front (that is the separate, notice-gated work tracker).
#[cfg(windows)]
pub fn idle_seconds() -> Option<u64> {
    use windows_sys::Win32::{System::SystemInformation::GetTickCount, UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO}};
    unsafe {
        let mut input = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut input) == 0 { return None; }
        Some(u64::from(GetTickCount().wrapping_sub(input.dwTime)) / 1000)
    }
}
#[cfg(target_os = "macos")]
pub fn idle_seconds() -> Option<u64> {
    let out = std::process::Command::new("/usr/sbin/ioreg").args(["-c", "IOHIDSystem", "-d", "1"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let nanos = text.lines().find(|s| s.contains("HIDIdleTime"))?.split('=').next_back()?.trim().parse::<u64>().ok()?;
    Some(nanos / 1_000_000_000)
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn idle_seconds() -> Option<u64> { None }
#[cfg(not(any(windows, target_os = "macos")))]
pub fn focus() -> Option<(String, bool)> {
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_work_app_allowlist_excludes_personal_lookalikes(){assert_eq!(tool("C:\\Program Files\\Adobe\\Adobe Premiere Pro.exe"),"premiere");assert_eq!(tool("my-premiere-passwords.exe"),"other");assert_eq!(tool("com.adobe.Photoshop"),"photoshop");assert_eq!(tool("personal-photoshop.exe"),"other");}
    #[test]
    fn fingerprints_and_delta_never_contain_text() {
        let a=parse_project(std::io::Cursor::new(b"<PremiereData><Sequence ObjectID='1'><VideoClipTrackItem ObjectID='2'><Text>private</Text></VideoClipTrackItem></Sequence></PremiereData>")).unwrap();
        let b=parse_project(std::io::Cursor::new(b"<PremiereData><Sequence ObjectID='1'><VideoClipTrackItem ObjectID='2'><Text>changed</Text></VideoClipTrackItem><Marker ObjectID='3'/></Sequence></PremiereData>")).unwrap();
        let (added, removed, changed) = delta(&a, &b);
        assert_eq!(added.markers, 1);
        assert_eq!(changed.clips, 1);
        assert_eq!(removed.clips, 0);
        assert!(!format!("{b:?}").contains("private"));
        assert_eq!(
            delta(&b, &b),
            (Counts::default(), Counts::default(), Counts::default())
        );
    }
    #[test]
    fn export_scan_stops_between_chunks_when_paused() {
        let path = std::env::temp_dir().join(format!("pulse-{}.mp4", uuid::Uuid::new_v4()));
        std::fs::write(&path, vec![1u8; 131072]).unwrap();
        let mut checks = 0;
        let result = fingerprints_with_gate(&path, || {
            checks += 1;
            checks == 1
        });
        assert_eq!(result.unwrap_err(), "Export scan cancelled");
        assert_eq!(checks, 2);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn unsupported_does_not_invent_zero_work() {
        assert!(parse_project(std::io::Cursor::new(
            b"<PremiereData><Unknown/></PremiereData>"
        ))
        .is_err());
    }
}
