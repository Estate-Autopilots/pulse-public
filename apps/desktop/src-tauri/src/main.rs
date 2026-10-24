#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    std::env::set_var("PULSE_COMPILED_VERSION", env!("CARGO_PKG_VERSION"));
    if pulse_desktop_core::update_recovery::special_mode() { return; }
    if std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true")
        && std::env::var("GITHUB_REPOSITORY").as_deref() == Ok("Estate-Autopilots/pulse-companion")
        && std::env::var("PULSE_UPDATER_ACCEPTANCE_FAIL_VERSION").as_deref() == Ok(env!("CARGO_PKG_VERSION"))
        && std::env::args().any(|a| a == "--update-boot") { std::process::exit(1); }
    pulse_desktop_lib::run();
}
