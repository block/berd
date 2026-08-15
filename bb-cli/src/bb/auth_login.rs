//! Browser login for BuilderBot auth.

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use builderbot_auth::auth_login::{
    build_auth_http_client, logout_session_credential, verify_session_credential, AuthMeResponse,
    OAuthCallback, OAuthLoginAttempt,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tiny_http::{Header, Response, Server, StatusCode};
use url::Url;

use super::auth_storage::{session_storage_key_from_config, SessionCredentialStorage};
use super::skills_config::{kgoose_service_url, SkillsConfig};

const CALLBACK_PATH: &str = "/callback";
const LOGIN_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CALLBACK_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy)]
enum AuthCallbackPage {
    Success,
    Failure,
}

const AUTH_CALLBACK_PAGE_TEMPLATE: &str = include_str!("auth_callback.html");

#[derive(Debug, Serialize)]
pub struct BrowserLoginSummary {
    pub kgoose_base_url: String,
    pub kgoose_service_path: String,
    pub storage: String,
    pub source: BrowserLoginCredentialSource,
    pub workspace_name: String,
    pub expires_at: Option<String>,
    pub credential_prefix: Option<String>,
    pub credential_sha256_prefix: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserLoginCredentialSource {
    Stored,
    BrowserLogin,
}

pub fn run_browser_login(
    config: &SkillsConfig,
    storage: &dyn SessionCredentialStorage,
) -> Result<BrowserLoginSummary> {
    let service_url = kgoose_service_url(&config.kgoose_base_url, &config.kgoose_service_path);
    let client = build_auth_http_client(Duration::from_secs(30))?;
    let storage_key = session_storage_key_from_config(config);

    match storage.get(&storage_key)? {
        Some(stored) => {
            if let Some(me) = verify_session_credential(
                &client,
                config.playpen.as_deref(),
                &service_url,
                &stored,
            )? {
                auth_info(
                    config,
                    &format!(
                        "Found valid BuilderBot CLI auth session in {} storage",
                        storage.kind()
                    ),
                );
                let workspace_name = me.active_workspace_name()?.to_string();
                return Ok(BrowserLoginSummary {
                    kgoose_base_url: config.kgoose_base_url.clone(),
                    kgoose_service_path: config.kgoose_service_path.clone(),
                    storage: storage.kind().to_string(),
                    source: BrowserLoginCredentialSource::Stored,
                    workspace_name,
                    expires_at: me.expires_at.or(stored.expires_at),
                    credential_prefix: None,
                    credential_sha256_prefix: None,
                });
            }
            auth_info(
                config,
                &format!(
                    "Stored BuilderBot CLI auth session in {} storage is invalid",
                    storage.kind()
                ),
            );
        }
        None => {
            auth_info(
                config,
                &format!(
                    "No BuilderBot CLI auth session found in {} storage",
                    storage.kind()
                ),
            );
        }
    }

    let server = Server::http("127.0.0.1:0")
        .map_err(|error| anyhow!("listen on loopback callback port: {error}"))?;
    let callback_url = format!("http://{}{}", server.server_addr(), CALLBACK_PATH);
    let oauth_attempt = OAuthLoginAttempt::generate()?;
    let login_url = oauth_attempt.login_url(&service_url, &callback_url)?;

    let (tx, rx) = mpsc::channel();

    if !config.json {
        println!("Opening BuilderBot auth login in your browser:");
        println!("{}", login_url.as_str());
    }
    if let Err(error) = webbrowser::open(login_url.as_str()) {
        if config.json {
            return Err(anyhow!(
                "failed to open browser for BuilderBot auth login: {error}"
            ));
        }
        println!("Could not open a browser automatically. Open the URL above manually.");
    }

    thread::spawn(move || {
        let result = receive_exchange_code(server, oauth_attempt);
        let _ = tx.send(result);
    });

    let (code, mut oauth_attempt) = rx
        .recv()
        .context("loopback auth server stopped before login completed")??;
    let verified = oauth_attempt.exchange_login_code_and_verify(
        &client,
        config.playpen.as_deref(),
        &service_url,
        &code,
    )?;
    let stored = verified.credential;
    let me = verified.me;
    let workspace_name = me.active_workspace_name()?.to_string();
    storage.set(&storage_key, &stored)?;
    auth_info(
        config,
        &format!(
            "Stored BuilderBot CLI auth session in {} storage",
            storage.kind()
        ),
    );

    Ok(BrowserLoginSummary {
        kgoose_base_url: config.kgoose_base_url.clone(),
        kgoose_service_path: config.kgoose_service_path.clone(),
        storage: storage.kind().to_string(),
        source: BrowserLoginCredentialSource::BrowserLogin,
        workspace_name,
        expires_at: me.expires_at.or_else(|| stored.expires_at.clone()),
        credential_prefix: Some(safe_prefix(&stored.session_credential)),
        credential_sha256_prefix: Some(sha256_prefix(&stored.session_credential)),
    })
}

pub fn verify_stored_session(
    config: &SkillsConfig,
    storage: &dyn SessionCredentialStorage,
) -> Result<Option<AuthMeResponse>> {
    let service_url = kgoose_service_url(&config.kgoose_base_url, &config.kgoose_service_path);
    let client = build_auth_http_client(Duration::from_secs(30))?;
    let storage_key = session_storage_key_from_config(config);
    let Some(stored) = storage.get(&storage_key)? else {
        return Ok(None);
    };

    verify_session_credential(&client, config.playpen.as_deref(), &service_url, &stored)
}

pub fn logout_stored_session(
    config: &SkillsConfig,
    storage: &dyn SessionCredentialStorage,
) -> Result<bool> {
    let service_url = kgoose_service_url(&config.kgoose_base_url, &config.kgoose_service_path);
    let client = build_auth_http_client(Duration::from_secs(30))?;
    let storage_key = session_storage_key_from_config(config);
    let Some(stored) = storage.get(&storage_key)? else {
        return Ok(false);
    };

    logout_session_credential(&client, config.playpen.as_deref(), &service_url, &stored)
}

fn receive_exchange_code(
    server: Server,
    mut attempt: OAuthLoginAttempt,
) -> Result<(String, OAuthLoginAttempt)> {
    let deadline = Instant::now() + LOGIN_ATTEMPT_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(anyhow!(
                "BuilderBot CLI auth login expired before receiving a valid callback"
            ));
        }
        let Some(request) = server
            .recv_timeout(remaining.min(CALLBACK_POLL_INTERVAL))
            .context("receive loopback auth callback")?
        else {
            continue;
        };
        let url = request.url().to_string();
        let parsed = match Url::parse(&format!("http://127.0.0.1{url}")) {
            Ok(parsed) => parsed,
            Err(_) => {
                let _ = respond_text(
                    request,
                    StatusCode(400),
                    "BuilderBot CLI auth ignored an invalid callback request. The valid login is still waiting.",
                );
                continue;
            }
        };
        if parsed.path() != CALLBACK_PATH {
            let _ = respond_text(
                request,
                StatusCode(404),
                "BuilderBot CLI auth is waiting for the callback.",
            );
            continue;
        }
        if request.method() != &tiny_http::Method::Get {
            let _ = respond_text(
                request,
                StatusCode(400),
                "BuilderBot CLI auth ignored an invalid callback request. The valid login is still waiting.",
            );
            continue;
        }

        match attempt.parse_callback(&parsed) {
            OAuthCallback::Code(code) => {
                let _ = respond_auth_page(request, StatusCode(200), AuthCallbackPage::Success);
                return Ok((code, attempt));
            }
            OAuthCallback::Error(error) => {
                respond_auth_page(request, StatusCode(400), AuthCallbackPage::Failure)?;
                return Err(anyhow!("auth callback returned error: {error}"));
            }
            OAuthCallback::Rejected(_) => {
                let _ = respond_text(
                    request,
                    StatusCode(400),
                    "BuilderBot CLI auth ignored an uncorrelated callback. The valid login is still waiting.",
                );
            }
        }
    }
}

fn respond_text(request: tiny_http::Request, status: StatusCode, body: &str) -> Result<()> {
    request
        .respond(
            Response::from_string(body)
                .with_status_code(status)
                .with_header(
                    Header::from_bytes("content-type", "text/plain; charset=utf-8").unwrap(),
                ),
        )
        .map_err(|error| anyhow!("write loopback callback response: {error}"))
}

fn respond_auth_page(
    request: tiny_http::Request,
    status: StatusCode,
    page: AuthCallbackPage,
) -> Result<()> {
    request
        .respond(
            Response::from_string(auth_callback_page(page))
                .with_status_code(status)
                .with_header(
                    Header::from_bytes("content-type", "text/html; charset=utf-8").unwrap(),
                )
                .with_header(Header::from_bytes("cache-control", "no-store").unwrap())
                .with_header(
                    Header::from_bytes(
                        "content-security-policy",
                        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
                    )
                    .unwrap(),
                )
                .with_header(Header::from_bytes("x-content-type-options", "nosniff").unwrap()),
        )
        .map_err(|error| anyhow!("write loopback callback response: {error}"))
}

fn auth_callback_page(page: AuthCallbackPage) -> String {
    let (title, class_name, icon, heading, message, terminal_message) = match page {
        AuthCallbackPage::Success => (
            "Signed in · BuilderBot CLI",
            "success",
            r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.25 4.25L19 6.5"/></svg>"#,
            "You’re signed in",
            "BuilderBot CLI authentication is complete. You can safely close this tab.",
            "Return to your terminal",
        ),
        AuthCallbackPage::Failure => (
            "Sign-in failed · BuilderBot CLI",
            "failure",
            r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>"#,
            "Sign-in didn’t finish",
            "BuilderBot CLI couldn’t complete authentication. Return to your terminal for details.",
            "Check your terminal",
        ),
    };

    AUTH_CALLBACK_PAGE_TEMPLATE
        .replace("__PAGE_TITLE__", title)
        .replace("__PAGE_CLASS__", class_name)
        .replace("__STATUS_ICON__", icon)
        .replace("__HEADING__", heading)
        .replace("__MESSAGE__", message)
        .replace("__TERMINAL_MESSAGE__", terminal_message)
}

fn safe_prefix(value: &str) -> String {
    value.chars().take(8).collect()
}

fn sha256_prefix(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn auth_info(config: &SkillsConfig, message: &str) {
    if config.json {
        eprintln!("info: {message}");
    } else {
        config.style.info(message);
    }
}

#[cfg(test)]
mod tests {
    use super::{auth_callback_page, AuthCallbackPage};

    #[test]
    fn callback_pages_are_self_contained_and_themed() {
        for page in [AuthCallbackPage::Success, AuthCallbackPage::Failure] {
            let html = auth_callback_page(page);

            assert!(html.starts_with("<!doctype html>"));
            assert!(html.contains("prefers-color-scheme: dark"));
            assert!(html.contains("prefers-reduced-motion: no-preference"));
            assert!(html.contains(">Berd</div>"));
            assert!(!html.contains("src="));
            assert!(!html.contains("href="));
            assert!(!html.contains("@import"));
            assert!(!html.contains("__PAGE_"));
            assert!(!html.contains("__STATUS_"));
            assert!(!html.contains("__HEADING__"));
            assert!(!html.contains("__MESSAGE__"));
            assert!(!html.contains("__TERMINAL_"));
        }
    }

    #[test]
    fn callback_pages_have_distinct_outcomes() {
        let success = auth_callback_page(AuthCallbackPage::Success);
        let failure = auth_callback_page(AuthCallbackPage::Failure);

        assert!(success.contains("You’re signed in"));
        assert!(success.contains(r#"class="success""#));
        assert!(failure.contains("Sign-in didn’t finish"));
        assert!(failure.contains(r#"class="failure""#));
    }
}
