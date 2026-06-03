use crate::services::builderbot;
use serde_json::{json, Map, Value};
use std::{cmp::Reverse, collections::HashSet, env};

const DEFAULT_LIST_LIMIT: u32 = 50;
const MAX_LIST_LIMIT: u32 = 100;

#[tauri::command]
pub async fn get_builderbot_tasks(limit: Option<u32>) -> Result<Value, String> {
    let limit = normalize_limit(limit);
    let user = require_builderbot_user()?;
    let common_query = vec![("limit", limit.to_string()), ("status", "all".to_string())];
    let mut authored_query = common_query.clone();
    authored_query.push(("author", user.clone()));
    let mut assigned_query = common_query;
    assigned_query.push(("assignee", user.clone()));

    let (authored_response, assigned_response) = tokio::try_join!(
        builderbot::get_json("/api/v1/tasks", &authored_query),
        builderbot::get_json("/api/v1/tasks", &assigned_query)
    )?;
    let mut response = merge_task_responses(authored_response, assigned_response, limit);
    attach_current_user(&mut response, &user);
    Ok(response)
}

#[tauri::command]
pub async fn get_builderbot_scheduled_triggers(limit: Option<u32>) -> Result<Value, String> {
    let limit = normalize_limit(limit);
    let user = require_builderbot_user()?;
    let mut response = builderbot::get_json(
        "/api/v1/scheduled-triggers",
        &[("limit", limit.to_string())],
    )
    .await?;
    attach_current_user(&mut response, &user);
    Ok(response)
}

#[tauri::command]
pub async fn get_builderbot_routing_rules(limit: Option<u32>) -> Result<Value, String> {
    let limit = normalize_limit(limit);
    let user = require_builderbot_user()?;
    let mut response =
        builderbot::get_json("/api/v1/routing-rules", &[("limit", limit.to_string())]).await?;
    attach_current_user(&mut response, &user);
    Ok(response)
}

fn normalize_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT)
}

fn current_builderbot_user() -> Option<String> {
    env::var("GOOSE_INTERNAL_BUILDERBOT_USER")
        .ok()
        .or_else(|| env::var("USER").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn require_builderbot_user() -> Result<String, String> {
    current_builderbot_user().ok_or_else(|| {
        "Unable to determine your Builderbot user. Set GOOSE_INTERNAL_BUILDERBOT_USER and try again."
            .to_string()
    })
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
}
