use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use reqwest::blocking::{Client, ClientBuilder};
use reqwest::header::{ACCEPT, USER_AGENT};
use reqwest::redirect::Policy;
use reqwest::StatusCode as HttpStatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::Url;
use zeroize::{Zeroize, Zeroizing};

use crate::auth::SESSION_CREDENTIAL_HEADER;
use crate::auth_storage::StoredSessionCredential;

pub const CLI_USER_AGENT: &str = "sq-kgoose-bb-auth-login";

#[derive(Debug, Deserialize)]
pub struct LoginExchangeResponse {
    pub session_credential: String,
    pub expires_at: String,
}

#[derive(Debug, Deserialize)]
pub struct AuthMeResponse {
    pub subject: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub expires_at: Option<String>,
    pub workspaces: AuthMeWorkspaces,
}

impl AuthMeResponse {
    pub fn active_workspace_name(&self) -> Result<&str> {
        self.workspaces
            .active
            .first()
            .map(|workspace| workspace.name.as_str())
            .ok_or_else(|| anyhow!("/v1/auth/me returned no active workspaces"))
    }
}

#[derive(Debug, Deserialize)]
pub struct AuthMeWorkspaces {
    pub active: Vec<AuthMeWorkspace>,
}

#[derive(Debug, Deserialize)]
pub struct AuthMeWorkspace {
    pub name: String,
}

#[derive(Debug)]
pub struct VerifiedLoginSession {
    pub credential: StoredSessionCredential,
    pub me: AuthMeResponse,
}

/// Per-login correlation and PKCE material. Keep this value in memory only and
/// drop it as soon as the login attempt completes, fails, or is canceled.
pub struct OAuthLoginAttempt {
    state: Zeroizing<String>,
    code_verifier: Zeroizing<String>,
    code_challenge: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OAuthCallback {
    Code(String),
    Error(String),
    Rejected(OAuthCallbackRejection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthCallbackRejection {
    MissingState,
    StateMismatch,
    MissingCode,
    InvalidState,
    InvalidCode,
    InvalidError,
    DuplicateParameter,
    ConflictingOutcome,
}

impl OAuthLoginAttempt {
    pub fn generate() -> Result<Self> {
        let mut state_bytes = [0_u8; 32];
        let mut verifier_bytes = [0_u8; 64];
        getrandom::fill(&mut state_bytes).context("generate OAuth state")?;
        getrandom::fill(&mut verifier_bytes).context("generate PKCE code verifier")?;

        let state = URL_SAFE_NO_PAD.encode(state_bytes);
        let code_verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
        state_bytes.zeroize();
        verifier_bytes.zeroize();

        Ok(Self::from_parts(state, code_verifier))
    }

    fn from_parts(state: String, code_verifier: String) -> Self {
        let code_challenge = pkce_s256_challenge(&code_verifier);
        Self {
            state: Zeroizing::new(state),
            code_verifier: Zeroizing::new(code_verifier),
            code_challenge,
        }
    }

    #[cfg(test)]
    fn test_state(&self) -> &str {
        &self.state
    }

    pub fn login_url(&self, server_url: &str, callback_url: &str) -> Result<Zeroizing<String>> {
        let callback_url = Url::parse(callback_url).context("callback URL must be absolute")?;
        if callback_url.scheme() != "http"
            || callback_url.host_str() != Some("127.0.0.1")
            || callback_url.port().is_none()
            || callback_url.cannot_be_a_base()
            || !callback_url.username().is_empty()
            || callback_url.password().is_some()
            || callback_url.query().is_some()
            || callback_url.fragment().is_some()
        {
            return Err(anyhow!(
                "callback URL must be an absolute HTTP URL on 127.0.0.1 with an explicit port and no userinfo, query, or fragment"
            ));
        }

        let mut url = auth_url(server_url, "/v1/auth/login")?;
        let callback_url = Zeroizing::new(String::from(callback_url));
        let state = Zeroizing::new(self.state.to_string());
        url.query_pairs_mut()
            .append_pair("type", "cli")
            .append_pair("returnTo", &callback_url)
            .append_pair("state", &state)
            .append_pair("code_challenge", &self.code_challenge)
            .append_pair("code_challenge_method", "S256");
        Ok(Zeroizing::new(String::from(url)))
    }

    pub fn state_matches(&self, returned_state: &str) -> bool {
        if self.state.len() != returned_state.len() {
            return false;
        }
        bool::from(self.state.as_bytes().ct_eq(returned_state.as_bytes()))
    }

    /// Parse one callback for this attempt. Rejections leave the attempt
    /// usable; a correlated success or authorization error consumes state.
    pub fn parse_callback(&mut self, callback_url: &Url) -> OAuthCallback {
        if self.state.is_empty() {
            return OAuthCallback::Rejected(OAuthCallbackRejection::StateMismatch);
        }

        let mut state = None;
        let mut code = None;
        let mut error = None;
        for (key, value) in callback_url.query_pairs() {
            let slot = match key.as_ref() {
                "state" => &mut state,
                "code" => &mut code,
                "error" => &mut error,
                _ => continue,
            };
            if slot.replace(value.into_owned()).is_some() {
                return OAuthCallback::Rejected(OAuthCallbackRejection::DuplicateParameter);
            }
        }

        let Some(state) = state.filter(|state| !state.is_empty()) else {
            return OAuthCallback::Rejected(OAuthCallbackRejection::MissingState);
        };
        if state.len() > 128 {
            return OAuthCallback::Rejected(OAuthCallbackRejection::InvalidState);
        }
        if !self.state_matches(&state) {
            return OAuthCallback::Rejected(OAuthCallbackRejection::StateMismatch);
        }
        if code.is_some() && error.is_some() {
            return OAuthCallback::Rejected(OAuthCallbackRejection::ConflictingOutcome);
        }
        if let Some(error) = error.filter(|error| !error.trim().is_empty()) {
            if error.len() > 1024 {
                return OAuthCallback::Rejected(OAuthCallbackRejection::InvalidError);
            }
            self.consume_state();
            return OAuthCallback::Error(error);
        }
        match code.filter(|code| !code.trim().is_empty()) {
            Some(code) if code.len() <= 1024 => {
                self.consume_state();
                OAuthCallback::Code(code)
            }
            Some(_) => OAuthCallback::Rejected(OAuthCallbackRejection::InvalidCode),
            None => OAuthCallback::Rejected(OAuthCallbackRejection::MissingCode),
        }
    }

    fn consume_state(&mut self) {
        self.state.zeroize();
    }

    pub fn exchange_login_code_and_verify(
        &mut self,
        client: &Client,
        playpen: Option<&str>,
        server_url: &str,
        code: &str,
    ) -> Result<VerifiedLoginSession> {
        if self.code_verifier.is_empty() {
            return Err(anyhow!("OAuth login attempt has already been exchanged"));
        }
        let result =
            exchange_login_code_and_verify(client, playpen, server_url, code, &self.code_verifier);
        self.code_verifier.zeroize();
        self.code_challenge.zeroize();
        result
    }
}

impl Drop for OAuthLoginAttempt {
    fn drop(&mut self) {
        self.state.zeroize();
        self.code_verifier.zeroize();
        self.code_challenge.zeroize();
    }
}

impl std::fmt::Debug for OAuthLoginAttempt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("OAuthLoginAttempt { .. }")
    }
}

fn pkce_s256_challenge(code_verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()))
}

#[derive(Debug, Serialize)]
struct LoginExchangeRequest<'a> {
    code: &'a str,
    code_verifier: &'a str,
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
    code_verifier: &str,
) -> Result<LoginExchangeResponse> {
    let url = auth_url(server_url, "/v1/auth/login/exchange")?;
    let mut request = client
        .post(url)
        .header(USER_AGENT, CLI_USER_AGENT)
        .header(ACCEPT, "application/json")
        .json(&LoginExchangeRequest {
            code,
            code_verifier,
        });
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

pub fn exchange_login_code_and_verify(
    client: &Client,
    playpen: Option<&str>,
    server_url: &str,
    code: &str,
    code_verifier: &str,
) -> Result<VerifiedLoginSession> {
    let exchange = exchange_login_code(client, playpen, server_url, code, code_verifier)?;
    let credential = StoredSessionCredential {
        session_credential: exchange.session_credential,
        expires_at: Some(exchange.expires_at),
    };
    let me =
        verify_session_credential(client, playpen, server_url, &credential)?.ok_or_else(|| {
            anyhow!("exchanged BuilderBot CLI auth session was rejected by /v1/auth/me")
        })?;
    Ok(VerifiedLoginSession { credential, me })
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

    const TEST_STATE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const TEST_CODE_VERIFIER: &str =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TEST_CODE_CHALLENGE: &str = "_-BU_nrgy23GXDr5th1SCfQ5hR20PQulmXM33xVGaOs";

    fn test_attempt() -> OAuthLoginAttempt {
        OAuthLoginAttempt::from_parts(TEST_STATE.to_string(), TEST_CODE_VERIFIER.to_string())
    }

    fn request_json(request: &RecordedRequest) -> serde_json::Value {
        serde_json::from_str(&request.body).expect("JSON request body")
    }

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
            r#"{"subject":"auth0|user_123","email":"test@example.com","name":"Test User","expires_at":"2026-06-15T00:00:00Z","roles":["ROLE_USER"],"workspaces":{"active":[{"name":"Test Workspace"},{"name":"Other Workspace"}]}}"#,
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
            verified.active_workspace_name().expect("active workspace"),
            "Test Workspace"
        );
        assert_eq!(
            request.bb_session_credential.as_deref(),
            Some("valid-session")
        );
        assert_eq!(request.path, "/v1/auth/me");
    }

    #[test]
    fn oauth_login_attempt_builds_correlated_s256_request() {
        let mut attempt = test_attempt();
        let url = attempt
            .login_url(
                "https://example.com/cash-app/goose",
                "http://127.0.0.1:1234/callback",
            )
            .expect("login URL");
        let url = Url::parse(&url).expect("parse login URL");
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();

        assert_eq!(url.path(), "/cash-app/goose/v1/auth/login");
        assert_eq!(query.get("type").map(String::as_str), Some("cli"));
        assert_eq!(
            query.get("returnTo").map(String::as_str),
            Some("http://127.0.0.1:1234/callback")
        );
        assert_eq!(query.get("state").map(String::as_str), Some(TEST_STATE));
        assert_eq!(
            query.get("code_challenge").map(String::as_str),
            Some(TEST_CODE_CHALLENGE)
        );
        assert_eq!(
            query.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert!(attempt.state_matches(TEST_STATE));
        assert!(!attempt.state_matches(&"c".repeat(43)));
        assert_eq!(
            attempt.parse_callback(
                &Url::parse(&format!(
                    "http://127.0.0.1/callback?code=exchange&state={TEST_STATE}"
                ))
                .expect("callback URL")
            ),
            OAuthCallback::Code("exchange".to_string())
        );
        assert_eq!(
            attempt.parse_callback(
                &Url::parse(&format!(
                    "http://127.0.0.1/callback?code=replay&state={TEST_STATE}"
                ))
                .expect("replay callback URL")
            ),
            OAuthCallback::Rejected(OAuthCallbackRejection::StateMismatch)
        );
        assert_eq!(
            attempt.parse_callback(
                &Url::parse("http://127.0.0.1/callback?code=empty-state-replay&state=")
                    .expect("empty-state replay callback URL")
            ),
            OAuthCallback::Rejected(OAuthCallbackRejection::StateMismatch)
        );
        assert!(attempt.test_state().is_empty());
    }

    #[test]
    fn oauth_login_attempt_rejects_non_loopback_callback_urls() {
        let attempt = test_attempt();

        for callback_url in [
            "https://127.0.0.1:1234/callback",
            "http://localhost:1234/callback",
            "http://127.0.0.1/callback",
            "http://user@127.0.0.1:1234/callback",
            "http://user:password@127.0.0.1:1234/callback",
            "http://127.0.0.1:1234/callback?existing=query",
            "http://127.0.0.1:1234/callback#fragment",
        ] {
            assert!(
                attempt
                    .login_url("https://example.com/cash-app/goose", callback_url)
                    .is_err(),
                "accepted invalid callback URL {callback_url}"
            );
        }
    }

    #[test]
    fn oauth_callback_parser_requires_exact_unambiguous_state() {
        let mut attempt = test_attempt();
        for (query, expected) in [
            (
                "code=exchange",
                OAuthCallback::Rejected(OAuthCallbackRejection::MissingState),
            ),
            (
                "code=exchange&state=ccccccccccccccccccccccccccccccccccccccccccc",
                OAuthCallback::Rejected(OAuthCallbackRejection::StateMismatch),
            ),
            (
                &format!("state={TEST_STATE}"),
                OAuthCallback::Rejected(OAuthCallbackRejection::MissingCode),
            ),
            (
                &format!("code={}&state={TEST_STATE}", "x".repeat(1025)),
                OAuthCallback::Rejected(OAuthCallbackRejection::InvalidCode),
            ),
            (
                &format!("code=exchange&state={}", "x".repeat(129)),
                OAuthCallback::Rejected(OAuthCallbackRejection::InvalidState),
            ),
            (
                &format!("error={}&state={TEST_STATE}", "x".repeat(1025)),
                OAuthCallback::Rejected(OAuthCallbackRejection::InvalidError),
            ),
            (
                &format!("code=first&code=second&state={TEST_STATE}"),
                OAuthCallback::Rejected(OAuthCallbackRejection::DuplicateParameter),
            ),
            (
                &format!("code=exchange&error=denied&state={TEST_STATE}"),
                OAuthCallback::Rejected(OAuthCallbackRejection::ConflictingOutcome),
            ),
        ] {
            let callback =
                Url::parse(&format!("http://127.0.0.1/callback?{query}")).expect("callback URL");
            assert_eq!(attempt.parse_callback(&callback), expected);
        }

        let error_callback = Url::parse(&format!(
            "http://127.0.0.1/callback?error=access_denied&state={TEST_STATE}"
        ))
        .expect("error callback URL");
        assert_eq!(
            attempt.parse_callback(&error_callback),
            OAuthCallback::Error("access_denied".to_string())
        );
    }

    #[test]
    fn generated_oauth_login_attempt_uses_high_entropy_url_safe_material() {
        let first = OAuthLoginAttempt::generate().expect("first OAuth attempt");
        let second = OAuthLoginAttempt::generate().expect("second OAuth attempt");

        for attempt in [&first, &second] {
            assert_eq!(attempt.state.len(), 43);
            assert_eq!(attempt.code_verifier.len(), 86);
            assert_eq!(attempt.code_challenge.len(), 43);
            assert!(attempt
                .state
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
            assert!(attempt
                .code_verifier
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
        }
        assert_ne!(first.state, second.state);
        assert_ne!(first.code_verifier, second.code_verifier);
        assert_eq!(format!("{first:?}"), "OAuthLoginAttempt { .. }");
    }

    #[test]
    fn exchange_login_code_sends_code_and_verifier() {
        let server = SingleResponseServer::start(
            200,
            r#"{"session_credential":"session","expires_at":"2026-06-15T00:00:00Z"}"#,
        );
        let client = build_auth_http_client(Duration::from_secs(5)).expect("client");

        let exchange = exchange_login_code(
            &client,
            None,
            &server.base_url,
            "one-time-code",
            TEST_CODE_VERIFIER,
        )
        .expect("exchange");
        let request = server.finish();

        assert_eq!(exchange.session_credential, "session");
        assert_eq!(exchange.expires_at, "2026-06-15T00:00:00Z");
        assert_eq!(request.path, "/v1/auth/login/exchange");
        assert_eq!(
            request_json(&request),
            serde_json::json!({
                "code": "one-time-code",
                "code_verifier": TEST_CODE_VERIFIER,
            })
        );
    }

    #[test]
    fn exchange_login_code_and_verify_checks_auth_me() {
        let server = SequentialResponseServer::start(vec![
            (
                200,
                r#"{"session_credential":"session","expires_at":"2026-06-15T00:00:00Z"}"#,
            ),
            (
                200,
                r#"{"subject":"auth0|user_123","email":"test@example.com","name":"Test User","expires_at":"2026-06-16T00:00:00Z","roles":["ROLE_USER"],"workspaces":{"active":[{"name":"Test Workspace"},{"name":"Other Workspace"}]}}"#,
            ),
        ]);
        let client = build_auth_http_client(Duration::from_secs(5)).expect("client");

        let verified = exchange_login_code_and_verify(
            &client,
            None,
            &server.base_url,
            "one-time-code",
            TEST_CODE_VERIFIER,
        )
        .expect("verified login");
        let requests = server.finish();

        assert_eq!(verified.credential.session_credential, "session");
        assert_eq!(
            verified.credential.expires_at.as_deref(),
            Some("2026-06-15T00:00:00Z")
        );
        assert_eq!(verified.me.subject.as_deref(), Some("auth0|user_123"));
        assert_eq!(
            verified
                .me
                .active_workspace_name()
                .expect("active workspace"),
            "Test Workspace"
        );
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].path, "/v1/auth/login/exchange");
        assert_eq!(requests[1].path, "/v1/auth/me");
        assert_eq!(
            requests[1].bb_session_credential.as_deref(),
            Some("session")
        );
    }

    #[test]
    fn exchange_login_code_and_verify_requires_auth_me_success() {
        let server = SequentialResponseServer::start(vec![
            (
                200,
                r#"{"session_credential":"session","expires_at":"2026-06-15T00:00:00Z"}"#,
            ),
            (401, r#"{}"#),
        ]);
        let client = build_auth_http_client(Duration::from_secs(5)).expect("client");

        let error = exchange_login_code_and_verify(
            &client,
            None,
            &server.base_url,
            "one-time-code",
            TEST_CODE_VERIFIER,
        )
        .expect_err("auth/me rejection fails login");
        let requests = server.finish();

        assert!(
            format!("{error:#}").contains("rejected by /v1/auth/me"),
            "unexpected error: {error:#}"
        );
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].path, "/v1/auth/login/exchange");
        assert_eq!(requests[1].path, "/v1/auth/me");
    }

    struct RecordedRequest {
        path: String,
        body: String,
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

    struct SequentialResponseServer {
        base_url: String,
        handle: thread::JoinHandle<Vec<RecordedRequest>>,
    }

    impl SequentialResponseServer {
        fn start(responses: Vec<(u16, &'static str)>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
            let base_url = format!("http://{}", listener.local_addr().expect("local addr"));
            let handle = thread::spawn(move || {
                let mut requests = Vec::new();
                for (status, body) in responses {
                    let (stream, _) = listener.accept().expect("accept request");
                    let request = Arc::new(Mutex::new(None));
                    handle_connection(stream, status, body, &request);
                    requests.push(
                        request
                            .lock()
                            .expect("request mutex")
                            .take()
                            .expect("recorded request"),
                    );
                }
                requests
            });
            Self { base_url, handle }
        }

        fn finish(self) -> Vec<RecordedRequest> {
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
        let mut content_length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("request header");
            if line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case(SESSION_CREDENTIAL_HEADER) {
                    bb_session_credential = Some(value.trim().to_string());
                } else if name.eq_ignore_ascii_case("content-length") {
                    content_length = value.trim().parse().expect("content length");
                }
            }
        }
        let mut request_body = vec![0_u8; content_length];
        std::io::Read::read_exact(&mut reader, &mut request_body).expect("request body");
        let request_body = String::from_utf8(request_body).expect("UTF-8 request body");
        *request.lock().expect("request mutex") = Some(RecordedRequest {
            path,
            body: request_body,
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
