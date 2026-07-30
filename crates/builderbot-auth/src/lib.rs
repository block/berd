//! Shared BuilderBot auth and org-routing primitives.

pub mod auth;
#[cfg(feature = "blocking-client")]
pub mod auth_login;
pub mod auth_storage;
pub mod config;
#[cfg(target_os = "macos")]
pub mod keychain;
pub mod org_routing;
pub mod preferences;
#[cfg(feature = "blocking-client")]
pub mod workspace;

pub use auth::SESSION_CREDENTIAL_HEADER;
