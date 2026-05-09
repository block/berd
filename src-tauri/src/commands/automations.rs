use std::{
    collections::HashMap,
    env, str,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use crate::services::distro_bundle::{DistroBundleState, KgooseDistroConfig};
use futures_util::StreamExt;
use reqwest::header::{HeaderValue, ACCEPT, CACHE_CONTROL, CONTENT_TYPE};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::task::JoinHandle;
use tokio::time::timeout;

const KGOOSE_AUTOMATIONS_BASE_URL_ENV: &str = "GOOSE_INTERNAL_KGOOSE_BASE_URL";
const KGOOSE_AUTOMATIONS_PATH_ENV: &str = "GOOSE_INTERNAL_KGOOSE_PATH";
const DEFAULT_KGOOSE_BASE_URL: &str = "https://kgoose.stage.sqprod.co/";
const DEFAULT_KGOOSE_PATH: &str = "cash-app/goose";
const GET_USER_TILES_ENDPOINT: &str = "v3/get-user-tiles";
const GET_TILE_ENDPOINT: &str = "v3/get-tile";
const GET_TILE_RESULTS_ENDPOINT: &str = "v3/get-tile-results";
const CREATE_TILE_ENDPOINT: &str = "v3/create-tile";
const PUSH_MESSAGES_ENDPOINT: &str = "v3/push-messages";
const CANCEL_LAST_USER_MESSAGE_ENDPOINT: &str = "v3/cancel-last-user-message";
const GET_MESSAGES_SSE_ENDPOINT: &str = "v3/get-messages-sse";
pub const AUTOMATION_BUILDER_STREAM_EVENT: &str = "automation-builder-stream";
const UPDATE_TILE_ENDPOINT: &str = "v3/update-tile";
const DELETE_TILE_ENDPOINT: &str = "v3/delete-tile";
const GENERATE_CRON_SCHEDULE_ENDPOINT: &str = "v3/generate-cron-schedule";
const MAX_ERROR_BODY_CHARS: usize = 500;
const KGOOSE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const KGOOSE_JSON_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const KGOOSE_SSE_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const KGOOSE_MESSAGES_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct AutomationStreamState {
    tasks: Arc<Mutex<HashMap<String, AutomationStreamTask>>>,
    next_generation: AtomicU64,
}

struct AutomationStreamTask {
    generation: u64,
    handle: JoinHandle<()>,
}

impl AutomationStreamState {
    pub fn abort_all(&self) {
        let tasks = self
            .tasks
            .lock()
            .expect("automation stream task mutex poisoned")
            .drain()
            .map(|(_, task)| task.handle)
            .collect::<Vec<_>>();
        for task in tasks {
            task.abort();
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SseMessage {
    id: Option<String>,
    event: String,
    data: String,
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
    let id = validate_id(id, "automation id")?;
    post_kgoose_json(state.inner(), GET_TILE_ENDPOINT, json!({ "id": id })).await
}

#[tauri::command]
pub async fn get_automation_tile_results(
    state: State<'_, DistroBundleState>,
    tile_id: String,
) -> Result<Value, String> {
    let tile_id = validate_id(tile_id, "automation id")?;
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
    let session_id = validate_id(session_id, "session id")?;
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
    let session_id = validate_id(session_id, "session id")?;
    let stream_id = validate_id(stream_id, "stream id")?;
    let url = build_kgoose_sse_url(
        GET_MESSAGES_SSE_ENDPOINT,
        &session_id,
        distro_state.inner().kgoose_config(),
    )?;
    let last_event_id = validate_last_event_id(last_event_id)?;

    let existing_task = stream_state
        .tasks
        .lock()
        .expect("automation stream task mutex poisoned")
        .remove(&stream_id)
        .map(|task| task.handle);
    if let Some(existing_task) = existing_task {
        existing_task.abort();
    }

    let app = window.app_handle().clone();
    let window_label = window.label().to_string();
    let generation = stream_state.next_generation.fetch_add(1, Ordering::Relaxed);
    let tasks = Arc::clone(&stream_state.tasks);
    let task_stream_id = stream_id.clone();
    let task_session_id = session_id.clone();
    let cleanup_stream_id = stream_id.clone();
    let task = tokio::spawn(async move {
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
            let _ = emit_stream_payload(
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
            );
        }

        // Completed tasks must only clear their own map entry; a newer stream
        // for the same id may have replaced this task while it was finishing.
        let mut active_tasks = tasks.lock().expect("automation stream task mutex poisoned");
        if active_tasks
            .get(&cleanup_stream_id)
            .is_some_and(|task| task.generation == generation)
        {
            active_tasks.remove(&cleanup_stream_id);
        }
    });
    stream_state
        .tasks
        .lock()
        .expect("automation stream task mutex poisoned")
        .insert(
            stream_id,
            AutomationStreamTask {
                generation,
                handle: task,
            },
        );

    Ok(())
}

#[tauri::command]
pub async fn stop_automation_builder_stream(
    stream_state: State<'_, AutomationStreamState>,
    stream_id: String,
) -> Result<(), String> {
    let stream_id = validate_id(stream_id, "stream id")?;
    let task = stream_state
        .tasks
        .lock()
        .expect("automation stream task mutex poisoned")
        .remove(&stream_id)
        .map(|task| task.handle);
    if let Some(task) = task {
        task.abort();
    }
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
    let id = validate_id(id, "automation id")?;
    ensure_generic_automation_tile(state.inner(), &id).await?;
    post_kgoose_json(state.inner(), DELETE_TILE_ENDPOINT, json!({ "id": id })).await
}

#[tauri::command]
pub async fn generate_automation_schedule(
    state: State<'_, DistroBundleState>,
    schedule_description: String,
    time_zone: Option<String>,
) -> Result<Value, String> {
    let schedule_description = validate_id(schedule_description, "schedule description")?;
    let mut body = json!({ "scheduleDescription": schedule_description });
    if let Some(time_zone) = time_zone.as_deref().and_then(trim_non_empty) {
        body["timeZone"] = Value::String(time_zone);
    }
    post_kgoose_json(state.inner(), GENERATE_CRON_SCHEDULE_ENDPOINT, body).await
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

    let space_id = tile.get("spaceId").or_else(|| tile.get("space_id"));
    if !matches!(space_id, None | Some(Value::Null)) {
        return Err("Refusing to mutate a space-scoped tile as an automation".to_string());
    }

    let tile_type = tile
        .get("type")
        .and_then(type_as_string)
        .unwrap_or_default();
    if is_builderbot_automation_type(&tile_type) {
        return Err("Refusing to mutate builderbot automations in goose-internal".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn get_automation_session_messages(
    state: State<'_, DistroBundleState>,
    session_id: String,
) -> Result<Value, String> {
    let session_id = validate_id(session_id, "session id")?;
    get_kgoose_messages_snapshot(state.inner(), &session_id).await
}

async fn post_kgoose_json(
    distro_state: &DistroBundleState,
    endpoint: &str,
    body: Value,
) -> Result<Value, String> {
    let url = build_kgoose_url(endpoint, distro_state.kgoose_config())?;
    let response = kgoose_client()
        .post(url.clone())
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .timeout(KGOOSE_JSON_REQUEST_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Failed to call kgoose at {}: {error}", url.as_str()))?;

    let status = response.status();
    let response_body = response.text().await.map_err(|error| {
        format!(
            "Failed to read kgoose response from {}: {error}",
            url.as_str()
        )
    })?;

    if !status.is_success() {
        return Err(format!(
            "kgoose request to {} failed with {}: {}",
            url.as_str(),
            status,
            truncate_error_body(&response_body)
        ));
    }

    serde_json::from_str(&response_body).map_err(|error| {
        format!(
            "Failed to parse kgoose response from {}: {error}",
            url.as_str()
        )
    })
}

async fn stream_kgoose_messages(
    app: AppHandle,
    url: reqwest::Url,
    window_label: String,
    stream_id: String,
    session_id: String,
    last_event_id: Option<HeaderValue>,
) -> Result<(), String> {
    let mut request = kgoose_client()
        .get(url.clone())
        .header(ACCEPT, "text/event-stream")
        .header(CACHE_CONTROL, "no-cache");
    if let Some(last_event_id) = last_event_id {
        request = request.header("Last-Event-ID", last_event_id);
    }

    let mut response = request
        .send()
        .await
        .map_err(|error| format!("Failed to open kgoose stream at {}: {error}", url.as_str()))?;
    let status = response.status();
    if !status.is_success() {
        let response_body = response.text().await.unwrap_or_default();
        return Err(format!(
            "kgoose stream to {} failed with {}: {}",
            url.as_str(),
            status,
            truncate_error_body(&response_body)
        ));
    }

    let mut decoder = SseDecoder::default();
    loop {
        let chunk = tokio::time::timeout(KGOOSE_SSE_IDLE_TIMEOUT, response.chunk())
            .await
            .map_err(|_| {
                format!(
                    "Timed out waiting for kgoose stream data from {}",
                    url.as_str()
                )
            })?
            .map_err(|error| {
                format!(
                    "Failed to read kgoose stream from {}: {error}",
                    url.as_str()
                )
            })?;
        let Some(chunk) = chunk else {
            return Ok(());
        };

        for event in decoder.push_chunk(&chunk) {
            let event_name = event.event.clone();
            let data = match parse_sse_event_data(&event_name, &event.data) {
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

fn build_kgoose_sse_url(
    endpoint: &str,
    session_id: &str,
    distro_config: Option<&KgooseDistroConfig>,
) -> Result<reqwest::Url, String> {
    let mut url = build_kgoose_url(endpoint, distro_config)?;
    url.query_pairs_mut().append_pair("session_id", session_id);
    Ok(url)
}

fn emit_stream_payload(
    app: &AppHandle,
    window_label: &str,
    payload: AutomationBuilderStreamPayload,
) -> Result<(), String> {
    app.emit_to(window_label, AUTOMATION_BUILDER_STREAM_EVENT, payload)
        .map_err(|error| format!("Failed to emit automation builder stream event: {error}"))
}

fn kgoose_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(KGOOSE_CONNECT_TIMEOUT)
            .build()
            .expect("failed to build kgoose HTTP client")
    })
}

async fn get_kgoose_messages_snapshot(
    distro_state: &DistroBundleState,
    session_id: &str,
) -> Result<Value, String> {
    let mut url = build_kgoose_url(GET_MESSAGES_SSE_ENDPOINT, distro_state.kgoose_config())?;
    url.query_pairs_mut()
        .append_pair("session_id", session_id)
        .append_pair("update_last_read_at", "false");

    let response = reqwest::Client::new()
        .get(url.clone())
        .header(ACCEPT, "text/event-stream")
        .header(CACHE_CONTROL, "no-cache")
        .send()
        .await
        .map_err(|error| format!("Failed to call kgoose at {}: {error}", url.as_str()))?;

    let status = response.status();
    if !status.is_success() {
        let response_body = response.text().await.map_err(|error| {
            format!(
                "Failed to read kgoose response from {}: {error}",
                url.as_str()
            )
        })?;
        return Err(format!(
            "kgoose request to {} failed with {}: {}",
            url.as_str(),
            status,
            truncate_error_body(&response_body)
        ));
    }

    timeout(KGOOSE_MESSAGES_SNAPSHOT_TIMEOUT, async {
        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|error| format!("Failed to read kgoose SSE stream: {error}"))?;
            buffer.extend_from_slice(&chunk);

            while let Some(event) = take_next_sse_event(&mut buffer)? {
                if let Some(payload) = messages_payload_from_sse_event(&event)? {
                    return Ok(payload);
                }
            }
        }

        Err("kgoose messages stream ended before returning session messages".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for kgoose session messages".to_string())?
}

fn validate_id(value: String, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    Ok(trimmed.to_string())
}

fn validate_last_event_id(value: Option<String>) -> Result<Option<HeaderValue>, String> {
    value
        .and_then(|value| trim_non_empty(&value))
        .map(|value| {
            HeaderValue::from_str(&value)
                .map_err(|error| format!("Last-Event-ID is invalid: {error}"))
        })
        .transpose()
}

fn sanitize_update_automation_request(request: Value) -> Result<Value, String> {
    let object = request
        .as_object()
        .ok_or_else(|| "update automation request must be an object".to_string())?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .and_then(trim_non_empty)
        .ok_or_else(|| "automation id must not be empty".to_string())?;

    let mut sanitized = Map::new();
    sanitized.insert("id".to_string(), Value::String(id));

    if let Some(title) = trimmed_string_field(object, "title") {
        sanitized.insert("title".to_string(), Value::String(title));
    }

    if bool_value(object.get("updateSchedule")) {
        sanitized.insert("updateSchedule".to_string(), Value::Bool(true));
        if let Some(schedule) = non_empty_string_field(object, "schedule") {
            sanitized.insert("schedule".to_string(), Value::String(schedule));
        }
        if let Some(time_zone) = non_empty_string_field(object, "timeZone") {
            sanitized.insert("timeZone".to_string(), Value::String(time_zone));
        }
    }

    if bool_value(object.get("updateInstructions")) {
        let instructions = object
            .get("instructions")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                "instructions must be an array when updateInstructions is true".to_string()
            })?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .and_then(trim_non_empty)
                    .ok_or_else(|| "instructions must contain only non-empty strings".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if instructions.is_empty() {
            return Err(
                "instructions must not be empty when updateInstructions is true".to_string(),
            );
        }

        sanitized.insert("updateInstructions".to_string(), Value::Bool(true));
        sanitized.insert(
            "instructions".to_string(),
            Value::Array(instructions.into_iter().map(Value::String).collect()),
        );
    }

    if let Some(enable_notifications) = object.get("enableNotifications").and_then(Value::as_bool) {
        sanitized.insert(
            "enableNotifications".to_string(),
            Value::Bool(enable_notifications),
        );
    }

    if sanitized.len() == 1 {
        return Err("At least one automation field must be provided for update".to_string());
    }

    Ok(Value::Object(sanitized))
}

fn trimmed_string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_string)
}

fn non_empty_string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .and_then(trim_non_empty)
}

fn bool_value(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

fn type_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.to_lowercase()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn is_builderbot_automation_type(value: &str) -> bool {
    matches!(
        value,
        "18" | "builderbot_automation" | "tile_type_builderbot_automation"
    )
}

fn build_kgoose_url(
    endpoint: &str,
    distro_config: Option<&KgooseDistroConfig>,
) -> Result<reqwest::Url, String> {
    let base_url = config_value(
        KGOOSE_AUTOMATIONS_BASE_URL_ENV,
        distro_config.and_then(|config| config.base_url.as_deref()),
        DEFAULT_KGOOSE_BASE_URL,
    );
    let path_prefix = config_value(
        KGOOSE_AUTOMATIONS_PATH_ENV,
        distro_config.and_then(|config| config.path.as_deref()),
        DEFAULT_KGOOSE_PATH,
    );

    let mut url = reqwest::Url::parse(&ensure_trailing_slash(&base_url))
        .map_err(|error| format!("Invalid {KGOOSE_AUTOMATIONS_BASE_URL_ENV}: {error}"))?;

    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "{KGOOSE_AUTOMATIONS_BASE_URL_ENV} must use http or https"
        ));
    }

    let path = [url.path(), path_prefix.as_str(), endpoint]
        .into_iter()
        .map(|segment| segment.trim_matches('/'))
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    url.set_path(&path);

    Ok(url)
}

fn config_value(name: &str, distro_value: Option<&str>, default: &str) -> String {
    env_value(name)
        .or_else(|| distro_value.and_then(trim_non_empty))
        .unwrap_or_else(|| default.to_string())
}

fn env_value(name: &str) -> Option<String> {
    env::var(name).ok().and_then(|value| trim_non_empty(&value))
}

fn trim_non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn take_next_sse_event(buffer: &mut Vec<u8>) -> Result<Option<String>, String> {
    let lf_index = find_bytes(buffer, b"\n\n").map(|index| (index, 2));
    let crlf_index = find_bytes(buffer, b"\r\n\r\n").map(|index| (index, 4));
    let (index, separator_len) = match (lf_index, crlf_index) {
        (Some(lf), Some(crlf)) => {
            if lf.0 < crlf.0 {
                lf
            } else {
                crlf
            }
        }
        (Some(lf), None) => lf,
        (None, Some(crlf)) => crlf,
        (None, None) => return Ok(None),
    };

    let event = String::from_utf8(buffer[..index].to_vec())
        .map_err(|error| format!("Failed to decode kgoose SSE event: {error}"))?;
    buffer.drain(..index + separator_len);
    Ok(Some(event))
}

fn find_bytes(buffer: &[u8], pattern: &[u8]) -> Option<usize> {
    buffer
        .windows(pattern.len())
        .position(|window| window == pattern)
}

fn messages_payload_from_sse_event(event: &str) -> Result<Option<Value>, String> {
    let mut event_name = "message";
    let mut data_lines = Vec::new();

    for raw_line in event.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(':') {
            continue;
        }

        let (field, value) = line
            .split_once(':')
            .map(|(field, value)| (field, value.strip_prefix(' ').unwrap_or(value)))
            .unwrap_or((line, ""));

        match field {
            "event" => event_name = value,
            "data" => data_lines.push(value),
            _ => {}
        }
    }

    if event_name != "messages" || data_lines.is_empty() {
        return Ok(None);
    }

    let data = data_lines.join("\n");
    let payload: Value = serde_json::from_str(&data)
        .map_err(|error| format!("Failed to parse kgoose SSE event: {error}"))?;

    if payload.get("get_messages_response").is_some()
        || payload.get("getMessagesResponse").is_some()
    {
        Ok(Some(payload))
    } else {
        Ok(None)
    }
}

fn ensure_trailing_slash(value: &str) -> String {
    if value.ends_with('/') {
        value.to_string()
    } else {
        format!("{value}/")
    }
}

fn truncate_error_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= MAX_ERROR_BODY_CHARS {
        return trimmed.to_string();
    }

    let mut truncated: String = trimmed.chars().take(MAX_ERROR_BODY_CHARS).collect();
    truncated.push_str("...");
    truncated
}

fn sanitize_create_automation_tile_request(mut request: Value) -> Result<Value, String> {
    let object = request
        .as_object_mut()
        .ok_or_else(|| "automation tile create request must be an object".to_string())?;
    let tile_type = object
        .get("type")
        .ok_or_else(|| "automation tile create request must include a type".to_string())?;

    if !is_supported_automation_summary_type(tile_type) {
        return Err("automation create request must use the summary tile type".to_string());
    }

    if object.get("spaceId").is_some_and(|value| !value.is_null())
        || object.get("space_id").is_some_and(|value| !value.is_null())
    {
        return Err("automation tile create request must not include a space id".to_string());
    }

    object.remove("spaceId");
    object.remove("space_id");
    Ok(request)
}

fn is_supported_automation_summary_type(value: &Value) -> bool {
    match value {
        Value::Number(value) => matches!(value.as_i64(), Some(4)),
        Value::String(value) => matches!(value.as_str(), "TILE_TYPE_SUMMARY" | "4" | "summary"),
        _ => false,
    }
}

fn sanitize_push_automation_builder_messages_request(request: Value) -> Result<Value, String> {
    let object = request
        .as_object()
        .ok_or_else(|| "automation builder push request must be an object".to_string())?;
    let allowed_keys = [
        "sessionId",
        "chatContext",
        "sessionName",
        "metadata",
        "profileConfig",
        "messages",
    ];
    reject_unknown_keys(object, &allowed_keys, "automation builder push request")?;

    let mut sanitized = Map::new();
    if let Some(session_id) = object.get("sessionId") {
        sanitized.insert(
            "sessionId".to_string(),
            Value::String(validate_id_value(session_id, "session id")?),
        );
    }
    if let Some(chat_context) = object.get("chatContext") {
        sanitized.insert(
            "chatContext".to_string(),
            sanitize_string_object(chat_context, &["source", "timeZone"], "chatContext")?,
        );
    }
    if let Some(session_name) = object.get("sessionName") {
        sanitized.insert(
            "sessionName".to_string(),
            Value::String(validate_id_value(session_name, "session name")?),
        );
    }
    if let Some(metadata) = object.get("metadata") {
        sanitized.insert(
            "metadata".to_string(),
            sanitize_string_object(metadata, &["client", "feature"], "metadata")?,
        );
    }
    if let Some(profile_config) = object.get("profileConfig") {
        sanitized.insert(
            "profileConfig".to_string(),
            sanitize_builder_profile_config(profile_config)?,
        );
    }

    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "automation builder push request must include messages".to_string())?;
    if messages.is_empty() {
        return Err("automation builder push request messages must not be empty".to_string());
    }
    sanitized.insert(
        "messages".to_string(),
        Value::Array(
            messages
                .iter()
                .map(sanitize_builder_message)
                .collect::<Result<Vec<_>, _>>()?,
        ),
    );

    // kgoose expects the generated camelCase/proto casing; keep that casing
    // while stripping request fields the builder frontend never sends.
    Ok(Value::Object(sanitized))
}

fn sanitize_builder_profile_config(value: &Value) -> Result<Value, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "automation builder profileConfig must be an object".to_string())?;
    reject_unknown_keys(object, &["userProfile"], "automation builder profileConfig")?;
    let user_profile = object
        .get("userProfile")
        .and_then(Value::as_object)
        .ok_or_else(|| "automation builder profileConfig must include userProfile".to_string())?;
    reject_unknown_keys(
        user_profile,
        &["preferredModel"],
        "automation builder userProfile",
    )?;
    let preferred_model = user_profile
        .get("preferredModel")
        .and_then(Value::as_object)
        .ok_or_else(|| "automation builder userProfile must include preferredModel".to_string())?;
    reject_unknown_keys(
        preferred_model,
        &["name", "provider"],
        "automation builder preferredModel",
    )?;
    let name = preferred_model
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "automation builder preferredModel name must be a string".to_string())?;
    if name != "goose-claude-4-6-opus" {
        return Err("automation builder preferredModel name is not supported".to_string());
    }
    let provider = preferred_model
        .get("provider")
        .and_then(Value::as_i64)
        .ok_or_else(|| "automation builder preferredModel provider must be a number".to_string())?;
    if provider != 1 {
        return Err("automation builder preferredModel provider is not supported".to_string());
    }
    Ok(json!({
        "userProfile": {
            "preferredModel": {
                "name": name,
                "provider": provider
            }
        }
    }))
}

fn sanitize_builder_message(message: &Value) -> Result<Value, String> {
    let object = message
        .as_object()
        .ok_or_else(|| "automation builder message must be an object".to_string())?;
    reject_unknown_keys(
        object,
        &["hidden", "messageContents"],
        "automation builder message",
    )?;
    let mut sanitized = Map::new();
    if let Some(hidden) = object.get("hidden") {
        let hidden = hidden
            .as_bool()
            .ok_or_else(|| "automation builder message hidden must be a boolean".to_string())?;
        sanitized.insert("hidden".to_string(), Value::Bool(hidden));
    }
    let contents = object
        .get("messageContents")
        .and_then(Value::as_array)
        .ok_or_else(|| "automation builder message must include messageContents".to_string())?;
    if contents.is_empty() {
        return Err("automation builder messageContents must not be empty".to_string());
    }
    sanitized.insert(
        "messageContents".to_string(),
        Value::Array(
            contents
                .iter()
                .map(sanitize_builder_message_content)
                .collect::<Result<Vec<_>, _>>()?,
        ),
    );
    Ok(Value::Object(sanitized))
}

fn sanitize_builder_message_content(content: &Value) -> Result<Value, String> {
    let object = content
        .as_object()
        .ok_or_else(|| "automation builder message content must be an object".to_string())?;
    let content_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "automation builder message content must include a type".to_string())?;
    match content_type {
        "MESSAGE_TYPE_TEXT" => sanitize_builder_text_content(object),
        "MESSAGE_TYPE_TOOL_RESPONSE" => sanitize_builder_tool_response_content(object),
        _ => Err("automation builder message content type is not supported".to_string()),
    }
}

fn sanitize_builder_text_content(object: &Map<String, Value>) -> Result<Value, String> {
    reject_unknown_keys(object, &["type", "text"], "automation builder text content")?;
    let text = object
        .get("text")
        .and_then(Value::as_object)
        .and_then(|text| text.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "automation builder text content must include non-empty text".to_string())?;
    Ok(json!({
        "type": "MESSAGE_TYPE_TEXT",
        "text": { "text": text }
    }))
}

fn sanitize_builder_tool_response_content(object: &Map<String, Value>) -> Result<Value, String> {
    reject_unknown_keys(
        object,
        &["type", "toolResponse"],
        "automation builder tool response content",
    )?;
    let response = object
        .get("toolResponse")
        .and_then(Value::as_object)
        .ok_or_else(|| "automation builder tool response must be an object".to_string())?;
    reject_unknown_keys(
        response,
        &["id", "status", "results"],
        "automation builder tool response",
    )?;
    let id = validate_id_value(
        response
            .get("id")
            .ok_or_else(|| "automation builder tool response must include an id".to_string())?,
        "tool response id",
    )?;
    let status = response
        .get("status")
        .and_then(Value::as_str)
        .filter(|status| *status == "success")
        .ok_or_else(|| "automation builder tool response status must be success".to_string())?;
    let results = response
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| "automation builder tool response must include results".to_string())?;
    if results.is_empty() {
        return Err("automation builder tool response results must not be empty".to_string());
    }
    let sanitized_results = results
        .iter()
        .map(|result| {
            let text = result
                .as_object()
                .and_then(|result| result.get("text"))
                .and_then(Value::as_object)
                .and_then(|text| text.get("text"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .ok_or_else(|| {
                    "automation builder tool response result must include non-empty text"
                        .to_string()
                })?;
            Ok(json!({ "text": { "text": text } }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({
        "type": "MESSAGE_TYPE_TOOL_RESPONSE",
        "toolResponse": {
            "id": id,
            "status": status,
            "results": sanitized_results
        }
    }))
}

fn sanitize_string_object(value: &Value, keys: &[&str], label: &str) -> Result<Value, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object"))?;
    reject_unknown_keys(object, keys, label)?;
    let mut sanitized = Map::new();
    for key in keys {
        if let Some(value) = object.get(*key) {
            let value = validate_id_value(value, key)?;
            sanitized.insert((*key).to_string(), Value::String(value));
        }
    }
    Ok(Value::Object(sanitized))
}

fn validate_id_value(value: &Value, label: &str) -> Result<String, String> {
    value
        .as_str()
        .ok_or_else(|| format!("{label} must be a string"))
        .and_then(|value| validate_id(value.to_string(), label))
}

fn reject_unknown_keys(
    object: &Map<String, Value>,
    allowed_keys: &[&str],
    label: &str,
) -> Result<(), String> {
    for key in object.keys() {
        if !allowed_keys.contains(&key.as_str()) {
            return Err(format!("{label} includes unsupported field {key}"));
        }
    }
    Ok(())
}

#[derive(Default)]
struct SseDecoder {
    utf8_buffer: Vec<u8>,
    text_buffer: String,
}

impl SseDecoder {
    fn push_chunk(&mut self, chunk: &[u8]) -> Vec<SseMessage> {
        self.utf8_buffer.extend_from_slice(chunk);
        loop {
            match str::from_utf8(&self.utf8_buffer) {
                Ok(text) => {
                    self.text_buffer.push_str(text);
                    self.utf8_buffer.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        let valid_text = str::from_utf8(&self.utf8_buffer[..valid_up_to])
                            .expect("valid utf8 prefix");
                        self.text_buffer.push_str(valid_text);
                    }
                    if let Some(error_len) = error.error_len() {
                        self.utf8_buffer.drain(..valid_up_to + error_len);
                        continue;
                    }
                    self.utf8_buffer.drain(..valid_up_to);
                    break;
                }
            }
        }
        drain_sse_messages(&mut self.text_buffer)
    }
}

fn drain_sse_messages(buffer: &mut String) -> Vec<SseMessage> {
    let mut messages = Vec::new();
    while let Some((event_end, drain_end)) = find_sse_event_boundary(buffer) {
        let raw_event = buffer[..event_end].to_string();
        buffer.drain(..drain_end);
        if let Some(message) = parse_sse_message(&raw_event) {
            messages.push(message);
        }
    }
    messages
}

fn find_sse_event_boundary(buffer: &str) -> Option<(usize, usize)> {
    let bytes = buffer.as_bytes();
    let mut line_start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\r' && bytes[index] != b'\n' {
            index += 1;
            continue;
        }

        if index == line_start {
            let drain_end =
                if bytes[index] == b'\r' && index + 1 < bytes.len() && bytes[index + 1] == b'\n' {
                    index + 2
                } else {
                    index + 1
                };
            return Some((line_start, drain_end));
        }

        index = if bytes[index] == b'\r' && index + 1 < bytes.len() && bytes[index + 1] == b'\n' {
            index + 2
        } else {
            index + 1
        };
        line_start = index;
    }
    None
}

fn parse_sse_message(raw_event: &str) -> Option<SseMessage> {
    let mut id = None;
    let mut event = None;
    let mut data_lines = Vec::new();

    for line in raw_event.split(['\n', '\r']) {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(value) = line.strip_prefix("id:") {
            id = Some(value.trim_start().to_string());
        } else if let Some(value) = line.strip_prefix("event:") {
            event = Some(value.trim_start().to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            data_lines.push(value.trim_start().to_string());
        }
    }

    let event = event.unwrap_or_else(|| "message".to_string());
    if event == "message" && data_lines.is_empty() && id.is_none() {
        return None;
    }

    Some(SseMessage {
        id,
        event,
        data: data_lines.join("\n"),
    })
}

fn parse_sse_data(data: &str) -> Result<Option<Value>, String> {
    let trimmed = data.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    serde_json::from_str(trimmed)
        .map(Some)
        .map_err(|error| format!("Failed to parse kgoose stream data: {error}"))
}

fn parse_sse_event_data(event: &str, data: &str) -> Result<Option<Value>, String> {
    match parse_sse_data(data) {
        Ok(value) => Ok(value),
        Err(error) if event == "messages" => Err(error),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_kgoose_sse_url, build_kgoose_url, drain_sse_messages, is_builderbot_automation_type,
        messages_payload_from_sse_event, parse_sse_data, parse_sse_event_data,
        sanitize_create_automation_tile_request, sanitize_push_automation_builder_messages_request,
        sanitize_update_automation_request, take_next_sse_event, truncate_error_body,
        validate_last_event_id, KgooseDistroConfig, SseDecoder, KGOOSE_AUTOMATIONS_BASE_URL_ENV,
        KGOOSE_AUTOMATIONS_PATH_ENV,
    };
    use serde_json::json;
    use std::env;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn builds_default_kgoose_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV);
        env::remove_var(KGOOSE_AUTOMATIONS_PATH_ENV);

        assert_eq!(
            build_kgoose_url("v3/get-user-tiles", None)
                .unwrap()
                .as_str(),
            "https://kgoose.stage.sqprod.co/cash-app/goose/v3/get-user-tiles"
        );
    }

    #[test]
    fn builds_distro_kgoose_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV);
        env::remove_var(KGOOSE_AUTOMATIONS_PATH_ENV);
        let config = KgooseDistroConfig {
            base_url: Some("https://kgoose.sqprod.co/base/".to_string()),
            path: Some("/prod/path/".to_string()),
        };

        assert_eq!(
            build_kgoose_url("/v3/get-tile", Some(&config))
                .unwrap()
                .as_str(),
            "https://kgoose.sqprod.co/base/prod/path/v3/get-tile"
        );
    }

    #[test]
    fn env_overrides_distro_kgoose_url_without_double_slashes() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var(
            KGOOSE_AUTOMATIONS_BASE_URL_ENV,
            "https://example.test/base/",
        );
        env::set_var(KGOOSE_AUTOMATIONS_PATH_ENV, "/custom/path/");
        let config = KgooseDistroConfig {
            base_url: Some("https://kgoose.sqprod.co/".to_string()),
            path: Some("ignored".to_string()),
        };

        assert_eq!(
            build_kgoose_url("/v3/get-tile", Some(&config))
                .unwrap()
                .as_str(),
            "https://example.test/base/custom/path/v3/get-tile"
        );

        env::remove_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV);
        env::remove_var(KGOOSE_AUTOMATIONS_PATH_ENV);
    }

    #[test]
    fn rejects_non_http_base_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV, "file:///tmp");

        assert!(build_kgoose_url("v3/get-user-tiles", None).is_err());

        env::remove_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV);
    }

    #[test]
    fn truncates_long_error_bodies() {
        let body = "x".repeat(600);
        let truncated = truncate_error_body(&body);

        assert_eq!(truncated.chars().count(), 503);
        assert!(truncated.ends_with("..."));
    }
    #[test]
    fn builds_sse_url_with_encoded_session_id() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV);
        env::remove_var(KGOOSE_AUTOMATIONS_PATH_ENV);

        assert_eq!(
            build_kgoose_sse_url("v3/get-messages-sse", "session/1", None)
                .unwrap()
                .as_str(),
            "https://kgoose.stage.sqprod.co/cash-app/goose/v3/get-messages-sse?session_id=session%2F1"
        );
    }

    #[test]
    fn drains_complete_sse_messages_and_keeps_partial_buffer() {
        let mut buffer =
            "id: 1\nevent: messages\ndata: {\"ok\":true}\n\nevent: heartbeat\n\nid: 2".to_string();

        let events = drain_sse_messages(&mut buffer);

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id.as_deref(), Some("1"));
        assert_eq!(events[0].event, "messages");
        assert_eq!(events[0].data, "{\"ok\":true}");
        assert_eq!(events[1].event, "heartbeat");
        assert_eq!(buffer, "id: 2");
    }

    #[test]
    fn drains_sse_messages_with_crlf_and_bare_cr_boundaries() {
        let mut buffer = "id: 1\revent: messages\rdata: {\"ok\":true}\r\rid: 2\r\n\r\n".to_string();

        let events = drain_sse_messages(&mut buffer);

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id.as_deref(), Some("1"));
        assert_eq!(events[0].data, "{\"ok\":true}");
        assert_eq!(events[1].id.as_deref(), Some("2"));
        assert!(buffer.is_empty());
    }

    #[test]
    fn decodes_split_multibyte_utf8_before_sse_parsing() {
        let mut decoder = SseDecoder::default();
        let bytes = "event: messages\ndata: {\"text\":\"cafe\u{301}\"}\n\n".as_bytes();
        let split_at = bytes
            .iter()
            .position(|byte| *byte == 0xcc)
            .expect("combining mark lead byte should exist")
            + 1;

        assert!(decoder.push_chunk(&bytes[..split_at]).is_empty());
        let events = decoder.push_chunk(&bytes[split_at..]);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "{\"text\":\"cafe\u{301}\"}");
    }

    #[test]
    fn parses_empty_and_json_sse_data() {
        assert_eq!(parse_sse_data("").unwrap(), None);
        assert_eq!(
            parse_sse_data("{\"get_messages_response\":{\"status\":\"CHAT_SESSION_STATUS_IDLE\"}}")
                .unwrap()
                .unwrap()["get_messages_response"]["status"],
            "CHAT_SESSION_STATUS_IDLE"
        );
    }

    #[test]
    fn only_requires_json_data_for_message_events() {
        assert_eq!(
            parse_sse_event_data("heartbeat", "still alive").unwrap(),
            None
        );
        assert!(parse_sse_event_data("messages", "still alive").is_err());
    }

    #[test]
    fn validates_last_event_id_as_header_value() {
        assert!(validate_last_event_id(Some("event-1".to_string()))
            .unwrap()
            .is_some());
        assert!(validate_last_event_id(Some("bad\nvalue".to_string())).is_err());
    }

    #[test]
    fn sanitizes_automation_tile_create_requests() {
        let request = sanitize_create_automation_tile_request(json!({
            "type": "TILE_TYPE_SUMMARY",
            "title": "Daily digest",
            "spaceId": null,
            "space_id": null
        }))
        .unwrap();

        assert_eq!(request["type"], "TILE_TYPE_SUMMARY");
        assert!(request.get("spaceId").is_none());
        assert!(request.get("space_id").is_none());
    }

    #[test]
    fn rejects_non_automation_tile_create_requests() {
        assert!(sanitize_create_automation_tile_request(json!({
            "type": 10,
            "title": "Automation status"
        }))
        .is_err());
        assert!(sanitize_create_automation_tile_request(json!({
            "type": "TILE_TYPE_BUILDERBOT_AUTOMATION",
            "title": "BuilderBot automation"
        }))
        .is_err());
    }

    #[test]
    fn rejects_space_scoped_automation_tile_create_requests() {
        assert!(sanitize_create_automation_tile_request(json!({
            "type": 4,
            "spaceId": "space-1"
        }))
        .is_err());
    }

    #[test]
    fn sanitizes_builder_push_text_and_tool_response_requests() {
        let request = sanitize_push_automation_builder_messages_request(json!({
            "sessionId": "session-1",
            "chatContext": {
                "source": "SOURCE_CREATE_TILE",
                "timeZone": "America/Los_Angeles"
            },
            "sessionName": "New automation",
            "metadata": {
                "client": "goose-internal",
                "feature": "automations-builder"
            },
            "profileConfig": {
                "userProfile": {
                    "preferredModel": {
                        "name": "goose-claude-4-6-opus",
                        "provider": 1
                    }
                }
            },
            "messages": [
                {
                    "hidden": true,
                    "messageContents": [
                        {
                            "type": "MESSAGE_TYPE_TEXT",
                            "text": { "text": "Create an automation" }
                        }
                    ]
                },
                {
                    "messageContents": [
                        {
                            "type": "MESSAGE_TYPE_TOOL_RESPONSE",
                            "toolResponse": {
                                "id": "tool-1",
                                "status": "success",
                                "results": [{ "text": { "text": "Approved" } }]
                            }
                        }
                    ]
                }
            ]
        }))
        .unwrap();

        assert_eq!(request["sessionId"], "session-1");
        assert_eq!(
            request["messages"][0]["messageContents"][0]["text"]["text"],
            "Create an automation"
        );
        assert_eq!(
            request["messages"][1]["messageContents"][0]["toolResponse"]["id"],
            "tool-1"
        );
        assert_eq!(
            request["profileConfig"]["userProfile"]["preferredModel"]["name"],
            "goose-claude-4-6-opus"
        );
        assert_eq!(
            request["profileConfig"]["userProfile"]["preferredModel"]["provider"],
            1
        );
    }

    #[test]
    fn rejects_bad_builder_push_request_shapes() {
        assert!(sanitize_push_automation_builder_messages_request(json!({
            "messages": []
        }))
        .is_err());
        assert!(sanitize_push_automation_builder_messages_request(json!({
            "sessionId": "",
            "messages": [{"messageContents": []}]
        }))
        .is_err());
        assert!(sanitize_push_automation_builder_messages_request(json!({
            "messages": [
                {
                    "messageContents": [
                        {
                            "type": "MESSAGE_TYPE_TEXT",
                            "text": { "text": "hello" },
                            "spoofed": true
                        }
                    ]
                }
            ]
        }))
        .is_err());
        assert!(sanitize_push_automation_builder_messages_request(json!({
            "profileConfig": {
                "userProfile": {
                    "preferredModel": {
                        "name": "kgoose-claude-sonnet-4-6",
                        "provider": 1
                    }
                }
            },
            "messages": [{"messageContents": [{"type": "MESSAGE_TYPE_TEXT", "text": { "text": "hello" }}]}]
        }))
        .is_err());
        assert!(sanitize_push_automation_builder_messages_request(json!({
            "profileConfig": {
                "userProfile": {
                    "preferredModel": {
                        "name": "goose-claude-4-6-opus",
                        "provider": 1
                    },
                    "clientTools": []
                }
            },
            "messages": [{"messageContents": [{"type": "MESSAGE_TYPE_TEXT", "text": { "text": "hello" }}]}]
        }))
        .is_err());
    }

    #[test]
    fn recognizes_builderbot_automation_types() {
        assert!(is_builderbot_automation_type("18"));
        assert!(is_builderbot_automation_type("builderbot_automation"));
        assert!(is_builderbot_automation_type(
            "tile_type_builderbot_automation"
        ));
        assert!(!is_builderbot_automation_type("10"));
        assert!(!is_builderbot_automation_type("tile_type_automation"));
    }

    #[test]
    fn sanitizes_update_automation_requests() {
        let request = sanitize_update_automation_request(json!({
            "id": " automation-1 ",
            "title": " Revenue digest ",
            "schedule": "0 9 * * *",
            "updateSchedule": true,
            "timeZone": "America/Los_Angeles",
            "instructions": ["Pull revenue"],
            "updateInstructions": true,
            "enableNotifications": true,
            "spaceId": "must-not-forward",
            "type": 18,
            "latestRenderedData": {"summary": "must-not-forward"}
        }))
        .unwrap();

        assert_eq!(
            request,
            json!({
                "id": "automation-1",
                "title": "Revenue digest",
                "schedule": "0 9 * * *",
                "updateSchedule": true,
                "timeZone": "America/Los_Angeles",
                "instructions": ["Pull revenue"],
                "updateInstructions": true,
                "enableNotifications": true
            })
        );
    }

    #[test]
    fn rejects_empty_update_automation_requests() {
        assert!(sanitize_update_automation_request(json!({
            "id": "automation-1",
            "spaceId": null
        }))
        .is_err());
    }

    #[test]
    fn rejects_empty_instruction_updates() {
        assert!(sanitize_update_automation_request(json!({
            "id": "automation-1",
            "instructions": [],
            "updateInstructions": true
        }))
        .is_err());
    }
    #[test]
    fn takes_sse_events_from_lf_and_crlf_buffers() {
        let mut buffer =
            b"event: connected\ndata: {}\n\nevent: heartbeat\r\ndata: {}\r\n\r\n".to_vec();

        assert_eq!(
            take_next_sse_event(&mut buffer).unwrap().unwrap(),
            "event: connected\ndata: {}"
        );
        assert_eq!(
            take_next_sse_event(&mut buffer).unwrap().unwrap(),
            "event: heartbeat\r\ndata: {}"
        );
        assert!(take_next_sse_event(&mut buffer).unwrap().is_none());
    }

    #[test]
    fn decodes_sse_events_after_split_utf8_characters() {
        let event = "event: messages\ndata: {\"text\":\"café\"}\n\n".as_bytes();
        let split_index = event
            .iter()
            .position(|byte| *byte == 0xc3)
            .map(|index| index + 1)
            .unwrap();
        let mut buffer = event[..split_index].to_vec();

        assert!(take_next_sse_event(&mut buffer).unwrap().is_none());

        buffer.extend_from_slice(&event[split_index..]);
        assert_eq!(
            take_next_sse_event(&mut buffer).unwrap().unwrap(),
            "event: messages\ndata: {\"text\":\"café\"}"
        );
    }

    #[test]
    fn extracts_only_full_messages_sse_payloads() {
        let delta = "event: messages\ndata: {\"delta_message_content\":{\"streaming_message_id\":\"msg-1\"}}";
        assert!(messages_payload_from_sse_event(delta).unwrap().is_none());

        let snapshot = "event: messages\ndata: {\"get_messages_response\":{\"messages\":[{\"id\":\"msg-1\"}]}}";
        assert_eq!(
            messages_payload_from_sse_event(snapshot).unwrap(),
            Some(json!({
                "get_messages_response": {
                    "messages": [{ "id": "msg-1" }]
                }
            }))
        );
    }
}
