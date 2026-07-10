use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::blocking::{Client, ClientBuilder};
use reqwest::header::{ACCEPT, USER_AGENT};
use reqwest::redirect::Policy;
use reqwest::StatusCode as HttpStatusCode;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::auth::SESSION_CREDENTIAL_HEADER;
use crate::auth_storage::StoredSessionCredential;

pub const CLI_USER_AGENT: &str = "sq-kgoose-bb-auth-login";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginExchangeResponse {
    pub session_credential: String,
    pub subject: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub expires_at: String,
}

#[derive(Debug, Deserialize)]
pub struct AuthMeResponse {
    pub subject: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct LoginExchangeRequest<'a> {
    code: &'a str,
}

pub fn build_auth_http_client(timeout: Duration) -> Result<Client> {
    ClientBuilder::new()
        .redirect(Policy::none())
        .timeout(timeout)
        .build()
        .context("build auth login HTTP client")
}

pub fn exchange_login_code(
    client: &Client,
    playpen: Option<&str>,
    server_url: &str,
    code: &str,
) -> Result<LoginExchangeResponse> {
    let url = auth_url(server_url, "/v1/auth/login/exchange")?;
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
        return Err(anyhow!(
            "/v1/auth/login/exchange failed with {status}: {body}"
        ));
    }
    serde_json::from_str(&body).context("parse login exchange response")
}

pub fn verify_session_credential(
    client: &Client,
    playpen: Option<&str>,
    server_url: &str,
    credential: &StoredSessionCredential,
) -> Result<Option<AuthMeResponse>> {
    let Some(session_credential) = credential.session_credential_header_value() else {
        return Ok(None);
    };
    let url = auth_url(server_url, "/v1/auth/me")?;
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
    let body = response.text().context("read /v1/auth/me response")?;
    if status == HttpStatusCode::UNAUTHORIZED || status == HttpStatusCode::FORBIDDEN {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(anyhow!("/v1/auth/me failed with {status}: {body}"));
    }
    let me: AuthMeResponse = serde_json::from_str(&body).context("parse /v1/auth/me response")?;
    Ok(Some(me))
}

pub fn logout_session_credential(
    client: &Client,
    playpen: Option<&str>,
    server_url: &str,
    credential: &StoredSessionCredential,
) -> Result<bool> {
    let Some(session_credential) = credential.session_credential_header_value() else {
        return Ok(false);
    };
    let url = auth_url(server_url, "/v1/auth/logout")?;
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
    let body = response.text().context("read /v1/auth/logout response")?;
    if status == HttpStatusCode::UNAUTHORIZED || status == HttpStatusCode::FORBIDDEN {
        return Ok(false);
    }
    if !status.is_success() {
        return Err(anyhow!("/v1/auth/logout failed with {status}: {body}"));
    }
    Ok(true)
}

pub fn login_url(server_url: &str, callback_url: &str) -> Result<Url> {
    let mut url = auth_url(server_url, "/v1/auth/login")?;
    url.query_pairs_mut()
        .append_pair("type", "cli")
        .append_pair("returnTo", callback_url);
    Ok(url)
}

pub fn auth_url(server_url: &str, path: &str) -> Result<Url> {
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

pub fn playpen_baggage(playpen: Option<&str>) -> Option<String> {
    playpen.map(|playpen| format!("kgoose-builderbot-playpen={playpen}"))
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use super::*;

    #[test]
    fn verify_session_credential_treats_unauthorized_as_invalid() {
        let server = SingleResponseServer::start(401, r#"{}"#);
        let client = build_auth_http_client(Duration::from_secs(5)).expect("client");
        let credential = StoredSessionCredential {
            session_credential: "expired-session".to_string(),
            expires_at: None,
        };

        let verified = verify_session_credential(&client, None, &server.base_url, &credential)
            .expect("verify session");
        let request = server.finish();

        assert!(verified.is_none());
        assert_eq!(request.path, "/v1/auth/me");
        assert_eq!(
            request.bb_session_credential.as_deref(),
            Some("expired-session")
        );
    }

    #[test]
    fn verify_session_credential_skips_empty_stored_credential() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind unused server");
        let base_url = format!("http://{}", listener.local_addr().expect("local addr"));
        let client = build_auth_http_client(Duration::from_secs(1)).expect("client");
        let credential = StoredSessionCredential {
            session_credential: String::new(),
            expires_at: None,
        };

        let verified = verify_session_credential(&client, None, &base_url, &credential)
            .expect("verify session");

        assert!(verified.is_none());
    }

    #[test]
    fn logout_session_credential_posts_logout_and_accepts_success() {
        let server = SingleResponseServer::start(200, r#"{}"#);
        let client = build_auth_http_client(Duration::from_secs(5)).expect("client");
        let credential = StoredSessionCredential {
            session_credential: "valid-session".to_string(),
            expires_at: None,
        };

        let logged_out = logout_session_credential(&client, None, &server.base_url, &credential)
            .expect("logout session");
        let request = server.finish();

        assert!(logged_out);
        assert_eq!(request.path, "/v1/auth/logout");
        assert_eq!(
            request.bb_session_credential.as_deref(),
            Some("valid-session")
        );
    }

    #[test]
    fn logout_session_credential_treats_unauthorized_as_already_invalid() {
        let server = SingleResponseServer::start(401, r#"{}"#);
        let client = build_auth_http_client(Duration::from_secs(5)).expect("client");
        let credential = StoredSessionCredential {
            session_credential: "expired-session".to_string(),
            expires_at: None,
        };

        let logged_out = logout_session_credential(&client, None, &server.base_url, &credential)
            .expect("logout session");
        let request = server.finish();

        assert!(!logged_out);
        assert_eq!(request.path, "/v1/auth/logout");
        assert_eq!(
            request.bb_session_credential.as_deref(),
            Some("expired-session")
        );
    }

    #[test]
    fn verify_session_credential_accepts_successful_me_response() {
        let server = SingleResponseServer::start(
            200,
            r#"{"subject":"auth0|user_123","email":"test@example.com","name":"Test User","expires_at":"2026-06-15T00:00:00Z","roles":["ROLE_USER"]}"#,
        );
        let client = build_auth_http_client(Duration::from_secs(5)).expect("client");
        let credential = StoredSessionCredential {
            session_credential: "valid-session".to_string(),
            expires_at: None,
        };

        let verified = verify_session_credential(&client, None, &server.base_url, &credential)
            .expect("verify session")
            .expect("authenticated");
        let request = server.finish();

        assert_eq!(verified.subject.as_deref(), Some("auth0|user_123"));
        assert_eq!(verified.expires_at.as_deref(), Some("2026-06-15T00:00:00Z"));
        assert_eq!(
            request.bb_session_credential.as_deref(),
            Some("valid-session")
        );
        assert_eq!(request.path, "/v1/auth/me");
    }

    #[test]
    fn login_url_uses_v1_route() {
        let url = login_url(
            "https://example.com/cash-app/goose",
            "http://127.0.0.1:1234/callback",
        )
        .expect("login URL");

        assert_eq!(url.path(), "/cash-app/goose/v1/auth/login");
    }

    #[test]
    fn exchange_login_code_uses_v1_route() {
        let server = SingleResponseServer::start(
            200,
            r#"{"sessionCredential":"session","sessionCredentialHeader":"X-BB-Session-Credential","subject":"user-123","expiresAt":"2026-06-15T00:00:00Z"}"#,
        );
        let client = build_auth_http_client(Duration::from_secs(5)).expect("client");

        let exchange = exchange_login_code(&client, None, &server.base_url, "one-time-code")
            .expect("exchange");
        let request = server.finish();

        assert_eq!(exchange.session_credential, "session");
        assert_eq!(exchange.subject.as_deref(), Some("user-123"));
        assert_eq!(exchange.expires_at, "2026-06-15T00:00:00Z");
        assert_eq!(request.path, "/v1/auth/login/exchange");
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
