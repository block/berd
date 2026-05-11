mod client;
mod sanitize;
mod stream_registry;

use crate::services::distro_bundle::DistroBundleState;
use client::{
    build_kgoose_sse_url, get_kgoose_messages_snapshot, open_kgoose_sse_stream, post_kgoose_json,
    read_kgoose_sse_chunk, CANCEL_LAST_USER_MESSAGE_ENDPOINT, CREATE_TILE_ENDPOINT,
    DELETE_TILE_ENDPOINT, GENERATE_CRON_SCHEDULE_ENDPOINT, GET_MESSAGES_SSE_ENDPOINT,
    GET_TILE_ENDPOINT, GET_TILE_RESULTS_ENDPOINT, GET_USER_TILES_ENDPOINT, PUSH_MESSAGES_ENDPOINT,
    UPDATE_TILE_ENDPOINT,
};
use sanitize::{
    is_builderbot_automation_type, sanitize_create_automation_tile_request,
    sanitize_push_automation_builder_messages_request, sanitize_update_automation_request,
    string_or_number_as_lowercase, trim_optional_string, trim_required_string,
    validate_last_event_id,
};
use serde::Serialize;
use serde_json::{json, Map, Value};
use stream_registry::AutomationStreamRegistry;
use tauri::{AppHandle, Emitter, Manager, State, Window};

use super::sse::SseDecoder;

pub const AUTOMATION_BUILDER_STREAM_EVENT: &str = "automation-builder-stream";

#[derive(Default)]
pub struct AutomationStreamState {
    // Keep Tauri-managed state at the command boundary instead of exposing the
    // registry implementation from lib.rs.
    registry: AutomationStreamRegistry,
}

impl AutomationStreamState {
    pub fn abort_all(&self) {
        self.registry.abort_all();
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationBuilderStreamPayload {
    stream_id: String,
    session_id: String,
    event: String,
    id: Option<String>,
    data: Option<Value>,
    error: Option<String>,
}

#[tauri::command]
pub async fn get_automation_tiles(state: State<'_, DistroBundleState>) -> Result<Value, String> {
    post_kgoose_json(
        state.inner(),
        GET_USER_TILES_ENDPOINT,
        json!({ "spaceId": null }),
    )
    .await
}

#[tauri::command]
pub async fn get_automation_tile(
    state: State<'_, DistroBundleState>,
    id: String,
) -> Result<Value, String> {
    let id = trim_required_string(&id, "automation id")?;
    post_kgoose_json(state.inner(), GET_TILE_ENDPOINT, json!({ "id": id })).await
}

#[tauri::command]
pub async fn get_automation_tile_results(
    state: State<'_, DistroBundleState>,
    tile_id: String,
) -> Result<Value, String> {
    let tile_id = trim_required_string(&tile_id, "automation id")?;
    post_kgoose_json(
        state.inner(),
        GET_TILE_RESULTS_ENDPOINT,
        json!({ "tileId": tile_id }),
    )
    .await
}

#[tauri::command]
pub async fn create_automation_tile(
    state: State<'_, DistroBundleState>,
    request: Value,
) -> Result<Value, String> {
    let request = sanitize_create_automation_tile_request(request)?;
    post_kgoose_json(state.inner(), CREATE_TILE_ENDPOINT, request).await
}

#[tauri::command]
pub async fn push_automation_builder_messages(
    state: State<'_, DistroBundleState>,
    request: Value,
) -> Result<Value, String> {
    let request = sanitize_push_automation_builder_messages_request(request)?;
    post_kgoose_json(state.inner(), PUSH_MESSAGES_ENDPOINT, request).await
}

#[tauri::command]
pub async fn cancel_automation_builder_message(
    state: State<'_, DistroBundleState>,
    session_id: String,
) -> Result<Value, String> {
    let session_id = trim_required_string(&session_id, "session id")?;
    post_kgoose_json(
        state.inner(),
        CANCEL_LAST_USER_MESSAGE_ENDPOINT,
        json!({ "sessionId": session_id }),
    )
    .await
}

#[tauri::command]
pub async fn start_automation_builder_stream(
    window: Window,
    distro_state: State<'_, DistroBundleState>,
    stream_state: State<'_, AutomationStreamState>,
    session_id: String,
    stream_id: String,
    last_event_id: Option<String>,
) -> Result<(), String> {
    let session_id = trim_required_string(&session_id, "session id")?;
    let stream_id = trim_required_string(&stream_id, "stream id")?;
    let url = build_kgoose_sse_url(
        GET_MESSAGES_SSE_ENDPOINT,
        &session_id,
        distro_state.inner().kgoose_config(),
    )?;
    let last_event_id = validate_last_event_id(last_event_id)?;

    let app = window.app_handle().clone();
    let window_label = window.label().to_string();
    let generation = stream_state.registry.next_generation();
    let task_stream_id = stream_id.clone();
    let task_session_id = session_id.clone();
    let cleanup_stream_id = stream_id.clone();
    let cleanup_registry = stream_state.registry.clone();

    stream_state
        .registry
        .replace_with_future(stream_id, generation, async move {
            if let Err(error) = stream_kgoose_messages(
                app.clone(),
                url,
                window_label.clone(),
                task_stream_id.clone(),
                task_session_id.clone(),
                last_event_id,
            )
            .await
            {
                if let Err(emit_error) = emit_stream_payload(
                    &app,
                    &window_label,
                    AutomationBuilderStreamPayload {
                        stream_id: task_stream_id,
                        session_id: task_session_id,
                        event: "error".to_string(),
                        id: None,
                        data: None,
                        error: Some(error),
                    },
                ) {
                    log::warn!("failed to emit automation stream error: {emit_error}");
                }
            }

            cleanup_registry.remove_if_generation(&cleanup_stream_id, generation);
        });

    Ok(())
}

#[tauri::command]
pub fn stop_automation_builder_stream(
    stream_state: State<'_, AutomationStreamState>,
    stream_id: String,
) -> Result<(), String> {
    let stream_id = trim_required_string(&stream_id, "stream id")?;
    stream_state.registry.abort(&stream_id);
    Ok(())
}

#[tauri::command]
pub async fn update_automation_tile(
    state: State<'_, DistroBundleState>,
    request: Value,
) -> Result<Value, String> {
    let request = sanitize_update_automation_request(request)?;
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "automation id must not be empty".to_string())?
        .to_string();
    ensure_generic_automation_tile(state.inner(), &id).await?;
    post_kgoose_json(state.inner(), UPDATE_TILE_ENDPOINT, request).await
}

#[tauri::command]
pub async fn delete_automation_tile(
    state: State<'_, DistroBundleState>,
    id: String,
) -> Result<Value, String> {
    let id = trim_required_string(&id, "automation id")?;
    ensure_generic_automation_tile(state.inner(), &id).await?;
    post_kgoose_json(state.inner(), DELETE_TILE_ENDPOINT, json!({ "id": id })).await
}

#[tauri::command]
pub async fn generate_automation_schedule(
    state: State<'_, DistroBundleState>,
    schedule_description: String,
    time_zone: Option<String>,
) -> Result<Value, String> {
    let schedule_description = trim_required_string(&schedule_description, "schedule description")?;
    let mut body = json!({ "scheduleDescription": schedule_description });
    if let Some(time_zone) = time_zone.as_deref().and_then(trim_optional_string) {
        body["timeZone"] = Value::String(time_zone);
    }
    post_kgoose_json(state.inner(), GENERATE_CRON_SCHEDULE_ENDPOINT, body).await
}

#[tauri::command]
pub async fn get_automation_session_messages(
    state: State<'_, DistroBundleState>,
    session_id: String,
) -> Result<Value, String> {
    let session_id = trim_required_string(&session_id, "session id")?;
    get_kgoose_messages_snapshot(state.inner(), &session_id).await
}

async fn ensure_generic_automation_tile(
    distro_state: &DistroBundleState,
    id: &str,
) -> Result<(), String> {
    let response = post_kgoose_json(distro_state, GET_TILE_ENDPOINT, json!({ "id": id })).await?;
    let tile = response
        .get("tileInfo")
        .or_else(|| response.get("tile_info"))
        .and_then(Value::as_object)
        .ok_or_else(|| "kgoose did not return tileInfo for automation".to_string())?;

    validate_generic_automation_tile(tile)
}

fn validate_generic_automation_tile(tile: &Map<String, Value>) -> Result<(), String> {
    let space_id = tile.get("spaceId").or_else(|| tile.get("space_id"));
    if !matches!(space_id, None | Some(Value::Null)) {
        return Err("Refusing to mutate a space-scoped tile as an automation".to_string());
    }

    let tile_type = tile
        .get("type")
        .and_then(string_or_number_as_lowercase)
        .ok_or_else(|| "kgoose did not return a valid tile type for automation".to_string())?;
    if is_builderbot_automation_type(&tile_type) {
        return Err("Refusing to mutate builderbot automations in goose-internal".to_string());
    }

    Ok(())
}

async fn stream_kgoose_messages(
    app: AppHandle,
    url: reqwest::Url,
    window_label: String,
    stream_id: String,
    session_id: String,
    last_event_id: Option<reqwest::header::HeaderValue>,
) -> Result<(), String> {
    let mut response = open_kgoose_sse_stream(url.clone(), last_event_id).await?;
    let mut decoder = SseDecoder::default();

    loop {
        let Some(chunk) = read_kgoose_sse_chunk(&mut response, &url).await? else {
            return Ok(());
        };

        for event in decoder.push_chunk(chunk.as_ref()) {
            let event_name = event.event.clone();
            let data = match parse_automation_sse_event_data(&event_name, &event.data) {
                Ok(data) => data,
                Err(error) => {
                    emit_stream_payload(
                        &app,
                        &window_label,
                        AutomationBuilderStreamPayload {
                            stream_id: stream_id.clone(),
                            session_id: session_id.clone(),
                            event: "warning".to_string(),
                            id: event.id,
                            data: None,
                            error: Some(error),
                        },
                    )?;
                    continue;
                }
            };
            emit_stream_payload(
                &app,
                &window_label,
                AutomationBuilderStreamPayload {
                    stream_id: stream_id.clone(),
                    session_id: session_id.clone(),
                    event: event.event,
                    id: event.id,
                    data,
                    error: None,
                },
            )?;

            if event_name == "completed" {
                return Ok(());
            }
        }
    }
}

fn parse_automation_sse_event_data(event: &str, data: &str) -> Result<Option<Value>, String> {
    let trimmed = data.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    match serde_json::from_str(trimmed) {
        Ok(value) => Ok(Some(value)),
        Err(error) if event == "messages" => {
            Err(format!("Failed to parse kgoose stream data: {error}"))
        }
        // Live streams may include non-json control events such as heartbeats.
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_automation_sse_event_data, validate_generic_automation_tile};
    use serde_json::json;

    #[test]
    fn rejects_tiles_without_valid_type_metadata() {
        let missing_type = json!({ "spaceId": null });
        let object_type = json!({ "type": { "name": "summary" }, "spaceId": null });

        assert!(validate_generic_automation_tile(missing_type.as_object().unwrap()).is_err());
        assert!(validate_generic_automation_tile(object_type.as_object().unwrap()).is_err());
    }

    #[test]
    fn rejects_builderbot_and_space_scoped_tiles() {
        let builderbot = json!({ "type": "TILE_TYPE_BUILDERBOT_AUTOMATION" });
        let space_scoped = json!({ "type": "summary", "spaceId": "space-1" });

        assert!(validate_generic_automation_tile(builderbot.as_object().unwrap()).is_err());
        assert!(validate_generic_automation_tile(space_scoped.as_object().unwrap()).is_err());
    }

    #[test]
    fn accepts_generic_automation_tiles() {
        let tile = json!({ "type": "summary", "spaceId": null });

        assert!(validate_generic_automation_tile(tile.as_object().unwrap()).is_ok());
    }

    #[test]
    fn only_requires_json_data_for_message_events() {
        assert_eq!(
            parse_automation_sse_event_data("heartbeat", "still alive").unwrap(),
            None
        );
        assert!(parse_automation_sse_event_data("messages", "still alive").is_err());
    }
}

fn emit_stream_payload(
    app: &AppHandle,
    window_label: &str,
    payload: AutomationBuilderStreamPayload,
) -> Result<(), String> {
    app.emit_to(window_label, AUTOMATION_BUILDER_STREAM_EVENT, payload)
        .map_err(|error| format!("Failed to emit automation builder stream event: {error}"))
}
