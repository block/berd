pub mod acp;
pub(crate) mod acp_tools_reconciler;
pub(crate) mod app_data_migration;
pub(crate) mod berdctl_discovery;
#[cfg(feature = "block-builderbot")]
pub(crate) mod builderbot;
pub mod bundled_agents;
pub mod bundled_skills;
pub(crate) mod diagnostic_log;
pub(crate) mod dir_env;
pub mod distro_bundle;
pub(crate) mod e2e_mode;
pub(crate) mod env_key;
pub(crate) mod goose_config;
pub(crate) mod installation_cohort;
#[cfg(target_os = "macos")]
pub(crate) mod installer_media;
#[cfg_attr(
    not(any(
        feature = "block-automations",
        feature = "block-feedback",
        feature = "block-managed-connections",
        feature = "block-voice-dictation"
    )),
    allow(dead_code)
)]
pub(crate) mod kgoose;
#[cfg(feature = "block-feedback")]
pub(crate) mod log_export;
#[cfg_attr(not(feature = "block-feedback"), allow(dead_code))]
pub(crate) mod log_redaction;
pub(crate) mod managed_acp_tools;
pub(crate) mod managed_node;
pub mod path_env;
pub(crate) mod process;
pub(crate) mod remote_backend;
pub mod renderer_monitor;
pub mod shell_env;
#[cfg(feature = "block-automations")]
pub(crate) mod sse;
