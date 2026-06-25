//! Browser login for BuilderBot auth.

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, USER_AGENT};
use reqwest::redirect::Policy;
use reqwest::StatusCode as HttpStatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tiny_http::{Header, Response, Server, StatusCode};
use url::Url;

use super::auth::SESSION_CREDENTIAL_HEADER;
use super::auth_storage::{SessionCredentialStorage, SessionStorageKey, StoredSessionCredential};
use super::skills_config::{kgoose_service_url, SkillsConfig};

const CALLBACK_PATH: &str = "/callback";
const CLI_USER_AGENT: &str = "sq-kgoose-bb-auth-login";

#[derive(Debug, Serialize)]
pub struct BrowserLoginSummary {
    pub kgoose_base_url: String,
    pub storage: String,
    pub source: BrowserLoginCredentialSource,
    pub subject: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub expires_at: Option<String>,
    pub credential_prefix: Option<String>,
    pub credential_sha256_prefix: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginExchangeResponse {
    session_credential: String,
    subject: Option<String>,
    email: Option<String>,
    name: Option<String>,
    expires_at: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserLoginCredentialSource {
    Stored,
    BrowserLogin,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMeResponse {
    pub authenticated: bool,
    pub subject: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct LoginExchangeRequest<'a> {
    code: &'a str,
}

pub fn run_browser_login(
    config: &SkillsConfig,
    storage: &dyn SessionCredentialStorage,
) -> Result<BrowserLoginSummary> {
    let service_url = kgoose_service_url(&config.kgoose_base_url);
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .context("build auth login HTTP client")?;
    let storage_key = SessionStorageKey::from_config(config);

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
                return Ok(BrowserLoginSummary {
                    kgoose_base_url: config.kgoose_base_url.clone(),
                    storage: storage.kind().to_string(),
                    source: BrowserLoginCredentialSource::Stored,
                    subject: me.subject,
                    email: me.email,
                    name: me.name,
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
    let exchange = exchange_login_code(&client, config.playpen.as_deref(), &service_url, &code)?;
    let stored = StoredSessionCredential {
        session_credential: exchange.session_credential.clone(),
        expires_at: Some(exchange.expires_at.clone()),
    };
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
        storage: storage.kind().to_string(),
        source: BrowserLoginCredentialSource::BrowserLogin,
        subject: exchange.subject,
        email: exchange.email,
        name: exchange.name,
        expires_at: Some(exchange.expires_at),
        credential_prefix: Some(safe_prefix(&exchange.session_credential)),
        credential_sha256_prefix: Some(sha256_prefix(&exchange.session_credential)),
    })
}

pub fn verify_stored_session(
    config: &SkillsConfig,
    storage: &dyn SessionCredentialStorage,
) -> Result<Option<AuthMeResponse>> {
    let service_url = kgoose_service_url(&config.kgoose_base_url);
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .context("build auth status HTTP client")?;
    let storage_key = SessionStorageKey::from_config(config);
    let Some(stored) = storage.get(&storage_key)? else {
        return Ok(None);
    };

    verify_session_credential(&client, config.playpen.as_deref(), &service_url, &stored)
}

pub fn logout_stored_session(
    config: &SkillsConfig,
    storage: &dyn SessionCredentialStorage,
) -> Result<bool> {
    let service_url = kgoose_service_url(&config.kgoose_base_url);
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .context("build auth logout HTTP client")?;
    let storage_key = SessionStorageKey::from_config(config);
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
            respond_text(
                request,
                StatusCode(400),
                "BuilderBot CLI auth failed. Return to the terminal.",
            )?;
            return Err(anyhow!("auth callback returned error: {error}"));
        }

        let code = parsed
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.into_owned())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow!("auth callback did not include an exchange code"))?;
        respond_text(
            request,
            StatusCode(200),
            "BuilderBot CLI auth complete. Return to the terminal.",
        )?;
        return Ok(code);
    }

    Err(anyhow!(
        "loopback auth server stopped without receiving a callback"
    ))
}

fn exchange_login_code(
    client: &Client,
    playpen: Option<&str>,
    server_url: &str,
    code: &str,
) -> Result<LoginExchangeResponse> {
    let url = auth_url(server_url, "/auth/login/exchange")?;
    let mut request = client
        .post(url)
        .header(USER_AGENT, CLI_USER_AGENT)
        .header(ACCEPT, "application/json")
        .json(&LoginExchangeRequest { code });
    if let Some(baggage) = playpen_baggage(playpen) {
        request = request.header("Baggage", baggage);
    }
    let response = request.send().context("exchange login code")?;
    let status = response.status();
    let body = response.text().context("read login exchange response")?;
    if !status.is_success() {
        return Err(anyhow!("/auth/login/exchange failed with {status}: {body}"));
    }
    serde_json::from_str(&body).context("parse login exchange response")
}

fn verify_session_credential(
    client: &Client,
    playpen: Option<&str>,
    server_url: &str,
    credential: &StoredSessionCredential,
) -> Result<Option<AuthMeResponse>> {
    let Some(session_credential) = credential.session_credential_header_value() else {
        return Ok(None);
    };
    let url = auth_url(server_url, "/auth/me")?;
    let mut request = client
        .get(url)
        .header(USER_AGENT, CLI_USER_AGENT)
        .header(ACCEPT, "application/json")
        .header(SESSION_CREDENTIAL_HEADER, session_credential);
    if let Some(baggage) = playpen_baggage(playpen) {
        request = request.header("Baggage", baggage);
    }
    let response = request
        .send()
        .context("verify stored BuilderBot CLI auth session")?;
    let status = response.status();
    let body = response.text().context("read /auth/me response")?;
    if status == HttpStatusCode::UNAUTHORIZED || status == HttpStatusCode::FORBIDDEN {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(anyhow!("/auth/me failed with {status}: {body}"));
    }
    let me: AuthMeResponse = serde_json::from_str(&body).context("parse /auth/me response")?;
    if me.authenticated {
        Ok(Some(me))
    } else {
        Ok(None)
    }
}

fn logout_session_credential(
    client: &Client,
    playpen: Option<&str>,
    server_url: &str,
    credential: &StoredSessionCredential,
) -> Result<bool> {
    let Some(session_credential) = credential.session_credential_header_value() else {
        return Ok(false);
    };
    let url = auth_url(server_url, "/auth/logout")?;
    let mut request = client
        .post(url)
        .header(USER_AGENT, CLI_USER_AGENT)
        .header(ACCEPT, "application/json")
        .header(SESSION_CREDENTIAL_HEADER, session_credential);
    if let Some(baggage) = playpen_baggage(playpen) {
        request = request.header("Baggage", baggage);
    }
    let response = request
        .send()
        .context("destroy stored BuilderBot CLI auth session")?;
    let status = response.status();
    let body = response.text().context("read /auth/logout response")?;
    if status == HttpStatusCode::UNAUTHORIZED || status == HttpStatusCode::FORBIDDEN {
        return Ok(false);
    }
    if !status.is_success() {
        return Err(anyhow!("/auth/logout failed with {status}: {body}"));
    }
    Ok(true)
}

fn login_url(server_url: &str, callback_url: &str) -> Result<Url> {
    let mut url = auth_url(server_url, "/auth/login")?;
    url.query_pairs_mut()
        .append_pair("type", "cli")
        .append_pair("returnTo", callback_url);
    Ok(url)
}

fn auth_url(server_url: &str, path: &str) -> Result<Url> {
    let base = Url::parse(server_url).context("server URL must be absolute")?;
    let path = format!(
        "{}/{}",
        base.path().trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    let mut url = base;
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn playpen_baggage(playpen: Option<&str>) -> Option<String> {
    playpen.map(|playpen| format!("kgoose-builderbot-playpen={playpen}"))
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
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use super::*;

    #[test]
    fn verify_session_credential_treats_unauthorized_as_invalid() {
        let server = SingleResponseServer::start(401, r#"{"authenticated":false}"#);
        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("client");
        let credential = StoredSessionCredential {
            session_credential: "expired-session".to_string(),
            expires_at: None,
        };

        let verified = verify_session_credential(&client, None, &server.base_url, &credential)
            .expect("verify session");
        let request = server.finish();

        assert!(verified.is_none());
        assert_eq!(request.path, "/auth/me");
        assert_eq!(
            request.bb_session_credential.as_deref(),
            Some("expired-session")
        );
    }

    #[test]
    fn verify_session_credential_skips_empty_stored_credential() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind unused server");
        let base_url = format!("http://{}", listener.local_addr().expect("local addr"));
        let client = Client::builder()
            .timeout(Duration::from_secs(1))
            .build()
            .expect("client");
        let credential = StoredSessionCredential {
            session_credential: String::new(),
            expires_at: None,
        };

        let verified = verify_session_credential(&client, None, &base_url, &credential)
            .expect("verify session");

        assert!(verified.is_none());
    }

    #[test]
    fn verify_session_credential_accepts_authenticated_me_response() {
        let server = SingleResponseServer::start(
            200,
            r#"{"authenticated":true,"subject":"auth0|user_123","email":"test@example.com","name":"Test User","expiresAt":"2026-06-15T00:00:00Z"}"#,
        );
        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("client");
        let credential = StoredSessionCredential {
            session_credential: "valid-session".to_string(),
            expires_at: None,
        };

        let verified = verify_session_credential(&client, None, &server.base_url, &credential)
            .expect("verify session")
            .expect("authenticated");
        let request = server.finish();

        assert_eq!(verified.subject.as_deref(), Some("auth0|user_123"));
        assert_eq!(
            request.bb_session_credential.as_deref(),
            Some("valid-session")
        );
    }

    struct RecordedRequest {
        path: String,
        bb_session_credential: Option<String>,
    }

    struct SingleResponseServer {
        base_url: String,
        handle: thread::JoinHandle<RecordedRequest>,
    }

    impl SingleResponseServer {
        fn start(status: u16, body: &'static str) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
            let base_url = format!("http://{}", listener.local_addr().expect("local addr"));
            let request = Arc::new(Mutex::new(None));
            let thread_request = Arc::clone(&request);
            let handle = thread::spawn(move || {
                let (stream, _) = listener.accept().expect("accept request");
                handle_connection(stream, status, body, &thread_request);
                thread_request
                    .lock()
                    .expect("request mutex")
                    .take()
                    .expect("recorded request")
            });
            Self { base_url, handle }
        }

        fn finish(self) -> RecordedRequest {
            self.handle.join().expect("join test server")
        }
    }

    fn handle_connection(
        mut stream: TcpStream,
        status: u16,
        body: &str,
        request: &Arc<Mutex<Option<RecordedRequest>>>,
    ) {
        let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
        let mut request_line = String::new();
        reader.read_line(&mut request_line).expect("request line");
        let path = request_line
            .split_whitespace()
            .nth(1)
            .expect("request path")
            .to_string();

        let mut bb_session_credential = None;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("request header");
            if line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case(SESSION_CREDENTIAL_HEADER) {
                    bb_session_credential = Some(value.trim().to_string());
                }
            }
        }
        *request.lock().expect("request mutex") = Some(RecordedRequest {
            path,
            bb_session_credential,
        });

        let response = format!(
            "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
    }
}
