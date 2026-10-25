//! Keep the UI responsive while the OS asks permission to restore a saved credential.
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex, MutexGuard};

pub struct DeferredCredentials<T> {
    value: Mutex<Option<T>>,
    restoring: AtomicBool,
}
impl<T> Default for DeferredCredentials<T> {
    fn default() -> Self { Self { value: Mutex::new(None), restoring: AtomicBool::new(true) } }
}
impl<T> DeferredCredentials<T> {
    pub fn lock(&self) -> std::sync::LockResult<MutexGuard<'_, Option<T>>> { self.value.lock() }
    pub fn is_restoring(&self) -> bool { self.restoring.load(Ordering::SeqCst) }
    /// Call while holding the value lock when signing in, switching accounts, or signing out.
    pub fn invalidate_restore(&self) { self.restoring.store(false, Ordering::SeqCst); }
    pub fn finish_restore(&self, value: Option<T>) {
        let mut current = self.value.lock().unwrap();
        if self.restoring.swap(false, Ordering::SeqCst) { *current = value; }
    }
}
/// What a silent (no-prompt) read of one OS credential entry found.
#[derive(Debug, PartialEq)]
pub enum Lookup<T> { Found(T), Missing, Unreadable }

/// The calm message when macOS keeps an older build's saved sign-in locked: sign in again, never a prompt loop.
pub const SIGN_IN_AGAIN: &str = "Pulse was updated and macOS keeps your earlier sign-in locked to the old version. Sign in again once: your settings and saved work are kept, and later updates keep you signed in.";

/// Which saved sign-in to use after an update. The current entry (written by the stable signing identity) wins;
/// a readable entry from an earlier build is moved to the current entry; an unreadable one asks for a fresh
/// browser approval instead of an OS password prompt.
pub fn restore_choice<T>(current: Lookup<T>, legacy: impl FnOnce() -> Lookup<T>) -> (Option<T>, bool, Option<&'static str>) {
    match current {
        Lookup::Found(value) => (Some(value), false, None),
        Lookup::Unreadable => (None, false, Some(SIGN_IN_AGAIN)),
        Lookup::Missing => match legacy() {
            Lookup::Found(value) => (Some(value), true, None),
            Lookup::Missing => (None, false, None),
            Lookup::Unreadable => (None, false, Some(SIGN_IN_AGAIN)),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn waiting_for_os_permission_does_not_lock_the_loading_status() {
        let state = DeferredCredentials::<String>::default();
        let _locked = state.lock().unwrap();
        assert!(state.is_restoring());
    }
    #[test] fn old_restore_cannot_replace_a_new_sign_in() {
        let state = DeferredCredentials::default();
        { let mut live = state.lock().unwrap(); state.invalidate_restore(); *live = Some("new-account"); }
        state.finish_restore(Some("old-account"));
        assert_eq!(*state.lock().unwrap(), Some("new-account"));
        assert!(!state.is_restoring());
    }
    #[test] fn sign_out_cannot_be_undone_by_a_late_restore() {
        let state = DeferredCredentials::default();
        { let mut live = state.lock().unwrap(); state.invalidate_restore(); *live = None; }
        state.finish_restore(Some("signed-out-account"));
        assert_eq!(*state.lock().unwrap(), None);
        assert!(!state.is_restoring());
    }
    #[test] fn completed_restore_exposes_the_original_saved_account() {
        let state = DeferredCredentials::default();
        state.finish_restore(Some("saved-account"));
        assert_eq!(*state.lock().unwrap(), Some("saved-account"));
        assert!(!state.is_restoring());
    }
    #[test] fn current_entry_wins_without_touching_the_old_one() {
        let (value, migrate, notice) = restore_choice(Lookup::Found("v2"), || panic!("legacy must not be read"));
        assert_eq!((value, migrate, notice), (Some("v2"), false, None));
    }
    #[test] fn a_readable_old_entry_moves_to_the_current_identity() {
        assert_eq!(restore_choice(Lookup::Missing, || Lookup::Found("old")), (Some("old"), true, None));
    }
    #[test] fn a_locked_old_entry_asks_to_sign_in_again_instead_of_prompting() {
        assert_eq!(restore_choice::<&str>(Lookup::Missing, || Lookup::Unreadable), (None, false, Some(SIGN_IN_AGAIN)));
        assert_eq!(restore_choice::<&str>(Lookup::Unreadable, || Lookup::Missing), (None, false, Some(SIGN_IN_AGAIN)));
    }
    #[test] fn nothing_saved_is_a_plain_first_sign_in() {
        assert_eq!(restore_choice::<&str>(Lookup::Missing, || Lookup::Missing), (None, false, None));
    }
}
