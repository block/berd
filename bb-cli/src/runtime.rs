use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;

use crate::kgoose::{
    ExtensionInfo, KgooseClient, KgooseConfig, ListExtensionsResponse, ToolConfig,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExtensionSummary {
    pub name: String,
    pub about: String,
}

#[derive(Debug, Clone)]
pub struct LoadedExtension {
    pub name: String,
    pub about: String,
    pub description: String,
    pub tools: Vec<RuntimeTool>,
}

#[derive(Debug, Clone)]
pub struct RuntimeTool {
    pub extension_name: String,
    pub kgoose_name: String,
    pub cli_name: String,
    pub about: String,
    pub description: String,
    pub parameters: Vec<ToolParameter>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolParameter {
    pub name: String,
    pub cli_name: String,
    pub required: bool,
    pub description: Option<String>,
    pub kind: ParameterKind,
    pub default: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ParameterKind {
    Scalar(ScalarKind),
    Array(ScalarKind),
    Json,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ScalarKind {
    String {
        enum_values: Vec<Value>,
        format: Option<String>,
    },
    Integer {
        enum_values: Vec<Value>,
    },
    Number {
        enum_values: Vec<Value>,
    },
    Boolean,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SchemaShape {
    Null,
    Scalar(ScalarShape),
    Array(ScalarShape),
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ScalarShape {
    String,
    Integer,
    Number,
    Boolean,
}

pub fn load_extensions(
    client: &impl KgooseClient,
    config: &KgooseConfig,
) -> Result<Vec<ExtensionSummary>> {
    let response = client.list_extensions(config)?;
    Ok(sort_extensions(response)
        .into_iter()
        .filter_map(|extension| {
            let name = extension.name?;
            Some(ExtensionSummary {
                about: compact_text(
                    extension
                        .description
                        .as_deref()
                        .unwrap_or(&format!("{} tools", extension.tool_count.unwrap_or(0))),
                ),
                name,
            })
        })
        .collect())
}

pub fn load_extension(
    client: &impl KgooseClient,
    config: &KgooseConfig,
    extension_name: &str,
    known_extensions: &[ExtensionSummary],
) -> Result<LoadedExtension> {
    let response = match client.list_tools(config, extension_name) {
        Ok(response) => response,
        Err(err) => {
            // The static catalog covers all known extensions (both live API and late-init
            // OAuth extensions like `asana` or `notion`). Using it here lets us distinguish
            // "unknown extension" (typo) from "known but not yet connected" and surface a
            // helpful G2 Connections hint for the latter.
            let is_known = known_extensions
                .iter()
                .any(|extension| extension.name == extension_name);

            if is_known || known_extensions.is_empty() {
                return Err(humanize_list_tools_error(
                    extension_name,
                    config.playpen.as_deref(),
                    &err,
                ));
            }

            anyhow::bail!(
                "unknown extension `{extension_name}` (available: {})",
                known_extensions
                    .iter()
                    .map(|extension| extension.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
    };

    let mut tools = response
        .tools
        .iter()
        .map(|tool| build_runtime_tool(extension_name, tool))
        .collect::<Result<Vec<_>>>()?;
    tools.sort_by(|left, right| left.cli_name.cmp(&right.cli_name));
    let description =
        extension_help_text(response.extension_description.as_deref(), "Extension tools");

    Ok(LoadedExtension {
        name: response
            .extension_name
            .clone()
            .unwrap_or_else(|| extension_name.to_string()),
        about: compact_text(&description),
        description,
        tools,
    })
}

fn humanize_list_tools_error(
    extension_name: &str,
    playpen: Option<&str>,
    err: &anyhow::Error,
) -> anyhow::Error {
    let raw = err.to_string();
    let raw_lower = raw.to_ascii_lowercase();
    let playpen_suffix = playpen
        .map(|playpen| format!(" in playpen `{playpen}`"))
        .unwrap_or_default();

    let reason = if raw_lower.contains("404 not found")
        || raw_lower.contains("not authorized")
        || raw_lower.contains("403 forbidden")
    {
        format!(
            "Can't inspect `{extension_name}`{playpen_suffix}.\n\
             `{extension_name}` is visible in the extension list, but the backend service wouldn't return its tools.\n\
             This usually means the extension is not connected in your account.\n\
             Check your G2 Connections settings to verify the extension is connected: https://g2.sqprod.co/settings\n\
             Server response: {raw}"
        )
    } else {
        format!(
            "Can't inspect `{extension_name}`{playpen_suffix}.\n\
             The backend service couldn't load the tool list for that extension.\n\
             Server response: {raw}"
        )
    };

    anyhow::anyhow!(reason)
}

pub fn normalize_cli_name(name: &str) -> String {
    name.replace('_', "-")
}

pub fn compact_text(value: &str) -> String {
    compact_text_with_limit(value, 88)
}

pub fn compact_text_with_limit(value: &str, max_len: usize) -> String {
    let summary = value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .trim();

    truncate(summary, max_len)
}

fn extension_help_text(value: Option<&str>, default: &str) -> String {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(default)
        .to_string()
}

fn truncate(value: &str, max_len: usize) -> String {
    let len = value.chars().count();
    if len <= max_len {
        return value.to_string();
    }

    let truncated = value.chars().take(max_len).collect::<String>();
    format!("{}...", truncated.trim_end())
}

fn sort_extensions(response: ListExtensionsResponse) -> Vec<ExtensionInfo> {
    let mut extensions = response.extensions;
    extensions.sort_by(|left, right| left.name.cmp(&right.name));
    extensions
}

fn build_runtime_tool(extension_name: &str, tool: &ToolConfig) -> Result<RuntimeTool> {
    let raw_description = tool
        .description
        .as_deref()
        .unwrap_or("No description provided.");
    Ok(RuntimeTool {
        extension_name: extension_name.to_string(),
        kgoose_name: tool_name(tool).to_string(),
        cli_name: normalize_cli_name(tool_name(tool)),
        about: compact_text(raw_description),
        description: raw_description.trim().to_string(),
        parameters: extract_tool_parameters(tool.config_json.as_deref())?,
    })
}

fn tool_name(tool: &ToolConfig) -> &str {
    tool.tool.as_deref().unwrap_or("?")
}

fn extract_tool_parameters(schema_json: Option<&str>) -> Result<Vec<ToolParameter>> {
    let Some(schema_json) = schema_json else {
        return Ok(Vec::new());
    };

    let root = serde_json::from_str::<Value>(schema_json).context("parse tool input schema")?;
    let schema = resolve_schema(&root, &root);
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };

    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();

    let mut parameters = properties
        .iter()
        .map(|(name, property)| {
            let resolved = resolve_schema(property, &root);
            Ok(ToolParameter {
                name: name.clone(),
                cli_name: normalize_cli_name(name),
                required: required.iter().any(|required_name| required_name == name),
                description: resolved
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                kind: classify_parameter_kind(&root, resolved),
                default: resolved.get("default").cloned(),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    parameters.sort_by(|left, right| {
        right
            .required
            .cmp(&left.required)
            .then_with(|| left.cli_name.cmp(&right.cli_name))
    });

    Ok(parameters)
}

fn classify_parameter_kind(root: &Value, schema: &Value) -> ParameterKind {
    match classify_schema_shape(root, schema) {
        SchemaShape::Scalar(shape) => ParameterKind::Scalar(scalar_kind(schema, &shape)),
        SchemaShape::Array(shape) => array_item_schema(root, schema)
            .map(|items| ParameterKind::Array(scalar_kind(items, &shape)))
            .unwrap_or(ParameterKind::Json),
        SchemaShape::Json | SchemaShape::Null => ParameterKind::Json,
    }
}

fn array_item_schema<'a>(root: &'a Value, schema: &'a Value) -> Option<&'a Value> {
    let schema = resolve_schema(schema, root);

    if let Some(items) = schema.get("items") {
        return Some(resolve_schema(items, root));
    }

    schema
        .get("anyOf")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|variant| match classify_schema_shape(root, variant) {
            SchemaShape::Array(_) => array_item_schema(root, variant),
            _ => None,
        })
}

fn scalar_kind(schema: &Value, shape: &ScalarShape) -> ScalarKind {
    let enum_values = extract_enum_values(schema);
    match shape {
        ScalarShape::String => ScalarKind::String {
            enum_values,
            format: schema
                .get("format")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        ScalarShape::Integer => ScalarKind::Integer { enum_values },
        ScalarShape::Number => ScalarKind::Number { enum_values },
        ScalarShape::Boolean => ScalarKind::Boolean,
    }
}

fn classify_schema_shape(root: &Value, schema: &Value) -> SchemaShape {
    let schema = resolve_schema(schema, root);

    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array) {
        return classify_any_of(root, any_of);
    }

    if schema
        .get("properties")
        .and_then(Value::as_object)
        .is_some()
    {
        return SchemaShape::Json;
    }

    match schema.get("type").and_then(Value::as_str) {
        Some("null") => SchemaShape::Null,
        Some("boolean") => SchemaShape::Scalar(ScalarShape::Boolean),
        Some("string") => SchemaShape::Scalar(ScalarShape::String),
        Some("integer") => SchemaShape::Scalar(ScalarShape::Integer),
        Some("number") => SchemaShape::Scalar(ScalarShape::Number),
        Some("array") => schema
            .get("items")
            .map(|items| classify_schema_shape(root, items))
            .and_then(|shape| match shape {
                SchemaShape::Scalar(shape) => Some(SchemaShape::Array(shape)),
                _ => None,
            })
            .unwrap_or(SchemaShape::Json),
        Some("object") => SchemaShape::Json,
        _ => {
            if schema.get("enum").and_then(Value::as_array).is_some() {
                infer_enum_shape(schema).map_or(SchemaShape::Json, SchemaShape::Scalar)
            } else {
                SchemaShape::Json
            }
        }
    }
}

fn classify_any_of(root: &Value, any_of: &[Value]) -> SchemaShape {
    let mut shapes = any_of
        .iter()
        .map(|schema| classify_schema_shape(root, schema))
        .filter(|shape| *shape != SchemaShape::Null)
        .collect::<Vec<_>>();

    if shapes.is_empty() {
        return SchemaShape::Null;
    }

    let first = shapes.remove(0);
    if shapes.iter().all(|shape| *shape == first) {
        return first;
    }

    if let Some(shape) = merge_any_of_scalars(&first, &shapes) {
        return shape;
    }

    SchemaShape::Json
}

fn merge_any_of_scalars(first: &SchemaShape, rest: &[SchemaShape]) -> Option<SchemaShape> {
    let SchemaShape::Scalar(first_scalar) = first else {
        return None;
    };

    if rest.iter().all(|shape| {
        matches!(
            shape,
            SchemaShape::Scalar(other) if other == first_scalar
        )
    }) {
        return Some(SchemaShape::Scalar(first_scalar.clone()));
    }

    if *first_scalar == ScalarShape::String
        && rest
            .iter()
            .all(|shape| matches!(shape, SchemaShape::Scalar(ScalarShape::String)))
    {
        return Some(SchemaShape::Scalar(ScalarShape::String));
    }

    None
}

fn infer_enum_shape(schema: &Value) -> Option<ScalarShape> {
    let mut values = schema.get("enum")?.as_array()?.iter();
    let first = values.next()?;

    let first_shape = match first {
        Value::String(_) => ScalarShape::String,
        Value::Number(number) if number.is_i64() || number.is_u64() => ScalarShape::Integer,
        Value::Number(_) => ScalarShape::Number,
        Value::Bool(_) => ScalarShape::Boolean,
        _ => return None,
    };

    if values.all(|value| matches_enum_shape(value, &first_shape)) {
        Some(first_shape)
    } else {
        None
    }
}

fn matches_enum_shape(value: &Value, shape: &ScalarShape) -> bool {
    match shape {
        ScalarShape::String => value.is_string(),
        ScalarShape::Integer => value.as_i64().is_some() || value.as_u64().is_some(),
        ScalarShape::Number => value.is_number(),
        ScalarShape::Boolean => value.is_boolean(),
    }
}

fn extract_enum_values(schema: &Value) -> Vec<Value> {
    schema
        .get("enum")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn resolve_schema<'a>(schema: &'a Value, root: &'a Value) -> &'a Value {
    let mut current = schema;

    while let Some(reference) = current.get("$ref").and_then(Value::as_str) {
        let Some(path) = reference.strip_prefix("#/") else {
            break;
        };

        let Some(resolved) = path
            .split('/')
            .try_fold(root, |value, segment| value.get(segment))
        else {
            break;
        };

        current = resolved;
    }

    current
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        load_extension, load_extensions, normalize_cli_name, ExtensionSummary, ParameterKind,
        ScalarKind, ToolParameter,
    };
    use crate::kgoose::{
        CallToolResponse, ExtensionInfo, KgooseClient, KgooseConfig, ListExtensionsResponse,
        ListToolsResponse, ToolConfig,
    };

    struct TestKgooseClient;

    impl KgooseClient for TestKgooseClient {
        fn list_extensions(
            &self,
            _config: &KgooseConfig,
        ) -> anyhow::Result<ListExtensionsResponse> {
            Ok(ListExtensionsResponse {
                extensions: vec![ExtensionInfo {
                    name: Some("utils".to_string()),
                    description: Some("Utility helpers".to_string()),
                    tool_count: Some(1),
                    any_tool_requires_user_auth: Some(false),
                    auth_satisfied_for_caller: Some(true),
                    ..Default::default()
                }],
            })
        }

        fn list_tools(
            &self,
            _config: &KgooseConfig,
            extension_name: &str,
        ) -> anyhow::Result<ListToolsResponse> {
            if extension_name != "utils" {
                anyhow::bail!("unknown extension");
            }

            Ok(ListToolsResponse {
                extension_name: Some("utils".to_string()),
                extension_description: Some("Utility helpers".to_string()),
                tools: vec![ToolConfig {
                    tool: Some("calculate".to_string()),
                    description: Some("Perform math".to_string()),
                    config_json: Some(
                        r#"{"type":"object","properties":{"numbers":{"type":"array","items":{"type":"number"}},"operation":{"type":"string","enum":["add","subtract"]}},"required":["numbers","operation"]}"#
                            .to_string(),
                    ),
                    mutates_state: Some(false),
                    ..Default::default()
                }],
            })
        }

        fn call_tool(
            &self,
            _config: &KgooseConfig,
            _extension_name: &str,
            _tool_name: &str,
            _arguments_json: &str,
            _headers: &BTreeMap<String, String>,
        ) -> anyhow::Result<CallToolResponse> {
            unreachable!("call_tool is not used during metadata loading")
        }
    }

    struct UnauthorizedKgooseClient;

    impl KgooseClient for UnauthorizedKgooseClient {
        fn list_extensions(
            &self,
            _config: &KgooseConfig,
        ) -> anyhow::Result<ListExtensionsResponse> {
            Ok(ListExtensionsResponse {
                extensions: vec![ExtensionInfo {
                    name: Some("airtable".to_string()),
                    description: Some("Airtable tools".to_string()),
                    tool_count: Some(4),
                    any_tool_requires_user_auth: Some(false),
                    auth_satisfied_for_caller: Some(false),
                    ..Default::default()
                }],
            })
        }

        fn list_tools(
            &self,
            _config: &KgooseConfig,
            extension_name: &str,
        ) -> anyhow::Result<ListToolsResponse> {
            anyhow::bail!(
                "POST /squareup.cash.kgoose.api.v3.ToolEndpointService/ListTools failed with 404 Not Found: Extension '{extension_name}' not found or not authorized"
            )
        }

        fn call_tool(
            &self,
            _config: &KgooseConfig,
            _extension_name: &str,
            _tool_name: &str,
            _arguments_json: &str,
            _headers: &BTreeMap<String, String>,
        ) -> anyhow::Result<CallToolResponse> {
            unreachable!("call_tool is not used during metadata loading")
        }
    }

    fn kgoose_config() -> KgooseConfig {
        KgooseConfig {
            base_url: "https://example.test".to_string(),
            service_path: crate::bb::skills_config::DEFAULT_KGOOSE_SERVICE_PATH.to_string(),
            playpen: Some("baxen".to_string()),
            goosemcp_playpen: None,
            timeout_secs: 600.0,
            session_credential: None,
        }
    }

    #[test]
    fn normalize_cli_name_replaces_underscores() {
        assert_eq!(
            normalize_cli_name("get_channel_messages"),
            "get-channel-messages"
        );
    }

    #[test]
    fn load_extensions_builds_sorted_extension_summaries() {
        let extensions =
            load_extensions(&TestKgooseClient, &kgoose_config()).expect("load extensions");
        assert_eq!(extensions.len(), 1);
        assert_eq!(extensions[0].name, "utils");
        assert_eq!(extensions[0].about, "Utility helpers");
    }

    #[test]
    fn load_extension_discovers_tools_and_schema_parameters() {
        let extension =
            load_extension(&TestKgooseClient, &kgoose_config(), "utils", &[]).expect("extension");
        assert_eq!(extension.name, "utils");
        assert_eq!(extension.about, "Utility helpers");
        assert_eq!(extension.description, "Utility helpers");
        assert_eq!(extension.tools.len(), 1);
        assert_eq!(extension.tools[0].cli_name, "calculate");
        assert_eq!(
            extension.tools[0].parameters[0],
            ToolParameter {
                name: "numbers".to_string(),
                cli_name: "numbers".to_string(),
                required: true,
                description: None,
                kind: ParameterKind::Array(ScalarKind::Number {
                    enum_values: Vec::new(),
                }),
                default: None,
            }
        );
    }

    #[test]
    fn load_extension_rewrites_inaccessible_errors_for_humans() {
        let known = vec![ExtensionSummary {
            name: "airtable".to_string(),
            about: "Airtable tools".to_string(),
        }];
        let error = load_extension(
            &UnauthorizedKgooseClient,
            &kgoose_config(),
            "airtable",
            &known,
        )
        .expect_err("expected inaccessible extension");

        let message = error.to_string();
        assert!(message.contains("Can't inspect `airtable`"));
        assert!(message.contains("wouldn't return its tools"));
        assert!(message.contains("G2 Connections settings"));
        assert!(message.contains("Server response:"));
    }

    #[test]
    fn load_extension_rewrites_catalog_known_inaccessible_errors_for_humans() {
        let error = load_extension(
            &UnauthorizedKgooseClient,
            &kgoose_config(),
            "asana",
            &[ExtensionSummary {
                name: "asana".to_string(),
                about: "Asana tools".to_string(),
            }],
        )
        .expect_err("expected inaccessible extension");

        let message = error.to_string();
        assert!(message.contains("Can't inspect `asana`"));
        assert!(message.contains("wouldn't return its tools"));
        assert!(message.contains("G2 Connections settings"));
    }
}
