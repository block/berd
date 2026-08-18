//! Browser login for BuilderBot auth.

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use builderbot_auth::auth_login::{
    build_auth_http_client, exchange_login_code_and_verify, login_url, logout_session_credential,
    verify_session_credential, AuthMeResponse, VerifiedLoginSession,
};
use builderbot_auth::auth_storage::StoredSessionCredential;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tiny_http::{Header, Response, Server, StatusCode};
use url::Url;

use super::auth_storage::{session_storage_key_from_config, SessionCredentialStorage};
use super::skills_config::{kgoose_service_url, SkillsConfig};

const CALLBACK_PATH: &str = "/callback";

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

struct BrowserLoginOutcome {
    summary: BrowserLoginSummary,
}

pub struct VerifiedStoredSession {
    pub credential: StoredSessionCredential,
    pub me: AuthMeResponse,
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
    run_browser_login_inner(config, storage).map(|outcome| outcome.summary)
}

fn run_browser_login_inner(
    config: &SkillsConfig,
    storage: &dyn SessionCredentialStorage,
) -> Result<BrowserLoginOutcome> {
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
                return Ok(BrowserLoginOutcome {
                    summary: BrowserLoginSummary {
                        kgoose_base_url: config.kgoose_base_url.clone(),
                        kgoose_service_path: config.kgoose_service_path.clone(),
                        storage: storage.kind().to_string(),
                        source: BrowserLoginCredentialSource::Stored,
                        workspace_name,
                        expires_at: me.expires_at.or_else(|| stored.expires_at.clone()),
                        credential_prefix: None,
                        credential_sha256_prefix: None,
                    },
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
    let login_url = login_url(&service_url, &callback_url)?;

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let result = receive_exchange_code(server);
        let _ = tx.send(result);
    });

    if !config.json {
        println!("Opening BuilderBot auth login in your browser:");
        println!("{login_url}");
    }
    if let Err(error) = webbrowser::open(login_url.as_str()) {
        if config.json {
            return Err(anyhow!(
                "failed to open browser for BuilderBot auth login: {error}"
            ));
        }
        println!("Could not open a browser automatically. Open the URL above manually.");
    }

    let code = rx
        .recv()
        .context("loopback auth server stopped before login completed")??;
    let verified =
        exchange_login_code_and_verify(&client, config.playpen.as_deref(), &service_url, &code)?;
    let (stored, me, workspace_name) =
        validate_and_store_login_credential(storage, &storage_key, verified)?;
    auth_info(
        config,
        &format!(
            "Stored BuilderBot CLI auth session in {} storage",
            storage.kind()
        ),
    );

    Ok(BrowserLoginOutcome {
        summary: BrowserLoginSummary {
            kgoose_base_url: config.kgoose_base_url.clone(),
            kgoose_service_path: config.kgoose_service_path.clone(),
            storage: storage.kind().to_string(),
            source: BrowserLoginCredentialSource::BrowserLogin,
            workspace_name,
            expires_at: me.expires_at.or_else(|| stored.expires_at.clone()),
            credential_prefix: Some(safe_prefix(&stored.session_credential)),
            credential_sha256_prefix: Some(sha256_prefix(&stored.session_credential)),
        },
    })
}

pub fn verify_stored_session(
    config: &SkillsConfig,
    storage: &dyn SessionCredentialStorage,
) -> Result<Option<VerifiedStoredSession>> {
    let service_url = kgoose_service_url(&config.kgoose_base_url, &config.kgoose_service_path);
    let client = build_auth_http_client(Duration::from_secs(30))?;
    let storage_key = session_storage_key_from_config(config);
    verify_stored_session_with(storage, &storage_key, |stored| {
        verify_session_credential(&client, config.playpen.as_deref(), &service_url, stored)
    })
}

fn verify_stored_session_with<F>(
    storage: &dyn SessionCredentialStorage,
    storage_key: &super::auth_storage::SessionStorageKey,
    verify: F,
) -> Result<Option<VerifiedStoredSession>>
where
    F: FnOnce(&StoredSessionCredential) -> Result<Option<AuthMeResponse>>,
{
    let Some(stored) = storage.get(storage_key)? else {
        return Ok(None);
    };
    Ok(verify(&stored)?.map(|me| VerifiedStoredSession {
        credential: stored,
        me,
    }))
}

fn store_login_credential(
    storage: &dyn SessionCredentialStorage,
    storage_key: &super::auth_storage::SessionStorageKey,
    credential: StoredSessionCredential,
) -> Result<StoredSessionCredential> {
    storage.set(storage_key, &credential)?;
    Ok(credential)
}

fn validate_and_store_login_credential(
    storage: &dyn SessionCredentialStorage,
    storage_key: &super::auth_storage::SessionStorageKey,
    verified: VerifiedLoginSession,
) -> Result<(StoredSessionCredential, AuthMeResponse, String)> {
    let workspace_name = verified.me.active_workspace_name()?.to_string();
    let stored = store_login_credential(storage, storage_key, verified.credential)?;
    Ok((stored, verified.me, workspace_name))
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

fn receive_exchange_code(server: Server) -> Result<String> {
    for request in server.incoming_requests() {
        let url = request.url().to_string();
        let parsed =
            Url::parse(&format!("http://127.0.0.1{url}")).context("parse loopback callback URL")?;
        if parsed.path() != CALLBACK_PATH {
            respond_text(
                request,
                StatusCode(404),
                "BuilderBot CLI auth is waiting for the callback.",
            )?;
            continue;
        }

        let error = parsed
            .query_pairs()
            .find(|(key, _)| key == "error")
            .map(|(_, value)| value.into_owned());
        if let Some(error) = error {
            respond_auth_page(request, StatusCode(400), AuthCallbackPage::Failure)?;
            return Err(anyhow!("auth callback returned error: {error}"));
        }

        let code = parsed
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.into_owned())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow!("auth callback did not include an exchange code"))?;
        respond_auth_page(request, StatusCode(200), AuthCallbackPage::Success)?;
        return Ok(code);
    }

    Err(anyhow!(
        "loopback auth server stopped without receiving a callback"
    ))
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
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;

    use anyhow::Result;
    use builderbot_auth::auth_login::{
        AuthMeResponse, AuthMeWorkspace, AuthMeWorkspaces, VerifiedLoginSession,
    };
    use builderbot_auth::auth_storage::{
        SessionCredentialStorage, SessionStorageKey, StoredSessionCredential,
    };

    use super::{
        auth_callback_page, store_login_credential, validate_and_store_login_credential,
        verify_stored_session_with, AuthCallbackPage,
    };

    struct SwappingStorage {
        reads: RefCell<VecDeque<StoredSessionCredential>>,
        read_count: Cell<usize>,
        writes: RefCell<Vec<StoredSessionCredential>>,
    }

    impl SwappingStorage {
        fn new(reads: impl IntoIterator<Item = StoredSessionCredential>) -> Self {
            Self {
                reads: RefCell::new(reads.into_iter().collect()),
                read_count: Cell::new(0),
                writes: RefCell::new(Vec::new()),
            }
        }
    }

    impl SessionCredentialStorage for SwappingStorage {
        fn kind(&self) -> &'static str {
            "swapping"
        }

        fn get(&self, _key: &SessionStorageKey) -> Result<Option<StoredSessionCredential>> {
            self.read_count.set(self.read_count.get() + 1);
            Ok(self.reads.borrow_mut().pop_front())
        }

        fn set(
            &self,
            _key: &SessionStorageKey,
            credential: &StoredSessionCredential,
        ) -> Result<()> {
            self.writes.borrow_mut().push(credential.clone());
            Ok(())
        }

        fn delete(&self, _key: &SessionStorageKey) -> Result<bool> {
            Ok(false)
        }
    }

    fn stored(value: &str) -> StoredSessionCredential {
        StoredSessionCredential {
            session_credential: value.to_string(),
            expires_at: None,
        }
    }

    fn auth_me() -> AuthMeResponse {
        AuthMeResponse {
            subject: None,
            email: None,
            name: None,
            expires_at: None,
            workspaces: AuthMeWorkspaces {
                active: vec![AuthMeWorkspace {
                    name: "Test Workspace".to_string(),
                }],
            },
        }
    }

    #[test]
    fn verification_returns_the_exact_credential_that_was_checked() {
        let storage = SwappingStorage::new([stored("verified-a"), stored("substituted-b")]);
        let key = SessionStorageKey::new("default", "https://kgoose.example");

        let verified = verify_stored_session_with(&storage, &key, |credential| {
            assert_eq!(credential.session_credential, "verified-a");
            Ok(Some(auth_me()))
        })
        .expect("verify stored session")
        .expect("verified session");

        assert_eq!(verified.credential.session_credential, "verified-a");
        assert_eq!(storage.read_count.get(), 1);
        assert_eq!(
            storage
                .get(&key)
                .expect("read substituted credential")
                .expect("substituted credential")
                .session_credential,
            "substituted-b"
        );
    }

    #[test]
    fn interactive_login_completion_returns_issued_credential_without_rereading_storage() {
        let storage = SwappingStorage::new([stored("substituted-b")]);
        let key = SessionStorageKey::new("default", "https://kgoose.example");

        let returned = store_login_credential(&storage, &key, stored("issued-a"))
            .expect("store completed login");

        assert_eq!(returned.session_credential, "issued-a");
        assert_eq!(storage.read_count.get(), 0);
        assert_eq!(storage.writes.borrow()[0].session_credential, "issued-a");
    }

    #[test]
    fn browser_login_does_not_store_a_session_without_an_active_workspace() {
        let storage = SwappingStorage::new([]);
        let key = SessionStorageKey::new("default", "https://kgoose.example");
        let verified = VerifiedLoginSession {
            credential: stored("issued-without-workspace"),
            me: AuthMeResponse {
                subject: None,
                email: None,
                name: None,
                expires_at: None,
                workspaces: AuthMeWorkspaces { active: vec![] },
            },
        };

        let error = validate_and_store_login_credential(&storage, &key, verified)
            .expect_err("reject login without an active workspace");

        assert!(error.to_string().contains("no active workspaces"));
        assert!(storage.writes.borrow().is_empty());
        assert!(storage.get(&key).expect("read storage").is_none());
    }

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
