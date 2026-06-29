//! Browser login for BuilderBot auth.

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use builderbot_auth::auth_login::{
    build_auth_http_client, exchange_login_code, login_url, logout_session_credential,
    verify_session_credential, AuthMeResponse,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tiny_http::{Header, Response, Server, StatusCode};
use url::Url;

use super::auth_storage::{
    session_storage_key_from_config, SessionCredentialStorage, StoredSessionCredential,
};
use super::skills_config::{kgoose_service_url, SkillsConfig};

const CALLBACK_PATH: &str = "/callback";

#[derive(Debug, Serialize)]
pub struct BrowserLoginSummary {
    pub kgoose_base_url: String,
    pub kgoose_service_path: String,
    pub storage: String,
    pub source: BrowserLoginCredentialSource,
    pub subject: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
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
                return Ok(BrowserLoginSummary {
                    kgoose_base_url: config.kgoose_base_url.clone(),
                    kgoose_service_path: config.kgoose_service_path.clone(),
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
        kgoose_service_path: config.kgoose_service_path.clone(),
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
