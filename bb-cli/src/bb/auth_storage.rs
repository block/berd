use anyhow::Result;

pub use builderbot_auth::auth_storage::{
    default_session_storage_for_bb_home, stored_session_credential_header_value,
    stored_session_credential_header_value_for_kgoose_base_url, SessionCredentialStorage,
    SessionStorageKey,
};

use super::skills_config::SkillsConfig;

pub fn default_session_storage(config: &SkillsConfig) -> Result<Box<dyn SessionCredentialStorage>> {
    default_session_storage_for_bb_home(config.bb_home.clone())
}

pub fn session_storage_key_from_config(config: &SkillsConfig) -> SessionStorageKey {
    SessionStorageKey::from_profile_and_kgoose_base_url(
        config.profile.clone(),
        &config.kgoose_base_url,
        &config.kgoose_service_path,
    )
}
