use crate::commands::auth::verified_auth_context;
use crate::services::builderbot;
use serde_json::{json, Map, Value};
use std::{cmp::Reverse, collections::HashSet};

const DEFAULT_LIST_LIMIT: u32 = 50;
const MAX_LIST_LIMIT: u32 = 100;

#[tauri::command]
pub async fn get_builderbot_tasks(limit: Option<u32>) -> Result<Value, String> {
    let limit = normalize_limit(limit);
    let auth = verified_auth_context().await?;
    let user = auth.user.clone();
    let common_query = vec![("limit", limit.to_string()), ("status", "all".to_string())];
    let mut authored_query = common_query.clone();
    authored_query.push(("author", user.clone()));
    let mut assigned_query = common_query;
    assigned_query.push(("assignee", user.clone()));

    let (authored_response, assigned_response) = tokio::try_join!(
        builderbot::get_json("/api/v1/tasks", &authored_query, &auth.session_credential),
        builderbot::get_json("/api/v1/tasks", &assigned_query, &auth.session_credential)
    )?;
    let mut response = merge_task_responses(authored_response, assigned_response, limit);
    attach_current_user(&mut response, &user);
    Ok(response)
}

#[tauri::command]
pub async fn get_builderbot_scheduled_triggers(limit: Option<u32>) -> Result<Value, String> {
    let limit = normalize_limit(limit);
    let auth = verified_auth_context().await?;
    let user = auth.user.clone();
    let query = user_owned_list_query(limit, &user);
    let mut response = builderbot::get_json(
        "/api/v1/scheduled-triggers",
        &query,
        &auth.session_credential,
    )
    .await?;
    attach_current_user(&mut response, &user);
    Ok(response)
}

#[tauri::command]
pub async fn get_builderbot_routing_rules(limit: Option<u32>) -> Result<Value, String> {
    let limit = normalize_limit(limit);
    let auth = verified_auth_context().await?;
    let user = auth.user.clone();
    let query = user_owned_list_query(limit, &user);
    let mut response =
        builderbot::get_json("/api/v1/routing-rules", &query, &auth.session_credential).await?;
    attach_current_user(&mut response, &user);
    Ok(response)
}

#[tauri::command]
pub async fn update_builderbot_scheduled_trigger(
    reference: String,
    request: Value,
) -> Result<Value, String> {
    let auth = verified_auth_context().await?;
    let reference = trim_builderbot_reference(&reference)?;
    let endpoint = format!("/api/v1/scheduled-triggers/{reference}");
    builderbot::put_json(
        &endpoint,
        sanitize_scheduled_trigger_update(&reference, request)?,
        &auth.session_credential,
    )
    .await
}

#[tauri::command]
pub async fn update_builderbot_routing_rule(
    reference: String,
    request: Value,
) -> Result<Value, String> {
    let auth = verified_auth_context().await?;
    let reference = trim_builderbot_reference(&reference)?;
    let endpoint = format!("/api/v1/routing-rules/{reference}");
    builderbot::put_json(
        &endpoint,
        sanitize_routing_rule_update(&reference, request)?,
        &auth.session_credential,
    )
    .await
}

fn normalize_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT)
}

fn user_owned_list_query(limit: u32, user: &str) -> Vec<(&'static str, String)> {
    vec![
        ("limit", limit.to_string()),
        ("owner", user.trim().to_string()),
    ]
}

fn trim_builderbot_reference(reference: &str) -> Result<String, String> {
    let trimmed = reference.trim();
    if trimmed.is_empty() {
        return Err("Builderbot reference is required.".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('?') || trimmed.contains('#') {
        return Err("Builderbot reference is invalid.".to_string());
    }
    Ok(trimmed.to_string())
}

fn sanitize_scheduled_trigger_update(reference: &str, request: Value) -> Result<Value, String> {
    let Some(object) = request.as_object() else {
        return Err("Builderbot scheduled trigger update must be an object.".to_string());
    };

    let mut sanitized = Map::new();
    if let Some(body_reference) = object.get("reference").and_then(Value::as_str) {
        let body_reference = trim_builderbot_reference(body_reference)?;
        if body_reference != reference {
            return Err("Builderbot scheduled trigger name cannot be changed here.".to_string());
        }
        sanitized.insert("reference".to_string(), Value::String(body_reference));
    }
    if let Some(enabled) = object.get("enabled").and_then(Value::as_bool) {
        sanitized.insert("enabled".to_string(), Value::Bool(enabled));
    }
    if let Some(cron_expression) = object.get("cron_expression").and_then(Value::as_str) {
        let trimmed = cron_expression.trim();
        if trimmed.is_empty() {
            return Err("Builderbot schedule is required.".to_string());
        }
        sanitized.insert(
            "cron_expression".to_string(),
            Value::String(trimmed.to_string()),
        );
    }
    if let Some(routine) = object.get("routine") {
        if !routine.is_object() {
            return Err("Builderbot routine update must be an object.".to_string());
        }
        sanitized.insert("routine".to_string(), routine.clone());
    }
    if let Some(task_config_json) = object.get("task_config_json").and_then(Value::as_str) {
        let trimmed = task_config_json.trim();
        if trimmed.is_empty() {
            return Err("Builderbot task payload is required.".to_string());
        }
        sanitized.insert(
            "task_config_json".to_string(),
            Value::String(trimmed.to_string()),
        );
    }
    if let Some(owners) = object.get("owners") {
        let Some(owners_array) = owners.as_array() else {
            return Err("Builderbot scheduled trigger owners must be an array.".to_string());
        };
        let sanitized_owners = owners_array
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|owner| !owner.is_empty())
            .map(|owner| Value::String(owner.to_string()))
            .collect();
        sanitized.insert("owners".to_string(), Value::Array(sanitized_owners));
    }

    if sanitized.is_empty() {
        return Err("Builderbot scheduled trigger update has no editable fields.".to_string());
    }
    Ok(Value::Object(sanitized))
}

fn sanitize_routing_rule_update(reference: &str, request: Value) -> Result<Value, String> {
    let Some(object) = request.as_object() else {
        return Err("Builderbot routing rule update must be an object.".to_string());
    };

    let mut sanitized = Map::new();
    if let Some(body_reference) = object.get("reference").and_then(Value::as_str) {
        let body_reference = trim_builderbot_reference(body_reference)?;
        if body_reference != reference {
            return Err("Builderbot routing rule name cannot be changed here.".to_string());
        }
        sanitized.insert("reference".to_string(), Value::String(body_reference));
    }
    if let Some(enabled) = object.get("enabled").and_then(Value::as_bool) {
        sanitized.insert("enabled".to_string(), Value::Bool(enabled));
    }
    if let Some(source) = object.get("source").and_then(Value::as_str) {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            return Err("Builderbot routing source is required.".to_string());
        }
        sanitized.insert("source".to_string(), Value::String(trimmed.to_string()));
    }
    if let Some(conditions) = object.get("conditions") {
        if !conditions.is_array() {
            return Err("Builderbot routing conditions must be an array.".to_string());
        }
        sanitized.insert("conditions".to_string(), conditions.clone());
    }
    if let Some(outcome_labels) = object.get("outcome_labels") {
        let Some(labels_array) = outcome_labels.as_array() else {
            return Err("Builderbot routing labels must be an array.".to_string());
        };
        let sanitized_labels = labels_array
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(|label| Value::String(label.to_string()))
            .collect();
        sanitized.insert("outcome_labels".to_string(), Value::Array(sanitized_labels));
    }
    if let Some(task_status) = object.get("task_status").and_then(Value::as_str) {
        let trimmed = task_status.trim();
        if !trimmed.is_empty() {
            sanitized.insert(
                "task_status".to_string(),
                Value::String(trimmed.to_string()),
            );
        }
    }
    if let Some(description_template) = object.get("description_template").and_then(Value::as_str) {
        sanitized.insert(
            "description_template".to_string(),
            Value::String(description_template.to_string()),
        );
    }
    if let Some(idempotency_key_template) = object
        .get("idempotency_key_template")
        .and_then(Value::as_str)
    {
        sanitized.insert(
            "idempotency_key_template".to_string(),
            Value::String(idempotency_key_template.to_string()),
        );
    }
    if let Some(max_matches_per_idempotency) = object
        .get("max_matches_per_idempotency")
        .and_then(Value::as_u64)
    {
        sanitized.insert(
            "max_matches_per_idempotency".to_string(),
            Value::Number(max_matches_per_idempotency.into()),
        );
    }
    if let Some(idempotency_enabled) = object.get("idempotency_enabled").and_then(Value::as_bool) {
        sanitized.insert(
            "idempotency_enabled".to_string(),
            Value::Bool(idempotency_enabled),
        );
    }
    if let Some(routine) = object.get("routine") {
        if !routine.is_object() {
            return Err("Builderbot routine update must be an object.".to_string());
        }
        sanitized.insert("routine".to_string(), routine.clone());
    }
    if let Some(owners) = object.get("owners") {
        let Some(owners_array) = owners.as_array() else {
            return Err("Builderbot routing rule owners must be an array.".to_string());
        };
        let sanitized_owners = owners_array
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|owner| !owner.is_empty())
            .map(|owner| Value::String(owner.to_string()))
            .collect();
        sanitized.insert("owners".to_string(), Value::Array(sanitized_owners));
    }

    if sanitized.is_empty() {
        return Err("Builderbot routing rule update has no editable fields.".to_string());
    }
    Ok(Value::Object(sanitized))
}

fn attach_current_user(response: &mut Value, user: &str) {
    if let Some(object) = response.as_object_mut() {
        object.insert("current_user".to_string(), json!(user));
    }
}

fn merge_task_responses(authored_response: Value, assigned_response: Value, limit: u32) -> Value {
    let mut tasks = Vec::new();
    let mut seen = HashSet::new();
    collect_tasks(&authored_response, &mut tasks, &mut seen, "authored");
    collect_tasks(&assigned_response, &mut tasks, &mut seen, "assigned");
    tasks.sort_by_key(|task| Reverse(task_timestamp(task)));
    tasks.truncate(limit as usize);

    let mut object = authored_response
        .as_object()
        .cloned()
        .unwrap_or_else(Map::new);
    object.insert("tasks".to_string(), Value::Array(tasks));
    Value::Object(object)
}

fn collect_tasks(
    response: &Value,
    tasks: &mut Vec<Value>,
    seen: &mut HashSet<String>,
    anonymous_prefix: &str,
) {
    let Some(items) = response.get("tasks").and_then(Value::as_array) else {
        return;
    };

    for (index, task) in items.iter().enumerate() {
        if !task.is_object() {
            continue;
        }
        let identity = task
            .get("key")
            .and_then(Value::as_str)
            .filter(|key| !key.trim().is_empty())
            .map(|key| format!("key:{key}"))
            .unwrap_or_else(|| format!("{anonymous_prefix}:{index}"));

        if seen.insert(identity) {
            tasks.push(task.clone());
        }
    }
}

fn task_timestamp(task: &Value) -> i64 {
    task.get("updated_at_ms")
        .or_else(|| task.get("created_at_ms"))
        .and_then(Value::as_i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_task_responses_deduplicates_and_sorts_by_recent_activity() {
        let authored = json!({
            "tasks": [
                { "key": "TSK-1", "updated_at_ms": 100, "author": "morganm" },
                { "key": "TSK-2", "updated_at_ms": 300, "author": "morganm" }
            ]
        });
        let assigned = json!({
            "tasks": [
                { "key": "TSK-1", "updated_at_ms": 100, "assignee": "morganm" },
                { "key": "TSK-3", "updated_at_ms": 200, "assignee": "morganm" }
            ]
        });

        let merged = merge_task_responses(authored, assigned, 50);
        let keys: Vec<_> = merged["tasks"]
            .as_array()
            .expect("tasks array")
            .iter()
            .filter_map(|task| task["key"].as_str())
            .collect();

        assert_eq!(keys, vec!["TSK-2", "TSK-3", "TSK-1"]);
    }

    #[test]
    fn merge_task_responses_respects_limit() {
        let authored = json!({
            "tasks": [
                { "key": "TSK-1", "updated_at_ms": 100 },
                { "key": "TSK-2", "updated_at_ms": 200 }
            ]
        });
        let assigned = json!({
            "tasks": [
                { "key": "TSK-3", "updated_at_ms": 300 }
            ]
        });

        let merged = merge_task_responses(authored, assigned, 2);

        assert_eq!(merged["tasks"].as_array().expect("tasks array").len(), 2);
    }

    #[test]
    fn user_owned_list_query_filters_before_backend_pagination() {
        assert_eq!(
            user_owned_list_query(50, " morganm "),
            vec![
                ("limit", "50".to_string()),
                ("owner", "morganm".to_string())
            ]
        );
    }
}
