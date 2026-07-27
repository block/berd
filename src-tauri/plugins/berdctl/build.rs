const COMMANDS: &[&str] = &["start", "stop", "status", "set_timeouts", "submit_result"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
