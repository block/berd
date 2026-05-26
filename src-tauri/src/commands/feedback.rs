use crate::services::{distro_bundle::DistroBundleState, kgoose};
use serde_json::{json, Value};
use tauri::State;

const FILE_ISSUE_ENDPOINT: &str = "feedback/v1/file-issue";
const FEEDBACK_PROJECT_KEY: &str = "goose-internal";

#[tauri::command]
pub async fn submit_feedback_issue(
    state: State<'_, DistroBundleState>,
    title: String,
    description: String,
) -> Result<Value, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Feedback title must not be empty".to_string());
    }
    let description = description.trim();
    if description.is_empty() {
        return Err("Feedback description must not be empty".to_string());
    }

    let body = json!({
        "title": title,
        "description": description,
        "labelIds": [],
        "project_key": FEEDBACK_PROJECT_KEY,
    });

    kgoose::post_json(state.inner(), FILE_ISSUE_ENDPOINT, body).await
}
