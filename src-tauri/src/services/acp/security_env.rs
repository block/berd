use tokio::process::Command;

/// Applies distribution-owned security configuration to a spawned Goose server.
///
/// Public Berd does not configure an external classifier or security log sink.
/// Internal distributions may replace this module during their pinned build.
pub(super) fn apply(_command: &mut Command) {}
