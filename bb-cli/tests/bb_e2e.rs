//! End-to-end tests for the `bb` binary (skills marketplace + bb-specific
//! surfaces). The sq/agent-tools CLI suite lives in `cli_e2e.rs`; shared mock
//! server infrastructure lives in `common/`.

mod common;

use std::fs;
use std::io::{Cursor, Write};
use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;

use common::{
    bb_command, calculate_tool_schema, list_tools_response, output_text, temp_test_dir,
    write_bb_org_config, write_extensions_catalog, MockResponse, MockServer,
    BB_TOOLS_CALL_TOOL_PATH, BB_TOOLS_LIST_TOOLS_PATH,
};

// ---------------------------------------------------------------------------
// fixtures

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn skill_zip(entries: &[(&str, &str)]) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = SimpleFileOptions::default();
    for (path, contents) in entries {
        zip.start_file(path, options).expect("start zip file");
        zip.write_all(contents.as_bytes()).expect("write zip file");
    }
    zip.finish().expect("finish zip").into_inner()
}

fn marketplace_skill_summary() -> Value {
    json!({
        "slug": "builderbot-tools",
        "name": "BuilderBot Tools",
        "description": "Use BuilderBot CLI tool wrappers from agent workflows.",
        "status": "stable",
        "visibility": "builtin",
        "enabled": true,
        "latest_version_id": "ver_builtin_builderbot_tools_0_1_0",
        "latest_content_sha256": "content-sha",
        "source_id": "src_builtin_builderbot",
        "source_revision": "builtin:builderbot-tools:0.1.0",
        "source_path": "builtin-skills/builderbot-tools",
        "tags": ["builderbot", "tools"],
        "teams": ["builderbot"],
        "updated_at": "2026-06-08T00:00:00Z"
    })
}

fn skill_page_response() -> MockResponse {
    MockResponse::json(json!({
        "items": [marketplace_skill_summary()],
        "next_cursor": null
    }))
}

/// `list`/`search` follow the skills page with a best-effort bundles fetch,
/// so most tests queue this empty bundles page right after the skills page.
fn empty_bundles_response() -> MockResponse {
    MockResponse::json(json!({ "items": [], "next_cursor": null }))
}

/// One bundle (`starter-pack`) that contains `builderbot-tools`, for tests
/// asserting bundle-membership annotations.
fn starter_pack_bundles_response() -> MockResponse {
    MockResponse::json(json!({
        "items": [{
            "slug": "starter-pack",
            "name": "Starter Pack",
            "description": "Everything you need to get going.",
            "status": "stable",
            "enabled": true,
            "skills": ["builderbot-tools"],
            "resolved_skills_count": 1
        }],
        "next_cursor": null
    }))
}

fn skill_detail_response() -> MockResponse {
    MockResponse::json(json!({
        "slug": "builderbot-tools",
        "name": "BuilderBot Tools",
        "description": "Use BuilderBot CLI tool wrappers from agent workflows.",
        "status": "stable",
        "enabled": true,
        "latest_version_id": "ver_builtin_builderbot_tools_0_1_0",
        "latest_content_sha256": "content-sha",
        "source_id": "src_builtin_builderbot",
        "source_revision": "builtin:builderbot-tools:0.1.0",
        "tags": ["builderbot", "tools"],
        "dependencies": [],
        "latest_version": null
    }))
}

/// Server capabilities pointing the `agents` target at a directory we control,
/// so installs link into the test sandbox instead of the real home directory.
fn capabilities_response(agents_dir: &Path) -> MockResponse {
    MockResponse::json(json!({
        "target_registry": {
            "agents": {
                "enabled": true,
                "global_paths": [format!("{}", agents_dir.display())],
                "project_paths": ["./.agents/skills"],
                "link_strategies": ["symlink"]
            }
        }
    }))
}

fn marketplace_install_plan(zip_bytes: &[u8], artifact_sha: &str, artifact_size: usize) -> Value {
    json!({
        "plan_id": "plan_phase1_builderbot_tools",
        "expires_at": "2026-06-08T01:00:00Z",
        "operations": [{
            "action": "install",
            "reason": "Install latest stable built-in skill artifact.",
            "skill": {
                "slug": "builderbot-tools",
                "version_id": "ver_builtin_builderbot_tools_0_1_0",
                "content_sha256": sha256_hex(zip_bytes)
            },
            "artifact": {
                "id": "art_builderbot_tools",
                "download_url": "/v1/marketplace/artifacts/art_builderbot_tools/download",
                "sha256": artifact_sha,
                "size_bytes": artifact_size,
                "media_type": "application/zip"
            },
            "installed_via": "explicit",
            "requires_setup": false
        }],
        "warnings": []
    })
}

fn noop_plan_response() -> MockResponse {
    MockResponse::json(json!({
        "plan_id": "plan_noop",
        "operations": [{
            "action": "noop",
            "reason": "Already at the latest version.",
            "skill": {
                "slug": "builderbot-tools",
                "version_id": "ver_builtin_builderbot_tools_0_1_0",
                "content_sha256": "content-sha"
            },
            "artifact": null,
            "installed_via": "explicit"
        }],
        "warnings": []
    }))
}

fn artifact_response(zip_bytes: Vec<u8>, sha: &str) -> MockResponse {
    MockResponse::bytes(
        200,
        zip_bytes.clone(),
        &[
            ("Content-Type", "application/zip".to_string()),
            ("X-Artifact-SHA256", sha.to_string()),
            ("X-Artifact-Size", zip_bytes.len().to_string()),
        ],
    )
}

fn marketplace_error_response(
    status: u16,
    code: &str,
    message: &str,
    request_id: &str,
) -> MockResponse {
    MockResponse::bytes(
        status,
        serde_json::to_vec(&json!({
            "error": {
                "code": code,
                "message": message,
                "request_id": request_id,
                "retryable": false,
                "details": [{
                    "path": "skills/builderbot-tools/SKILL.md",
                    "field": "description",
                    "message": "description is required"
                }]
            }
        }))
        .expect("serialize marketplace error"),
        &[("Content-Type", "application/json".to_string())],
    )
}

/// Seeds `<skills_home>/packages/<slug>` with a SKILL.md and install metadata
/// as if a previous `bb skills install` had completed.
fn write_installed_package(skills_home: &Path, slug: &str, content_sha: &str, targets: &[&str]) {
    let package = skills_home.join("packages").join(slug);
    fs::create_dir_all(&package).expect("create package dir");
    fs::write(package.join("SKILL.md"), "# BuilderBot Tools\n").expect("write SKILL.md");
    fs::write(
        package.join(".bb-skills-meta.json"),
        serde_json::to_vec_pretty(&json!({
            "schema_version": "bb-skills-install/v1",
            "server_url": "http://marketplace.local",
            "slug": slug,
            "version_id": "ver_builtin_builderbot_tools_0_1_0",
            "content_sha256": content_sha,
            "artifact_sha256": "artifact-sha",
            "artifact_size_bytes": 123,
            "installed_at": "2026-06-10T00:00:00Z",
            "installed_via": "explicit",
            "source_id": null,
            "source_revision": null,
            "scope": "global",
            "targets": targets,
            "local_source": false,
            "pinned": false
        }))
        .expect("serialize metadata"),
    )
    .expect("write metadata");
}

/// Seeds the offline capabilities cache so commands that never reach the
/// server (`remove`, `which`) resolve targets to a sandboxed directory.
fn write_capabilities_cache(skills_home: &Path, agents_dir: &Path) {
    let cache_dir = skills_home.join("cache");
    fs::create_dir_all(&cache_dir).expect("create cache dir");
    fs::write(
        cache_dir.join("capabilities.json"),
        serde_json::to_vec(&json!({
            "target_registry": {
                "agents": {
                    "enabled": true,
                    "global_paths": [format!("{}", agents_dir.display())],
                    "project_paths": ["./.agents/skills"],
                    "link_strategies": ["symlink"]
                }
            }
        }))
        .expect("serialize capabilities cache"),
    )
    .expect("write capabilities cache");
}

fn parse_stderr_error(stderr: &str) -> Value {
    serde_json::from_str::<Value>(stderr.trim())
        .unwrap_or_else(|err| panic!("stderr should be one JSON error object ({err}): {stderr}"))
}

// ---------------------------------------------------------------------------
// bb root surfaces

#[test]
fn bb_root_help_lists_skills_and_tools() {
    let output = bb_command().arg("--help").output().expect("run bb help");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(stdout.contains("auth"));
    assert!(stdout.contains("config"));
    assert!(stdout.contains("skills"));
    assert!(stdout.contains("tools"));
    assert!(stdout.contains("Builderbot command line tools"));
    assert!(!stdout.contains("--local-dev"));
}

#[test]
fn bb_tools_root_help_does_not_require_org() {
    let temp = temp_test_dir("bb-tools-help-no-org");
    let bb_home = temp.join("bb-home");
    fs::create_dir_all(&bb_home).expect("create bb home");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .args(["tools", "--help"])
        .output()
        .expect("run bb tools help");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(stdout.contains("Discover auth-backed tool extensions"));
    assert!(!stderr.contains("org_required"), "stderr was: {stderr}");
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_completions_emit_shell_script() {
    let output = bb_command()
        .args(["completions", "bash"])
        .output()
        .expect("run bb completions");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(stdout.contains("bb"), "stdout was: {stdout}");
    assert!(
        stdout.len() > 100,
        "completion script looks empty: {stdout}"
    );
}

// ---------------------------------------------------------------------------
// discovery: list / search / show / bundles

#[test]
fn bb_skills_list_fetches_marketplace_skills_and_bundle_membership() {
    let server = MockServer::start(vec![skill_page_response(), starter_pack_bundles_response()]);

    let output = bb_command()
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "list", "--json"])
        .output()
        .expect("run bb skills list");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse list output");
    assert_eq!(response["items"][0]["slug"], json!("builderbot-tools"));
    assert_eq!(response["items"][0]["installed"], json!(false));
    assert_eq!(response["items"][0]["update_available"], Value::Null);
    assert_eq!(response["items"][0]["bundles"], json!(["starter-pack"]));
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(
        requests[0].path,
        "/cash-app/goose/v1/marketplace/skills?limit=5000"
    );
    assert_eq!(requests[1].method, "GET");
    assert_eq!(
        requests[1].path,
        "/cash-app/goose/v1/marketplace/bundles?limit=5000"
    );
}

#[test]
fn bb_skills_list_uses_custom_kgoose_service_path() {
    let server = MockServer::start(vec![skill_page_response(), starter_pack_bundles_response()]);

    let output = bb_command()
        .env("KGOOSE_BASE_URL", &server.base_url)
        .env("KGOOSE_SERVICE_PATH", "/cash-app/goose-square")
        .args(["skills", "list", "--json"])
        .output()
        .expect("run bb skills list");
    let requests = server.finish();
    let (_stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].path,
        "/cash-app/goose-square/v1/marketplace/skills?limit=5000"
    );
    assert_eq!(
        requests[1].path,
        "/cash-app/goose-square/v1/marketplace/bundles?limit=5000"
    );
}

#[test]
fn bb_skills_list_formats_marketplace_skills_for_humans() {
    let server = MockServer::start(vec![skill_page_response(), starter_pack_bundles_response()]);

    let output = bb_command()
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "list"])
        .output()
        .expect("run bb skills list");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(stderr.is_empty(), "stderr was: {stderr}");
    assert!(stdout.contains("Available (1):"), "stdout was: {stdout}");
    assert!(
        stdout.contains("  builderbot-tools [stable]"),
        "stdout was: {stdout}"
    );
    assert!(
        stdout.contains("    Use BuilderBot CLI tool wrappers from agent workflows."),
        "stdout was: {stdout}"
    );
    assert!(
        stdout.contains("    name: BuilderBot Tools"),
        "stdout was: {stdout}"
    );
    assert!(
        stdout.contains("    tags: builderbot, tools"),
        "stdout was: {stdout}"
    );
    assert!(
        stdout.contains("    bundles: starter-pack"),
        "stdout was: {stdout}"
    );
    assert!(
        stdout.contains("Install one with: bb skills install <slug>"),
        "stdout was: {stdout}"
    );
}

#[test]
fn bb_skills_list_groups_installed_and_available_skills() {
    let temp = temp_test_dir("bb-skills-list-grouped");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let skills_home = temp.join("skills-home");
    write_installed_package(&skills_home, "builderbot-tools", "content-sha", &["agents"]);
    let server = MockServer::start(vec![
        MockResponse::json(json!({
            "items": [
                marketplace_skill_summary(),
                {
                    "slug": "git-fixture",
                    "name": "Git Fixture",
                    "description": "Git fixture skill.",
                    "status": "stable",
                    "enabled": true,
                    "latest_version_id": "ver_git_fixture_0_1_0",
                    "latest_content_sha256": "git-fixture-sha",
                    "tags": ["git"]
                }
            ],
            "next_cursor": null
        })),
        empty_bundles_response(),
    ]);

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", skills_home.join("packages"))
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "list"])
        .output()
        .expect("run bb skills list");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(stdout.contains("Installed (1):"), "stdout was: {stdout}");
    assert!(stdout.contains("Available (1):"), "stdout was: {stdout}");
    // The installed skill carries its local version and freshness marker...
    assert!(
        stdout.contains("  builderbot-tools [stable] (up to date)"),
        "stdout was: {stdout}"
    );
    assert!(
        stdout.contains("    version: ver_builtin_builderbot_tools_0_1_0"),
        "stdout was: {stdout}"
    );
    assert!(
        stdout.contains("    targets: agents"),
        "stdout was: {stdout}"
    );
    // ...and the installed section comes before the available one.
    let installed_at = stdout.find("Installed (1):").expect("installed section");
    let available_at = stdout.find("Available (1):").expect("available section");
    assert!(installed_at < available_at, "stdout was: {stdout}");
    assert!(
        stdout.contains("  git-fixture [stable]"),
        "stdout was: {stdout}"
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_search_passes_query_filter() {
    let server = MockServer::start(vec![skill_page_response(), empty_bundles_response()]);

    let output = bb_command()
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "search", "builder", "--json"])
        .output()
        .expect("run bb skills search");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse search output");
    assert_eq!(response["items"][0]["slug"], json!("builderbot-tools"));
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].path,
        "/cash-app/goose/v1/marketplace/skills?limit=5000&query=builder"
    );
    assert_eq!(
        requests[1].path,
        "/cash-app/goose/v1/marketplace/bundles?limit=5000"
    );
}

#[test]
fn bb_skills_show_prints_skill_detail() {
    let server = MockServer::start(vec![skill_detail_response()]);

    let output = bb_command()
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "show", "builderbot-tools", "--json"])
        .output()
        .expect("run bb skills show");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse show output");
    assert_eq!(response["slug"], json!("builderbot-tools"));
    assert_eq!(
        response["latest_version_id"],
        json!("ver_builtin_builderbot_tools_0_1_0")
    );
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].path,
        "/cash-app/goose/v1/marketplace/skills/builderbot-tools"
    );
}

#[test]
fn bb_skills_bundles_lists_bundles() {
    let server = MockServer::start(vec![MockResponse::json(json!({
        "items": [{
            "slug": "starter-pack",
            "name": "Starter Pack",
            "description": "Everything you need to get going.",
            "status": "stable",
            "enabled": true,
            "skills": ["builderbot-tools"],
            "resolved_skills_count": 1
        }],
        "next_cursor": null
    }))]);

    let output = bb_command()
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "bundles", "--json"])
        .output()
        .expect("run bb skills bundles");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse bundles output");
    assert_eq!(response["items"][0]["slug"], json!("starter-pack"));
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].path,
        "/cash-app/goose/v1/marketplace/bundles?limit=5000"
    );
}

// ---------------------------------------------------------------------------
// config & auth resolution

#[test]
fn bb_skills_ignores_legacy_profile_server_url_and_auth() {
    let server = MockServer::start(vec![skill_page_response(), empty_bundles_response()]);
    let temp = temp_test_dir("bb-skills-profile-config");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    fs::create_dir_all(&bb_home).expect("create bb home");
    fs::write(
        bb_home.join("skills.yaml"),
        format!(
            "current_profile: local\nprofiles:\n  local:\n    server_url: {}\n    auth:\n      token: profile-token\n",
            server.base_url
        ),
    )
    .expect("write skills config");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "list", "--json"])
        .output()
        .expect("run bb skills list");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse list output");
    assert_eq!(response["items"][0]["slug"], json!("builderbot-tools"));
    assert_eq!(requests.len(), 2);
    assert!(!requests[0].headers.contains_key("authorization"));
    assert!(!requests[0].headers.contains_key("x-bb-session-credential"));
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_list_uses_stored_session_credential_despite_legacy_profile_auth() {
    let server = MockServer::start(vec![skill_page_response(), empty_bundles_response()]);
    let temp = temp_test_dir("bb-skills-list-session");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let storage_path = temp.join("auth-sessions.json");
    fs::create_dir_all(&bb_home).expect("create bb home");
    fs::write(
        bb_home.join("skills.yaml"),
        format!(
            "current_profile: local\nprofiles:\n  local:\n    server_url: {}\n    auth:\n      token: profile-token\n",
            server.base_url
        ),
    )
    .expect("write skills config");
    let storage_key =
        browser_auth_storage_key("local", &format!("{}/cash-app/goose", server.base_url));
    fs::write(
        &storage_path,
        serde_json::to_string_pretty(&json!({
            storage_key: {
                "sessionCredential": "stored-marketplace-session",
                "expiresAt": "2026-06-15T00:00:00Z"
            }
        }))
        .expect("serialize storage"),
    )
    .expect("write auth storage");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "list", "--json"])
        .output()
        .expect("run bb skills list");
    let requests = server.finish();
    let (_stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(requests.len(), 2);
    for request in requests {
        assert_eq!(
            request
                .headers
                .get("x-bb-session-credential")
                .map(String::as_str),
            Some("stored-marketplace-session")
        );
        assert!(!request.headers.contains_key("authorization"));
    }
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_local_dev_discovers_checked_in_config_from_ancestor() {
    let server = MockServer::start(vec![MockResponse::json(json!({
        "target_registry": {
            "agents": {"kind": "filesystem"}
        }
    }))]);
    let server_base_url = server.base_url.clone();
    let temp = temp_test_dir("bb-local-dev-config");
    let child = temp.join("nested/project");
    fs::create_dir_all(&child).expect("create nested current dir");
    fs::write(
        temp.join("bb-local-dev-config.yaml"),
        "current_profile: local-dev\nprofiles:\n  local-dev:\n    skills_home: .bb/local-dev/skills\n",
    )
    .expect("write local dev config");

    let output = bb_command()
        .current_dir(&child)
        .env("KGOOSE_BASE_URL", &server_base_url)
        .args(["--local-dev", "skills", "doctor", "--json"])
        .output()
        .expect("run bb local dev doctor");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse doctor output");
    assert_eq!(response["local_dev"], json!(true));
    assert_eq!(response["profile"], json!("local-dev"));
    assert_eq!(response["kgoose_base_url"], json!(server_base_url));
    assert!(response["bb_skills_home"]
        .as_str()
        .expect("bb_skills_home string")
        .ends_with(".bb/local-dev/skills"));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(
        requests[0].path,
        "/cash-app/goose/v1/marketplace/capabilities"
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_env_playpen_adds_baggage_header() {
    let server = MockServer::start(vec![skill_page_response(), empty_bundles_response()]);

    let output = bb_command()
        .env("BB_KGOOSE_PLAYPEN", "baxen")
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "list", "--json"])
        .output()
        .expect("run bb skills list");
    let requests = server.finish();
    let (_stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].headers.get("baggage").map(String::as_str),
        Some("kgoose-builderbot-playpen=baxen")
    );
    assert_eq!(
        requests[1].headers.get("baggage").map(String::as_str),
        Some("kgoose-builderbot-playpen=baxen")
    );
}

#[test]
fn bb_auth_status_without_token_is_local_and_unauthenticated() {
    let temp = temp_test_dir("bb-auth-status");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("auth-sessions.json");
    write_bb_org_config(&bb_home, "test");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .args(["auth", "status", "--json"])
        .output()
        .expect("run bb auth status");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse status output");
    assert_eq!(response["authenticated"], json!(false));
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_auth_status_requires_org_in_json_mode() {
    let temp = temp_test_dir("bb-auth-status-missing-org");
    let bb_home = temp.join("bb-home");
    fs::create_dir_all(&bb_home).expect("create bb home");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .args(["auth", "status", "--json"])
        .output()
        .expect("run bb auth status");
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    let payload = parse_stderr_error(&stderr);
    assert_eq!(payload["error"]["code"], json!("org_required"));
    assert_eq!(payload["error"]["exit_code"], json!(3));
    assert!(
        payload["error"]["message"]
            .as_str()
            .expect("error message string")
            .contains("bb config set org <org>"),
        "stderr was: {stderr}"
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_auth_status_uses_org_routed_custom_base_url() {
    let temp = temp_test_dir("bb-auth-status-org-base");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("auth-sessions.json");
    write_bb_org_config(&bb_home, "test");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", "blockstaging.build")
        .args(["auth", "status", "--json"])
        .output()
        .expect("run bb auth status");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse status output");
    assert_eq!(response["authenticated"], json!(false));
    assert_eq!(
        response["kgoose_base_url"],
        json!("https://test.blockstaging.build")
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_auth_status_uses_auth_me_for_stored_file_session() {
    let temp = temp_test_dir("bb-auth-status-stored");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let storage_path = temp.join("auth-sessions.json");
    let server = MockServer::start(vec![MockResponse::json(json!({
        "authenticated": true,
        "subject": "auth0|user_123",
        "email": "test@example.com",
        "name": "Test User",
        "expiresAt": "2026-06-15T00:00:00Z"
    }))]);
    let storage_key =
        browser_auth_storage_key("default", &format!("{}/cash-app/goose", server.base_url));
    fs::write(
        &storage_path,
        serde_json::to_string_pretty(&json!({
            storage_key: {
                "sessionCredential": "stored-cli-session",
                "expiresAt": "2026-06-15T00:00:00Z"
            }
        }))
        .expect("serialize storage"),
    )
    .expect("write auth storage");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["auth", "status", "--json"])
        .output()
        .expect("run bb auth status");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse status output");
    assert_eq!(response["authenticated"], json!(true));
    assert_eq!(response["subject"], json!("auth0|user_123"));
    assert_eq!(response["email"], json!("test@example.com"));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/cash-app/goose/auth/me");
    assert_eq!(
        requests[0]
            .headers
            .get("x-bb-session-credential")
            .map(String::as_str),
        Some("stored-cli-session")
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_auth_login_uses_valid_stored_file_session() {
    let temp = temp_test_dir("bb-auth-login-stored");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let storage_path = temp.join("auth-sessions.json");
    let server = MockServer::start(vec![MockResponse::json(json!({
        "authenticated": true,
        "subject": "auth0|user_123",
        "email": "test@example.com",
        "name": "Test User",
        "expiresAt": "2026-06-15T00:00:00Z",
        "hasAccessToken": true,
        "hasRefreshToken": true
    }))]);
    let storage_key =
        browser_auth_storage_key("default", &format!("{}/cash-app/goose", server.base_url));
    fs::write(
        &storage_path,
        serde_json::to_string_pretty(&json!({
            storage_key: {
                "sessionCredential": "stored-cli-session",
                "expiresAt": "2026-06-15T00:00:00Z"
            }
        }))
        .expect("serialize storage"),
    )
    .expect("write auth storage");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["auth", "login", "--json"])
        .output()
        .expect("run bb auth login");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse login output");
    assert_eq!(response["source"], json!("stored"));
    assert_eq!(response["storage"], json!("file"));
    assert_eq!(response["subject"], json!("auth0|user_123"));
    assert_eq!(response["credentialPrefix"], Value::Null);
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/cash-app/goose/auth/me");
    assert_eq!(
        requests[0]
            .headers
            .get("x-bb-session-credential")
            .map(String::as_str),
        Some("stored-cli-session")
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_auth_login_env_playpen_adds_baggage_to_stored_session_check() {
    let temp = temp_test_dir("bb-auth-login-playpen");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let storage_path = temp.join("auth-sessions.json");
    let server = MockServer::start(vec![MockResponse::json(json!({
        "authenticated": true,
        "subject": "auth0|user_123",
        "email": "test@example.com",
        "name": "Test User",
        "expiresAt": "2026-06-15T00:00:00Z",
        "hasAccessToken": true,
        "hasRefreshToken": true
    }))]);
    let storage_key =
        browser_auth_storage_key("default", &format!("{}/cash-app/goose", server.base_url));
    fs::write(
        &storage_path,
        serde_json::to_string_pretty(&json!({
            storage_key: {
                "sessionCredential": "stored-cli-session",
                "expiresAt": "2026-06-15T00:00:00Z"
            }
        }))
        .expect("serialize storage"),
    )
    .expect("write auth storage");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("BB_KGOOSE_PLAYPEN", "baxen")
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["auth", "login", "--json"])
        .output()
        .expect("run bb auth login");
    let requests = server.finish();
    let (_stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, "/cash-app/goose/auth/me");
    assert_eq!(
        requests[0].headers.get("baggage").map(String::as_str),
        Some("kgoose-builderbot-playpen=baxen")
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_auth_logout_removes_stored_file_session() {
    let temp = temp_test_dir("bb-auth-logout");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let storage_path = temp.join("auth-sessions.json");
    let server = MockServer::start(vec![MockResponse::json(json!({}))]);
    let server_url = format!("{}/cash-app/goose", server.base_url);
    let default_key = browser_auth_storage_key("default", &server_url);
    let other_key = browser_auth_storage_key("other", &server_url);
    fs::write(
        &storage_path,
        serde_json::to_string_pretty(&json!({
            default_key: {
                "sessionCredential": "default-session",
                "expiresAt": "2026-06-15T00:00:00Z"
            },
            other_key: {
                "sessionCredential": "other-session",
                "expiresAt": "2026-06-15T00:00:00Z"
            }
        }))
        .expect("serialize storage"),
    )
    .expect("write auth storage");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["auth", "logout", "--json"])
        .output()
        .expect("run bb auth logout");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse logout output");
    assert_eq!(response["removed"], json!(true));
    assert_eq!(response["server_revoked"], json!(true));
    assert_eq!(response["storage"], json!("file"));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/cash-app/goose/auth/logout");
    assert_eq!(
        requests[0]
            .headers
            .get("x-bb-session-credential")
            .map(String::as_str),
        Some("default-session")
    );

    let storage = fs::read_to_string(&storage_path).expect("read storage");
    assert!(!storage.contains("default-session"));
    assert!(storage.contains("other-session"));

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", "http://127.0.0.1:9")
        .args(["auth", "logout", "--json"])
        .output()
        .expect("run bb auth logout again");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse logout output");
    assert_eq!(response["removed"], json!(false));
    assert_eq!(response["server_revoked"], json!(false));

    fs::remove_dir_all(temp).expect("remove temp dir");
}

fn browser_auth_storage_key(profile: &str, server_url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(profile.as_bytes());
    hasher.update([0]);
    hasher.update(server_url.trim_end_matches('/').as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn bb_config_set_and_get_roundtrip() {
    let temp = temp_test_dir("bb-config-prefs");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let skills_home = temp.join("skills-home");

    let set = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", skills_home.join("packages"))
        .args(["config", "set", "channel", "beta", "--json"])
        .output()
        .expect("run bb config set");
    let (set_stdout, set_stderr) = output_text(&set);
    assert!(set.status.success(), "stderr was: {set_stderr}");
    let set_response = serde_json::from_str::<Value>(&set_stdout).expect("parse set output");
    assert_eq!(set_response["updated"], json!("channel"));

    let get = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", skills_home.join("packages"))
        .args(["config", "get", "channel", "--json"])
        .output()
        .expect("run bb config get");
    let (get_stdout, get_stderr) = output_text(&get);
    assert!(get.status.success(), "stderr was: {get_stderr}");
    let get_response = serde_json::from_str::<Value>(&get_stdout).expect("parse get output");
    assert_eq!(get_response["channel"], json!("beta"));

    let set_org = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", skills_home.join("packages"))
        .args(["config", "set", "org", " Test-Org ", "--json"])
        .output()
        .expect("run bb config set org");
    let (_set_org_stdout, set_org_stderr) = output_text(&set_org);
    assert!(set_org.status.success(), "stderr was: {set_org_stderr}");

    let get_org = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", skills_home.join("packages"))
        .args(["config", "get", "org", "--json"])
        .output()
        .expect("run bb config get org");
    let (get_org_stdout, get_org_stderr) = output_text(&get_org);
    assert!(get_org.status.success(), "stderr was: {get_org_stderr}");
    let get_org_response =
        serde_json::from_str::<Value>(&get_org_stdout).expect("parse get org output");
    assert_eq!(get_org_response["org"], json!("test-org"));
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_config_set_org_repairs_invalid_existing_org() {
    let temp = temp_test_dir("bb-config-repair-org");
    let bb_home = temp.join("bb-home");
    fs::create_dir_all(&bb_home).expect("create bb home");
    fs::write(bb_home.join("config.yaml"), "org: bad_org\n").expect("write invalid config");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .args(["config", "set", "org", "Test-Org", "--json"])
        .output()
        .expect("run bb config set org");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse set org output");
    assert_eq!(response["updated"], json!("org"));

    let saved = fs::read_to_string(bb_home.join("config.yaml")).expect("read repaired config");
    assert!(saved.contains("org: test-org"), "saved config was: {saved}");
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_auth_is_removed_but_config_alias_still_works() {
    let temp = temp_test_dir("bb-skills-alias");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let skills_home = temp.join("skills-home");

    let status = bb_command()
        .env("BB_HOME", &bb_home)
        .args(["skills", "auth", "status", "--json"])
        .output()
        .expect("run bb skills auth status");
    let (_, status_stderr) = output_text(&status);
    assert!(!status.status.success());
    assert!(
        status_stderr.contains("unrecognized subcommand 'auth'"),
        "stderr was: {status_stderr}"
    );

    let get = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", skills_home.join("packages"))
        .args(["skills", "config", "get", "channel", "--json"])
        .output()
        .expect("run bb skills config get");
    let (get_stdout, get_stderr) = output_text(&get);
    assert!(get.status.success(), "stderr was: {get_stderr}");
    let get_response = serde_json::from_str::<Value>(&get_stdout).expect("parse get output");
    assert_eq!(get_response["channel"], json!("stable"));
    fs::remove_dir_all(temp).expect("remove temp dir");
}

// ---------------------------------------------------------------------------
// error envelopes

#[test]
fn bb_skills_list_surfaces_marketplace_error_envelope() {
    let server = MockServer::start(vec![marketplace_error_response(
        404,
        "skill_not_found",
        "Skill was not found.",
        "req_list_123",
    )]);

    let output = bb_command()
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "list"])
        .output()
        .expect("run bb skills list");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    assert!(
        stderr.contains("Skill was not found. (skill_not_found)"),
        "stderr was: {stderr}"
    );
    assert!(
        stderr.contains("request_id: req_list_123"),
        "stderr was: {stderr}"
    );
    assert!(
        stderr.contains(
            "details: skills/builderbot-tools/SKILL.md.description: description is required"
        ),
        "stderr was: {stderr}"
    );
}

#[test]
fn bb_skills_list_json_errors_are_structured() {
    let server = MockServer::start(vec![marketplace_error_response(
        404,
        "skill_not_found",
        "Skill was not found.",
        "req_list_123",
    )]);

    let output = bb_command()
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "list", "--json"])
        .output()
        .expect("run bb skills list");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    let payload = parse_stderr_error(&stderr);
    assert_eq!(payload["error"]["code"], json!("skill_not_found"));
    assert!(
        payload["error"]["message"]
            .as_str()
            .expect("error message string")
            .contains("Skill was not found."),
        "stderr was: {stderr}"
    );
    assert_eq!(payload["error"]["exit_code"], json!(1));
    assert_eq!(output.status.code(), Some(1));
}

// ---------------------------------------------------------------------------
// install

#[test]
fn bb_skills_install_downloads_verifies_and_installs_into_isolated_home() {
    let zip_bytes = skill_zip(&[
        ("SKILL.md", "# BuilderBot Tools\n"),
        ("SETUP.md", "No setup.\n"),
    ]);
    let artifact_sha = sha256_hex(&zip_bytes);
    let temp = temp_test_dir("bb-skills-install");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let skills_home = temp.join("skills-home");
    let agents_dir = temp.join("agents-skills");
    let server = MockServer::start(vec![
        capabilities_response(&agents_dir),
        MockResponse::json(marketplace_install_plan(
            &zip_bytes,
            &artifact_sha,
            zip_bytes.len(),
        )),
        skill_detail_response(),
        artifact_response(zip_bytes, &artifact_sha),
    ]);

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", skills_home.join("packages"))
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "skills",
            "install",
            "builderbot-tools",
            "--target",
            "agents",
            "--yes",
            "--json",
        ])
        .output()
        .expect("run bb skills install");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse install output");
    assert_eq!(response["installed"][0]["slug"], json!("builderbot-tools"));
    assert_eq!(
        response["installed"][0]["targets"],
        json!(["agents"]),
        "stdout was: {stdout}"
    );

    // Canonical package + metadata.
    let package = skills_home.join("packages/builderbot-tools");
    assert!(package.join("SKILL.md").is_file());
    let metadata = serde_json::from_slice::<Value>(
        &fs::read(package.join(".bb-skills-meta.json")).expect("read metadata"),
    )
    .expect("parse metadata");
    assert_eq!(metadata["slug"], json!("builderbot-tools"));
    assert_eq!(metadata["local_source"], json!(false));
    assert_eq!(metadata["source_id"], json!("src_builtin_builderbot"));

    // Link into the registry-provided agents directory.
    let link = agents_dir.join("builderbot-tools");
    assert!(
        link.join("SKILL.md").is_file(),
        "expected link at {}",
        link.display()
    );
    #[cfg(unix)]
    assert!(fs::symlink_metadata(&link)
        .expect("link metadata")
        .file_type()
        .is_symlink());

    // Downloaded artifact is kept for provenance.
    let downloads = fs::read_dir(skills_home.join("downloads"))
        .expect("read downloads dir")
        .filter_map(|entry| entry.ok())
        .collect::<Vec<_>>();
    assert_eq!(downloads.len(), 1, "expected one persisted artifact");

    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(
        requests[0].path,
        "/cash-app/goose/v1/marketplace/capabilities"
    );
    assert_eq!(requests[1].method, "POST");
    assert_eq!(
        requests[1].path,
        "/cash-app/goose/v1/marketplace/install-plan"
    );
    assert_eq!(
        requests[1].body["targets"][0]["slug"],
        json!("builderbot-tools")
    );
    assert_eq!(
        requests[1].body["client"]["install_targets"],
        json!(["agents"])
    );
    assert_eq!(requests[2].method, "GET");
    assert_eq!(
        requests[2].path,
        "/cash-app/goose/v1/marketplace/skills/builderbot-tools"
    );
    assert_eq!(requests[3].method, "GET");
    assert_eq!(
        requests[3].path,
        "/cash-app/goose/v1/marketplace/artifacts/art_builderbot_tools/download"
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

/// The default layout: the canonical packages dir IS the agents target dir,
/// so the agents entry is the real package (no self-link) and other flows
/// (remove) treat it as the package, not a link.
#[test]
fn bb_skills_install_canonical_agents_dir_holds_real_package() {
    let zip_bytes = skill_zip(&[("SKILL.md", "# BuilderBot Tools\n")]);
    let artifact_sha = sha256_hex(&zip_bytes);
    let temp = temp_test_dir("bb-skills-install-canonical");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let skills_home = temp.join("skills-home");
    let agents_dir = temp.join("agents-skills");
    let server = MockServer::start(vec![
        capabilities_response(&agents_dir),
        MockResponse::json(marketplace_install_plan(
            &zip_bytes,
            &artifact_sha,
            zip_bytes.len(),
        )),
        skill_detail_response(),
        artifact_response(zip_bytes, &artifact_sha),
    ]);

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        // Canonical packages dir == the registry's agents directory, like the
        // real default (`~/.agents/skills`).
        .env("BB_SKILLS_PACKAGES_DIR", &agents_dir)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "skills",
            "install",
            "builderbot-tools",
            "--target",
            "agents",
            "--yes",
            "--json",
        ])
        .output()
        .expect("run bb skills install");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse install output");
    assert_eq!(
        response["installed"][0]["links"][0]["strategy"],
        json!("existing"),
        "stdout was: {stdout}"
    );

    // The agents entry is the real package directory, not a symlink.
    let package = agents_dir.join("builderbot-tools");
    assert!(package.join("SKILL.md").is_file());
    assert!(package.join(".bb-skills-meta.json").is_file());
    assert!(!fs::symlink_metadata(&package)
        .expect("package metadata")
        .file_type()
        .is_symlink());

    // Remove treats the entry as the package (offline via cached registry).
    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", &agents_dir)
        .env("KGOOSE_BASE_URL", "http://127.0.0.1:9")
        .args(["skills", "remove", "builderbot-tools", "--yes", "--json"])
        .output()
        .expect("run bb skills remove");
    let (stdout, stderr) = output_text(&output);
    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse remove output");
    assert_eq!(response["removed_package"], json!(true));
    assert!(!package.exists());
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_install_surfaces_install_plan_error_envelope() {
    let temp = temp_test_dir("bb-skills-install-plan-error");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let agents_dir = temp.join("agents-skills");
    let server = MockServer::start(vec![
        capabilities_response(&agents_dir),
        marketplace_error_response(
            422,
            "validation_failed",
            "Install plan could not be created.",
            "req_plan_123",
        ),
    ]);

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", temp.join("skills-home"))
        .env("BB_SKILLS_PACKAGES_DIR", temp.join("skills-home/packages"))
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "skills",
            "install",
            "builderbot-tools",
            "--target",
            "agents",
            "--yes",
            "--json",
        ])
        .output()
        .expect("run bb skills install");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    let payload = parse_stderr_error(&stderr);
    assert_eq!(payload["error"]["code"], json!("validation_failed"));
    assert_eq!(payload["error"]["exit_code"], json!(6));
    assert_eq!(output.status.code(), Some(6));
    assert_eq!(
        requests.len(),
        2,
        "should not request artifact after plan failure"
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_install_surfaces_artifact_error_envelope() {
    let zip_bytes = skill_zip(&[("SKILL.md", "# BuilderBot Tools\n")]);
    let artifact_sha = sha256_hex(&zip_bytes);
    let temp = temp_test_dir("bb-skills-artifact-error");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let agents_dir = temp.join("agents-skills");
    let server = MockServer::start(vec![
        capabilities_response(&agents_dir),
        MockResponse::json(marketplace_install_plan(
            &zip_bytes,
            &artifact_sha,
            zip_bytes.len(),
        )),
        skill_detail_response(),
        marketplace_error_response(
            403,
            "artifact_plan_forbidden",
            "Artifact is not authorized by this install plan.",
            "req_artifact_123",
        ),
    ]);

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", temp.join("skills-home"))
        .env("BB_SKILLS_PACKAGES_DIR", temp.join("skills-home/packages"))
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "skills",
            "install",
            "builderbot-tools",
            "--target",
            "agents",
            "--yes",
            "--json",
        ])
        .output()
        .expect("run bb skills install");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    let payload = parse_stderr_error(&stderr);
    assert_eq!(payload["error"]["code"], json!("artifact_plan_forbidden"));
    assert_eq!(payload["error"]["exit_code"], json!(4));
    assert_eq!(output.status.code(), Some(4));
    assert_eq!(requests.len(), 4);
    assert!(!temp.join("skills-home/packages/builderbot-tools").exists());
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_install_refuses_checksum_mismatch() {
    let good_zip = skill_zip(&[("SKILL.md", "# BuilderBot Tools\n")]);
    let bad_zip = skill_zip(&[("SKILL.md", "# Tampered\n")]);
    let artifact_sha = sha256_hex(&good_zip);
    let temp = temp_test_dir("bb-skills-checksum");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let agents_dir = temp.join("agents-skills");
    let server = MockServer::start(vec![
        capabilities_response(&agents_dir),
        MockResponse::json(marketplace_install_plan(
            &good_zip,
            &artifact_sha,
            bad_zip.len(),
        )),
        skill_detail_response(),
        artifact_response(bad_zip, &artifact_sha),
    ]);

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", temp.join("skills-home"))
        .env("BB_SKILLS_PACKAGES_DIR", temp.join("skills-home/packages"))
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "skills",
            "install",
            "builderbot-tools",
            "--target",
            "agents",
            "--yes",
            "--json",
        ])
        .output()
        .expect("run bb skills install");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    let payload = parse_stderr_error(&stderr);
    assert_eq!(
        payload["error"]["code"],
        json!("artifact_checksum_mismatch")
    );
    assert_eq!(payload["error"]["exit_code"], json!(8));
    assert_eq!(output.status.code(), Some(8));
    assert!(!temp.join("skills-home/packages/builderbot-tools").exists());
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_install_refuses_unsafe_zip_paths() {
    let zip_bytes = skill_zip(&[
        ("SKILL.md", "# BuilderBot Tools\n"),
        ("../escape.md", "nope\n"),
    ]);
    let artifact_sha = sha256_hex(&zip_bytes);
    let temp = temp_test_dir("bb-skills-path-safety");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let agents_dir = temp.join("agents-skills");
    let server = MockServer::start(vec![
        capabilities_response(&agents_dir),
        MockResponse::json(marketplace_install_plan(
            &zip_bytes,
            &artifact_sha,
            zip_bytes.len(),
        )),
        skill_detail_response(),
        artifact_response(zip_bytes, &artifact_sha),
    ]);

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", temp.join("skills-home"))
        .env("BB_SKILLS_PACKAGES_DIR", temp.join("skills-home/packages"))
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "skills",
            "install",
            "builderbot-tools",
            "--target",
            "agents",
            "--yes",
            "--json",
        ])
        .output()
        .expect("run bb skills install");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    let payload = parse_stderr_error(&stderr);
    assert!(
        payload["error"]["message"]
            .as_str()
            .expect("error message string")
            .contains("unsafe zip entry"),
        "stderr was: {stderr}"
    );
    assert!(!temp.join("escape.md").exists());
    assert!(!temp.join("skills-home/packages/builderbot-tools").exists());
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_install_refuses_unmanaged_package_overwrite() {
    let zip_bytes = skill_zip(&[("SKILL.md", "# BuilderBot Tools\n")]);
    let artifact_sha = sha256_hex(&zip_bytes);
    let temp = temp_test_dir("bb-skills-unmanaged");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let agents_dir = temp.join("agents-skills");
    let server = MockServer::start(vec![
        capabilities_response(&agents_dir),
        MockResponse::json(marketplace_install_plan(
            &zip_bytes,
            &artifact_sha,
            zip_bytes.len(),
        )),
    ]);
    let unmanaged = temp.join("skills-home/packages/builderbot-tools");
    fs::create_dir_all(&unmanaged).expect("create unmanaged package");
    fs::write(unmanaged.join("SKILL.md"), "user file").expect("write unmanaged skill");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", temp.join("skills-home"))
        .env("BB_SKILLS_PACKAGES_DIR", temp.join("skills-home/packages"))
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "skills",
            "install",
            "builderbot-tools",
            "--target",
            "agents",
            "--yes",
            "--json",
        ])
        .output()
        .expect("run bb skills install");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    let payload = parse_stderr_error(&stderr);
    assert_eq!(payload["error"]["code"], json!("unmanaged_package_dir"));
    assert_eq!(payload["error"]["exit_code"], json!(7));
    assert!(
        payload["error"]["message"]
            .as_str()
            .expect("error message string")
            .contains("refusing to overwrite"),
        "stderr was: {stderr}"
    );
    assert_eq!(output.status.code(), Some(7));
    assert_eq!(
        fs::read_to_string(unmanaged.join("SKILL.md")).expect("read unmanaged skill"),
        "user file"
    );
    assert_eq!(requests.len(), 2, "should fail before artifact download");
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_install_rejects_unresolvable_version_pin() {
    let zip_bytes = skill_zip(&[("SKILL.md", "# BuilderBot Tools\n")]);
    let artifact_sha = sha256_hex(&zip_bytes);
    let temp = temp_test_dir("bb-skills-version-pin");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let agents_dir = temp.join("agents-skills");
    let server = MockServer::start(vec![
        capabilities_response(&agents_dir),
        MockResponse::json(marketplace_install_plan(
            &zip_bytes,
            &artifact_sha,
            zip_bytes.len(),
        )),
    ]);

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", temp.join("skills-home"))
        .env("BB_SKILLS_PACKAGES_DIR", temp.join("skills-home/packages"))
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "skills",
            "install",
            "builderbot-tools",
            "--version",
            "ver_older_pin",
            "--target",
            "agents",
            "--yes",
            "--json",
        ])
        .output()
        .expect("run bb skills install");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    let payload = parse_stderr_error(&stderr);
    assert_eq!(payload["error"]["code"], json!("version_pin_unresolved"));
    assert_eq!(payload["error"]["exit_code"], json!(6));
    assert_eq!(output.status.code(), Some(6));
    assert_eq!(requests.len(), 2, "should stop after plan resolution");
    assert!(!temp.join("skills-home/packages/builderbot-tools").exists());
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_install_local_path_installs_without_marketplace() {
    let temp = temp_test_dir("bb-skills-local-path");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let agents_dir = temp.join("agents-skills");
    let server = MockServer::start(vec![capabilities_response(&agents_dir)]);
    let source = temp.join("local-skill");
    fs::create_dir_all(&source).expect("create local skill dir");
    fs::write(source.join("SKILL.md"), "# Local Skill\n").expect("write local SKILL.md");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", temp.join("skills-home"))
        .env("BB_SKILLS_PACKAGES_DIR", temp.join("skills-home/packages"))
        .current_dir(&temp)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "skills",
            "install",
            "./local-skill",
            "--target",
            "agents",
            "--yes",
            "--json",
        ])
        .output()
        .expect("run bb skills install local path");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse install output");
    assert_eq!(response["installed"][0]["slug"], json!("local-skill"));

    let package = temp.join("skills-home/packages/local-skill");
    assert!(package.join("SKILL.md").is_file());
    let metadata = serde_json::from_slice::<Value>(
        &fs::read(package.join(".bb-skills-meta.json")).expect("read metadata"),
    )
    .expect("parse metadata");
    assert_eq!(metadata["local_source"], json!(true));
    assert!(agents_dir.join("local-skill/SKILL.md").is_file());
    assert_eq!(
        requests.len(),
        1,
        "local installs should only fetch capabilities"
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

// ---------------------------------------------------------------------------
// update / installed / which / remove

#[test]
fn bb_skills_update_reports_up_to_date_skills() {
    let temp = temp_test_dir("bb-skills-update-noop");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let skills_home = temp.join("skills-home");
    let agents_dir = temp.join("agents-skills");
    write_installed_package(&skills_home, "builderbot-tools", "content-sha", &["agents"]);
    let server = MockServer::start(vec![
        capabilities_response(&agents_dir),
        noop_plan_response(),
    ]);

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", skills_home.join("packages"))
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "update", "--yes", "--json"])
        .output()
        .expect("run bb skills update");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse update output");
    assert_eq!(response["up_to_date"], json!(["builderbot-tools"]));
    assert_eq!(response["installed"], json!([]));
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].path,
        "/cash-app/goose/v1/marketplace/install-plan"
    );
    assert_eq!(
        requests[1].body["installed"][0]["slug"],
        json!("builderbot-tools")
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_installed_reports_update_availability() {
    let temp = temp_test_dir("bb-skills-installed");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let skills_home = temp.join("skills-home");
    write_installed_package(&skills_home, "builderbot-tools", "content-sha", &["agents"]);
    let server = MockServer::start(vec![skill_page_response()]);

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", skills_home.join("packages"))
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["skills", "installed", "--json"])
        .output()
        .expect("run bb skills installed");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse installed output");
    assert_eq!(response["items"][0]["slug"], json!("builderbot-tools"));
    // Local content sha matches the marketplace's latest -> no update pending.
    assert_eq!(response["items"][0]["update_available"], json!(false));
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].path,
        "/cash-app/goose/v1/marketplace/skills?limit=5000"
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[cfg(unix)]
#[test]
fn bb_skills_which_reports_link_state() {
    let temp = temp_test_dir("bb-skills-which");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let skills_home = temp.join("skills-home");
    let agents_dir = temp.join("agents-skills");
    write_installed_package(&skills_home, "builderbot-tools", "content-sha", &["agents"]);
    write_capabilities_cache(&skills_home, &agents_dir);
    fs::create_dir_all(&agents_dir).expect("create agents dir");
    std::os::unix::fs::symlink(
        skills_home.join("packages/builderbot-tools"),
        agents_dir.join("builderbot-tools"),
    )
    .expect("create target link");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", skills_home.join("packages"))
        .env("KGOOSE_BASE_URL", "http://127.0.0.1:9")
        .args(["skills", "which", "builderbot-tools", "--json"])
        .output()
        .expect("run bb skills which");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse which output");
    assert_eq!(response["slug"], json!("builderbot-tools"));
    assert_eq!(response["links"][0]["target"], json!("agents"));
    assert_eq!(response["links"][0]["state"], json!("ok"));
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[cfg(unix)]
#[test]
fn bb_skills_remove_deletes_links_and_package() {
    let temp = temp_test_dir("bb-skills-remove");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let skills_home = temp.join("skills-home");
    let agents_dir = temp.join("agents-skills");
    write_installed_package(&skills_home, "builderbot-tools", "content-sha", &["agents"]);
    write_capabilities_cache(&skills_home, &agents_dir);
    fs::create_dir_all(&agents_dir).expect("create agents dir");
    std::os::unix::fs::symlink(
        skills_home.join("packages/builderbot-tools"),
        agents_dir.join("builderbot-tools"),
    )
    .expect("create target link");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", skills_home.join("packages"))
        .env("KGOOSE_BASE_URL", "http://127.0.0.1:9")
        .args(["skills", "remove", "builderbot-tools", "--yes", "--json"])
        .output()
        .expect("run bb skills remove");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse remove output");
    assert_eq!(response["removed_package"], json!(true));
    assert!(!skills_home.join("packages/builderbot-tools").exists());
    assert!(
        fs::symlink_metadata(agents_dir.join("builderbot-tools")).is_err(),
        "target link should be removed"
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

// ---------------------------------------------------------------------------
// doctor

#[test]
fn bb_skills_doctor_offline_reports_server_failure() {
    let temp = temp_test_dir("bb-skills-doctor-offline");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", temp.join("skills-home"))
        .env("BB_SKILLS_PACKAGES_DIR", temp.join("skills-home/packages"))
        .env("KGOOSE_BASE_URL", "http://127.0.0.1:9")
        .args(["skills", "doctor", "--json"])
        .output()
        .expect("run bb skills doctor");
    let (stdout, stderr) = output_text(&output);

    // Doctor reports problems instead of failing outright.
    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse doctor output");
    assert_eq!(response["ok"], json!(false));
    let checks = response["checks"].as_array().expect("checks array");
    let server_check = checks
        .iter()
        .find(|check| check["name"] == json!("server"))
        .expect("server check present");
    assert_eq!(server_check["status"], json!("fail"));
    fs::remove_dir_all(temp).expect("remove temp dir");
}

// ---------------------------------------------------------------------------
// bb tools passthrough

#[test]
fn bb_tools_help_surfaces_schema_derived_flags() {
    let server = MockServer::start(vec![list_tools_response(
        "utils",
        calculate_tool_schema(true),
    )]);

    let output = server
        .bb_tools_command()
        .args(["utils", "calculate", "--help"])
        .output()
        .expect("run bb tools help");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(stdout.contains("Usage: bb tools utils calculate"));
    assert!(stdout.contains("--numbers <NUMBER>"));
    assert!(stdout.contains("--operation <TEXT>"));
    assert!(stdout.contains("--round-up"));
    assert!(stdout.contains("--no-round-up"));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, BB_TOOLS_LIST_TOOLS_PATH);
    assert_eq!(requests[0].body["extension_name"], json!("utils"));
}

#[test]
fn bb_tools_forwards_stored_session_credential_to_kgoose_calls() {
    let server = MockServer::start(vec![
        list_tools_response("utils", calculate_tool_schema(false)),
        MockResponse::json(json!({
            "content": [{"text": {"text": "{\"sum\":5}"}}],
            "is_error": false
        })),
    ]);
    let temp = temp_test_dir("bb-tools-session");
    let storage_path = temp.join("auth-sessions.json");
    let storage_key =
        browser_auth_storage_key("default", &format!("{}/cash-app/goose", server.base_url));
    fs::write(
        &storage_path,
        serde_json::to_string_pretty(&json!({
            storage_key: {
                "sessionCredential": "stored-bb-tools-session",
                "expiresAt": "2026-06-15T00:00:00Z"
            }
        }))
        .expect("serialize storage"),
    )
    .expect("write auth storage");

    let output = server
        .bb_tools_command()
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .args([
            "utils",
            "calculate",
            "--numbers",
            "2",
            "3",
            "--operation",
            "add",
        ])
        .output()
        .expect("run bb tools tool");
    let requests = server.finish();
    let (_stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]
            .headers
            .get("x-bb-session-credential")
            .map(String::as_str),
        Some("stored-bb-tools-session")
    );
    assert_eq!(
        requests[1]
            .headers
            .get("x-bb-session-credential")
            .map(String::as_str),
        Some("stored-bb-tools-session")
    );
    assert_eq!(requests[0].path, BB_TOOLS_LIST_TOOLS_PATH);
    assert_eq!(requests[1].path, BB_TOOLS_CALL_TOOL_PATH);
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_tools_resolves_session_credential_from_current_profile() {
    let server = MockServer::start(vec![
        list_tools_response("utils", calculate_tool_schema(false)),
        MockResponse::json(json!({
            "content": [{"text": {"text": "{\"sum\":5}"}}],
            "is_error": false
        })),
    ]);
    let temp = temp_test_dir("bb-tools-current-profile-session");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    fs::write(
        bb_home.join("skills.yaml"),
        "current_profile: local\nprofiles:\n  local: {}\n",
    )
    .expect("write skills config");
    let storage_path = temp.join("auth-sessions.json");
    let storage_key =
        browser_auth_storage_key("local", &format!("{}/cash-app/goose", server.base_url));
    fs::write(
        &storage_path,
        serde_json::to_string_pretty(&json!({
            storage_key: {
                "sessionCredential": "stored-current-profile-session",
                "expiresAt": "2026-06-15T00:00:00Z"
            }
        }))
        .expect("serialize storage"),
    )
    .expect("write auth storage");

    let output = server
        .bb_tools_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .args([
            "utils",
            "calculate",
            "--numbers",
            "2",
            "3",
            "--operation",
            "add",
        ])
        .output()
        .expect("run bb tools tool");
    let requests = server.finish();
    let (_stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]
            .headers
            .get("x-bb-session-credential")
            .map(String::as_str),
        Some("stored-current-profile-session")
    );
    assert_eq!(
        requests[1]
            .headers
            .get("x-bb-session-credential")
            .map(String::as_str),
        Some("stored-current-profile-session")
    );
    assert_eq!(requests[0].path, BB_TOOLS_LIST_TOOLS_PATH);
    assert_eq!(requests[1].path, BB_TOOLS_CALL_TOOL_PATH);
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[cfg(unix)]
#[test]
fn bb_tools_root_metadata_commands_do_not_read_auth_storage() {
    let temp = temp_test_dir("bb-tools-metadata-auth-storage");
    let malformed_storage = temp.join("auth-sessions.json");
    fs::write(&malformed_storage, "not json").expect("write malformed auth storage");

    for args in [
        vec!["--version"],
        vec!["--summary"],
        vec!["--describe-commands"],
    ] {
        let server = MockServer::start(vec![]);
        let output = server
            .bb_tools_command()
            .env("BB_AUTH_STORAGE", "file")
            .env("BB_AUTH_STORAGE_FILE", &malformed_storage)
            .args(args)
            .output()
            .expect("run bb tools metadata command");
        let requests = server.finish();
        let (_stdout, stderr) = output_text(&output);

        assert!(output.status.success(), "stderr was: {stderr}");
        assert!(requests.is_empty(), "requests were: {requests:#?}");
    }

    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_tools_describe_commands_uses_static_catalog_without_network() {
    let server = MockServer::start(vec![]);
    let catalog_path = write_extensions_catalog(
        "bb-tools-describe-commands",
        r#"
- name: secret
  about: Needs more auth
- name: utils
  about: Utility helpers
"#,
    );

    let output = server
        .bb_tools_command()
        .env("KGOOSE_EXTENSIONS_CATALOG", &catalog_path)
        .arg("--describe-commands")
        .output()
        .expect("run bb tools describe-commands");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);
    fs::remove_file(&catalog_path).expect("remove extensions catalog");

    assert!(output.status.success(), "stderr was: {stderr}");
    let description = serde_json::from_str::<Value>(&stdout).expect("parse describe output");
    assert_eq!(description["name"], json!("tools"));
    assert_eq!(
        description["commands"],
        json!([
            {
                "name": "appkit",
                "summary": "Block App Kit CLI (local exec)"
            },
            {
                "name": "secret",
                "summary": "Needs more auth"
            },
            {
                "name": "utils",
                "summary": "Utility helpers"
            }
        ])
    );
    assert!(stderr.is_empty(), "stderr was: {stderr}");
    assert!(requests.is_empty(), "requests were: {requests:#?}");
}
