use crate::services::kgoose::KgooseContext;
use serde_json::Value;

const LIST_OAUTH_EXTENSIONS_ENDPOINT: &str = "list-oauth-extensions";

pub(super) async fn post_kgoose_json(
    kgoose: &KgooseContext<'_>,
    endpoint: &str,
    body: Value,
) -> Result<Value, String> {
    // TODO(connect-in-app): forward Auth0 G2 JWT — see kgoose note. Until the
    // backend wires that up, parity with automations endpoints means going
    // unauthenticated here.
    kgoose.post_json(endpoint, body).await
}

pub(super) async fn list_oauth_extensions(kgoose: &KgooseContext<'_>) -> Result<Value, String> {
    post_kgoose_json(
        kgoose,
        LIST_OAUTH_EXTENSIONS_ENDPOINT,
        Value::Object(Default::default()),
    )
    .await
}
