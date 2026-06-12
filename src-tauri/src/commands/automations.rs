mod sanitize;
mod stream_registry;

use crate::services::{
    distro_bundle::DistroBundleState,
    kgoose::{self, build_sse_url, open_sse_stream, read_sse_chunk},
    sse::{SseDecoder, SseMessage},
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
use tokio::time::{timeout, Duration};

pub const AUTOMATION_BUILDER_STREAM_EVENT: &str = "automation-builder-stream";

const CANCEL_LAST_USER_MESSAGE_ENDPOINT: &str = "v3/cancel-last-user-message";
const CREATE_TILE_ENDPOINT: &str = "v3/create-tile";
const DELETE_TILE_ENDPOINT: &str = "v3/delete-tile";
const GENERATE_CRON_SCHEDULE_ENDPOINT: &str = "v3/generate-cron-schedule";
const GET_MESSAGES_SSE_ENDPOINT: &str = "v3/get-messages-sse";
const GET_TILE_ENDPOINT: &str = "v3/get-tile";
const GET_TILE_RESULTS_ENDPOINT: &str = "v3/get-tile-results";
const GET_USER_TILES_ENDPOINT: &str = "v3/get-user-tiles";
const KGOOSE_MESSAGES_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);
const PUSH_MESSAGES_ENDPOINT: &str = "v3/push-messages";
const REFRESH_TILE_ENDPOINT: &str = "v3/refresh-tile";
const UPDATE_TILE_ENDPOINT: &str = "v3/update-tile";
const NON_GENERIC_AUTOMATION_TILE_ERROR: &str =
    "Changes can't be made because expected an automation but found a tile";
const DELETE_UNMANAGED_AUTOMATION_ERROR: &str =
    "This automation can't be deleted because it isn't managed by Goose";

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
    kgoose::post_json(
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
    kgoose::post_json(state.inner(), GET_TILE_ENDPOINT, json!({ "id": id })).await
}

#[tauri::command]
pub async fn get_automation_tile_results(
    state: State<'_, DistroBundleState>,
    tile_id: String,
) -> Result<Value, String> {
    let tile_id = trim_required_string(&tile_id, "automation id")?;
    kgoose::post_json(
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
    kgoose::post_json(state.inner(), CREATE_TILE_ENDPOINT, request).await
}

#[tauri::command]
pub async fn push_automation_builder_messages(
    state: State<'_, DistroBundleState>,
    request: Value,
) -> Result<Value, String> {
    let request = sanitize_push_automation_builder_messages_request(request)?;
    kgoose::post_json(state.inner(), PUSH_MESSAGES_ENDPOINT, request).await
}

#[tauri::command]
pub async fn cancel_automation_builder_message(
    state: State<'_, DistroBundleState>,
    session_id: String,
) -> Result<Value, String> {
    let session_id = trim_required_string(&session_id, "session id")?;
    kgoose::post_json(
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
    let url = build_sse_url(
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
    ensure_generic_automation_tile(state.inner(), &id, NON_GENERIC_AUTOMATION_TILE_ERROR).await?;
    kgoose::post_json(state.inner(), UPDATE_TILE_ENDPOINT, request).await
}

#[tauri::command]
pub async fn delete_automation_tile(
    state: State<'_, DistroBundleState>,
    id: String,
) -> Result<Value, String> {
    let id = trim_required_string(&id, "automation id")?;
    ensure_generic_automation_tile(state.inner(), &id, DELETE_UNMANAGED_AUTOMATION_ERROR).await?;
    kgoose::post_json(state.inner(), DELETE_TILE_ENDPOINT, json!({ "id": id })).await
}

#[tauri::command]
pub async fn refresh_automation_tile(
    state: State<'_, DistroBundleState>,
    id: String,
) -> Result<Value, String> {
    let id = trim_required_string(&id, "automation id")?;
    ensure_generic_automation_tile(state.inner(), &id, NON_GENERIC_AUTOMATION_TILE_ERROR).await?;
    kgoose::post_json(state.inner(), REFRESH_TILE_ENDPOINT, json!({ "id": id })).await
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
    kgoose::post_json(state.inner(), GENERATE_CRON_SCHEDULE_ENDPOINT, body).await
}

#[tauri::command]
pub async fn get_automation_session_messages(
    state: State<'_, DistroBundleState>,
    session_id: String,
) -> Result<Value, String> {
    let session_id = trim_required_string(&session_id, "session id")?;
    get_automation_messages_snapshot(state.inner(), &session_id).await
}

async fn ensure_generic_automation_tile(
    distro_state: &DistroBundleState,
    id: &str,
    non_generic_error: &str,
) -> Result<(), String> {
    let response = kgoose::post_json(distro_state, GET_TILE_ENDPOINT, json!({ "id": id })).await?;
    let tile = response
        .get("tileInfo")
        .or_else(|| response.get("tile_info"))
        .and_then(Value::as_object)
        .ok_or_else(|| "kgoose did not return tileInfo for automation".to_string())?;

    validate_generic_automation_tile(tile, non_generic_error)
}

fn validate_generic_automation_tile(
    tile: &Map<String, Value>,
    non_generic_error: &str,
) -> Result<(), String> {
    if !is_generic_automation_space_id(tile.get("spaceId"))
        || !is_generic_automation_space_id(tile.get("space_id"))
    {
        return Err(non_generic_error.to_string());
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

fn is_generic_automation_space_id(space_id: Option<&Value>) -> bool {
    match space_id {
        None | Some(Value::Null) => true,
        Some(Value::String(space_id)) => space_id.is_empty(),
        Some(_) => false,
    }
}

async fn stream_kgoose_messages(
    app: AppHandle,
    url: reqwest::Url,
    window_label: String,
    stream_id: String,
    session_id: String,
    last_event_id: Option<reqwest::header::HeaderValue>,
) -> Result<(), String> {
    let mut response = open_sse_stream(url.clone(), last_event_id).await?;
    let mut decoder = SseDecoder::default();

    loop {
        let Some(chunk) = read_sse_chunk(&mut response, &url).await? else {
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

async fn get_automation_messages_snapshot(
    distro_state: &DistroBundleState,
    session_id: &str,
) -> Result<Value, String> {
    timeout(KGOOSE_MESSAGES_SNAPSHOT_TIMEOUT, async {
        let mut url = build_sse_url(
            GET_MESSAGES_SSE_ENDPOINT,
            session_id,
            distro_state.kgoose_config(),
        )?;
        url.query_pairs_mut()
            .append_pair("update_last_read_at", "false");

        let mut response = open_sse_stream(url.clone(), None).await?;
        let mut decoder = SseDecoder::default();
        while let Some(chunk) = read_sse_chunk(&mut response, &url).await? {
            for event in decoder.push_chunk(&chunk) {
                if let Some(payload) = automation_messages_payload_from_sse_message(&event)? {
                    return Ok(payload);
                }
            }
        }

        Err("kgoose messages stream ended before returning session messages".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for kgoose session messages".to_string())?
}

fn automation_messages_payload_from_sse_message(
    event: &SseMessage,
) -> Result<Option<Value>, String> {
    if event.event != "messages" || event.data.is_empty() {
        return Ok(None);
    }

    let payload: Value = serde_json::from_str(&event.data)
        .map_err(|error| format!("Failed to parse kgoose SSE event: {error}"))?;

    // kgoose has sent both proto/snake casing and generated/camel casing across
    // clients; keep accepting both at this automation boundary.
    if payload.get("get_messages_response").is_some()
        || payload.get("getMessagesResponse").is_some()
    {
        Ok(Some(payload))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        automation_messages_payload_from_sse_message, parse_automation_sse_event_data,
        validate_generic_automation_tile, DELETE_UNMANAGED_AUTOMATION_ERROR,
        NON_GENERIC_AUTOMATION_TILE_ERROR,
    };
    use crate::services::sse::SseMessage;
    use serde_json::json;

    fn validate_tile(tile: &serde_json::Value) -> Result<(), String> {
        validate_generic_automation_tile(
            tile.as_object().unwrap(),
            NON_GENERIC_AUTOMATION_TILE_ERROR,
        )
    }

    #[test]
    fn rejects_tiles_without_valid_type_metadata() {
        let missing_type = json!({ "spaceId": null });
        let object_type = json!({ "type": { "name": "summary" }, "spaceId": null });

        assert!(validate_tile(&missing_type).is_err());
        assert!(validate_tile(&object_type).is_err());
    }

    #[test]
    fn rejects_builderbot_and_space_scoped_tiles() {
        let builderbot = json!({ "type": "TILE_TYPE_BUILDERBOT_AUTOMATION" });
        let space_scoped_camel = json!({ "type": "summary", "spaceId": "space-1" });
        let space_scoped_snake = json!({ "type": "summary", "space_id": "space-1" });

        assert!(validate_tile(&builderbot).is_err());
        assert!(validate_tile(&space_scoped_camel).is_err());
        assert!(validate_tile(&space_scoped_snake).is_err());
    }

    #[test]
    fn uses_delete_error_for_space_scoped_tiles() {
        let space_scoped = json!({ "type": "summary", "spaceId": "space-1" });

        assert_eq!(
            validate_generic_automation_tile(
                space_scoped.as_object().unwrap(),
                DELETE_UNMANAGED_AUTOMATION_ERROR,
            ),
            Err(DELETE_UNMANAGED_AUTOMATION_ERROR.to_string())
        );
    }

    #[test]
    fn accepts_generic_automation_tiles() {
        let missing_space_id = json!({ "type": "summary" });
        let null_space_id = json!({ "type": "summary", "spaceId": null });

        assert!(validate_tile(&missing_space_id).is_ok());
        assert!(validate_tile(&null_space_id).is_ok());
    }

    #[test]
    fn accepts_empty_string_space_id_as_generic_automation_tile() {
        let empty_camel_space_id = json!({ "type": "summary", "spaceId": "" });
        let empty_snake_space_id = json!({ "type": "summary", "space_id": "" });

        assert!(validate_tile(&empty_camel_space_id).is_ok());
        assert!(validate_tile(&empty_snake_space_id).is_ok());
    }

    #[test]
    fn only_requires_json_data_for_message_events() {
        assert_eq!(
            parse_automation_sse_event_data("heartbeat", "still alive").unwrap(),
            None
        );
        assert!(parse_automation_sse_event_data("messages", "still alive").is_err());
    }

    #[test]
    fn extracts_only_full_messages_sse_payloads() {
        let delta = SseMessage {
            id: None,
            event: "messages".to_string(),
            data: "{\"delta_message_content\":{\"streaming_message_id\":\"msg-1\"}}".to_string(),
        };
        assert!(automation_messages_payload_from_sse_message(&delta)
            .unwrap()
            .is_none());

        let snapshot = SseMessage {
            id: None,
            event: "messages".to_string(),
            data: "{\"get_messages_response\":{\"messages\":[{\"id\":\"msg-1\"}]}}".to_string(),
        };
        assert_eq!(
            automation_messages_payload_from_sse_message(&snapshot).unwrap(),
            Some(json!({
                "get_messages_response": {
                    "messages": [{ "id": "msg-1" }]
                }
            }))
        );
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
