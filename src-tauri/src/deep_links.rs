use percent_encoding::percent_decode_str;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

pub(crate) fn install<R: Runtime>(app: &tauri::App<R>) {
    // Handles link delivered while app is already running. TODO: cold start from link.
    let deep_link_app = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        handle_urls(deep_link_app.clone(), event.urls());
    });
}

fn handle_urls<R: Runtime>(app: AppHandle<R>, urls: Vec<Url>) {
    let mut opened_session = false;
    for url in urls {
        log::info!("Received deep link: {url}");
        if !opened_session {
            if let Some(session_id) = parse_session_deep_link(&url) {
                opened_session = open_session(app.clone(), session_id);
            }
        }
    }
    focus_main_window(&app, opened_session);
}

fn focus_main_window<R: Runtime>(app: &AppHandle<R>, reveal: bool) {
    if let Some(window) = app.get_webview_window("main") {
        if reveal {
            let _ = window.show();
        }
        let _ = window.set_focus();
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

#[cfg(feature = "goosectl")]
fn open_session<R: Runtime>(app: AppHandle<R>, session_id: String) -> bool {
    tauri::async_runtime::spawn(async move {
        let result = tauri_plugin_goosectl::dispatch_app_command(
            app,
            "sessions".to_string(),
            serde_json::json!({
                "action": "open",
                "session_id": session_id,
            }),
            None,
        )
        .await;
        if result.is_err() {
            log::warn!("Failed to open session from deep link");
        }
    });
    true
}

#[cfg(not(feature = "goosectl"))]
fn open_session<R: Runtime>(_app: AppHandle<R>, _session_id: String) -> bool {
    log::warn!("Ignoring session deep link because the goosectl feature is disabled");
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Option<String> {
        parse_session_deep_link(&Url::parse(raw).unwrap())
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
}
