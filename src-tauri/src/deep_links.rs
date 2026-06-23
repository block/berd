use base64::{
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
    Engine as _,
};
use percent_encoding::percent_decode_str;
use serde::Deserialize;
#[cfg(feature = "goosectl")]
use serde::Serialize;
#[cfg(feature = "goosectl")]
use tauri::Emitter;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

#[cfg(feature = "goosectl")]
const SESSION_DEEP_LINK_ERROR_EVENT: &str = "goose:session-deep-link-error";

#[cfg(feature = "goosectl")]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionDeepLinkErrorPayload {
    session_id: String,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DeepLinkAction {
    OpenSession(String),
    CreateRecipeSession(RecipeDeepLink),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecipeDeepLink {
    prompt: String,
}

#[derive(Debug, Deserialize)]
struct RecipePayload {
    instructions: Option<String>,
    prompt: Option<String>,
}

pub(crate) fn install<R: Runtime>(app: &tauri::App<R>) {
    // Handles links delivered while the app is already running. Startup
    // session links are drained by GoosectlBridge after the renderer command
    // registry has mounted.
    let deep_link_app = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        handle_urls(deep_link_app.clone(), event.urls());
    });
}

fn handle_urls<R: Runtime>(app: AppHandle<R>, urls: Vec<Url>) {
    let mut handled_link = false;
    for url in urls {
        log::info!("Received deep link: {url}");
        if !handled_link {
            if let Some(action) = parse_deep_link(&url) {
                handled_link = handle_deep_link_action(app.clone(), action);
            }
        }
    }
    focus_main_window(&app, handled_link);
}

fn focus_main_window<R: Runtime>(app: &AppHandle<R>, reveal: bool) {
    if let Some(window) = app.get_webview_window("main") {
        if reveal {
            let _ = window.show();
        }
        let _ = window.set_focus();
    }
}

fn parse_deep_link(url: &Url) -> Option<DeepLinkAction> {
    if let Some(session_id) = parse_session_deep_link(url) {
        return Some(DeepLinkAction::OpenSession(session_id));
    }

    parse_recipe_deep_link(url).map(DeepLinkAction::CreateRecipeSession)
}

fn handle_deep_link_action<R: Runtime>(app: AppHandle<R>, action: DeepLinkAction) -> bool {
    match action {
        DeepLinkAction::OpenSession(session_id) => open_session(app, session_id),
        DeepLinkAction::CreateRecipeSession(recipe) => create_recipe_session(app, recipe),
    }
}

fn parse_session_deep_link(url: &Url) -> Option<String> {
    if url.scheme() != "goose-internal" {
        return None;
    }

    let mut segments = url.path_segments()?.collect::<Vec<_>>();
    let encoded_session_id = match url.host_str() {
        Some("session") if segments.len() == 1 => segments.pop(),
        None | Some("") if segments.len() == 2 && segments[0] == "session" => Some(segments[1]),
        _ => None,
    }?;

    percent_decode_str(encoded_session_id)
        .decode_utf8()
        .ok()
        .map(|session_id| session_id.into_owned())
        .filter(|session_id| !session_id.is_empty())
}

fn parse_recipe_deep_link(url: &Url) -> Option<RecipeDeepLink> {
    if url.scheme() != "goose-internal" || !is_recipe_route(url) {
        return None;
    }

    let encoded_config = url
        .query_pairs()
        .find_map(|(key, value)| (key == "config").then(|| value.into_owned()))?;
    let decoded_config = decode_recipe_config(&encoded_config).ok()?;
    let payload: RecipePayload = serde_json::from_slice(&decoded_config).ok()?;
    let prompt = recipe_session_prompt(&payload)?;

    Some(RecipeDeepLink { prompt })
}

fn is_recipe_route(url: &Url) -> bool {
    match url.host_str() {
        Some("recipe") => url.path().is_empty() || url.path() == "/",
        None | Some("") => url.path() == "/recipe",
        _ => false,
    }
}

fn decode_recipe_config(config: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD
        .decode(config)
        .or_else(|_| URL_SAFE.decode(config))
}

fn recipe_session_prompt(payload: &RecipePayload) -> Option<String> {
    let parts = [payload.instructions.as_deref(), payload.prompt.as_deref()]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

#[cfg(feature = "goosectl")]
fn open_session<R: Runtime>(app: AppHandle<R>, session_id: String) -> bool {
    tauri::async_runtime::spawn(async move {
        let requested_session_id = session_id.clone();
        let result = tauri_plugin_goosectl::dispatch_app_command(
            app.clone(),
            "sessions".to_string(),
            serde_json::json!({
                "action": "open",
                "session_id": session_id,
            }),
            None,
        )
        .await;
        match result {
            Ok(_) => {}
            Err(error) => {
                log::warn!("Failed to open session from deep link: {error}");
                let payload = session_deep_link_error_payload(&requested_session_id, &error);
                emit_session_deep_link_error(&app, payload);
            }
        }
    });
    true
}

#[cfg(feature = "goosectl")]
fn create_recipe_session<R: Runtime>(app: AppHandle<R>, recipe: RecipeDeepLink) -> bool {
    tauri::async_runtime::spawn(async move {
        let result = tauri_plugin_goosectl::dispatch_app_command(
            app.clone(),
            "sessions".to_string(),
            serde_json::json!({
                "action": "create",
                "prompt": recipe.prompt,
            }),
            None,
        )
        .await;

        match result {
            Ok(value) => {
                let Some(session_id) = value.get("session_id").and_then(|session_id| {
                    session_id
                        .as_str()
                        .map(str::trim)
                        .filter(|session_id| !session_id.is_empty())
                        .map(str::to_string)
                }) else {
                    let message = "Created a recipe session but could not open it.";
                    log::warn!("{message}");
                    emit_session_deep_link_error_message(&app, "recipe", message);
                    return;
                };
                let open_result = tauri_plugin_goosectl::dispatch_app_command(
                    app.clone(),
                    "sessions".to_string(),
                    serde_json::json!({
                        "action": "open",
                        "session_id": &session_id,
                    }),
                    None,
                )
                .await;
                if let Err(error) = open_result {
                    log::warn!("Failed to open recipe session from deep link: {error}");
                    let payload = session_deep_link_error_payload(&session_id, &error);
                    emit_session_deep_link_error(&app, payload);
                }
            }
            Err(error) => {
                log::warn!("Failed to create recipe session from deep link: {error}");
                let message = deep_link_error_message(
                    &error,
                    "Could not create a new session for the install link.",
                );
                emit_session_deep_link_error_message(&app, "recipe", &message);
            }
        }
    });
    true
}

#[cfg(feature = "goosectl")]
fn session_deep_link_error_payload(
    session_id: &str,
    error: &tauri_plugin_goosectl::AppCommandDispatchError,
) -> SessionDeepLinkErrorPayload {
    let message =
        deep_link_error_message(error, &format!("Could not open session \"{session_id}\"."));
    SessionDeepLinkErrorPayload {
        session_id: session_id.to_string(),
        message,
    }
}

#[cfg(feature = "goosectl")]
fn deep_link_error_message(
    error: &tauri_plugin_goosectl::AppCommandDispatchError,
    fallback: &str,
) -> String {
    match error {
        tauri_plugin_goosectl::AppCommandDispatchError::Command { message, .. }
            if !message.trim().is_empty() =>
        {
            message.clone()
        }
        _ => fallback.to_string(),
    }
}

#[cfg(feature = "goosectl")]
fn emit_session_deep_link_error<R: Runtime>(
    app: &AppHandle<R>,
    payload: SessionDeepLinkErrorPayload,
) {
    if let Err(error) = app.emit_to("main", SESSION_DEEP_LINK_ERROR_EVENT, payload) {
        log::warn!("Failed to emit session deep link error event: {error}");
    }
}

#[cfg(feature = "goosectl")]
fn emit_session_deep_link_error_message<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    message: &str,
) {
    emit_session_deep_link_error(
        app,
        SessionDeepLinkErrorPayload {
            session_id: session_id.to_string(),
            message: message.to_string(),
        },
    );
}

#[cfg(not(feature = "goosectl"))]
fn open_session<R: Runtime>(_app: AppHandle<R>, _session_id: String) -> bool {
    log::warn!("Ignoring session deep link because the goosectl feature is disabled");
    false
}

#[cfg(not(feature = "goosectl"))]
fn create_recipe_session<R: Runtime>(_app: AppHandle<R>, _recipe: RecipeDeepLink) -> bool {
    log::warn!("Ignoring recipe deep link because the goosectl feature is disabled");
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Option<String> {
        parse_session_deep_link(&Url::parse(raw).unwrap())
    }

    fn parse_recipe(raw: &str) -> Option<RecipeDeepLink> {
        parse_recipe_deep_link(&Url::parse(raw).unwrap())
    }

    fn encode_recipe(value: serde_json::Value) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())
    }

    #[test]
    fn parses_session_host_route() {
        assert_eq!(
            parse("goose-internal://session/abc-123"),
            Some("abc-123".to_string())
        );
    }

    #[test]
    fn parses_session_path_route() {
        assert_eq!(
            parse("goose-internal:///session/abc-123"),
            Some("abc-123".to_string())
        );
    }

    #[test]
    fn percent_decodes_session_id() {
        assert_eq!(
            parse("goose-internal://session/id%2Fwith%20spaces"),
            Some("id/with spaces".to_string())
        );
    }

    #[test]
    fn ignores_non_session_links() {
        assert_eq!(parse("goose-internal://connect-return"), None);
        assert_eq!(parse("https://example.com/session/abc"), None);
        assert_eq!(parse("goose-internal://session/"), None);
        assert_eq!(parse("goose-internal:///session/"), None);
        assert_eq!(parse("goose-internal://session/a/b"), None);
        assert_eq!(parse("goose-internal://session/%FF"), None);
    }

    #[test]
    fn parses_recipe_host_route() {
        let config = encode_recipe(serde_json::json!({
            "instructions": "Act as a skill installer.",
            "prompt": "Install this skill.",
        }));

        assert_eq!(
            parse_recipe(&format!("goose-internal://recipe?config={config}")),
            Some(RecipeDeepLink {
                prompt: "Act as a skill installer.\n\nInstall this skill.".to_string(),
            })
        );
    }

    #[test]
    fn parses_recipe_path_route() {
        let config = encode_recipe(serde_json::json!({
            "prompt": "Install this skill.",
        }));

        assert_eq!(
            parse_recipe(&format!("goose-internal:///recipe?config={config}")),
            Some(RecipeDeepLink {
                prompt: "Install this skill.".to_string(),
            })
        );
    }

    #[test]
    fn ignores_invalid_recipe_links() {
        let empty_prompt = encode_recipe(serde_json::json!({
            "prompt": " ",
        }));
        let path = encode_recipe(serde_json::json!({
            "prompt": "Install this skill.",
        }));

        assert_eq!(parse_recipe("goose-internal://recipe"), None);
        assert_eq!(
            parse_recipe("goose-internal://recipe?config=not-base64"),
            None
        );
        assert_eq!(
            parse_recipe(&format!("goose-internal://recipe?config={empty_prompt}")),
            None
        );
        assert_eq!(
            parse_recipe(&format!("goose-internal://recipe/extra?config={path}")),
            None
        );
        assert_eq!(parse_recipe("goose://recipe?config=abc"), None);
        assert_eq!(parse_recipe("https://example.com/recipe?config=abc"), None);
    }

    #[cfg(feature = "goosectl")]
    #[test]
    fn builds_dispatch_error_payloads() {
        assert_eq!(
            session_deep_link_error_payload(
                "missing-session",
                &tauri_plugin_goosectl::AppCommandDispatchError::Command {
                    code: "session_not_found".to_string(),
                    message:
                        "No session \"missing-session\"; list sessions with `goosectl session list`."
                            .to_string(),
                },
            ),
            SessionDeepLinkErrorPayload {
                session_id: "missing-session".to_string(),
                message:
                    "No session \"missing-session\"; list sessions with `goosectl session list`."
                        .to_string(),
            }
        );
        assert_eq!(
            session_deep_link_error_payload(
                "missing-session",
                &tauri_plugin_goosectl::AppCommandDispatchError::Command {
                    code: "backend_read_failed".to_string(),
                    message: "Backend down".to_string(),
                },
            ),
            SessionDeepLinkErrorPayload {
                session_id: "missing-session".to_string(),
                message: "Backend down".to_string(),
            }
        );
        assert_eq!(
            session_deep_link_error_payload(
                "missing-session",
                &tauri_plugin_goosectl::AppCommandDispatchError::Timeout,
            ),
            SessionDeepLinkErrorPayload {
                session_id: "missing-session".to_string(),
                message: "Could not open session \"missing-session\".".to_string(),
            }
        );
    }
}
