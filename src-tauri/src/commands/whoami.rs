use crate::commands::runtime_config::RuntimeConfigState;
use crate::services::{distro_bundle::DistroBundleState, kgoose::KgooseContext};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

const WHOAMI_ENDPOINT: &str = "v3/whoami";

/// Identity resolved by kgoose from the Cloudflare Access context. kgoose emits
/// snake_case keys; `caller_type` carries an alias so we still deserialize it,
/// and the whole struct serializes as camelCase to match the frontend's other
/// kgoose payloads. Every field is optional so a partial response never fails
/// to parse and the caller can treat a missing email as "no identity".
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoAmIResponse {
    #[serde(default)]
    pub creator: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub ldap: Option<String>,
    #[serde(default, alias = "caller_type")]
    pub caller_type: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// Resolves the calling user's identity via kgoose `v3/whoami`. Identity is
/// established at the network edge (Cloudflare WARP -> Access), so the request
/// carries an empty body and no application/session authorization headers. It
/// shares kgoose routing and network-access handling, but intentionally omits
/// the stored BuilderBot session credential used by enterprise product APIs.
/// Returns an error (never panics) on any network/parse/access failure; callers
/// treat that as "no identity".
pub(crate) async fn request_whoami(
    distro_state: &DistroBundleState,
    runtime_config: &crate::commands::runtime_config::RuntimeConfig,
) -> Result<WhoAmIResponse, String> {
    let kgoose = KgooseContext::new(distro_state, runtime_config);
    let response = kgoose
        .post_json_without_session_credential(WHOAMI_ENDPOINT, json!({}))
        .await?;
    serde_json::from_value(response)
        .map_err(|error| format!("Failed to parse whoami response: {error}"))
}

#[tauri::command]
pub async fn whoami(
    state: State<'_, DistroBundleState>,
    runtime_config_state: State<'_, RuntimeConfigState>,
) -> Result<WhoAmIResponse, String> {
    let runtime_config = runtime_config_state.ready_config(state.inner()).await?;
    request_whoami(state.inner(), &runtime_config).await
}
