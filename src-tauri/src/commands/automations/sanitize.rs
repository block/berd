use reqwest::header::HeaderValue;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

pub(super) fn trim_required_string(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    Ok(trimmed.to_string())
}

pub(super) fn trim_optional_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(super) fn validate_last_event_id(value: Option<String>) -> Result<Option<HeaderValue>, String> {
    value
        .and_then(|value| trim_optional_string(&value))
        .map(|value| {
            HeaderValue::from_str(&value)
                .map_err(|error| format!("Last-Event-ID is invalid: {error}"))
        })
        .transpose()
}

pub(super) fn string_or_number_as_lowercase(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.to_lowercase()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

pub(super) fn is_builderbot_automation_type(value: &str) -> bool {
    matches!(
        value,
        "18" | "builderbot_automation" | "tile_type_builderbot_automation"
    )
}

// Shared policy for kgoose TileType proto values this app can safely create.
// Goose Internal does not currently vend generated Rust TileType bindings, so
// frontend and Tauri load this JSON policy instead of duplicating enum tables.
const CREATABLE_TILE_TYPES_JSON: &str =
    include_str!("../../../../resources/creatable-tile-types.json");
static CREATABLE_TILE_TYPES: LazyLock<Vec<CreatableTileType>> = LazyLock::new(|| {
    let tile_types: Vec<CreatableTileType> = serde_json::from_str(CREATABLE_TILE_TYPES_JSON)
        .expect("resources/creatable-tile-types.json is malformed");
    assert!(
        tile_types
            .iter()
            .flat_map(|tile_type| tile_type.aliases.iter())
            .all(|alias| alias == &alias.to_lowercase()),
        "resources/creatable-tile-types.json aliases must be lowercase"
    );
    tile_types
});

#[derive(Deserialize)]
struct CreatableTileType {
    id: i32,
    aliases: Vec<String>,
}

pub(super) fn sanitize_create_automation_tile_request(request: Value) -> Result<Value, String> {
    let object = request
        .as_object()
        .ok_or_else(|| "automation tile create request must be an object".to_string())?;
    let tile_type = normalize_create_tile_type(
        object
            .get("type")
            .or_else(|| object.get("tileType"))
            .or_else(|| object.get("tile_type"))
            .ok_or_else(|| "automation tile create request must include a type".to_string())?,
    )?;

    if object.get("spaceId").is_some_and(|value| !value.is_null())
        || object.get("space_id").is_some_and(|value| !value.is_null())
    {
        return Err("automation tile create request must not include a space id".to_string());
    }

    let mut sanitized = Map::new();
    // kgoose decodes this protobuf-backed JSON field as a TileType enum.
    // Normalize accepted aliases to enum numbers so string spellings do not get
    // dropped before reaching CreateTileRequest.type.
    sanitized.insert("type".to_string(), Value::Number(tile_type.into()));
    copy_create_field(object, &mut sanitized, "title");
    copy_create_field(object, &mut sanitized, "schedule");
    copy_create_field(object, &mut sanitized, "timeZone");
    copy_create_field(object, &mut sanitized, "instructions");
    copy_create_field(object, &mut sanitized, "allowHumanInput");
    copy_create_field(object, &mut sanitized, "enableNotifications");
    Ok(Value::Object(sanitized))
}

fn copy_create_field(object: &Map<String, Value>, sanitized: &mut Map<String, Value>, key: &str) {
    if let Some(value) = object.get(key) {
        sanitized.insert(key.to_string(), value.clone());
    }
}

fn normalize_create_tile_type(value: &Value) -> Result<i32, String> {
    let normalized = string_or_number_as_lowercase(value).ok_or_else(|| {
        "automation tile create request type must be a string or number".to_string()
    })?;

    if matches!(normalized.as_str(), "6" | "task" | "tile_type_task") {
        return Err("automation create request must not use the task tile type".to_string());
    }

    if matches!(
        normalized.as_str(),
        "18" | "builderbot_automation" | "tile_type_builderbot_automation"
    ) {
        return Err(
            "automation create request must not use the builderbot automation tile type"
                .to_string(),
        );
    }

    CREATABLE_TILE_TYPES
        .iter()
        .find_map(|tile_type| {
            (normalized == tile_type.id.to_string()
                || tile_type
                    .aliases
                    .iter()
                    .any(|alias| alias.as_str() == normalized))
            .then_some(tile_type.id)
        })
        .ok_or_else(|| "automation create request must include a supported tile type".to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PushAutomationBuilderMessagesRequest {
    session_id: Option<String>,
    chat_context: Option<ChatContext>,
    session_name: Option<String>,
    metadata: Option<Metadata>,
    profile_config: Option<BuilderProfileConfig>,
    messages: Vec<BuilderMessage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatContext {
    source: Option<String>,
    time_zone: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    client: Option<String>,
    feature: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuilderProfileConfig {
    user_profile: BuilderUserProfile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuilderUserProfile {
    preferred_model: BuilderPreferredModel,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuilderPreferredModel {
    name: String,
    provider: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuilderMessage {
    hidden: Option<bool>,
    message_contents: Vec<BuilderMessageContent>,
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum BuilderMessageContent {
    #[serde(rename = "MESSAGE_TYPE_TEXT", rename_all = "camelCase")]
    Text { text: TextPayload },
    #[serde(rename = "MESSAGE_TYPE_TOOL_RESPONSE", rename_all = "camelCase")]
    ToolResponse { tool_response: BuilderToolResponse },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TextPayload {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuilderToolResponse {
    id: String,
    status: String,
    results: Vec<ToolResponseResult>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolResponseResult {
    text: TextPayload,
}

pub(super) fn sanitize_push_automation_builder_messages_request(
    request: Value,
) -> Result<Value, String> {
    let request = parse_json::<PushAutomationBuilderMessagesRequest>(
        request,
        "automation builder push request",
    )?;
    if request.messages.is_empty() {
        return Err("automation builder push request messages must not be empty".to_string());
    }

    let mut sanitized = Map::new();
    if let Some(session_id) = request.session_id {
        sanitized.insert(
            "sessionId".to_string(),
            Value::String(trim_required_string(&session_id, "session id")?),
        );
    }
    if let Some(chat_context) = request.chat_context {
        sanitized.insert(
            "chatContext".to_string(),
            sanitize_chat_context(chat_context)?,
        );
    }
    if let Some(session_name) = request.session_name {
        sanitized.insert(
            "sessionName".to_string(),
            Value::String(trim_required_string(&session_name, "session name")?),
        );
    }
    if let Some(metadata) = request.metadata {
        sanitized.insert("metadata".to_string(), sanitize_metadata(metadata)?);
    }
    if let Some(profile_config) = request.profile_config {
        sanitized.insert(
            "profileConfig".to_string(),
            sanitize_builder_profile_config(profile_config)?,
        );
    }

    sanitized.insert(
        "messages".to_string(),
        Value::Array(
            request
                .messages
                .into_iter()
                .map(sanitize_builder_message)
                .collect::<Result<Vec<_>, _>>()?,
        ),
    );

    Ok(Value::Object(sanitized))
}

fn parse_json<T>(value: Value, label: &str) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(value).map_err(|error| format!("{label} is invalid: {error}"))
}

fn sanitize_chat_context(chat_context: ChatContext) -> Result<Value, String> {
    let mut sanitized = Map::new();
    if let Some(source) = chat_context.source {
        sanitized.insert(
            "source".to_string(),
            Value::String(trim_required_string(&source, "source")?),
        );
    }
    if let Some(time_zone) = chat_context.time_zone {
        sanitized.insert(
            "timeZone".to_string(),
            Value::String(trim_required_string(&time_zone, "timeZone")?),
        );
    }
    Ok(Value::Object(sanitized))
}

fn sanitize_metadata(metadata: Metadata) -> Result<Value, String> {
    let mut sanitized = Map::new();
    if let Some(client) = metadata.client {
        sanitized.insert(
            "client".to_string(),
            Value::String(trim_required_string(&client, "client")?),
        );
    }
    if let Some(feature) = metadata.feature {
        sanitized.insert(
            "feature".to_string(),
            Value::String(trim_required_string(&feature, "feature")?),
        );
    }
    Ok(Value::Object(sanitized))
}

fn sanitize_builder_profile_config(profile_config: BuilderProfileConfig) -> Result<Value, String> {
    let preferred_model = profile_config.user_profile.preferred_model;
    if preferred_model.name != "goose-claude-4-6-opus" {
        return Err("automation builder preferredModel name is not supported".to_string());
    }
    if preferred_model.provider != 1 {
        return Err("automation builder preferredModel provider is not supported".to_string());
    }
    Ok(json!({
        "userProfile": {
            "preferredModel": {
                "name": preferred_model.name,
                "provider": preferred_model.provider
            }
        }
    }))
}

fn sanitize_builder_message(message: BuilderMessage) -> Result<Value, String> {
    if message.message_contents.is_empty() {
        return Err("automation builder messageContents must not be empty".to_string());
    }

    let mut sanitized = Map::new();
    if let Some(hidden) = message.hidden {
        sanitized.insert("hidden".to_string(), Value::Bool(hidden));
    }
    sanitized.insert(
        "messageContents".to_string(),
        Value::Array(
            message
                .message_contents
                .into_iter()
                .map(sanitize_builder_message_content)
                .collect::<Result<Vec<_>, _>>()?,
        ),
    );
    Ok(Value::Object(sanitized))
}

fn sanitize_builder_message_content(content: BuilderMessageContent) -> Result<Value, String> {
    match content {
        BuilderMessageContent::Text { text } => sanitize_builder_text_content(text),
        BuilderMessageContent::ToolResponse { tool_response } => {
            sanitize_builder_tool_response_content(tool_response)
        }
    }
}

fn sanitize_builder_text_content(text: TextPayload) -> Result<Value, String> {
    let text = trim_required_string(&text.text, "automation builder text content")?;
    Ok(json!({
        "type": "MESSAGE_TYPE_TEXT",
        "text": { "text": text }
    }))
}

fn sanitize_builder_tool_response_content(response: BuilderToolResponse) -> Result<Value, String> {
    let id = trim_required_string(&response.id, "tool response id")?;
    if response.status != "success" {
        return Err("automation builder tool response status must be success".to_string());
    }
    if response.results.is_empty() {
        return Err("automation builder tool response results must not be empty".to_string());
    }

    let sanitized_results = response
        .results
        .into_iter()
        .map(|result| {
            let text =
                trim_required_string(&result.text.text, "automation builder tool response result")?;
            Ok(json!({ "text": { "text": text } }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({
        "type": "MESSAGE_TYPE_TOOL_RESPONSE",
        "toolResponse": {
            "id": id,
            "status": response.status,
            "results": sanitized_results
        }
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAutomationTileRequest {
    id: String,
    title: Option<String>,
    schedule: Option<String>,
    update_schedule: Option<bool>,
    time_zone: Option<String>,
    instructions: Option<Vec<String>>,
    update_instructions: Option<bool>,
    enable_notifications: Option<bool>,
    // Updates intentionally ignore stale or dangerous frontend fields instead
    // of rejecting them, because tile detail objects are reused as edit inputs.
    #[serde(flatten)]
    #[allow(dead_code)]
    ignored_frontend_fields: Map<String, Value>,
}

pub(super) fn sanitize_update_automation_request(request: Value) -> Result<Value, String> {
    let request = parse_json::<UpdateAutomationTileRequest>(request, "update automation request")?;
    let id = trim_required_string(&request.id, "automation id")?;

    let mut sanitized = Map::new();
    sanitized.insert("id".to_string(), Value::String(id));

    if let Some(title) = request.title {
        let title = trim_required_string(&title, "title")?;
        sanitized.insert("title".to_string(), Value::String(title));
    }

    if request.update_schedule.unwrap_or(false) {
        sanitized.insert("updateSchedule".to_string(), Value::Bool(true));
        let mut has_schedule_update_field = false;
        if let Some(schedule) = request.schedule {
            sanitized.insert(
                "schedule".to_string(),
                Value::String(schedule.trim().to_string()),
            );
            has_schedule_update_field = true;
        }
        if let Some(time_zone) = request.time_zone {
            let time_zone = trim_required_string(&time_zone, "timeZone")?;
            sanitized.insert("timeZone".to_string(), Value::String(time_zone));
            has_schedule_update_field = true;
        }
        if !has_schedule_update_field {
            return Err(
                "schedule or timeZone must be provided when updateSchedule is true".to_string(),
            );
        }
    }

    if request.update_instructions.unwrap_or(false) {
        let instructions = request
            .instructions
            .ok_or_else(|| {
                "instructions must be an array when updateInstructions is true".to_string()
            })?
            .into_iter()
            .map(|value| trim_required_string(&value, "instructions"))
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

    if let Some(enable_notifications) = request.enable_notifications {
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

#[cfg(test)]
mod tests {
    use super::{
        is_builderbot_automation_type, sanitize_create_automation_tile_request,
        sanitize_push_automation_builder_messages_request, sanitize_update_automation_request,
        validate_last_event_id,
    };
    use serde_json::json;

    #[test]
    fn sanitizes_automation_tile_create_requests() {
        let request = sanitize_create_automation_tile_request(json!({
            "type": "tile_type_summary",
            "title": "Daily digest",
            "schedule": "0 9 * * *",
            "timeZone": "America/Los_Angeles",
            "instructions": ["Pull revenue"],
            "allowHumanInput": false,
            "enableNotifications": true,
            "id": "must-not-forward",
            "creator": "must-not-forward",
            "created": "must-not-forward",
            "updated": "must-not-forward",
            "status": "must-not-forward",
            "latestRunStatus": "must-not-forward",
            "latestChatSessionId": "must-not-forward",
            "lastSuccessAt": "must-not-forward",
            "requiredConnections": ["must-not-forward"],
            "subscribedLabels": ["must-not-forward"],
            "toolCallNames": ["must-not-forward"],
            "subscriptionFilters": {"statuses": ["must-not-forward"]},
            "spaceId": null,
            "space_id": null,
            "latestRenderedData": {"summary": "must-not-forward"},
            "latest_rendered_data": {"summary": "must-not-forward"}
        }))
        .unwrap();

        assert_eq!(request["type"], 4);
        assert_eq!(request["title"], "Daily digest");
        assert_eq!(request["schedule"], "0 9 * * *");
        assert_eq!(request["timeZone"], "America/Los_Angeles");
        assert_eq!(request["instructions"], json!(["Pull revenue"]));
        assert_eq!(request["allowHumanInput"], false);
        assert_eq!(request["enableNotifications"], true);
        assert_eq!(request.as_object().unwrap().len(), 7);
    }

    #[test]
    fn sanitizes_frontend_shaped_automation_tile_create_requests() {
        let request = sanitize_create_automation_tile_request(json!({
            "type": "TILE_TYPE_AUTOMATION",
            "title": "Daily digest",
            "schedule": "0 9 * * *",
            "timeZone": "America/Los_Angeles",
            "instructions": ["Pull revenue"],
            "allowHumanInput": false,
            "enableNotifications": true
        }))
        .unwrap();

        assert_eq!(
            request,
            json!({
                "type": 10,
                "title": "Daily digest",
                "schedule": "0 9 * * *",
                "timeZone": "America/Los_Angeles",
                "instructions": ["Pull revenue"],
                "allowHumanInput": false,
                "enableNotifications": true
            })
        );
    }

    #[test]
    fn sanitizes_supported_automation_tile_create_types() {
        let request = sanitize_create_automation_tile_request(json!({
            "type": 10,
            "title": "Automation status"
        }))
        .unwrap();
        assert_eq!(request["type"], 10);

        let request = sanitize_create_automation_tile_request(json!({
            "tile_type": "TILE_TYPE_FORM",
            "title": "Form automation"
        }))
        .unwrap();
        assert_eq!(request["type"], 12);
        assert!(request.get("tile_type").is_none());
    }

    #[test]
    fn rejects_unsupported_automation_tile_create_types() {
        assert!(sanitize_create_automation_tile_request(json!({
            "type": "TILE_TYPE_BUILDERBOT_AUTOMATION",
            "title": "BuilderBot automation"
        }))
        .is_err());
        assert!(sanitize_create_automation_tile_request(json!({
            "type": "TILE_TYPE_TASK",
            "title": "Task automation"
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
            "messages": [
                {
                    "messageContents": [
                        {
                            "type": "MESSAGE_TYPE_TOOL_RESPONSE",
                            "toolResponse": {
                                "id": "tool-1",
                                "status": "success",
                                "results": [
                                    {
                                        "text": { "text": "Approved" },
                                        "spoofed": true
                                    }
                                ]
                            }
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
    fn rejects_update_requests_without_mutation_fields() {
        assert!(sanitize_update_automation_request(json!({
            "id": "automation-1",
            "spaceId": null
        }))
        .is_err());
    }

    #[test]
    fn strips_unsupported_fields_from_update_requests() {
        let request = sanitize_update_automation_request(json!({
            "id": "automation-1",
            "title": "Daily digest",
            "spaceId": "must-not-forward",
            "type": 18,
            "latestRenderedData": {"summary": "must-not-forward"}
        }))
        .unwrap();

        assert_eq!(
            request,
            json!({
                "id": "automation-1",
                "title": "Daily digest"
            })
        );
    }

    #[test]
    fn rejects_empty_update_title() {
        assert!(sanitize_update_automation_request(json!({
            "id": "automation-1",
            "title": " "
        }))
        .is_err());
    }

    #[test]
    fn rejects_empty_schedule_update_fields() {
        assert!(sanitize_update_automation_request(json!({
            "id": "automation-1",
            "updateSchedule": true
        }))
        .is_err());
        assert!(sanitize_update_automation_request(json!({
            "id": "automation-1",
            "timeZone": " ",
            "updateSchedule": true
        }))
        .is_err());
    }

    #[test]
    fn sanitizes_empty_schedule_as_clear_schedule_update() {
        let request = sanitize_update_automation_request(json!({
            "id": "automation-1",
            "schedule": " ",
            "updateSchedule": true
        }))
        .unwrap();

        assert_eq!(
            request,
            json!({
                "id": "automation-1",
                "schedule": "",
                "updateSchedule": true
            })
        );
    }

    #[test]
    fn validates_last_event_id_as_header_value() {
        assert!(validate_last_event_id(Some("event-1".to_string()))
            .unwrap()
            .is_some());
        assert!(validate_last_event_id(Some("bad\nvalue".to_string())).is_err());
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
}
