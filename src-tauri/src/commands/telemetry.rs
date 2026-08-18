use crate::services::distro_bundle::{DistroBundleState, TelemetryChannel};
use reqwest::{
    header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        OnceLock,
    },
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;

const OTEL_LOGS_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const OTEL_LOGS_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

// Telemetry-gateway path convention: the build-injected endpoint is the full
// `https://<host>/v1/logs` URL, and the anonymous `/v1/bootstrap` URL is
// derived from it by swapping the path suffix. Swapping in a real gateway host
// is therefore pure configuration — build env, this file's host allowlist, the
// CSP, and the pinned test values — with no code-path changes.
const OTEL_LOGS_PATH: &str = "/v1/logs";
const TELEMETRY_BOOTSTRAP_PATH: &str = "/v1/bootstrap";

// Wire-contract version the gateway validates every upload against. It names
// the *body* contract the renderer serializes — the closed resource-attribute
// set, the strict log-record shape, the event catalog and its per-event
// parameters — so any change to what goes on the wire has to move in lockstep
// with a version the gateway has registered. Sent on `/v1/logs` exactly once;
// missing, empty, unregistered, or comma-joined (i.e. sent twice) is a
// terminal 400 `schema_validation_failed`, and a rejected batch is permanently
// lost because the renderer's `BatchLogRecordProcessor` drops it.
// `/v1/bootstrap` does not read it.
const TELEMETRY_SCHEMA_VERSION_HEADER: &str = "x-berd-schema-version";
const TELEMETRY_SCHEMA_VERSION: &str = "berd-otlp-logs-v1";

// Telemetry-gateway host allowlist. The renderer's OTLP endpoint is
// build-injected from VITE_OTLP_LOGS_ENDPOINT (see vite.config.ts) and must
// resolve to one of these hosts:
//
// - otel.berd.xyz — the production gateway (squareup/berd-monitoring's
//   production deployment), injected for VITE_ENVIRONMENT=production builds.
// - otel.test.blockstaging.build — the staging gateway
//   (squareup/berd-monitoring's staging deployment), injected for
//   VITE_ENVIRONMENT=staging builds.
// - otlp.invalid.goose-internal.example — DUMMY placeholder injected in
//   development; the prod/staging gate plus this fake host keep the path
//   inert in dev and external clones.
//
// Keep this in sync with vite.config.ts's endpoint constants and
// tauri.conf.json's CSP connect-src.
const ALLOWED_OTEL_LOGS_HOSTS: [&str; 3] = [
    "otel.berd.xyz",
    "otel.test.blockstaging.build",
    "otlp.invalid.goose-internal.example",
];

// File under the app-data dir holding the persistent anonymous installation
// id. It keys bootstrap-token issuance (and rate limiting) on the gateway and
// is stamped by the renderer as the `installation.id` resource attribute.
const INSTALLATION_ID_FILE_NAME: &str = "telemetry-installation-id";

// File under the app-data dir holding the user's telemetry consent. It lives
// here — not in the renderer's localStorage — precisely so this module can
// enforce it natively: "disabled" must mean no bytes to the gateway at all,
// including `/v1/bootstrap` (which carries the installation id), and only the
// Rust host can guarantee that regardless of renderer timing. A missing file
// is DISABLED — telemetry is opt-in, and every failure mode reads as "no
// consent".
const TELEMETRY_SETTINGS_FILE_NAME: &str = "telemetry-settings.json";
const TELEMETRY_SETTINGS_SCHEMA_VERSION: u32 = 1;

// Refresh the cached upload token this long before its reported expiry, so an
// export near the boundary does not race server-side expiry.
const TOKEN_REFRESH_MARGIN: Duration = Duration::from_secs(60);

// Cap on the gateway-reported token TTL. `Instant + Duration` panics on
// overflow and the TTL is network input, so an unbounded `expiresInSeconds`
// from a buggy or hostile gateway must not reach the addition verbatim. A day
// is far beyond any TTL the gateway actually issues (~15 minutes); clamping
// costs nothing but an earlier proactive refresh.
const MAX_TOKEN_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Native half of the telemetry bootstrap-token flow. The upload token never
/// enters the renderer: it is bootstrapped anonymously from the gateway keyed
/// on the persistent installation id, cached here in process memory, and
/// attached to `/v1/logs` uploads as a `Bearer` header.
///
/// Also owns the persisted telemetry consent (see
/// `TELEMETRY_SETTINGS_FILE_NAME`), read from disk when the state is
/// constructed in `setup()` — synchronously, before any webview exists — so
/// there is no startup window in which an export can outrun the consent check.
pub struct TelemetryAuthState {
    app_data_dir: PathBuf,
    installation_id: OnceLock<String>,
    token: Mutex<Option<CachedUploadToken>>,
    consent_enabled: AtomicBool,
    /// Monotonic count of consent revocations this process has seen. An export
    /// snapshots it at entry and aborts at its next network boundary if it has
    /// moved, so revocation cancels work already past the entry gate (see
    /// `ensure_consent_unrevoked`).
    revocation_epoch: AtomicU64,
}

struct CachedUploadToken {
    token: String,
    /// Proactive-refresh deadline: issuance time plus the reported TTL minus
    /// `TOKEN_REFRESH_MARGIN`.
    refresh_after: Instant,
}

impl TelemetryAuthState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let consent_enabled = load_telemetry_consent(&app_data_dir);
        Self {
            app_data_dir,
            installation_id: OnceLock::new(),
            token: Mutex::new(None),
            consent_enabled: AtomicBool::new(consent_enabled),
            revocation_epoch: AtomicU64::new(0),
        }
    }

    /// The effective telemetry consent: forced ON in enforced builds,
    /// otherwise the persisted user setting. Fail-closed — a missing,
    /// unreadable, or unrecognized settings file means disabled.
    fn consent_granted(&self) -> bool {
        telemetry_enforced_by_build() || self.consent_enabled.load(Ordering::Relaxed)
    }

    /// Snapshot of the revocation counter, taken as an export begins and
    /// carried to every network boundary it later crosses (see
    /// `ensure_consent_unrevoked`).
    fn revocation_epoch(&self) -> u64 {
        self.revocation_epoch.load(Ordering::Relaxed)
    }

    /// The mid-flight consent check: an export may continue only while consent
    /// is still granted *and* no revocation has landed since its snapshot.
    ///
    /// The epoch — rather than a plain `consent_granted()` re-check — is what
    /// makes revocation supersede a re-grant: a batch in flight when the user
    /// opted out never ships, even if they opt back in before it reaches the
    /// next boundary, and only batches queued after the re-grant flow again.
    /// `Relaxed` throughout, matching the consent load: there is no
    /// cross-variable invariant (either signal alone aborts) and the check is
    /// inherently racy against bytes already on the wire.
    ///
    /// The error is deliberately distinct from the entry gate's, so logs
    /// separate a mid-flight abort from a settled-off refusal.
    fn ensure_consent_unrevoked(&self, epoch: u64) -> Result<(), String> {
        if !self.consent_granted() || self.revocation_epoch() != epoch {
            return Err("Telemetry consent was revoked during export".to_string());
        }
        Ok(())
    }

    fn settings(&self) -> TelemetrySettings {
        TelemetrySettings {
            enabled: self.consent_granted(),
        }
    }

    /// Persists and applies consent, and on revocation bumps the epoch so
    /// exports already past the entry gate abort at their next network
    /// boundary. A grant deliberately does not bump: there is no reason for
    /// opting in to kill work in progress.
    fn set_consent(&self, enabled: bool) -> Result<TelemetrySettings, String> {
        if telemetry_enforced_by_build() {
            // The settings toggle is never rendered in enforced builds, so a
            // write reaching here is a bug — refuse loudly rather than
            // persisting a value the build would ignore.
            return Err("Telemetry is always enabled in this build".to_string());
        }
        persist_telemetry_consent(&self.app_data_dir, enabled)?;
        self.consent_enabled.store(enabled, Ordering::Relaxed);
        if !enabled {
            self.revocation_epoch.fetch_add(1, Ordering::Relaxed);
        }
        Ok(self.settings())
    }

    /// The persistent anonymous installation id, loaded (or created) on first
    /// use. Falls back to a session-only id when the app-data dir is
    /// unwritable, keeping telemetry best-effort rather than fallible.
    fn installation_id(&self) -> &str {
        self.installation_id.get_or_init(|| {
            load_or_create_installation_id(&self.app_data_dir).unwrap_or_else(|error| {
                log::warn!("Failed to persist telemetry installation id: {error}");
                Uuid::new_v4().to_string()
            })
        })
    }

    /// Returns a valid upload token, bootstrapping a fresh one when none is
    /// cached or the cached one is within the proactive-refresh margin of
    /// expiry. The lock is held across the bootstrap call so concurrent
    /// exports cannot stampede the gateway's per-install rate limit.
    ///
    /// Takes the caller's revocation-epoch snapshot because the consent
    /// re-check for the bootstrap request has to happen *here*, not at the call
    /// site: waiting on the lock behind a sibling's bootstrap can be the
    /// longest stall in an export, and the request below is the one that
    /// carries the installation id. A cache hit needs no check — it touches no
    /// network, and the caller re-checks before the upload it is fetching the
    /// token for.
    async fn upload_token(
        &self,
        client: &reqwest::Client,
        bootstrap_url: &reqwest::Url,
        epoch: u64,
    ) -> Result<String, String> {
        let mut cached = self.token.lock().await;
        if let Some(token) = cached.as_ref() {
            if Instant::now() < token.refresh_after {
                return Ok(token.token.clone());
            }
        }
        self.ensure_consent_unrevoked(epoch)?;
        let fresh = bootstrap_upload_token(client, bootstrap_url, self.installation_id()).await?;
        let value = fresh.token.clone();
        *cached = Some(fresh);
        Ok(value)
    }

    /// Drops the cached token, but only if it is still the one the gateway
    /// just rejected. Concurrent exports each 401 on the same stale token
    /// (every window runs its own `BatchLogRecordProcessor`), and an
    /// unconditional clear would let each of them discard the fresh token a
    /// sibling just cached and re-bootstrap — a stampede against the
    /// per-install rate-limited endpoint, where a tripped limiter permanently
    /// drops the batch. Compare-and-clear means only the first invalidation
    /// clears; the rest reuse the sibling's fresh token on retry.
    async fn invalidate_upload_token(&self, rejected_token: &str) {
        let mut cached = self.token.lock().await;
        if cached
            .as_ref()
            .is_some_and(|token| token.token == rejected_token)
        {
            *cached = None;
        }
    }
}

/// Whether this build enforces telemetry ON, skipping the user setting (the
/// renderer also hides the toggle). Mapped from `VITE_TELEMETRY_ENFORCED=1` by
/// every gate resolver — `scripts/block-feature-gates.sh` (dev and Unix
/// bundles), `Get-BerdAppFeatures` in `scripts/windows/WindowsDev.psm1`, and
/// `scripts/release/build-macos.sh` — so the renderer's build flag and this
/// Cargo feature always move together. The resolvers are pinned equal by
/// `scripts/release/tests/release-scripts.test.mjs`; a build that set only the
/// renderer flag would hide the consent toggle and then reject every export.
fn telemetry_enforced_by_build() -> bool {
    cfg!(feature = "block-telemetry-enforced")
}

/// On-disk shape of the consent file. The schema version is pinned exactly:
/// a file from a future schema fails closed (reads as disabled) rather than
/// guessing at consent semantics this build does not know.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedTelemetrySettings {
    schema_version: u32,
    enabled: bool,
}

/// Wire shape of `get_telemetry_settings` / `set_telemetry_enabled`: the
/// *effective* consent, i.e. what the export gate will actually apply.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySettings {
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtelLogsExportResponse {
    pub status: u16,
    pub status_text: String,
    pub body: String,
}

/// Wire shape of `get_telemetry_resource`: the native half of the OTel
/// `Resource` the renderer stamps on every upload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryResource {
    pub installation_id: String,
    pub channel: TelemetryChannel,
}

/// Returns the native half of the renderer's OTel `Resource`: the persistent
/// anonymous installation id (stamped as `installation.id`) and the
/// distribution channel the staged distro config declares (stamped as
/// `distribution.channel` — `"public"` when no distro bundle or no `telemetry`
/// section is present).
#[tauri::command]
pub fn get_telemetry_resource(
    state: tauri::State<'_, TelemetryAuthState>,
    distro: tauri::State<'_, DistroBundleState>,
) -> TelemetryResource {
    TelemetryResource {
        installation_id: state.installation_id().to_string(),
        channel: distro.telemetry_channel(),
    }
}

/// Returns the effective telemetry consent for this installation, read from
/// the Rust-owned settings file (missing file = disabled) or forced ON by an
/// enforced build.
#[tauri::command]
pub fn get_telemetry_settings(state: tauri::State<'_, TelemetryAuthState>) -> TelemetrySettings {
    state.settings()
}

/// Persists the user's telemetry consent atomically (write-then-rename) and
/// applies it immediately — the next export sees the new value with no restart,
/// and a revocation also aborts exports already in flight at their next network
/// boundary. Refused in enforced builds, where consent is not user-settable.
#[tauri::command]
pub fn set_telemetry_enabled(
    state: tauri::State<'_, TelemetryAuthState>,
    enabled: bool,
) -> Result<TelemetrySettings, String> {
    state.set_consent(enabled)
}

/// Exports a batch of OTel log records (already serialized to OTLP/HTTP JSON)
/// to the approved telemetry-gateway `/v1/logs` endpoint through native
/// networking, so WebView CORS cannot block the renderer's OTLP exporter. The
/// endpoint host must be allowlisted; auth is a short-lived upload token
/// bootstrapped here (see `export_with_bootstrap_auth` for the single 401
/// retry), and every upload declares the body contract it was serialized
/// against (see `TELEMETRY_SCHEMA_VERSION`). Other HTTP 4xx/5xx responses are
/// returned to the renderer, whose `BatchLogRecordProcessor` drops the failed
/// batch — there is no renderer-side retry. Bodies are not size-checked here:
/// the renderer caps batch size and attribute-value length (see
/// `MAX_LOG_EXPORT_BATCH_SIZE` in `src/shared/telemetry/client.ts`) so a full
/// batch stays under the gateway's request-body limit, which it would otherwise
/// answer with a 413 that costs the whole batch. The body is sent as plain
/// uncompressed JSON: the gateway parses the raw bytes, so any
/// `content-encoding` would come back a terminal 400.
#[tauri::command]
pub async fn export_otel_logs(
    state: tauri::State<'_, TelemetryAuthState>,
    endpoint: String,
    body: String,
) -> Result<OtelLogsExportResponse, String> {
    export_otel_logs_for_state(state.inner(), &endpoint, body).await
}

/// The native enforcement gate plus the export itself. Consent is checked
/// before anything else — ahead of even endpoint validation — so a disabled
/// installation sends no bytes to the gateway at all, including the bootstrap
/// request that carries the installation id. This also catches records the
/// renderer's batch processor had already queued when the user flipped
/// telemetry off: they reach this command, and stop here.
///
/// One check at entry would not be enough, because the awaits below can run for
/// tens of seconds — the token mutex behind a sibling's bootstrap, the bootstrap
/// response itself, a 401 re-auth — while the settings toggle confirms "off"
/// synchronously. So the revocation epoch is snapshotted here, *before* the gate
/// so a revocation racing entry supersedes it too, and re-checked at every
/// network boundary the export goes on to cross (see
/// `ensure_consent_unrevoked`).
///
/// Residual, and the best a check-before-send design can do: a request already
/// on the wire when revocation lands cannot be recalled, so post-revocation
/// traffic is bounded to at most that single in-flight HTTP request.
async fn export_otel_logs_for_state(
    auth: &TelemetryAuthState,
    endpoint: &str,
    body: String,
) -> Result<OtelLogsExportResponse, String> {
    let epoch = auth.revocation_epoch();
    if !auth.consent_granted() {
        return Err("Telemetry is disabled for this installation".to_string());
    }
    let logs_url = allowed_otel_logs_endpoint(endpoint)?;
    let bootstrap_url = telemetry_bootstrap_url(&logs_url)?;
    export_with_bootstrap_auth(client(), auth, epoch, &logs_url, &bootstrap_url, body).await
}

/// Uploads one OTLP batch with bootstrap-token auth. On a 401 — the gateway's
/// only auth-failure code — the rejected token is invalidated
/// (compare-and-clear, see `invalidate_upload_token`), a fresh one is fetched
/// — from the cache when a concurrent export already re-bootstrapped, from
/// `/v1/bootstrap` otherwise — and the same body is retried exactly once (the
/// gateway has confirmed the single retry is idempotency-safe). This native
/// retry is the only retry anywhere in the pipeline: the renderer's
/// `BatchLogRecordProcessor` drops failed batches, so a batch hitting token
/// expiry would otherwise be permanently lost.
///
/// `epoch` is the caller's revocation snapshot: consent is re-checked before
/// each of the two possible uploads, and inside `upload_token` before either
/// bootstrap, so a revocation arriving mid-export stops the export's next
/// request rather than only its next batch.
async fn export_with_bootstrap_auth(
    client: &reqwest::Client,
    auth: &TelemetryAuthState,
    epoch: u64,
    logs_url: &reqwest::Url,
    bootstrap_url: &reqwest::Url,
    body: String,
) -> Result<OtelLogsExportResponse, String> {
    let token = auth.upload_token(client, bootstrap_url, epoch).await?;
    auth.ensure_consent_unrevoked(epoch)?;
    let response = post_otel_logs(client, logs_url, &token, body.clone()).await?;
    if response.status != 401 {
        return Ok(response);
    }

    auth.invalidate_upload_token(&token).await;
    let token = auth.upload_token(client, bootstrap_url, epoch).await?;
    auth.ensure_consent_unrevoked(epoch)?;
    post_otel_logs(client, logs_url, &token, body).await
}

async fn post_otel_logs(
    client: &reqwest::Client,
    logs_url: &reqwest::Url,
    token: &str,
    body: String,
) -> Result<OtelLogsExportResponse, String> {
    let response = client
        .post(logs_url.clone())
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header(TELEMETRY_SCHEMA_VERSION_HEADER, TELEMETRY_SCHEMA_VERSION)
        .timeout(OTEL_LOGS_REQUEST_TIMEOUT)
        .body(body)
        .send()
        .await
        .map_err(|error| {
            format!(
                "Failed to export OTel logs to {}: {error}",
                logs_url.as_str()
            )
        })?;

    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let body = response.text().await.map_err(|error| {
        format!(
            "Failed to read OTel logs response from {}: {error}",
            logs_url
        )
    })?;

    Ok(OtelLogsExportResponse {
        status: status.as_u16(),
        status_text,
        body,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResponse {
    token: String,
    expires_in_seconds: u64,
}

/// Anonymously bootstraps a short-lived upload-only token from the gateway,
/// keyed on the installation id.
async fn bootstrap_upload_token(
    client: &reqwest::Client,
    bootstrap_url: &reqwest::Url,
    installation_id: &str,
) -> Result<CachedUploadToken, String> {
    let response = client
        .post(bootstrap_url.clone())
        .header(ACCEPT, "application/json")
        .timeout(OTEL_LOGS_REQUEST_TIMEOUT)
        .json(&serde_json::json!({ "installationId": installation_id }))
        .send()
        .await
        .map_err(|error| {
            format!("Telemetry bootstrap request to {bootstrap_url} failed: {error}")
        })?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Telemetry bootstrap to {bootstrap_url} failed: {status}"
        ));
    }

    let response: BootstrapResponse = response.json().await.map_err(|error| {
        format!("Invalid telemetry bootstrap response from {bootstrap_url}: {error}")
    })?;

    // A TTL at or below the margin yields an already-stale cache entry, so
    // every export re-bootstraps — correct, if wasteful, for a gateway that
    // issues very short tokens.
    let ttl = Duration::from_secs(response.expires_in_seconds).min(MAX_TOKEN_TTL);
    Ok(CachedUploadToken {
        token: response.token,
        refresh_after: Instant::now() + ttl.saturating_sub(TOKEN_REFRESH_MARGIN),
    })
}

/// Loads the persisted installation id, generating and persisting a fresh UUID
/// when the file is missing or holds a value the gateway would reject.
fn load_or_create_installation_id(app_data_dir: &Path) -> Result<String, String> {
    let path = app_data_dir.join(INSTALLATION_ID_FILE_NAME);
    if let Ok(existing) = fs::read_to_string(&path) {
        let existing = existing.trim();
        if is_valid_installation_id(existing) {
            return Ok(existing.to_string());
        }
    }

    let id = Uuid::new_v4().to_string();
    fs::create_dir_all(app_data_dir).map_err(|error| {
        format!(
            "Failed to create app data dir {}: {error}",
            app_data_dir.display()
        )
    })?;
    // Write-then-rename so a crash can never leave a torn id on disk.
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &id).map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .map_err(|error| format!("Failed to persist {}: {error}", path.display()))?;
    Ok(id)
}

/// Loads the persisted telemetry consent. Fail-closed: a missing file (the
/// normal first-run state — telemetry is opt-in), an unreadable file, invalid
/// JSON, or an unknown schema version all read as disabled.
fn load_telemetry_consent(app_data_dir: &Path) -> bool {
    let path = app_data_dir.join(TELEMETRY_SETTINGS_FILE_NAME);
    let Ok(raw) = fs::read_to_string(&path) else {
        return false;
    };
    match serde_json::from_str::<PersistedTelemetrySettings>(&raw) {
        Ok(settings) if settings.schema_version == TELEMETRY_SETTINGS_SCHEMA_VERSION => {
            settings.enabled
        }
        Ok(settings) => {
            log::warn!(
                "Ignoring telemetry settings with unknown schema version {}",
                settings.schema_version
            );
            false
        }
        Err(error) => {
            log::warn!("Ignoring unreadable telemetry settings: {error}");
            false
        }
    }
}

/// Persists the telemetry consent with a write-then-rename, mirroring the
/// installation-id write, so a crash can never leave a torn settings file —
/// and a torn file would read as disabled anyway. The rename replaces an
/// existing destination on Windows too — `std::fs::rename`'s documented
/// contract, via `MoveFileExW`/`FileRenameInfoEx` with replace-if-exists,
/// unlike C's `rename` — so re-toggling consent needs no remove-first step.
fn persist_telemetry_consent(app_data_dir: &Path, enabled: bool) -> Result<(), String> {
    let path = app_data_dir.join(TELEMETRY_SETTINGS_FILE_NAME);
    fs::create_dir_all(app_data_dir).map_err(|error| {
        format!(
            "Failed to create app data dir {}: {error}",
            app_data_dir.display()
        )
    })?;
    let body = serde_json::to_string_pretty(&PersistedTelemetrySettings {
        schema_version: TELEMETRY_SETTINGS_SCHEMA_VERSION,
        enabled,
    })
    .map_err(|error| format!("Failed to serialize telemetry settings: {error}"))?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, body).map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .map_err(|error| format!("Failed to persist {}: {error}", path.display()))?;
    Ok(())
}

/// Mirrors the gateway's accepted installation-id shape
/// (`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`), so a corrupted file regenerates
/// instead of bootstrapping with a value the gateway will reject.
fn is_valid_installation_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (8..=128).contains(&value.len())
        && first.is_ascii_alphanumeric()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// Validates that an OTLP logs endpoint is HTTPS, targets an allowlisted
/// gateway host (rejecting look-alike / spoofed-suffix hosts) on its default
/// port with no userinfo, and follows the `/v1/logs` path convention the
/// bootstrap derivation relies on. Userinfo is rejected because reqwest turns
/// URL credentials into a renderer-controlled `Authorization: Basic` header —
/// on the logs upload ahead of the Bearer token, and on the otherwise
/// anonymous bootstrap request, which derives its URL from this one. An
/// explicit port is rejected because the host allowlist compares `host_str()`
/// alone, which would otherwise admit any other service on an allowed host.
fn allowed_otel_logs_endpoint(raw_url: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw_url)
        .map_err(|error| format!("Invalid OTel logs endpoint {raw_url}: {error}"))?;

    if url.scheme() != "https" {
        return Err(format!("OTel logs endpoint must use https: {raw_url}"));
    }

    // Deliberately does not echo the URL: it carries the credentials.
    if !url.username().is_empty() || url.password().is_some() {
        return Err("OTel logs endpoint must not include credentials".to_string());
    }

    match url.host_str() {
        Some(host) if ALLOWED_OTEL_LOGS_HOSTS.contains(&host) => {}
        _ => return Err(format!("OTel logs endpoint host is not allowed: {raw_url}")),
    }

    if url.port().is_some() {
        return Err(format!(
            "OTel logs endpoint must not include an explicit port: {raw_url}"
        ));
    }

    if !url.path().ends_with(OTEL_LOGS_PATH) {
        return Err(format!(
            "OTel logs endpoint path must end with {OTEL_LOGS_PATH}: {raw_url}"
        ));
    }

    Ok(url)
}

/// Derives the anonymous bootstrap endpoint from the validated logs endpoint:
/// same scheme/host (and any path prefix), with the trailing `/v1/logs`
/// swapped for `/v1/bootstrap` — so a real-host swap needs no
/// bootstrap-specific configuration.
fn telemetry_bootstrap_url(logs_url: &reqwest::Url) -> Result<reqwest::Url, String> {
    let prefix = logs_url
        .path()
        .strip_suffix(OTEL_LOGS_PATH)
        .ok_or_else(|| {
            format!("OTel logs endpoint path must end with {OTEL_LOGS_PATH}: {logs_url}")
        })?;
    let mut url = logs_url.clone();
    url.set_path(&format!("{prefix}{TELEMETRY_BOOTSTRAP_PATH}"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(OTEL_LOGS_CONNECT_TIMEOUT)
            .redirect(Policy::none())
            .build()
            .expect("failed to build OTel logs HTTP client")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex as StdMutex,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[derive(Clone, Debug)]
    struct RecordedRequest {
        path: String,
        /// Every header line as received, names lowercased, in wire order — so
        /// a test can assert a header was sent *exactly once* rather than
        /// merely present. The gateway rejects a comma-joined
        /// `x-berd-schema-version` the same way it rejects a missing one.
        headers: Vec<(String, String)>,
        body: String,
    }

    impl RecordedRequest {
        fn header_values(&self, name: &str) -> Vec<&str> {
            self.headers
                .iter()
                .filter(|(header, _)| header == name)
                .map(|(_, value)| value.as_str())
                .collect()
        }

        fn header(&self, name: &str) -> Option<&str> {
            self.header_values(name).first().copied()
        }

        fn authorization(&self) -> Option<&str> {
            self.header("authorization")
        }
    }

    struct ScriptedResponse {
        status: u16,
        body: String,
    }

    /// Minimal HTTP/1.1 gateway double: records every request and answers with
    /// the script's response. `Connection: close` keeps reqwest from reusing
    /// sockets, so one connection carries exactly one request.
    struct TestGateway {
        base_url: String,
        requests: Arc<StdMutex<Vec<RecordedRequest>>>,
    }

    impl TestGateway {
        async fn spawn<F>(respond: F) -> Self
        where
            F: Fn(&RecordedRequest) -> ScriptedResponse + Send + Sync + 'static,
        {
            Self::spawn_async(move |request| {
                let response = respond(&request);
                std::future::ready(response)
            })
            .await
        }

        /// `spawn` with a responder that may await, so a test can hold a
        /// response open at a chosen point in the export flow (see the consent
        /// module's revocation tests). Requests are recorded *before* the
        /// responder runs, so a test can poll `requests_to` to learn the export
        /// has reached this step while the response is still pending.
        async fn spawn_async<F, Fut>(respond: F) -> Self
        where
            F: Fn(RecordedRequest) -> Fut + Send + Sync + 'static,
            Fut: std::future::Future<Output = ScriptedResponse> + Send + 'static,
        {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let requests: Arc<StdMutex<Vec<RecordedRequest>>> = Arc::default();
            let recorded = requests.clone();
            let respond = Arc::new(respond);
            tokio::spawn(async move {
                loop {
                    let Ok((mut stream, _)) = listener.accept().await else {
                        break;
                    };
                    let recorded = recorded.clone();
                    let respond = respond.clone();
                    tokio::spawn(async move {
                        let request = read_request(&mut stream).await;
                        recorded.lock().unwrap().push(request.clone());
                        let response = respond(request).await;
                        let payload = format!(
                            "HTTP/1.1 {} Scripted\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            response.status,
                            response.body.len(),
                            response.body
                        );
                        let _ = stream.write_all(payload.as_bytes()).await;
                        let _ = stream.shutdown().await;
                    });
                }
            });
            Self {
                base_url: format!("http://{addr}"),
                requests,
            }
        }

        fn url(&self, path: &str) -> reqwest::Url {
            reqwest::Url::parse(&format!("{}{path}", self.base_url)).unwrap()
        }

        fn requests_to(&self, path: &str) -> Vec<RecordedRequest> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.path == path)
                .cloned()
                .collect()
        }
    }

    async fn read_request(stream: &mut TcpStream) -> RecordedRequest {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        let header_end = loop {
            if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
                break pos + 4;
            }
            let n = stream.read(&mut chunk).await.unwrap();
            assert!(n > 0, "connection closed before headers arrived");
            buf.extend_from_slice(&chunk[..n]);
        };

        let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let mut lines = head.lines();
        let request_line = lines.next().unwrap_or_default();
        let path = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_string();
        let mut content_length = 0usize;
        let mut headers = Vec::new();
        for line in lines {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let name = name.to_ascii_lowercase();
            let value = value.trim().to_string();
            if name == "content-length" {
                content_length = value.parse().unwrap_or(0);
            }
            headers.push((name, value));
        }

        while buf.len() < header_end + content_length {
            let n = stream.read(&mut chunk).await.unwrap();
            assert!(n > 0, "connection closed before body arrived");
            buf.extend_from_slice(&chunk[..n]);
        }
        let body =
            String::from_utf8_lossy(&buf[header_end..header_end + content_length]).to_string();

        RecordedRequest {
            path,
            headers,
            body,
        }
    }

    fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    fn test_auth_state() -> (tempfile::TempDir, TelemetryAuthState) {
        let dir = tempfile::tempdir().unwrap();
        let state = TelemetryAuthState::new(dir.path().to_path_buf());
        (dir, state)
    }

    /// Auth state with consent already persisted, which every test that drives
    /// an actual upload needs: consent is re-read at each network boundary the
    /// export crosses (see `ensure_consent_unrevoked`), not only at the entry
    /// gate, so an unconsented state now aborts the transport path as well.
    fn consented_auth_state() -> (tempfile::TempDir, TelemetryAuthState) {
        let dir = tempfile::tempdir().unwrap();
        persist_telemetry_consent(dir.path(), true).unwrap();
        let state = TelemetryAuthState::new(dir.path().to_path_buf());
        (dir, state)
    }

    /// Responds to `/v1/bootstrap` with sequentially numbered tokens
    /// (`token-1`, `token-2`, …) of the given TTL; other paths fall through to
    /// `logs`.
    fn gateway_script(
        ttl_seconds: u64,
        logs: impl Fn(&RecordedRequest) -> ScriptedResponse + Send + Sync + 'static,
    ) -> impl Fn(&RecordedRequest) -> ScriptedResponse + Send + Sync + 'static {
        let bootstrap_count = Arc::new(AtomicUsize::new(0));
        move |request| {
            if request.path == "/v1/bootstrap" {
                let n = bootstrap_count.fetch_add(1, Ordering::SeqCst) + 1;
                ScriptedResponse {
                    status: 200,
                    body: format!(
                        r#"{{"token":"token-{n}","tokenType":"Bearer","expiresInSeconds":{ttl_seconds}}}"#
                    ),
                }
            } else {
                logs(request)
            }
        }
    }

    const EXPORT_BODY: &str = r#"{"resourceLogs":[]}"#;

    #[tokio::test]
    async fn bootstraps_once_and_reuses_the_cached_token() {
        let gateway = TestGateway::spawn(gateway_script(900, |_| ScriptedResponse {
            status: 200,
            body: "{}".to_string(),
        }))
        .await;
        let (_dir, auth) = consented_auth_state();
        let logs_url = gateway.url("/v1/logs");
        let bootstrap_url = gateway.url("/v1/bootstrap");

        for _ in 0..2 {
            let response = export_with_bootstrap_auth(
                client(),
                &auth,
                auth.revocation_epoch(),
                &logs_url,
                &bootstrap_url,
                EXPORT_BODY.to_string(),
            )
            .await
            .unwrap();
            assert_eq!(response.status, 200);
        }

        let bootstraps = gateway.requests_to("/v1/bootstrap");
        assert_eq!(bootstraps.len(), 1);
        assert_eq!(
            bootstraps[0].body,
            format!(r#"{{"installationId":"{}"}}"#, auth.installation_id())
        );

        let logs = gateway.requests_to("/v1/logs");
        assert_eq!(logs.len(), 2);
        for request in &logs {
            assert_eq!(request.authorization(), Some("Bearer token-1"));
            assert_eq!(request.body, EXPORT_BODY);
        }
    }

    #[tokio::test]
    async fn refreshes_the_token_proactively_before_expiry() {
        // A TTL inside the refresh margin makes the cached token immediately
        // stale, so the second export must re-bootstrap without ever seeing a
        // server-side rejection.
        let gateway = TestGateway::spawn(gateway_script(30, |_| ScriptedResponse {
            status: 200,
            body: "{}".to_string(),
        }))
        .await;
        let (_dir, auth) = consented_auth_state();
        let logs_url = gateway.url("/v1/logs");
        let bootstrap_url = gateway.url("/v1/bootstrap");

        for _ in 0..2 {
            export_with_bootstrap_auth(
                client(),
                &auth,
                auth.revocation_epoch(),
                &logs_url,
                &bootstrap_url,
                EXPORT_BODY.to_string(),
            )
            .await
            .unwrap();
        }

        assert_eq!(gateway.requests_to("/v1/bootstrap").len(), 2);
        let logs = gateway.requests_to("/v1/logs");
        assert_eq!(logs[0].authorization(), Some("Bearer token-1"));
        assert_eq!(logs[1].authorization(), Some("Bearer token-2"));
    }

    #[tokio::test]
    async fn clamps_an_unbounded_bootstrap_ttl_instead_of_panicking() {
        // `expiresInSeconds` deserializes as an unbounded u64, and
        // `Instant + Duration` panics on overflow — before the clamp, a
        // gateway answering u64::MAX panicked the export task with the
        // token-cache lock held. The clamped token must still cache: the
        // second export reuses it rather than re-bootstrapping.
        let gateway = TestGateway::spawn(gateway_script(u64::MAX, |_| ScriptedResponse {
            status: 200,
            body: "{}".to_string(),
        }))
        .await;
        let (_dir, auth) = consented_auth_state();
        let logs_url = gateway.url("/v1/logs");
        let bootstrap_url = gateway.url("/v1/bootstrap");

        for _ in 0..2 {
            let response = export_with_bootstrap_auth(
                client(),
                &auth,
                auth.revocation_epoch(),
                &logs_url,
                &bootstrap_url,
                EXPORT_BODY.to_string(),
            )
            .await
            .unwrap();
            assert_eq!(response.status, 200);
        }

        assert_eq!(gateway.requests_to("/v1/bootstrap").len(), 1);
        let logs = gateway.requests_to("/v1/logs");
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[1].authorization(), Some("Bearer token-1"));
    }

    #[tokio::test]
    async fn reauths_and_retries_the_same_body_once_on_401() {
        let gateway = TestGateway::spawn(gateway_script(900, |request| {
            if request.authorization() == Some("Bearer token-1") {
                ScriptedResponse {
                    status: 401,
                    body: r#"{"error":"invalid_bearer_token"}"#.to_string(),
                }
            } else {
                ScriptedResponse {
                    status: 200,
                    body: "{}".to_string(),
                }
            }
        }))
        .await;
        let (_dir, auth) = consented_auth_state();

        let response = export_with_bootstrap_auth(
            client(),
            &auth,
            auth.revocation_epoch(),
            &gateway.url("/v1/logs"),
            &gateway.url("/v1/bootstrap"),
            EXPORT_BODY.to_string(),
        )
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(gateway.requests_to("/v1/bootstrap").len(), 2);
        let logs = gateway.requests_to("/v1/logs");
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].authorization(), Some("Bearer token-1"));
        assert_eq!(logs[1].authorization(), Some("Bearer token-2"));
        // The retry re-sends the exact same batch.
        assert_eq!(logs[0].body, logs[1].body);
    }

    /// Deterministic replay of the concurrent-export race the compare-and-clear
    /// exists for: N exports 401 on the same stale token, the first re-auth
    /// caches a fresh one, and each straggler then invalidates. An
    /// unconditional clear would discard the fresh token every time and
    /// re-bootstrap N times against the per-install rate-limited endpoint;
    /// with compare-and-clear the straggler's invalidation is a no-op and its
    /// retry rides the sibling's token.
    #[tokio::test]
    async fn a_stragglers_invalidation_keeps_a_siblings_fresh_token() {
        let gateway = TestGateway::spawn(gateway_script(900, |request| {
            if request.authorization() == Some("Bearer token-1") {
                ScriptedResponse {
                    status: 401,
                    body: r#"{"error":"invalid_bearer_token"}"#.to_string(),
                }
            } else {
                ScriptedResponse {
                    status: 200,
                    body: "{}".to_string(),
                }
            }
        }))
        .await;
        let (_dir, auth) = consented_auth_state();
        let logs_url = gateway.url("/v1/logs");
        let bootstrap_url = gateway.url("/v1/bootstrap");

        // First export: token-1 is rejected, the re-auth caches token-2.
        let response = export_with_bootstrap_auth(
            client(),
            &auth,
            auth.revocation_epoch(),
            &logs_url,
            &bootstrap_url,
            EXPORT_BODY.to_string(),
        )
        .await
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(gateway.requests_to("/v1/bootstrap").len(), 2);

        // A straggler that also 401ed on token-1 invalidates after the
        // sibling's re-auth: the cache holds token-2, so nothing clears and
        // its retry reuses the sibling's token without a third bootstrap.
        auth.invalidate_upload_token("token-1").await;
        let response = export_with_bootstrap_auth(
            client(),
            &auth,
            auth.revocation_epoch(),
            &logs_url,
            &bootstrap_url,
            EXPORT_BODY.to_string(),
        )
        .await
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(gateway.requests_to("/v1/bootstrap").len(), 2);
        let logs = gateway.requests_to("/v1/logs");
        assert_eq!(logs.last().unwrap().authorization(), Some("Bearer token-2"));

        // Invalidating with the token actually cached still clears, so a
        // genuine rejection of the current token re-bootstraps as before.
        auth.invalidate_upload_token("token-2").await;
        export_with_bootstrap_auth(
            client(),
            &auth,
            auth.revocation_epoch(),
            &logs_url,
            &bootstrap_url,
            EXPORT_BODY.to_string(),
        )
        .await
        .unwrap();
        assert_eq!(gateway.requests_to("/v1/bootstrap").len(), 3);
    }

    #[tokio::test]
    async fn retries_at_most_once_on_repeated_401() {
        let gateway = TestGateway::spawn(gateway_script(900, |_| ScriptedResponse {
            status: 401,
            body: r#"{"error":"invalid_bearer_token"}"#.to_string(),
        }))
        .await;
        let (_dir, auth) = consented_auth_state();

        let response = export_with_bootstrap_auth(
            client(),
            &auth,
            auth.revocation_epoch(),
            &gateway.url("/v1/logs"),
            &gateway.url("/v1/bootstrap"),
            EXPORT_BODY.to_string(),
        )
        .await
        .unwrap();

        // The second 401 is surfaced to the renderer, not retried again.
        assert_eq!(response.status, 401);
        assert_eq!(gateway.requests_to("/v1/logs").len(), 2);
        assert_eq!(gateway.requests_to("/v1/bootstrap").len(), 2);
    }

    #[tokio::test]
    async fn bootstrap_failure_fails_the_export_without_posting_logs() {
        let gateway = TestGateway::spawn(|_| ScriptedResponse {
            status: 500,
            body: r#"{"error":"internal"}"#.to_string(),
        })
        .await;
        let (_dir, auth) = consented_auth_state();

        let error = export_with_bootstrap_auth(
            client(),
            &auth,
            auth.revocation_epoch(),
            &gateway.url("/v1/logs"),
            &gateway.url("/v1/bootstrap"),
            EXPORT_BODY.to_string(),
        )
        .await
        .unwrap_err();

        assert!(error.contains("bootstrap"));
        assert!(gateway.requests_to("/v1/logs").is_empty());
    }

    /// The gateway validates every upload against a registered wire-contract
    /// version and 400s a missing, empty, or comma-joined header — terminal for
    /// that batch, which the renderer then drops. The retry has to carry it too,
    /// since it is a second upload, not a resend of the first request's headers.
    #[tokio::test]
    async fn declares_the_schema_version_on_every_upload_including_the_retry() {
        let gateway = TestGateway::spawn(gateway_script(900, |request| {
            if request.authorization() == Some("Bearer token-1") {
                ScriptedResponse {
                    status: 401,
                    body: r#"{"error":"invalid_bearer_token"}"#.to_string(),
                }
            } else {
                ScriptedResponse {
                    status: 200,
                    body: "{}".to_string(),
                }
            }
        }))
        .await;
        let (_dir, auth) = consented_auth_state();

        export_with_bootstrap_auth(
            client(),
            &auth,
            auth.revocation_epoch(),
            &gateway.url("/v1/logs"),
            &gateway.url("/v1/bootstrap"),
            EXPORT_BODY.to_string(),
        )
        .await
        .unwrap();

        let logs = gateway.requests_to("/v1/logs");
        assert_eq!(logs.len(), 2);
        for request in &logs {
            // Exactly once: a header sent twice reaches the gateway
            // comma-joined, which it rejects like a missing one.
            assert_eq!(
                request.header_values(TELEMETRY_SCHEMA_VERSION_HEADER),
                vec!["berd-otlp-logs-v1"]
            );
            assert_eq!(request.header("content-type"), Some("application/json"));
            // The gateway hands the raw request bytes to its JSON parser, so a
            // compressed body is a 400 rather than something it decodes.
            assert_eq!(request.header("content-encoding"), None);
        }
    }

    #[tokio::test]
    async fn bootstrap_posts_json_without_the_schema_version_header() {
        let gateway = TestGateway::spawn(gateway_script(900, |_| ScriptedResponse {
            status: 200,
            body: "{}".to_string(),
        }))
        .await;
        let (_dir, auth) = consented_auth_state();

        export_with_bootstrap_auth(
            client(),
            &auth,
            auth.revocation_epoch(),
            &gateway.url("/v1/logs"),
            &gateway.url("/v1/bootstrap"),
            EXPORT_BODY.to_string(),
        )
        .await
        .unwrap();

        let bootstraps = gateway.requests_to("/v1/bootstrap");
        assert_eq!(bootstraps.len(), 1);
        // `content-type: application/json` is required — the gateway answers a
        // missing or other content type with a 415.
        assert_eq!(
            bootstraps[0].header("content-type"),
            Some("application/json")
        );
        // Bootstrap does not read the schema version: it exchanges an
        // installation id for a token and never sees a log body.
        assert!(bootstraps[0]
            .header_values(TELEMETRY_SCHEMA_VERSION_HEADER)
            .is_empty());
        // Anonymous: the token being fetched cannot authenticate its own fetch.
        assert_eq!(bootstraps[0].authorization(), None);
    }

    #[test]
    fn creates_and_persists_the_installation_id() {
        let dir = tempfile::tempdir().unwrap();

        let first = load_or_create_installation_id(dir.path()).unwrap();
        let second = load_or_create_installation_id(dir.path()).unwrap();

        assert_eq!(first, second);
        assert!(is_valid_installation_id(&first));
        assert_eq!(
            fs::read_to_string(dir.path().join(INSTALLATION_ID_FILE_NAME)).unwrap(),
            first
        );
    }

    #[test]
    fn regenerates_an_invalid_persisted_installation_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(INSTALLATION_ID_FILE_NAME);
        fs::write(&path, "bad id!").unwrap();

        let id = load_or_create_installation_id(dir.path()).unwrap();

        assert!(is_valid_installation_id(&id));
        assert_eq!(fs::read_to_string(&path).unwrap(), id);
    }

    #[test]
    fn installation_id_is_stable_across_state_instances() {
        let dir = tempfile::tempdir().unwrap();
        let first = TelemetryAuthState::new(dir.path().to_path_buf());
        let second = TelemetryAuthState::new(dir.path().to_path_buf());

        assert_eq!(first.installation_id(), second.installation_id());
    }

    #[test]
    fn telemetry_resource_serializes_the_renderer_wire_shape() {
        // The renderer validates this exact shape (camelCase keys, lowercase
        // channel literals) before stamping the OTel resource.
        let resource = TelemetryResource {
            installation_id: "11111111-2222-4333-8444-555555555555".to_string(),
            channel: TelemetryChannel::Internal,
        };

        assert_eq!(
            serde_json::to_value(&resource).unwrap(),
            serde_json::json!({
                "installationId": "11111111-2222-4333-8444-555555555555",
                "channel": "internal"
            })
        );
    }

    // Consent is opt-in and fail-closed, so the enforced build inverts most of
    // these expectations; its behavior is pinned separately below.
    #[cfg(not(feature = "block-telemetry-enforced"))]
    mod consent {
        use super::*;
        use tokio::sync::Semaphore;

        #[test]
        fn defaults_to_disabled_without_a_settings_file() {
            let (_dir, auth) = test_auth_state();

            assert!(!auth.consent_granted());
            assert!(!auth.settings().enabled);
        }

        #[test]
        fn set_consent_persists_and_survives_restart() {
            let dir = tempfile::tempdir().unwrap();
            let auth = TelemetryAuthState::new(dir.path().to_path_buf());

            let settings = auth.set_consent(true).unwrap();
            assert!(settings.enabled);
            assert!(auth.consent_granted());

            // The file is schema-versioned JSON a fresh state (a new app
            // start) reads back during construction.
            let raw = fs::read_to_string(dir.path().join(TELEMETRY_SETTINGS_FILE_NAME)).unwrap();
            let persisted: PersistedTelemetrySettings = serde_json::from_str(&raw).unwrap();
            assert_eq!(persisted.schema_version, TELEMETRY_SETTINGS_SCHEMA_VERSION);
            assert!(persisted.enabled);

            let restarted = TelemetryAuthState::new(dir.path().to_path_buf());
            assert!(restarted.consent_granted());

            restarted.set_consent(false).unwrap();
            assert!(!restarted.consent_granted());
            assert!(!TelemetryAuthState::new(dir.path().to_path_buf()).consent_granted());
        }

        #[test]
        fn corrupt_settings_fail_closed() {
            let dir = tempfile::tempdir().unwrap();
            fs::write(
                dir.path().join(TELEMETRY_SETTINGS_FILE_NAME),
                "not json at all",
            )
            .unwrap();

            assert!(!load_telemetry_consent(dir.path()));
        }

        #[test]
        fn future_schema_versions_fail_closed() {
            let dir = tempfile::tempdir().unwrap();
            fs::write(
                dir.path().join(TELEMETRY_SETTINGS_FILE_NAME),
                r#"{"schemaVersion":2,"enabled":true}"#,
            )
            .unwrap();

            assert!(!load_telemetry_consent(dir.path()));
        }

        /// The gate has to fire before *anything* else — no endpoint
        /// validation, no bootstrap, no upload. The allowlisted host here is
        /// unreachable, so this test staying instant (no connect timeout) is
        /// itself evidence no network was attempted.
        #[tokio::test]
        async fn export_refuses_before_any_network_io_when_consent_is_off() {
            let (_dir, auth) = test_auth_state();

            let error = export_otel_logs_for_state(
                &auth,
                "https://otlp.invalid.goose-internal.example/v1/logs",
                EXPORT_BODY.to_string(),
            )
            .await
            .unwrap_err();

            assert!(error.contains("disabled"));
        }

        /// With consent granted the gate passes and the export proceeds into
        /// the existing validation/auth path (whose mechanics the tests above
        /// pin): a non-HTTPS endpoint now fails on *validation*, not consent.
        #[tokio::test]
        async fn export_passes_the_gate_once_consent_is_granted() {
            let dir = tempfile::tempdir().unwrap();
            persist_telemetry_consent(dir.path(), true).unwrap();
            let auth = TelemetryAuthState::new(dir.path().to_path_buf());

            let error = export_otel_logs_for_state(
                &auth,
                "http://otlp.invalid.goose-internal.example/v1/logs",
                EXPORT_BODY.to_string(),
            )
            .await
            .unwrap_err();

            assert!(error.contains("https"));
        }

        /// Polls until the gateway has recorded a request to `path`, so a test
        /// can act — revoke consent — at a known point in an export's flow. The
        /// double records a request before running its responder, so this
        /// returns while a paused response is still pending.
        async fn wait_for_request(gateway: &TestGateway, path: &str) {
            for _ in 0..500 {
                if !gateway.requests_to(path).is_empty() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("gateway never received a request to {path}");
        }

        fn bootstrap_response(token: &str) -> ScriptedResponse {
            ScriptedResponse {
                status: 200,
                body: format!(
                    r#"{{"token":"{token}","tokenType":"Bearer","expiresInSeconds":900}}"#
                ),
            }
        }

        /// An export that is awaiting the bootstrap response when consent is
        /// revoked must not go on to upload the batch: the entry gate has
        /// already passed, so only the pre-upload re-check can stop it.
        #[tokio::test]
        async fn revoking_consent_while_bootstrap_is_pending_aborts_before_the_logs_post() {
            let release = Arc::new(Semaphore::new(0));
            let gate = release.clone();
            let gateway = TestGateway::spawn_async(move |request| {
                let gate = gate.clone();
                async move {
                    if request.path == "/v1/bootstrap" {
                        // Held open until the test has revoked consent.
                        let _permit = gate.acquire().await;
                        bootstrap_response("token-1")
                    } else {
                        ScriptedResponse {
                            status: 200,
                            body: "{}".to_string(),
                        }
                    }
                }
            })
            .await;
            let (_dir, auth) = consented_auth_state();
            let auth = Arc::new(auth);
            let logs_url = gateway.url("/v1/logs");
            let bootstrap_url = gateway.url("/v1/bootstrap");
            let epoch = auth.revocation_epoch();

            let export = tokio::spawn({
                let auth = auth.clone();
                async move {
                    export_with_bootstrap_auth(
                        client(),
                        &auth,
                        epoch,
                        &logs_url,
                        &bootstrap_url,
                        EXPORT_BODY.to_string(),
                    )
                    .await
                }
            });

            wait_for_request(&gateway, "/v1/bootstrap").await;
            auth.set_consent(false).unwrap();
            release.add_permits(1);

            let error = export.await.unwrap().unwrap_err();
            assert!(error.contains("revoked"), "unexpected error: {error}");
            // The bootstrap was already on the wire and cannot be recalled;
            // the batch itself never leaves.
            assert_eq!(gateway.requests_to("/v1/bootstrap").len(), 1);
            assert!(gateway.requests_to("/v1/logs").is_empty());
        }

        /// The 401 path is the widest post-gate window: it would otherwise
        /// re-bootstrap (a second request carrying the installation id) and
        /// re-send the batch after the revocation.
        #[tokio::test]
        async fn revoking_consent_after_a_401_aborts_before_reauth_and_retry() {
            let release = Arc::new(Semaphore::new(0));
            let gate = release.clone();
            let gateway = TestGateway::spawn_async(move |request| {
                let gate = gate.clone();
                async move {
                    if request.path == "/v1/bootstrap" {
                        bootstrap_response("token-1")
                    } else {
                        // Held open until the test has revoked consent, then
                        // answered with the auth failure that drives the retry.
                        let _permit = gate.acquire().await;
                        ScriptedResponse {
                            status: 401,
                            body: r#"{"error":"invalid_bearer_token"}"#.to_string(),
                        }
                    }
                }
            })
            .await;
            let (_dir, auth) = consented_auth_state();
            let auth = Arc::new(auth);
            let logs_url = gateway.url("/v1/logs");
            let bootstrap_url = gateway.url("/v1/bootstrap");
            let epoch = auth.revocation_epoch();

            let export = tokio::spawn({
                let auth = auth.clone();
                async move {
                    export_with_bootstrap_auth(
                        client(),
                        &auth,
                        epoch,
                        &logs_url,
                        &bootstrap_url,
                        EXPORT_BODY.to_string(),
                    )
                    .await
                }
            });

            wait_for_request(&gateway, "/v1/logs").await;
            auth.set_consent(false).unwrap();
            release.add_permits(1);

            let error = export.await.unwrap().unwrap_err();
            assert!(error.contains("revoked"), "unexpected error: {error}");
            // The 401 cleared the cached token, so the re-check inside
            // `upload_token` fires ahead of the re-auth request itself.
            assert_eq!(gateway.requests_to("/v1/bootstrap").len(), 1);
            assert_eq!(gateway.requests_to("/v1/logs").len(), 1);
        }

        /// Revocation supersedes: opting back in while the batch is still in
        /// flight does not resurrect it, which is what the epoch buys over a
        /// plain `consent_granted()` re-check (that would pass this batch).
        #[tokio::test]
        async fn a_revocation_supersedes_a_regrant_for_in_flight_exports() {
            let release = Arc::new(Semaphore::new(0));
            let gate = release.clone();
            let gateway = TestGateway::spawn_async(move |request| {
                let gate = gate.clone();
                async move {
                    if request.path == "/v1/bootstrap" {
                        let _permit = gate.acquire().await;
                        bootstrap_response("token-1")
                    } else {
                        ScriptedResponse {
                            status: 200,
                            body: "{}".to_string(),
                        }
                    }
                }
            })
            .await;
            let (_dir, auth) = consented_auth_state();
            let auth = Arc::new(auth);
            let logs_url = gateway.url("/v1/logs");
            let bootstrap_url = gateway.url("/v1/bootstrap");
            let epoch = auth.revocation_epoch();

            let export = tokio::spawn({
                let auth = auth.clone();
                async move {
                    export_with_bootstrap_auth(
                        client(),
                        &auth,
                        epoch,
                        &logs_url,
                        &bootstrap_url,
                        EXPORT_BODY.to_string(),
                    )
                    .await
                }
            });

            wait_for_request(&gateway, "/v1/bootstrap").await;
            auth.set_consent(false).unwrap();
            auth.set_consent(true).unwrap();
            release.add_permits(1);

            let error = export.await.unwrap().unwrap_err();
            assert!(error.contains("revoked"), "unexpected error: {error}");
            assert!(auth.consent_granted());
            assert!(gateway.requests_to("/v1/logs").is_empty());
        }

        /// The re-check for the bootstrap request lives inside `upload_token`,
        /// after the lock and the cache miss — so a revoked epoch reaches no
        /// endpoint at all, not even the one that would fetch a token.
        #[tokio::test]
        async fn a_revoked_epoch_skips_all_network_on_a_cache_miss() {
            let gateway = TestGateway::spawn(gateway_script(900, |_| ScriptedResponse {
                status: 200,
                body: "{}".to_string(),
            }))
            .await;
            let (_dir, auth) = consented_auth_state();
            let epoch = auth.revocation_epoch();
            auth.set_consent(false).unwrap();

            let error = export_with_bootstrap_auth(
                client(),
                &auth,
                epoch,
                &gateway.url("/v1/logs"),
                &gateway.url("/v1/bootstrap"),
                EXPORT_BODY.to_string(),
            )
            .await
            .unwrap_err();

            assert!(error.contains("revoked"), "unexpected error: {error}");
            assert!(gateway.requests_to("/v1/bootstrap").is_empty());
            assert!(gateway.requests_to("/v1/logs").is_empty());
        }
    }

    #[cfg(feature = "block-telemetry-enforced")]
    mod enforced_consent {
        use super::*;

        #[test]
        fn consent_is_granted_without_a_settings_file() {
            let (_dir, auth) = test_auth_state();

            assert!(auth.consent_granted());
            assert!(auth.settings().enabled);
        }

        #[test]
        fn consent_writes_are_refused() {
            let (_dir, auth) = test_auth_state();

            let error = auth.set_consent(false).unwrap_err();

            assert!(error.contains("always enabled"));
        }
    }

    #[test]
    fn allows_configured_otlp_endpoint_host() {
        let url = allowed_otel_logs_endpoint("https://otlp.invalid.goose-internal.example/v1/logs")
            .unwrap();

        assert_eq!(
            url.as_str(),
            "https://otlp.invalid.goose-internal.example/v1/logs"
        );
    }

    /// Pins the exact URL pair a production build uses: the injected
    /// `/v1/logs` endpoint validates against the allowlist and derives the
    /// production `/v1/bootstrap` URL.
    #[test]
    fn allows_the_production_gateway_host_and_derives_its_bootstrap_url() {
        let logs_url = allowed_otel_logs_endpoint("https://otel.berd.xyz/v1/logs").unwrap();

        let bootstrap_url = telemetry_bootstrap_url(&logs_url).unwrap();

        assert_eq!(logs_url.as_str(), "https://otel.berd.xyz/v1/logs");
        assert_eq!(bootstrap_url.as_str(), "https://otel.berd.xyz/v1/bootstrap");
    }

    /// Pins the exact URL pair a staging build uses: the injected
    /// `/v1/logs` endpoint validates against the allowlist and derives the
    /// staging `/v1/bootstrap` URL.
    #[test]
    fn allows_the_staging_gateway_host_and_derives_its_bootstrap_url() {
        let logs_url =
            allowed_otel_logs_endpoint("https://otel.test.blockstaging.build/v1/logs").unwrap();

        let bootstrap_url = telemetry_bootstrap_url(&logs_url).unwrap();

        assert_eq!(
            logs_url.as_str(),
            "https://otel.test.blockstaging.build/v1/logs"
        );
        assert_eq!(
            bootstrap_url.as_str(),
            "https://otel.test.blockstaging.build/v1/bootstrap"
        );
    }

    #[test]
    fn rejects_non_allowed_host() {
        let error = allowed_otel_logs_endpoint("https://otlp.evil.example/v1/logs").unwrap_err();

        assert!(error.contains("not allowed"));
    }

    #[test]
    fn rejects_spoofed_host_suffix() {
        let error = allowed_otel_logs_endpoint(
            "https://otlp.invalid.goose-internal.example.evil.com/v1/logs",
        )
        .unwrap_err();

        assert!(error.contains("not allowed"));
    }

    #[test]
    fn rejects_non_https_scheme() {
        let error =
            allowed_otel_logs_endpoint("http://otlp.invalid.goose-internal.example/v1/logs")
                .unwrap_err();

        assert!(error.contains("https"));
    }

    /// URL userinfo would reach the wire as a renderer-controlled
    /// `Authorization: Basic` header, including on the anonymous bootstrap
    /// request; the error must not echo the credential either.
    #[test]
    fn rejects_endpoint_with_userinfo_credentials() {
        let error =
            allowed_otel_logs_endpoint("https://user:hunter2@otel.test.blockstaging.build/v1/logs")
                .unwrap_err();

        assert!(error.contains("credentials"));
        assert!(!error.contains("hunter2"));
    }

    #[test]
    fn rejects_endpoint_with_username_only_userinfo() {
        let error = allowed_otel_logs_endpoint("https://user@otel.test.blockstaging.build/v1/logs")
            .unwrap_err();

        assert!(error.contains("credentials"));
    }

    /// The allowlist compares `host_str()` alone, so without the port check
    /// an allowed host on an arbitrary port would receive the upload token
    /// and installation id.
    #[test]
    fn rejects_endpoint_with_explicit_port() {
        let error = allowed_otel_logs_endpoint("https://otel.test.blockstaging.build:8443/v1/logs")
            .unwrap_err();

        assert!(error.contains("port"));
    }

    /// The scheme-default port normalizes away during URL parsing instead of
    /// tripping the explicit-port rejection.
    #[test]
    fn allows_the_scheme_default_port() {
        let url =
            allowed_otel_logs_endpoint("https://otel.test.blockstaging.build:443/v1/logs").unwrap();

        assert_eq!(url.as_str(), "https://otel.test.blockstaging.build/v1/logs");
    }

    #[test]
    fn rejects_endpoint_off_the_logs_path_convention() {
        let error =
            allowed_otel_logs_endpoint("https://otlp.invalid.goose-internal.example/v1/bootstrap")
                .unwrap_err();

        assert!(error.contains("/v1/logs"));
    }

    #[test]
    fn derives_the_bootstrap_url_from_the_logs_endpoint() {
        let logs_url =
            allowed_otel_logs_endpoint("https://otlp.invalid.goose-internal.example/v1/logs")
                .unwrap();

        let bootstrap_url = telemetry_bootstrap_url(&logs_url).unwrap();

        assert_eq!(
            bootstrap_url.as_str(),
            "https://otlp.invalid.goose-internal.example/v1/bootstrap"
        );
    }

    #[test]
    fn bootstrap_url_preserves_a_gateway_path_prefix() {
        let logs_url =
            reqwest::Url::parse("https://otlp.invalid.goose-internal.example/gateway/v1/logs")
                .unwrap();

        let bootstrap_url = telemetry_bootstrap_url(&logs_url).unwrap();

        assert_eq!(
            bootstrap_url.as_str(),
            "https://otlp.invalid.goose-internal.example/gateway/v1/bootstrap"
        );
    }
}
