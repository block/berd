use crate::services::{distro_bundle::DistroBundleState, kgoose};
use serde_json::{json, Value};
use tauri::State;

const FILE_ISSUE_ENDPOINT: &str = "feedback/v1/file-issue";
const FEEDBACK_PROJECT_KEY: &str = "goose-internal";
const NETWORK_ACCESS_MESSAGE: &str =
    "Unable to submit feedback. Please check that you're connected to Cloudflare WARP and try again.";
const SUBMIT_FAILED_MESSAGE: &str = "Failed to submit feedback";

#[tauri::command]
pub async fn submit_feedback_issue(
    state: State<'_, DistroBundleState>,
    title: String,
    description: String,
) -> Result<Value, Value> {
    let title = title.trim();
    if title.is_empty() {
        return Err(feedback_error(
            "validation",
            "Feedback title must not be empty",
        ));
    }
    let description = description.trim();
    if description.is_empty() {
        return Err(feedback_error(
            "validation",
            "Feedback description must not be empty",
        ));
    }

    let body = json!({
        "title": title,
        "description": description,
        "labelIds": [],
        "project_key": FEEDBACK_PROJECT_KEY,
    });

    kgoose::post_json_detailed(state.inner(), FILE_ISSUE_ENDPOINT, body)
        .await
        .map_err(|error| {
            let (code, message) = if error.is_likely_access_failure() {
                ("networkAccess", NETWORK_ACCESS_MESSAGE)
            } else {
                ("submitFailed", SUBMIT_FAILED_MESSAGE)
            };
            log_feedback_failure(FILE_ISSUE_ENDPOINT, code, &error);
            feedback_error(code, message)
        })
}

fn feedback_error(code: &str, message: &str) -> Value {
    json!({ "code": code, "message": message })
}

fn log_feedback_failure(endpoint: &str, code: &str, kgoose_error: &kgoose::KgooseJsonError) {
    let status = kgoose_error
        .status()
        .map(|status| status.as_u16().to_string())
        .unwrap_or_else(|| "none".to_string());
    let content_type = kgoose_error.content_type().unwrap_or("none");
    let request_error_category = kgoose_error
        .request_error_kind()
        .map(kgoose::KgooseRequestErrorKind::as_str)
        .unwrap_or("none");

    log::warn!(
        "feedback submission failed: failure_kind={} endpoint={} kgoose_error_kind={} status={} content_type={} request_error_category={}",
        code,
        endpoint,
        kgoose_error.kind(),
        status,
        content_type,
        request_error_category
    );
}
