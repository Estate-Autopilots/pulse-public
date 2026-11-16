//! A separate copy of the previous executable supervises an update. App data is never copied or replaced.
use serde::{Deserialize, Serialize};
use std::{fs, io, path::{Path, PathBuf}, process::{Command, Stdio}, thread, time::{Duration, Instant}};
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Journal {
    pub previous: String,
    pub target: String,
    pub install: PathBuf,
    pub backup: PathBuf,
    pub relative_exe: PathBuf,
    pub stage: String,
    pub attempts: u8,
}
impl Journal {
    pub fn load(path: &Path) -> io::Result<Self> { serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other) }
    pub fn save(&self, path: &Path) -> io::Result<()> {
        let next = path.with_extension("new");
        fs::write(&next, serde_json::to_vec(self).map_err(io::Error::other)?)?;
        // Windows rename cannot replace an existing file. Truncate/write the journal there; readers retry.
        #[cfg(windows)]
        { fs::copy(&next, path)?; Ok(()) }
        #[cfg(not(windows))]
        fs::rename(next, path)
    }
    pub fn failed_twice(&self) -> bool { self.stage == "starting" && self.attempts >= 2 }
    pub fn acknowledge(&mut self, version: &str) -> bool {
        if self.stage == "starting" && self.target == version { self.stage = "healthy".into(); true } else { false }
    }
    fn validate(&self) -> io::Result<()> {
        if !self.install.is_absolute() || !self.backup.is_absolute() || self.install == self.backup || self.backup.starts_with(&self.install) || self.relative_exe.is_absolute() || self.relative_exe.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(io::Error::other("Unsafe recovery paths"));
        }
        Ok(())
    }
    pub fn restore(&mut self, path: &Path) -> io::Result<()> {
        self.validate()?;
        let failed = self.install.with_file_name(format!("Pulse-failed-{}-{}", self.target, std::process::id()));
        // Retain the failed build too; never delete user data, queues, pairing, or the previous build.
        fs::rename(&self.install, &failed)?;
        if let Err(error) = copy_tree(&self.backup, &self.install) {
            // A partial restore is retained separately; put the original installation back on error.
            let partial = self.install.with_file_name(format!("Pulse-restore-incomplete-{}", std::process::id()));
            if self.install.exists() { let _ = fs::rename(&self.install, partial); }
            let _ = fs::rename(&failed, &self.install);
            return Err(error);
        }
        self.stage = "rolled-back".into(); self.save(path)
    }
}
pub fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    if to == from || to.starts_with(from) { return Err(io::Error::other("Recovery backup must be outside the installation")); }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?; let source = entry.path(); let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() { copy_tree(&source, &target)?; }
        else if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(source)?, target)?;
            #[cfg(not(unix))]
            return Err(io::Error::other("Cannot back up a symbolic link"));
        } else { fs::copy(source, target)?; }
    }
    Ok(())
}
fn command(exe: &Path) -> Command {
    let mut c = Command::new(exe); c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(0x08000000); }
    c
}
// Called before Tauri initialization so the watchdog works even when the new app cannot initialize.
pub fn special_mode() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|a| a == "--pulse-version-file") {
        if let Some(path) = args.get(2) { let _ = fs::write(path, std::env::var("PULSE_COMPILED_VERSION").unwrap_or_default()); }
        return true;
    }
    if args.get(1).is_some_and(|a| a == "--pulse-update-watchdog") {
        if let Some(path) = args.get(2) { let _ = supervise(Path::new(path)); }
        return true;
    }
    false
}
pub fn supervise(path: &Path) -> io::Result<()> {
    let mut journal = Journal::load(path)?; journal.validate()?;
    // Only the preserved executable may supervise. It never loads credentials or runs collection threads.
    if fs::canonicalize(std::env::current_exe()?)? != fs::canonicalize(journal.backup.join(&journal.relative_exe))? { return Err(io::Error::other("Recovery executable mismatch")); }
    let exe = journal.install.join(&journal.relative_exe);
    let probe = path.with_extension("version"); let deadline = Instant::now() + Duration::from_secs(300);
    // NSIS is asynchronous and may still be replacing files after the old process exits.
    loop {
        if Journal::load(path).is_ok_and(|j| j.stage == "cancelled") { return Ok(()); }
        thread::sleep(Duration::from_secs(3));
        if let Ok(mut child) = command(&exe).arg("--pulse-version-file").arg(&probe).spawn() {
            let end = Instant::now() + Duration::from_secs(5);
            while child.try_wait()?.is_none() && Instant::now() < end { thread::sleep(Duration::from_millis(100)); }
            if child.try_wait()?.is_none() { let _ = child.kill(); let _ = child.wait(); }
            if fs::read_to_string(&probe).is_ok_and(|v| v == journal.target) { break; }
        }
        if Instant::now() > deadline {
            // A completely unlaunchable replacement cannot produce a version receipt. Preserve the failed
            // installation and restore the saved app rather than leaving the user with a closed, broken app.
            journal.stage = "install-failed".into(); journal.save(path)?;
            journal.restore(path)?; command(&exe).arg("--update-recovered").spawn()?;
            return Ok(());
        }
    }
    for attempt in 1..=2 {
        journal.stage = "starting".into(); journal.attempts = attempt; journal.save(path)?;
        let Ok(mut child) = command(&exe).arg("--update-boot").arg(path).spawn() else { continue; };
        let end = Instant::now() + Duration::from_secs(90);
        loop {
            thread::sleep(Duration::from_millis(500));
            if Journal::load(path).is_ok_and(|j| j.stage == "healthy") { return Ok(()); }
            if child.try_wait()?.is_some() { break; }
            if Instant::now() > end { child.kill()?; child.wait()?; break; }
        }
    }
    if journal.failed_twice() { journal.restore(path)?; command(&exe).arg("--update-recovered").spawn()?; }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn journal() -> Journal { Journal { previous:"0.3.1".into(),target:"0.3.2".into(), install:"/tmp/pulse-install".into(),backup:"/tmp/pulse-backup".into(),relative_exe:"pulse".into(),stage:"starting".into(),attempts:0 } }
    #[test] fn two_failed_starts_required() { let mut j=journal();j.attempts=1;assert!(!j.failed_twice());j.attempts=2;assert!(j.failed_twice());assert!(!j.acknowledge("0.3.1"));assert!(j.acknowledge("0.3.2"));assert!(!j.failed_twice()); }
    #[test] fn backup_must_be_outside_install_and_relative_exe_safe() { let mut j=journal();j.backup=j.install.join("backup");assert!(j.validate().is_err());j=journal();j.relative_exe="../someone-else".into();assert!(j.validate().is_err()); }
    #[test] fn copy_rejects_a_nested_backup_before_creating_it() {
        let root=std::env::temp_dir().join(format!("pulse-nested-backup-test-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();fs::write(root.join("pulse"),b"working-app").unwrap();
        assert!(copy_tree(&root,&root.join("previous")).is_err());
        assert!(!root.join("previous").exists());assert_eq!(fs::read(root.join("pulse")).unwrap(),b"working-app");
    }
    #[test] fn rollback_restores_previous_app_and_retains_failed_app_and_user_queue() {
        let root=std::env::temp_dir().join(format!("pulse-recovery-test-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&root).unwrap();
        let mut j=journal();j.install=root.join("installed");j.backup=root.join("previous");j.attempts=2;
        fs::create_dir_all(&j.install).unwrap();fs::create_dir_all(&j.backup).unwrap();
        fs::write(j.install.join("pulse"),b"broken-new").unwrap();fs::write(j.backup.join("pulse"),b"working-old").unwrap();fs::write(root.join("queue"),b"paired-offline-work").unwrap();
        let file=root.join("journal.json");j.save(&file).unwrap();j.restore(&file).unwrap();
        assert_eq!(fs::read(j.install.join("pulse")).unwrap(),b"working-old");assert_eq!(fs::read(root.join("queue")).unwrap(),b"paired-offline-work");
        assert!(fs::read_dir(root).unwrap().any(|e|e.unwrap().file_name().to_string_lossy().starts_with("Pulse-failed")));assert_eq!(Journal::load(&file).unwrap().stage,"rolled-back");
    }
}
