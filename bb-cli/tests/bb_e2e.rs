//! End-to-end tests for the `bb` binary (skills marketplace + bb-specific
//! surfaces). The sq/agent-tools CLI suite lives in `cli_e2e.rs`; shared mock
//! server infrastructure lives in `common/`.
mod common;

use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::thread;
use std::time::{Duration, Instant};

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

fn agent_document(name: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: Writes release notes.\n---\n{body}\n")
}

fn marketplace_agent_version(slug: &str, version_id: &str, content_sha256: &str) -> Value {
    json!({
        "id": version_id,
        "slug": slug,
        "name": "Release Notes",
        "status": "stable",
        "content_sha256": content_sha256,
        "artifact": {
            "id": format!("art_{version_id}"),
            "sha256": "read-artifact-sha",
            "size_bytes": 1,
            "media_type": "application/zip"
        },
        "source": {
            "source_id": "src_builtin_agents",
            "snapshot_id": "snap_123",
            "revision": "main@abc123",
            "path": "agents/release-notes.md"
        },
        "created_at": "2026-07-29T00:00:00Z"
    })
}

fn marketplace_agent_detail(slug: &str, version_id: &str, content_sha256: &str) -> Value {
    json!({
        "slug": slug,
        "name": "Release Notes",
        "description": "Writes release notes.",
        "status": "stable",
        "enabled": true,
        "latest_version_id": version_id,
        "latest_content_sha256": content_sha256,
        "source_id": "src_builtin_agents",
        "source_revision": "main@abc123",
        "source_path": "agents/release-notes.md",
        "tags": ["release"],
        "latest_version": marketplace_agent_version(slug, version_id, content_sha256),
        "versions": [{
            "id": version_id,
            "status": "stable",
            "content_sha256": content_sha256,
            "created_at": "2026-07-29T00:00:00Z"
        }]
    })
}

fn marketplace_agent_summary(slug: &str, version_id: &str, content_sha256: &str) -> Value {
    let mut summary = marketplace_agent_detail(slug, version_id, content_sha256);
    let fields = summary.as_object_mut().expect("agent detail object");
    fields.remove("latest_version");
    fields.remove("versions");
    summary
}

fn agent_install_plan(
    slug: &str,
    version_id: &str,
    content_sha256: &str,
    action: &str,
    artifact: Option<Value>,
) -> MockResponse {
    MockResponse::json(json!({
        "operations": [{
            "action": action,
            "reason": if action == "noop" { "Already at the requested version." } else { "Install marketplace agent." },
            "kind": "agent",
            "skill": {
                "slug": slug,
                "version_id": version_id,
                "content_sha256": content_sha256
            },
            "artifact": artifact,
            "installed_via": "explicit"
        }]
    }))
}

fn agent_artifact(slug: &str, version_id: &str, bytes: Vec<u8>) -> (Value, MockResponse) {
    let sha256 = sha256_hex(&bytes);
    (
        json!({
            "id": format!("art_{version_id}"),
            "download_url": format!("/v1/marketplace/artifacts/{slug}-{version_id}/download"),
            "sha256": sha256,
            "size_bytes": bytes.len(),
            "media_type": "application/zip"
        }),
        MockResponse::bytes(200, bytes, &[]),
    )
}

fn agent_target(home: &Path, slug: &str) -> PathBuf {
    home.join(".agents")
        .join("agents")
        .join(format!("{slug}.md"))
}

fn agent_state(bb_home: &Path, slug: &str) -> PathBuf {
    bb_home
        .join("agents")
        .join("installed")
        .join(format!("{slug}.json"))
}

fn managed_agent_metadata(slug: &str, document: &[u8]) -> Value {
    json!({
        "schema_version": "bb-agent-install/v1",
        "kind": "agent",
        "slug": slug,
        "version_id": "agent-v1",
        "content_sha256": "content-v1",
        "installed_file_sha256": sha256_hex(document),
        "artifact_id": "art_agent-v1",
        "artifact_sha256": "artifact-sha",
        "artifact_size_bytes": 42,
        "artifact_media_type": "application/zip",
        "source_id": "src_builtin_agents",
        "source_snapshot_id": "snap_123",
        "source_revision": "main@abc123",
        "source_path": format!("agents/{slug}.md"),
        "server_url": "http://example.test/api/goose",
        "installed_at": "2026-07-29T00:00:00Z",
        "installed_via": "explicit"
    })
}

fn write_managed_agent(bb_home: &Path, home: &Path, slug: &str, document: &[u8]) {
    let target = agent_target(home, slug);
    let state = agent_state(bb_home, slug);
    fs::create_dir_all(target.parent().expect("target parent")).expect("create target parent");
    fs::create_dir_all(state.parent().expect("state parent")).expect("create state parent");
    fs::write(&target, document).expect("write managed target");
    fs::write(
        &state,
        serde_json::to_vec(&managed_agent_metadata(slug, document)).expect("serialize state"),
    )
    .expect("write managed state");
}

fn snapshot_agent_target(path: &Path) -> (bool, bool, Option<Vec<u8>>) {
    let metadata = fs::symlink_metadata(path).expect("stat agent target");
    let file_type = metadata.file_type();
    let bytes = (file_type.is_file() || file_type.is_symlink())
        .then(|| fs::read(path).expect("read agent target"));
    (file_type.is_dir(), file_type.is_symlink(), bytes)
}

fn assert_agent_pair_unchanged(
    target: &Path,
    state: &Path,
    target_before: &(bool, bool, Option<Vec<u8>>),
    state_before: &Option<Vec<u8>>,
) {
    assert_eq!(snapshot_agent_target(target), *target_before);
    let state_after = fs::read(state).ok();
    assert_eq!(state_after, *state_before);
}

fn assert_agent_failure(
    output: &std::process::Output,
    target: &Path,
    state: &Path,
    target_before: &(bool, bool, Option<Vec<u8>>),
    state_before: &Option<Vec<u8>>,
    exit_code: i32,
    error_code: &str,
) {
    let (stdout, stderr) = output_text(output);
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    assert_eq!(
        output.status.code(),
        Some(exit_code),
        "stderr was: {stderr}"
    );
    let error = parse_stderr_error(&stderr);
    assert_eq!(error["error"]["code"], error_code);
    assert_eq!(error["error"]["exit_code"], exit_code);
    assert_agent_pair_unchanged(target, state, target_before, state_before);
}

#[test]
fn bb_agents_are_discoverable_and_install_requires_a_slug_without_network() {
    let output = bb_command().arg("--help").output().expect("run bb help");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(stdout.contains("agents"), "stdout was: {stdout}");

    let server = MockServer::start(vec![]);
    let output = bb_command()
        .env("KGOOSE_BASE_URL", &server.base_url)
        .arg("--describe-commands")
        .output()
        .expect("run bb describe-commands");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let description = serde_json::from_str::<Value>(&stdout).expect("parse describe output");
    let agents = description["commands"]
        .as_array()
        .expect("root commands array")
        .iter()
        .find(|command| command["name"] == "agents")
        .expect("agents command in public description");
    assert_eq!(
        agents["commands"]
            .as_array()
            .expect("agents commands array")
            .iter()
            .map(|command| command["name"].as_str().expect("command name"))
            .collect::<Vec<_>>(),
        [
            "list",
            "search",
            "show",
            "install",
            "update",
            "installed",
            "which",
            "remove",
        ]
    );
    assert!(requests.is_empty(), "requests were: {requests:#?}");

    let server = MockServer::start(vec![]);
    let bb_home = temp_test_dir("bb-agents-install-missing-slug");
    write_bb_org_config(&bb_home, "test");
    let mut before = fs::read_dir(&bb_home)
        .expect("read bb home before parsing")
        .map(|entry| entry.expect("read bb home entry").file_name())
        .collect::<Vec<_>>();
    before.sort();
    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["agents", "install"])
        .output()
        .expect("run bb agents install without slug");
    let requests = server.finish();
    let (_stdout, stderr) = output_text(&output);

    assert_eq!(output.status.code(), Some(2), "stderr was: {stderr}");
    assert!(stderr.contains("<slug>"), "stderr was: {stderr}");
    assert!(requests.is_empty(), "requests were: {requests:#?}");
    let mut after = fs::read_dir(&bb_home)
        .expect("read bb home after parsing")
        .map(|entry| entry.expect("read bb home entry").file_name())
        .collect::<Vec<_>>();
    after.sort();
    assert_eq!(
        after, before,
        "missing-slug parsing must not mutate BB_HOME"
    );
    fs::remove_dir_all(bb_home).expect("remove bb home");
}

#[test]
fn bb_agents_update_requires_a_managed_install() {
    let sandbox = temp_test_dir("bb-agents-update-absent");
    let bb_home = sandbox.join("bb-home");
    let home = sandbox.join("home");
    write_bb_org_config(&bb_home, "test");
    let server = MockServer::start(vec![]);

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("HOME", &home)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["agents", "update", "release-notes", "--json"])
        .output()
        .expect("run bb agents update");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(stdout.is_empty(), "stdout was: {stdout}");
    assert_eq!(output.status.code(), Some(1), "stderr was: {stderr}");
    let error = parse_stderr_error(&stderr);
    assert_eq!(error["error"]["code"], "not_installed");
    assert_eq!(error["error"]["exit_code"], 1);
    assert!(requests.is_empty(), "absent update must stay local");
    assert!(!agent_target(&home, "release-notes").exists());
    assert!(!agent_state(&bb_home, "release-notes").exists());

    fs::remove_dir_all(sandbox).expect("remove absent update sandbox");
}

#[test]
fn bb_agents_use_agent_routes_and_stable_catalog_output() {
    let server = MockServer::start(vec![MockResponse::json(json!({
        "items": [marketplace_agent_summary("release-notes", "agent-v1", "content-v1")],
        "next_cursor": null
    }))]);
    let output = bb_command()
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["agents", "list"])
        .output()
        .expect("run bb agents list");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(
        stdout.contains("release-notes Release Notes"),
        "stdout was: {stdout}"
    );
    assert!(stdout.contains("status: stable"), "stdout was: {stdout}");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(
        requests[0].path,
        "/api/goose/v1/marketplace/agents?limit=5000"
    );

    let server = MockServer::start(vec![MockResponse::json(json!({
        "items": [marketplace_agent_summary("release-notes", "agent-v1", "content-v1")],
        "next_cursor": null
    }))]);
    let output = bb_command()
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["agents", "search", "release notes", "--json"])
        .output()
        .expect("run bb agents search");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse search JSON");
    assert_eq!(response["items"][0]["slug"], "release-notes");
    assert_eq!(response["items"][0]["source"]["id"], "src_builtin_agents");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(
        requests[0].path,
        "/api/goose/v1/marketplace/agents?limit=5000&query=release%20notes"
    );

    let server = MockServer::start(vec![MockResponse::json(marketplace_agent_detail(
        "release-notes",
        "agent-v1",
        "content-v1",
    ))]);
    let output = bb_command()
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["agents", "show", "release-notes", "--json"])
        .output()
        .expect("run bb agents show");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse show JSON");
    assert_eq!(response["latest_version"]["id"], "agent-v1");
    assert_eq!(response["versions"][0]["content_sha256"], "content-v1");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(
        requests[0].path,
        "/api/goose/v1/marketplace/agents/release-notes"
    );
}

#[test]
fn bb_agents_lifecycle_is_idempotent_and_local_queries_stay_offline() {
    let sandbox = temp_test_dir("bb-agents-lifecycle");
    let bb_home = sandbox.join("bb-home");
    let home = sandbox.join("home");
    write_bb_org_config(&bb_home, "test");

    let v1_document = agent_document("Release Notes", "Write version one.");
    let v2_document = agent_document("Release Notes", "Write version two.");
    let (v1_artifact, v1_response) = agent_artifact(
        "release-notes",
        "agent-v1",
        skill_zip(&[("agent.md", &v1_document)]),
    );
    let (v2_artifact, v2_response) = agent_artifact(
        "release-notes",
        "agent-v2",
        skill_zip(&[("agent.md", &v2_document)]),
    );
    let server = MockServer::start(vec![
        MockResponse::json(marketplace_agent_detail(
            "release-notes",
            "agent-v1",
            "content-v1",
        )),
        agent_install_plan(
            "release-notes",
            "agent-v1",
            "content-v1",
            "install",
            Some(v1_artifact),
        ),
        MockResponse::json(marketplace_agent_version(
            "release-notes",
            "agent-v1",
            "content-v1",
        )),
        v1_response,
        MockResponse::json(marketplace_agent_detail(
            "release-notes",
            "agent-v2",
            "content-v2",
        )),
        agent_install_plan(
            "release-notes",
            "agent-v2",
            "content-v2",
            "update",
            Some(v2_artifact),
        ),
        MockResponse::json(marketplace_agent_version(
            "release-notes",
            "agent-v2",
            "content-v2",
        )),
        v2_response,
        MockResponse::json(marketplace_agent_detail(
            "release-notes",
            "agent-v2",
            "content-v2",
        )),
        agent_install_plan("release-notes", "agent-v2", "content-v2", "noop", None),
        MockResponse::json(marketplace_agent_version(
            "release-notes",
            "agent-v2",
            "content-v2",
        )),
    ]);

    let run = |arguments: &[&str]| {
        bb_command()
            .env("BB_HOME", &bb_home)
            .env("HOME", &home)
            .env("KGOOSE_BASE_URL", &server.base_url)
            .args(arguments)
            .output()
            .expect("run bb agents lifecycle command")
    };

    let install = run(&["agents", "install", "release-notes", "--json"]);
    let (stdout, stderr) = output_text(&install);
    assert!(install.status.success(), "stderr was: {stderr}");
    let install = serde_json::from_str::<Value>(&stdout).expect("parse install JSON");
    assert_eq!(install["status"], "installed");
    assert_eq!(install["version_id"], "agent-v1");
    assert_eq!(install["source"]["snapshot_id"], "snap_123");

    let update = run(&["agents", "update", "release-notes", "--json"]);
    let (stdout, stderr) = output_text(&update);
    assert!(update.status.success(), "stderr was: {stderr}");
    let update = serde_json::from_str::<Value>(&stdout).expect("parse update JSON");
    assert_eq!(update["status"], "updated");
    assert_eq!(update["version_id"], "agent-v2");

    let target = agent_target(&home, "release-notes");
    let state = agent_state(&bb_home, "release-notes");
    assert_eq!(
        fs::read(&target).expect("read installed agent"),
        v2_document.as_bytes()
    );
    let persisted = serde_json::from_slice::<Value>(&fs::read(&state).expect("read state"))
        .expect("parse persisted state");
    assert_eq!(persisted["schema_version"], "bb-agent-install/v1");
    assert_eq!(persisted["kind"], "agent");
    assert_eq!(persisted["slug"], "release-notes");
    assert_eq!(persisted["version_id"], "agent-v2");
    assert_eq!(persisted["content_sha256"], "content-v2");
    assert_eq!(
        persisted["installed_file_sha256"],
        sha256_hex(v2_document.as_bytes())
    );
    assert_eq!(persisted["artifact_id"], "art_agent-v2");
    assert_eq!(persisted["source_id"], "src_builtin_agents");
    assert_eq!(persisted["source_snapshot_id"], "snap_123");
    assert_eq!(persisted["source_revision"], "main@abc123");
    assert_eq!(persisted["source_path"], "agents/release-notes.md");
    let target_before_noop = fs::read(&target).expect("snapshot target before noop");
    let state_before_noop = fs::read(&state).expect("snapshot state before noop");
    let target_mtime_before_noop = fs::metadata(&target)
        .expect("stat target before noop")
        .modified()
        .expect("read target mtime before noop");
    let state_mtime_before_noop = fs::metadata(&state)
        .expect("stat state before noop")
        .modified()
        .expect("read state mtime before noop");

    let noop = run(&["agents", "update", "release-notes", "--json"]);
    let (stdout, stderr) = output_text(&noop);
    assert!(noop.status.success(), "stderr was: {stderr}");
    let noop = serde_json::from_str::<Value>(&stdout).expect("parse noop JSON");
    assert_eq!(noop["status"], "up_to_date");
    assert_eq!(
        fs::read(&target).expect("read target after noop"),
        target_before_noop,
        "up-to-date must not rewrite the managed document"
    );
    assert_eq!(
        fs::read(&state).expect("read state after noop"),
        state_before_noop,
        "up-to-date must not rewrite the managed state"
    );
    assert_eq!(
        fs::metadata(&target)
            .expect("stat target after noop")
            .modified()
            .expect("read target mtime after noop"),
        target_mtime_before_noop,
        "up-to-date must preserve the managed document modification time"
    );
    assert_eq!(
        fs::metadata(&state)
            .expect("stat state after noop")
            .modified()
            .expect("read state mtime after noop"),
        state_mtime_before_noop,
        "up-to-date must preserve the managed state modification time"
    );

    let requests = server.finish();
    assert_eq!(requests.len(), 11, "noop must not download an artifact");
    assert_eq!(
        requests[0].path,
        "/api/goose/v1/marketplace/agents/release-notes"
    );
    assert_eq!(requests[1].method, "POST");
    assert_eq!(requests[1].path, "/api/goose/v1/marketplace/install-plan");
    assert_eq!(
        requests[1].body["targets"],
        json!([{"type": "agent", "slug": "release-notes"}])
    );
    assert_eq!(
        requests[2].path,
        "/api/goose/v1/marketplace/agents/release-notes/versions/agent-v1"
    );
    assert_eq!(
        requests[3].path,
        "/api/goose/v1/marketplace/artifacts/release-notes-agent-v1/download"
    );
    assert_eq!(requests[5].body["installed"][0]["version_id"], "agent-v1");
    assert_eq!(requests[9].body["installed"][0]["version_id"], "agent-v2");

    let server = MockServer::start(vec![]);
    let run_offline = |arguments: &[&str]| {
        bb_command()
            .env("BB_HOME", &bb_home)
            .env("HOME", &home)
            .env("KGOOSE_BASE_URL", &server.base_url)
            .args(arguments)
            .output()
            .expect("run local bb agents command")
    };
    let installed = run_offline(&["agents", "installed", "--json"]);
    let (stdout, stderr) = output_text(&installed);
    assert!(installed.status.success(), "stderr was: {stderr}");
    let installed = serde_json::from_str::<Value>(&stdout).expect("parse installed JSON");
    assert_eq!(installed["items"][0]["status"], "installed");
    assert_eq!(
        installed["items"][0]["path"],
        target.to_string_lossy().as_ref()
    );

    let installed_human = run_offline(&["agents", "installed"]);
    let (stdout, stderr) = output_text(&installed_human);
    assert!(installed_human.status.success(), "stderr was: {stderr}");
    assert!(stdout.contains("release-notes"), "stdout was: {stdout}");
    assert!(stdout.contains("version: agent-v2"), "stdout was: {stdout}");

    let which = run_offline(&["agents", "which", "release-notes", "--json"]);
    let (stdout, stderr) = output_text(&which);
    assert!(which.status.success(), "stderr was: {stderr}");
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).expect("parse which JSON")["version_id"],
        "agent-v2"
    );

    let removed = run_offline(&["agents", "remove", "release-notes", "--json"]);
    let (stdout, stderr) = output_text(&removed);
    assert!(removed.status.success(), "stderr was: {stderr}");
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).expect("parse remove JSON")["status"],
        "removed"
    );
    assert!(!target.exists());
    assert!(!state.exists());

    let absent = run_offline(&["agents", "remove", "release-notes", "--json"]);
    let (stdout, stderr) = output_text(&absent);
    assert!(absent.status.success(), "stderr was: {stderr}");
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).expect("parse absent JSON")["status"],
        "already_absent"
    );
    let requests = server.finish();
    assert!(
        requests.is_empty(),
        "local ownership queries must not use the network"
    );
    fs::remove_dir_all(sandbox).expect("remove lifecycle sandbox");
}

#[test]
fn bb_agents_report_local_ownership_conflicts_without_modifying_user_content() {
    let sandbox = temp_test_dir("bb-agents-conflicts");
    let bb_home = sandbox.join("bb-home");
    let home = sandbox.join("home");
    write_bb_org_config(&bb_home, "test");
    let document = agent_document("Release Notes", "Managed content.");

    write_managed_agent(&bb_home, &home, "alpha", document.as_bytes());
    write_managed_agent(&bb_home, &home, "bravo", document.as_bytes());
    fs::remove_file(agent_target(&home, "bravo")).expect("remove managed target for missing case");

    let malformed_state = agent_state(&bb_home, "invalid!");
    fs::create_dir_all(malformed_state.parent().expect("state parent"))
        .expect("create state parent");
    fs::write(&malformed_state, "not json").expect("write malformed state");

    let target_only = agent_target(&home, "target-only");
    fs::create_dir_all(target_only.parent().expect("target parent")).expect("create target parent");
    fs::write(&target_only, "local target only").expect("write target-only agent");

    write_managed_agent(&bb_home, &home, "changed", document.as_bytes());
    let changed_target = agent_target(&home, "changed");
    fs::write(&changed_target, "local changes").expect("change managed target");

    let mismatched_target = agent_target(&home, "mismatched");
    let mismatched_state = agent_state(&bb_home, "mismatched");
    fs::create_dir_all(mismatched_target.parent().expect("target parent"))
        .expect("create target parent");
    fs::create_dir_all(mismatched_state.parent().expect("state parent"))
        .expect("create state parent");
    fs::write(&mismatched_target, document.as_bytes()).expect("write mismatched target");
    let mut mismatched_metadata = managed_agent_metadata("another-agent", document.as_bytes());
    mismatched_metadata["slug"] = json!("another-agent");
    fs::write(
        &mismatched_state,
        serde_json::to_vec(&mismatched_metadata).expect("serialize mismatched state"),
    )
    .expect("write mismatched state");

    let directory_target = agent_target(&home, "directory");
    fs::create_dir_all(&directory_target).expect("create directory target");
    let directory_state = agent_state(&bb_home, "directory");
    fs::create_dir_all(directory_state.parent().expect("state parent"))
        .expect("create state parent");
    fs::write(
        &directory_state,
        serde_json::to_vec(&managed_agent_metadata("directory", document.as_bytes()))
            .expect("serialize directory state"),
    )
    .expect("write directory state");

    #[cfg(unix)]
    let symlink_target = {
        let target = agent_target(&home, "symlink");
        let destination = sandbox.join("local-agent.md");
        fs::write(&destination, "linked local content").expect("write symlink destination");
        std::os::unix::fs::symlink(&destination, &target).expect("create agent symlink");
        let state = agent_state(&bb_home, "symlink");
        fs::create_dir_all(state.parent().expect("state parent")).expect("create state parent");
        fs::write(
            &state,
            serde_json::to_vec(&managed_agent_metadata("symlink", document.as_bytes()))
                .expect("serialize symlink state"),
        )
        .expect("write symlink state");
        target
    };

    let server = MockServer::start(vec![]);
    let run = |arguments: &[&str]| {
        bb_command()
            .env("BB_HOME", &bb_home)
            .env("HOME", &home)
            .env("KGOOSE_BASE_URL", &server.base_url)
            .args(arguments)
            .output()
            .expect("run local ownership command")
    };

    let installed = run(&["agents", "installed", "--json"]);
    let (stdout, stderr) = output_text(&installed);
    assert!(installed.status.success(), "stderr was: {stderr}");
    let installed = serde_json::from_str::<Value>(&stdout).expect("parse installed JSON");
    let items = installed["items"].as_array().expect("installed items");
    assert_eq!(
        items
            .iter()
            .map(|item| item["slug"].as_str().expect("slug"))
            .collect::<Vec<_>>(),
        [
            "alpha",
            "bravo",
            "changed",
            "directory",
            "invalid!",
            "mismatched",
            "symlink"
        ],
        "installed records must be sorted by slug"
    );
    assert_eq!(items[0]["status"], "installed");
    assert_eq!(items[1]["status"], "missing");
    assert!(items
        .iter()
        .any(|item| item["slug"] == "invalid!" && item["status"] == "conflict"));

    let missing = run(&["agents", "which", "bravo", "--json"]);
    let (stdout, stderr) = output_text(&missing);
    assert!(missing.status.success(), "stderr was: {stderr}");
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).expect("parse missing JSON")["status"],
        "missing"
    );

    for (slug, preserved_path) in [
        ("target-only", &target_only),
        ("changed", &changed_target),
        ("mismatched", &mismatched_target),
        ("directory", &directory_target),
        #[cfg(unix)]
        ("symlink", &symlink_target),
    ] {
        let state = agent_state(&bb_home, slug);
        let target_before = snapshot_agent_target(preserved_path);
        let state_before = fs::read(&state).ok();
        for command in ["install", "update", "remove"] {
            let output = run(&["agents", command, slug, "--json"]);
            let (_stdout, stderr) = output_text(&output);
            assert_eq!(output.status.code(), Some(7), "stderr was: {stderr}");
            let error = parse_stderr_error(&stderr);
            assert_eq!(error["error"]["code"], "agent_conflict");
            assert_eq!(error["error"]["details"]["slug"], slug);
            assert_agent_pair_unchanged(preserved_path, &state, &target_before, &state_before);
        }
    }

    let requests = server.finish();
    assert!(
        requests.is_empty(),
        "protected local content must not trigger marketplace requests"
    );
    fs::remove_dir_all(sandbox).expect("remove conflict sandbox");
}

#[test]
fn bb_agents_preserve_managed_pairs_for_failure_envelopes() {
    let sandbox = temp_test_dir("bb-agents-failure-envelopes");
    let bb_home = sandbox.join("bb-home");
    let home = sandbox.join("home");
    let document = agent_document("Release Notes", "Managed content.");
    write_bb_org_config(&bb_home, "test");
    write_managed_agent(&bb_home, &home, "release-notes", document.as_bytes());
    let target = agent_target(&home, "release-notes");
    let state = agent_state(&bb_home, "release-notes");
    let target_before = snapshot_agent_target(&target);
    let state_before = fs::read(&state).ok();
    let run = |server: &MockServer, arguments: &[&str]| {
        bb_command()
            .env("BB_HOME", &bb_home)
            .env("HOME", &home)
            .env("KGOOSE_BASE_URL", &server.base_url)
            .args(arguments)
            .output()
            .expect("run bb agents failure command")
    };

    let server = MockServer::start(vec![marketplace_error_response(
        404,
        "agent_not_found",
        "Agent was not found.",
        "req_agent_marketplace",
    )]);
    let output = run(&server, &["agents", "list", "--json"]);
    let requests = server.finish();
    assert_agent_failure(
        &output,
        &target,
        &state,
        &target_before,
        &state_before,
        1,
        "agent_not_found",
    );
    assert_eq!(
        requests[0].path,
        "/api/goose/v1/marketplace/agents?limit=5000"
    );

    let server = MockServer::start(vec![marketplace_error_response(
        401,
        "authentication_required",
        "Sign in before using marketplace agents.",
        "req_agent_auth",
    )]);
    let output = run(&server, &["agents", "list", "--json"]);
    let requests = server.finish();
    assert_agent_failure(
        &output,
        &target,
        &state,
        &target_before,
        &state_before,
        3,
        "authentication_required",
    );
    assert_eq!(
        requests[0].path,
        "/api/goose/v1/marketplace/agents?limit=5000"
    );

    let server = MockServer::start(vec![
        MockResponse::json(marketplace_agent_detail(
            "release-notes",
            "agent-v2",
            "content-v2",
        )),
        marketplace_error_response(
            422,
            "agent_plan_blocked",
            "Agent install plan is blocked.",
            "req_agent_plan",
        ),
    ]);
    let output = run(&server, &["agents", "update", "release-notes", "--json"]);
    let requests = server.finish();
    assert_agent_failure(
        &output,
        &target,
        &state,
        &target_before,
        &state_before,
        6,
        "agent_plan_blocked",
    );
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].path, "/api/goose/v1/marketplace/install-plan");

    let server = MockServer::start(vec![
        MockResponse::json(marketplace_agent_detail(
            "release-notes",
            "agent-v2",
            "content-v2",
        )),
        MockResponse::json(json!({
            "operations": [{
                "action": "update",
                "reason": "Invalid operation kind.",
                "kind": "skill",
                "skill": {
                    "slug": "release-notes",
                    "version_id": "agent-v2",
                    "content_sha256": "content-v2"
                },
                "artifact": null,
                "installed_via": "explicit"
            }]
        })),
    ]);
    let output = run(&server, &["agents", "update", "release-notes", "--json"]);
    let _requests = server.finish();
    assert_agent_failure(
        &output,
        &target,
        &state,
        &target_before,
        &state_before,
        8,
        "invalid_agent_operation_kind",
    );

    let zip = skill_zip(&[("agent.md", &document)]);
    let (artifact, _response) = agent_artifact("release-notes", "agent-v2", zip);
    let server = MockServer::start(vec![
        MockResponse::json(marketplace_agent_detail(
            "release-notes",
            "agent-v2",
            "content-v2",
        )),
        agent_install_plan(
            "release-notes",
            "agent-v2",
            "content-v2",
            "update",
            Some(artifact),
        ),
        MockResponse::json(marketplace_agent_version(
            "release-notes",
            "agent-v2",
            "content-v2",
        )),
        marketplace_error_response(
            403,
            "agent_artifact_forbidden",
            "Agent artifact is not authorized.",
            "req_agent_artifact",
        ),
    ]);
    let output = run(&server, &["agents", "update", "release-notes", "--json"]);
    let requests = server.finish();
    assert_agent_failure(
        &output,
        &target,
        &state,
        &target_before,
        &state_before,
        4,
        "agent_artifact_forbidden",
    );
    assert_eq!(requests.len(), 4);

    let lock = bb_home
        .join("agents")
        .join("locks")
        .join("release-notes.lock");
    fs::create_dir_all(lock.parent().expect("lock parent")).expect("create lock parent");
    fs::write(&lock, "locked").expect("write active lock");
    let server = MockServer::start(vec![]);
    let output = run(&server, &["agents", "update", "release-notes", "--json"]);
    let requests = server.finish();
    assert_agent_failure(
        &output,
        &target,
        &state,
        &target_before,
        &state_before,
        7,
        "agent_locked",
    );
    assert!(requests.is_empty(), "filesystem failure must stay local");

    fs::remove_dir_all(sandbox).expect("remove failure sandbox");
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

fn capabilities_response_for_target(target: &str, target_dir: &Path) -> MockResponse {
    MockResponse::json(json!({
        "target_registry": {
            target: {
                "enabled": true,
                "global_paths": [format!("{}", target_dir.display())],
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
fn bb_root_help_lists_apps_skills_and_tools() {
    let output = bb_command().arg("--help").output().expect("run bb help");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(stdout.contains("apps"));
    assert!(!stdout.contains("appkit"));
    assert!(stdout.contains("auth"));
    assert!(stdout.contains("config"));
    assert!(stdout.contains("skills"));
    assert!(stdout.contains("tools"));
    assert!(stdout.contains("Builderbot command line tools"));
    assert!(!stdout.contains("--local-dev"));
}

#[test]
fn bb_root_description_lists_apps_not_appkit() {
    let output = bb_command()
        .arg("--describe-commands")
        .output()
        .expect("describe bb commands");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let description = serde_json::from_str::<Value>(&stdout).expect("parse command description");
    let command_names = description["commands"]
        .as_array()
        .expect("commands array")
        .iter()
        .filter_map(|command| command["name"].as_str())
        .collect::<Vec<_>>();
    assert!(command_names.contains(&"apps"));
    assert!(!command_names.contains(&"appkit"));
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
        stdout.contains("bb,agents)"),
        "completion script missing agents root transition: {stdout}"
    );
    for subcommand in [
        "list",
        "search",
        "show",
        "install",
        "update",
        "installed",
        "which",
        "remove",
    ] {
        assert!(
            stdout.contains(&format!("bb__subcmd__agents,{subcommand})")),
            "completion script missing agents transition for {subcommand}: {stdout}"
        );
    }
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
        "/api/goose/v1/marketplace/skills?limit=5000"
    );
    assert_eq!(requests[1].method, "GET");
    assert_eq!(
        requests[1].path,
        "/api/goose/v1/marketplace/bundles?limit=5000"
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
        "/api/goose/v1/marketplace/skills?limit=5000&query=builder"
    );
    assert_eq!(
        requests[1].path,
        "/api/goose/v1/marketplace/bundles?limit=5000"
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
        "/api/goose/v1/marketplace/skills/builderbot-tools"
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
        "/api/goose/v1/marketplace/bundles?limit=5000"
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
    let storage_key = browser_auth_storage_key("local", &format!("{}/api/goose", server.base_url));
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
        "subject": "auth0|user_123",
        "email": "test@example.com",
        "name": "Test User",
        "expires_at": "2026-06-15T00:00:00Z",
        "roles": ["ROLE_USER"],
        "workspaces": {"active": [
            {"name": "Test \u{202e}Workspace"},
            {"name": "Other Workspace"}
        ]}
    }))]);
    let storage_key =
        browser_auth_storage_key("default", &format!("{}/api/goose", server.base_url));
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
    assert!(stdout.contains(r#""workspace_name": "Test \u202eWorkspace""#));
    let response = serde_json::from_str::<Value>(&stdout).expect("parse status output");
    assert_eq!(response["authenticated"], json!(true));
    assert_eq!(response["expires_at"], json!("2026-06-15T00:00:00Z"));
    assert_eq!(response["workspace_name"], json!("Test \u{202e}Workspace"));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/api/goose/v1/auth/me");
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
fn bb_auth_status_errors_never_echo_a_reflected_session() {
    let secret = "reflected_session_credential_123456";
    let server = MockServer::start(vec![
        MockResponse::text(500, secret),
        MockResponse::text(500, secret),
    ]);
    let temp = temp_test_dir("bb-auth-status-redaction");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("auth-sessions.json");
    write_bb_org_config(&bb_home, "test");
    write_browser_auth_session(
        &storage_path,
        &server.base_url,
        secret,
        "2099-01-01T00:00:00Z",
    );

    for args in [vec!["auth", "status"], vec!["auth", "status", "--json"]] {
        let output = bb_command()
            .env("BB_HOME", &bb_home)
            .env("BB_AUTH_STORAGE", "file")
            .env("BB_AUTH_STORAGE_FILE", &storage_path)
            .env("KGOOSE_BASE_URL", &server.base_url)
            .args(args)
            .output()
            .expect("run failing bb auth status");
        let (stdout, stderr) = output_text(&output);

        assert!(!output.status.success());
        assert!(!stdout.contains(secret));
        assert!(!stderr.contains(secret));
        assert!(stderr.contains("/v1/auth/me failed with 500"));
    }

    assert_eq!(server.finish().len(), 2);
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_auth_login_uses_valid_stored_file_session() {
    let temp = temp_test_dir("bb-auth-login-stored");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let storage_path = temp.join("auth-sessions.json");
    let server = MockServer::start(vec![MockResponse::json(json!({
        "subject": "auth0|user_123",
        "email": "test@example.com",
        "name": "Test User",
        "expires_at": "2026-06-15T00:00:00Z",
        "roles": ["ROLE_USER"],
        "workspaces": {"active": [
            {"name": "Test \u{202e}Workspace"},
            {"name": "Other Workspace"}
        ]}
    }))]);
    let storage_key =
        browser_auth_storage_key("default", &format!("{}/api/goose", server.base_url));
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
    assert!(stdout.contains(r#""workspace_name": "Test \u202eWorkspace""#));
    let response = serde_json::from_str::<Value>(&stdout).expect("parse login output");
    assert_eq!(response["source"], json!("stored"));
    assert_eq!(response["storage"], json!("file"));
    assert_eq!(response["workspace_name"], json!("Test \u{202e}Workspace"));
    assert_eq!(response["credentialPrefix"], Value::Null);
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/api/goose/v1/auth/me");
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
        "subject": "auth0|user_123",
        "email": "test@example.com",
        "name": "Test User",
        "expires_at": "2026-06-15T00:00:00Z",
        "roles": ["ROLE_USER"],
        "workspaces": {"active": [{"name": "Test Workspace"}]}
    }))]);
    let storage_key =
        browser_auth_storage_key("default", &format!("{}/api/goose", server.base_url));
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
    assert_eq!(requests[0].path, "/api/goose/v1/auth/me");
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
    let server_url = format!("{}/api/goose", server.base_url);
    let default_key = browser_auth_storage_key("default", &server_url);
    let other_key = browser_auth_storage_key("other", &server_url);
    let purpose_storage_path = PathBuf::from(format!("{}.purpose-tokens", storage_path.display()));
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
    fs::write(
        &purpose_storage_path,
        serde_json::to_string_pretty(&json!({
            "obsolete-purpose-token": { "accessToken": "legacy-secret" }
        }))
        .expect("serialize legacy purpose token storage"),
    )
    .expect("write legacy purpose token storage");

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
    assert_eq!(response["purpose_token_removed"], json!(true));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/api/goose/v1/auth/logout");
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
    assert!(!purpose_storage_path.exists());

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
    assert_eq!(response["purpose_token_removed"], json!(false));

    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_workspace_list_prints_accessible_workspaces_as_json() {
    let temp = temp_test_dir("bb-workspace-list");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("auth-sessions.json");
    write_bb_org_config(&bb_home, "test");
    let server = MockServer::start(vec![MockResponse::json(json!({
        "workspaces": [
            {
                "workspace_identifier": "workspace-one",
                "display_name": "Workspace One",
                "roles": ["ROLE_USER"]
            },
            {
                "workspace_identifier": "workspace-two",
                "display_name": "Workspace Two",
                "roles": ["ROLE_USER", "ROLE_ADMIN"]
            }
        ],
        "active_workspace_identifier": "workspace-one"
    }))]);
    write_browser_auth_session(
        &storage_path,
        &server.base_url,
        "stored-cli-session",
        "2026-06-15T00:00:00Z",
    );

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["workspace", "list", "--json"])
        .output()
        .expect("run bb workspace list");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse workspace list output");
    assert_eq!(
        response["active_workspace_identifier"],
        json!("workspace-one")
    );
    assert_eq!(response["workspaces"][1]["display_name"], "Workspace Two");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/api/goose/v1/workspaces/list");
    assert_eq!(requests[0].body, json!({}));
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
fn bb_workspace_switch_flag_skips_list_and_stores_rotated_credential() {
    let temp = temp_test_dir("bb-workspace-switch");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("auth-sessions.json");
    write_bb_org_config(&bb_home, "test");
    let server = MockServer::start(vec![MockResponse::json(json!({
        "workspace": {
            "workspace_identifier": "workspace-two",
            "display_name": "Workspace Two",
            "roles": ["ROLE_USER"]
        },
        "session_credential": "rotated-cli-session"
    }))]);
    write_browser_auth_session(
        &storage_path,
        &server.base_url,
        "stored-cli-session",
        "2026-06-15T00:00:00Z",
    );

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "workspace",
            "switch",
            "--workspace",
            "workspace-two",
            "--json",
        ])
        .output()
        .expect("run bb workspace switch");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse workspace switch output");
    assert_eq!(
        response["workspace"]["workspace_identifier"],
        "workspace-two"
    );
    assert_eq!(response["switched"], true);
    assert!(
        !stdout.contains("rotated-cli-session"),
        "credential leaked to stdout: {stdout}"
    );
    assert_eq!(
        requests.len(),
        1,
        "direct switch should skip workspace list"
    );
    assert_eq!(requests[0].path, "/api/goose/v1/workspaces/switch");
    assert_eq!(
        requests[0].body,
        json!({"workspace_identifier": "workspace-two"})
    );
    assert_eq!(
        requests[0]
            .headers
            .get("x-bb-session-credential")
            .map(String::as_str),
        Some("stored-cli-session")
    );
    let storage: Value = serde_json::from_str(
        &fs::read_to_string(&storage_path).expect("read rotated auth storage"),
    )
    .expect("parse rotated auth storage");
    let stored = storage
        .as_object()
        .expect("storage object")
        .values()
        .next()
        .expect("stored session");
    assert_eq!(stored["sessionCredential"], "rotated-cli-session");
    assert_eq!(stored["expiresAt"], "2026-06-15T00:00:00Z");
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_workspace_switch_current_workspace_keeps_stored_credential() {
    let temp = temp_test_dir("bb-workspace-switch-current");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("auth-sessions.json");
    write_bb_org_config(&bb_home, "test");
    let server = MockServer::start(vec![MockResponse::json(json!({
        "workspace": {
            "workspace_identifier": "workspace-one",
            "display_name": "Workspace One",
            "roles": ["ROLE_USER"]
        }
    }))]);
    write_browser_auth_session(
        &storage_path,
        &server.base_url,
        "stored-cli-session",
        "2026-06-15T00:00:00Z",
    );

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "workspace",
            "switch",
            "--workspace",
            "workspace-one",
            "--json",
        ])
        .output()
        .expect("run bb workspace switch current");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse workspace switch output");
    assert_eq!(response["switched"], false);
    let storage = fs::read_to_string(&storage_path).expect("read auth storage");
    assert!(storage.contains("stored-cli-session"));
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_workspace_switch_persists_rotated_credential_before_validating_workspace() {
    let temp = temp_test_dir("bb-workspace-switch-missing-workspace");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("auth-sessions.json");
    write_bb_org_config(&bb_home, "test");
    let server = MockServer::start(vec![MockResponse::json(json!({
        "session_credential": "rotated-cli-session"
    }))]);
    write_browser_auth_session(
        &storage_path,
        &server.base_url,
        "stored-cli-session",
        "2026-06-15T00:00:00Z",
    );

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "workspace",
            "switch",
            "--workspace",
            "workspace-two",
            "--json",
        ])
        .output()
        .expect("run bb workspace switch with malformed response");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    assert!(stderr.contains("returned no workspace"));
    let storage = fs::read_to_string(&storage_path).expect("read auth storage");
    assert!(storage.contains("rotated-cli-session"));
    assert!(!storage.contains("stored-cli-session"));
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_workspace_switch_rejects_invalid_rotated_credential_before_storage() {
    let temp = temp_test_dir("bb-workspace-switch-invalid-credential");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("auth-sessions.json");
    write_bb_org_config(&bb_home, "test");
    let server = MockServer::start(vec![MockResponse::json(json!({
        "workspace": {
            "workspace_identifier": "workspace-two",
            "display_name": "Workspace Two",
            "roles": ["ROLE_USER"]
        },
        "session_credential": "invalid\ncredential"
    }))]);
    write_browser_auth_session(
        &storage_path,
        &server.base_url,
        "stored-cli-session",
        "2026-06-15T00:00:00Z",
    );

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "workspace",
            "switch",
            "--workspace",
            "workspace-two",
            "--json",
        ])
        .output()
        .expect("run bb workspace switch with invalid credential");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    assert!(stderr.contains("invalid replacement credential"));
    let storage = fs::read_to_string(&storage_path).expect("read auth storage");
    assert!(storage.contains("stored-cli-session"));
    assert!(!storage.contains("invalid"));
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_workspace_errors_escape_untrusted_server_text() {
    let temp = temp_test_dir("bb-workspace-error-safety");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("auth-sessions.json");
    write_bb_org_config(&bb_home, "test");
    let server = MockServer::start(vec![MockResponse::text(
        403,
        "denied\u{1b}[2J\u{202e}spoofed",
    )]);
    write_browser_auth_session(
        &storage_path,
        &server.base_url,
        "stored-cli-session",
        "2026-06-15T00:00:00Z",
    );

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args(["workspace", "list", "--json"])
        .output()
        .expect("run forbidden bb workspace list");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    assert!(!stderr.contains('\u{1b}'), "raw escape leaked: {stderr:?}");
    assert!(
        !stderr.contains('\u{202e}'),
        "raw bidi control leaked: {stderr:?}"
    );
    assert!(
        stderr.contains(r"\\u{1b}"),
        "escaped control missing: {stderr}"
    );
    assert!(
        stderr.contains(r"\\u{202e}"),
        "escaped bidi control missing: {stderr}"
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_workspace_switch_requires_flag_outside_a_tty() {
    let temp = temp_test_dir("bb-workspace-switch-noninteractive");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("auth-sessions.json");
    write_bb_org_config(&bb_home, "test");
    write_browser_auth_session(
        &storage_path,
        "http://127.0.0.1:9",
        "stored-cli-session",
        "2026-06-15T00:00:00Z",
    );

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", "http://127.0.0.1:9")
        .args(["workspace", "switch", "--json"])
        .output()
        .expect("run non-interactive bb workspace switch");
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    let payload = parse_stderr_error(&stderr);
    assert_eq!(payload["error"]["code"], "workspace_required");
    assert!(payload["error"]["message"]
        .as_str()
        .expect("error message")
        .contains("--workspace <ID>"));
    fs::remove_dir_all(temp).expect("remove temp dir");
}

fn write_browser_auth_session(
    storage_path: &Path,
    base_url: &str,
    session_credential: &str,
    expires_at: &str,
) {
    let storage_key = browser_auth_storage_key("default", &format!("{}/api/goose", base_url));
    fs::write(
        storage_path,
        serde_json::to_string_pretty(&json!({
            storage_key: {
                "sessionCredential": session_credential,
                "expiresAt": expires_at
            }
        }))
        .expect("serialize auth storage"),
    )
    .expect("write auth storage");
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
        .args(["skills", "config", "get", "org", "--json"])
        .output()
        .expect("run bb skills config get");
    let (get_stdout, get_stderr) = output_text(&get);
    assert!(get.status.success(), "stderr was: {get_stderr}");
    let get_response = serde_json::from_str::<Value>(&get_stdout).expect("parse get output");
    assert_eq!(get_response["org"], json!("test"));
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
    assert_eq!(requests[0].path, "/api/goose/v1/marketplace/capabilities");
    assert_eq!(requests[1].method, "POST");
    assert_eq!(requests[1].path, "/api/goose/v1/marketplace/install-plan");
    assert_eq!(
        requests[1].body["targets"][0]["slug"],
        json!("builderbot-tools")
    );
    assert_eq!(
        requests[1].body["client"]["install_targets"],
        json!(["agents"])
    );
    assert!(
        requests[1].body.get("channel").is_none(),
        "install-plan requests must not expose a channel selector"
    );
    assert_eq!(requests[2].method, "GET");
    assert_eq!(
        requests[2].path,
        "/api/goose/v1/marketplace/skills/builderbot-tools"
    );
    assert_eq!(requests[3].method, "GET");
    assert_eq!(
        requests[3].path,
        "/api/goose/v1/marketplace/artifacts/art_builderbot_tools/download"
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_install_rejects_unsafe_plan_before_artifact_fetch_or_root_escape() {
    let temp = temp_test_dir("bb-skills-unsafe-plan-slug");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let skills_home = temp.join("skills-home");
    let agents_dir = temp.join("agents-skills");
    let outside = temp.join("outside-sentinel");
    fs::create_dir_all(&outside).expect("create outside sentinel");
    fs::write(outside.join("keep"), "untouched").expect("write outside sentinel");

    let malicious_plan = json!({
        "plan_id": "malicious",
        "operations": [{
            "action": "install",
            "skill": {
                "slug": "../outside-sentinel",
                "version_id": "version-1",
                "content_sha256": "content-sha"
            },
            "artifact": {
                "id": "artifact-1",
                "download_url": "/must-not-fetch",
                "sha256": "unused",
                "size_bytes": 1
            },
            "installed_via": "explicit"
        }],
        "warnings": []
    });
    let server = MockServer::start(vec![
        capabilities_response(&agents_dir),
        MockResponse::json(malicious_plan),
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
    let (_stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(
        stderr.contains("invalid skill name"),
        "stderr was: {stderr}"
    );
    assert_eq!(
        requests.len(),
        2,
        "artifact or detail fetch escaped validation"
    );
    assert_eq!(
        fs::read_to_string(outside.join("keep")).unwrap(),
        "untouched"
    );
    assert!(!skills_home.join("outside-sentinel").exists());
    assert!(!agents_dir.join("outside-sentinel").exists());
    assert!(
        !skills_home.join("downloads").exists()
            || fs::read_dir(skills_home.join("downloads"))
                .unwrap()
                .next()
                .is_none()
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_install_and_update_restore_package_when_target_linking_fails() {
    for action in ["install", "update"] {
        let zip_bytes = skill_zip(&[("SKILL.md", "# New BuilderBot Tools\n")]);
        let artifact_sha = sha256_hex(&zip_bytes);
        let temp = temp_test_dir(&format!("bb-skills-{action}-target-recovery"));
        let bb_home = temp.join("bb-home");
        let skills_home = temp.join("skills-home");
        let invalid_target = temp.join("target-is-a-file");
        write_bb_org_config(&bb_home, "test");
        write_installed_package(&skills_home, "builderbot-tools", "old-content", &["claude"]);
        fs::write(&invalid_target, "not a directory").expect("create invalid target");

        let mut plan = marketplace_install_plan(&zip_bytes, &artifact_sha, zip_bytes.len());
        plan["operations"][0]["action"] = json!(action);
        let server = MockServer::start(vec![
            capabilities_response_for_target("claude", &invalid_target),
            MockResponse::json(plan),
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
                "claude",
                "--yes",
                "--json",
            ])
            .output()
            .expect("run bb skills install");
        let _requests = server.finish();
        let (stdout, stderr) = output_text(&output);

        assert!(
            !output.status.success(),
            "stdout: {stdout}; stderr: {stderr}"
        );
        assert!(
            format!("{stdout}\n{stderr}").contains("restored the previous package"),
            "stdout: {stdout}; stderr: {stderr}"
        );
        assert_eq!(
            fs::read_to_string(skills_home.join("packages/builderbot-tools/SKILL.md"))
                .expect("read restored package"),
            "# BuilderBot Tools\n"
        );
        fs::remove_dir_all(temp).expect("remove temp dir");
    }
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
fn bb_skills_install_backs_up_unmanaged_package_before_replacing_it() {
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
        skill_detail_response(),
        artifact_response(zip_bytes, &artifact_sha),
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

    assert!(output.status.success(), "stderr was: {stderr}");
    let response = serde_json::from_str::<Value>(&stdout).expect("parse install output");
    assert_eq!(response["installed"][0]["slug"], json!("builderbot-tools"));
    assert_eq!(
        fs::read_to_string(unmanaged.join("SKILL.md")).expect("read unmanaged skill"),
        "# BuilderBot Tools\n"
    );
    assert!(unmanaged.join(".bb-skills-meta.json").is_file());
    let backup_root = unmanaged
        .parent()
        .expect("packages directory")
        .join(".backups");
    let backups = fs::read_dir(&backup_root)
        .expect("read backup directory")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("builderbot-tools-"))
        })
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1);
    assert_eq!(
        fs::read_to_string(backups[0].join("SKILL.md")).expect("read backup skill"),
        "user file"
    );
    let backup_output = &response["installed"][0]["backups"][0];
    assert_eq!(backup_output["source_path"], json!(unmanaged));
    assert_eq!(backup_output["backup_path"], json!(backups[0]));
    assert!(backup_output["created_at"]
        .as_str()
        .is_some_and(|created_at| created_at.ends_with('Z')
            && created_at.contains('T')
            && created_at.matches(':').count() == 1));
    assert_eq!(requests.len(), 4);
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_skills_install_human_output_reports_real_folder_backup() {
    let temp = temp_test_dir("bb-skills-backup-output");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");
    let skills_home = temp.join("skills-home");
    let packages_dir = skills_home.join("packages");
    let agents_dir = temp.join("agents-skills");
    let source = temp.join("source/builderbot-tools");
    fs::create_dir_all(&source).expect("create local skill source");
    fs::write(source.join("SKILL.md"), "# Marketplace replacement\n")
        .expect("write local skill source");
    let existing = packages_dir.join("builderbot-tools");
    fs::create_dir_all(&existing).expect("create conflicting skill");
    fs::write(existing.join("SKILL.md"), "# User-owned skill\n").expect("write conflicting skill");
    let server = MockServer::start(vec![capabilities_response(&agents_dir)]);

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_SKILLS_HOME", &skills_home)
        .env("BB_SKILLS_PACKAGES_DIR", &packages_dir)
        .env("KGOOSE_BASE_URL", &server.base_url)
        .args([
            "skills",
            "install",
            source.to_str().expect("UTF-8 source path"),
            "--target",
            "agents",
            "--yes",
        ])
        .output()
        .expect("run bb skills install");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    let backups = fs::read_dir(packages_dir.join(".backups"))
        .expect("read backup directory")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1);
    assert!(
        stdout.contains(&format!(
            "conflicting skill at {} was replaced. Backup created on ",
            existing.display()
        )),
        "stdout was: {stdout}"
    );
    assert!(
        stdout.contains(&format!("Z at {}", backups[0].display())),
        "stdout was: {stdout}"
    );
    assert_eq!(
        fs::read_to_string(backups[0].join("SKILL.md")).expect("read backup skill"),
        "# User-owned skill\n"
    );
    assert_eq!(
        fs::read_to_string(existing.join("SKILL.md")).expect("read installed skill"),
        "# Marketplace replacement\n"
    );
    assert_eq!(requests.len(), 1);
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
    assert_eq!(requests[1].path, "/api/goose/v1/marketplace/install-plan");
    assert_eq!(
        requests[1].body["installed"][0]["slug"],
        json!("builderbot-tools")
    );
    assert!(
        requests[1].body.get("channel").is_none(),
        "update requests must not expose a channel selector"
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
        "/api/goose/v1/marketplace/skills?limit=5000"
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
// External Apps Platform control plane

const APPROVED_APPS_BASE_URL: &str = "https://compose-ctrl.test.blockstaging.build";

#[test]
fn bb_shipped_artifact_contains_no_apps_test_transport() {
    let binary = fs::read(env!("CARGO_BIN_EXE_bb")).expect("read shipped bb test artifact");
    for forbidden in [
        "BB_APPS_E2E_CONTROL_PLANE_URL",
        "BB_APPS_E2E_AUTH_URL",
        "BB_APPS_E2E_CREDENTIAL",
        "BB_APPS_E2E_RESOLVE_ADDR",
        "Berd Apps E2E Test CA",
    ] {
        assert!(
            !binary
                .windows(forbidden.len())
                .any(|window| window == forbidden.as_bytes()),
            "shipped bb artifact contained Apps test-only material {forbidden:?}"
        );
    }
}

#[test]
fn bb_apps_help_distinguishes_external_and_internal_paths() {
    let output = bb_command()
        .args(["apps", "--help"])
        .output()
        .expect("run bb apps help");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    for expected in [
        "Apps Platform",
        "bb-block",
        "bb-public",
        "Cloudflare-backed internal App Kit",
        "bb tools appkit",
        "separate internal Compose workflow",
        "list",
        "get",
        "versions",
        "rollback",
        "ready",
        "debug",
    ] {
        assert!(
            stdout.contains(expected),
            "help did not explain {expected:?}: {stdout}"
        );
    }
}

#[test]
fn bb_apps_inspection_help_exposes_filters_and_app_ids() {
    let list = bb_command()
        .args(["apps", "list", "--help"])
        .output()
        .expect("run bb apps list help");
    let (list_stdout, list_stderr) = output_text(&list);
    assert!(list.status.success(), "stderr was: {list_stderr}");
    for expected in [
        "--scope <SCOPE>",
        "manageable",
        "owned",
        "publisher",
        "--include-deleted",
        "--base-url <URL>",
    ] {
        assert!(
            list_stdout.contains(expected),
            "list help omitted {expected:?}: {list_stdout}"
        );
    }

    for subcommand in ["get", "versions"] {
        let output = bb_command()
            .args(["apps", subcommand, "--help"])
            .output()
            .unwrap_or_else(|error| panic!("run bb apps {subcommand} help: {error}"));
        let (stdout, stderr) = output_text(&output);
        assert!(output.status.success(), "stderr was: {stderr}");
        for expected in [
            "<APP_ID>",
            "--environment <ENVIRONMENT>",
            "--base-url <URL>",
        ] {
            assert!(
                stdout.contains(expected),
                "{subcommand} help omitted {expected:?}: {stdout}"
            );
        }
    }
}

#[test]
fn bb_apps_ready_and_debug_help_expose_their_arguments() {
    let ready = bb_command()
        .args(["apps", "ready", "--help"])
        .output()
        .expect("run bb apps ready help");
    let (ready_stdout, ready_stderr) = output_text(&ready);
    assert!(ready.status.success(), "stderr was: {ready_stderr}");
    for expected in [
        "<APP_ID>",
        "--version-id <VERSION_ID>",
        "--environment <ENVIRONMENT>",
        "--base-url <URL>",
    ] {
        assert!(
            ready_stdout.contains(expected),
            "ready help omitted {expected:?}: {ready_stdout}"
        );
    }

    let debug = bb_command()
        .args(["apps", "debug", "--help"])
        .output()
        .expect("run bb apps debug help");
    let (debug_stdout, debug_stderr) = output_text(&debug);
    assert!(debug.status.success(), "stderr was: {debug_stderr}");
    for expected in [
        "<APP_ID>",
        "--version-id <VERSION_ID>",
        "--environment <ENVIRONMENT>",
        "--tail-lines <N>",
        "1-1000",
        "control-plane default: 200",
    ] {
        assert!(
            debug_stdout.contains(expected),
            "debug help omitted {expected:?}: {debug_stdout}"
        );
    }
}

#[test]
fn bb_apps_rollback_help_exposes_optional_target_and_environment() {
    let output = bb_command()
        .args(["apps", "rollback", "--help"])
        .output()
        .expect("run bb apps rollback help");
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    for expected in [
        "<APP_ID>",
        "--version-id <VERSION_ID>",
        "--environment <ENVIRONMENT>",
        "previous version",
        "--base-url <URL>",
    ] {
        assert!(
            stdout.contains(expected),
            "rollback help omitted {expected:?}: {stdout}"
        );
    }
}

#[test]
fn bb_apps_ready_requires_version_before_auth_or_network() {
    let output = bb_command()
        .args([
            "apps",
            "ready",
            "merchant-lookup",
            "--base-url",
            "https://compose-ctrl.test.blockstaging.build",
        ])
        .output()
        .expect("run bb apps ready without version id");
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    assert!(stderr.contains("--version-id <VERSION_ID>"));
    assert!(stderr.contains("required"));
}

#[test]
fn bb_apps_contract_rejects_loopback_before_reading_or_sending_the_session() {
    let kgoose = MockServer::start(vec![]);
    let control_plane = MockServer::start(vec![]);
    let temp = temp_test_dir("bb-apps-loopback-origin");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("auth-sessions.json");
    let session_credential = "stored_session_credential_1234567890";
    write_bb_org_config(&bb_home, "test");
    write_browser_auth_session(
        &storage_path,
        &kgoose.base_url,
        session_credential,
        "2099-01-01T00:00:00Z",
    );

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .env("KGOOSE_BASE_URL", &kgoose.base_url)
        .args(["apps", "contract", "--base-url", &control_plane.base_url])
        .output()
        .expect("run bb apps contract with loopback origin");
    let kgoose_requests = kgoose.finish();
    let control_plane_requests = control_plane.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    assert!(stderr.contains("approved Builderlab ingress"));
    assert!(!stderr.contains(session_credential));
    assert!(kgoose_requests.is_empty());
    assert!(control_plane_requests.is_empty());
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_apps_contract_rejects_arbitrary_https_origin() {
    let temp = temp_test_dir("bb-apps-arbitrary-origin");
    let bb_home = temp.join("bb-home");
    write_bb_org_config(&bb_home, "test");

    let output = bb_command()
        .env("BB_HOME", &bb_home)
        .args(["apps", "contract", "--base-url", "https://attacker.example"])
        .output()
        .expect("run bb apps contract with arbitrary origin");
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    assert!(stderr.contains("approved Builderlab ingress"));
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_apps_json_without_a_session_exits_promptly_with_auth_required() {
    let temp = temp_test_dir("bb-apps-json-auth-required");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("missing-auth-sessions.json");
    write_bb_org_config(&bb_home, "test");

    let mut child = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .args([
            "apps",
            "contract",
            "--base-url",
            "https://compose-ctrl.test.blockstaging.build",
            "--json",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start noninteractive bb apps contract");
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().expect("poll bb apps contract") {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().expect("stop hung bb apps contract");
            child.wait().expect("reap hung bb apps contract");
            panic!("bb apps contract did not fail promptly without a session");
        }
        thread::sleep(Duration::from_millis(10));
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    child
        .stdout
        .take()
        .expect("capture stdout")
        .read_to_string(&mut stdout)
        .expect("read stdout");
    child
        .stderr
        .take()
        .expect("capture stderr")
        .read_to_string(&mut stderr)
        .expect("read stderr");

    assert_eq!(status.code(), Some(3), "stderr was: {stderr}");
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    let payload = parse_stderr_error(&stderr);
    assert_eq!(payload["error"]["code"], json!("auth_required"));
    assert_eq!(payload["error"]["exit_code"], json!(3));
    assert!(!storage_path.exists());
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_apps_pipeline_without_a_session_never_starts_browser_login() {
    let temp = temp_test_dir("bb-apps-pipeline-auth-required");
    let bb_home = temp.join("bb-home");
    let storage_path = temp.join("missing-auth-sessions.json");
    write_bb_org_config(&bb_home, "test");

    let mut child = bb_command()
        .env("BB_HOME", &bb_home)
        .env("BB_AUTH_STORAGE", "file")
        .env("BB_AUTH_STORAGE_FILE", &storage_path)
        .args(["apps", "contract", "--base-url", APPROVED_APPS_BASE_URL])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start piped bb apps contract");
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().expect("poll bb apps contract") {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().expect("stop hung bb apps contract");
            child.wait().expect("reap hung bb apps contract");
            panic!("piped bb apps contract did not fail promptly without a session");
        }
        thread::sleep(Duration::from_millis(10));
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    child
        .stdout
        .take()
        .expect("capture stdout")
        .read_to_string(&mut stdout)
        .expect("read stdout");
    child
        .stderr
        .take()
        .expect("capture stderr")
        .read_to_string(&mut stderr)
        .expect("read stderr");

    assert_eq!(status.code(), Some(3), "stderr was: {stderr}");
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    assert!(stderr.contains("BuilderBot CLI auth is required"));
    assert!(!stderr.contains("Opening BuilderBot auth login"));
    assert!(!stderr.contains("127.0.0.1"));
    assert!(!storage_path.exists());
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
    assert_bb_tools_session_credential(
        "bb-tools-session",
        "default",
        "stored-bb-tools-session",
        |_temp, _command| {},
    );
}

fn assert_bb_tools_session_credential(
    temp_name: &str,
    storage_profile: &str,
    storage_credential: &str,
    configure_command: impl FnOnce(&Path, &mut std::process::Command),
) {
    let server = MockServer::start(vec![
        list_tools_response("utils", calculate_tool_schema(false)),
        MockResponse::json(json!({
            "content": [{"text": {"text": "{\"sum\":5}"}}],
            "is_error": false
        })),
    ]);
    let temp = temp_test_dir(temp_name);
    let storage_path = temp.join("auth-sessions.json");
    let storage_key = browser_auth_storage_key(
        storage_profile,
        &format!("{}/cash-app/goose", server.base_url),
    );
    fs::write(
        &storage_path,
        serde_json::to_string_pretty(&json!({
            storage_key: {
                "sessionCredential": storage_credential,
                "expiresAt": "2026-06-15T00:00:00Z"
            }
        }))
        .expect("serialize storage"),
    )
    .expect("write auth storage");

    let mut command = server.bb_tools_command();
    configure_command(&temp, &mut command);
    let output = command
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
        Some(storage_credential)
    );
    assert_eq!(
        requests[1]
            .headers
            .get("x-bb-session-credential")
            .map(String::as_str),
        Some(storage_credential)
    );
    assert_eq!(requests[0].path, BB_TOOLS_LIST_TOOLS_PATH);
    assert_eq!(requests[1].path, BB_TOOLS_CALL_TOOL_PATH);
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn bb_tools_resolves_session_credential_from_current_profile() {
    assert_bb_tools_session_credential(
        "bb-tools-current-profile-session",
        "local",
        "stored-current-profile-session",
        |temp, command| {
            let bb_home = temp.join("bb-home");
            write_bb_org_config(&bb_home, "test");
            fs::write(
                bb_home.join("skills.yaml"),
                "current_profile: local\nprofiles:\n  local: {}\n",
            )
            .expect("write skills config");
            command.env("BB_HOME", &bb_home);
        },
    );
}

#[test]
fn bb_tools_env_profile_does_not_require_readable_skills_config() {
    assert_bb_tools_session_credential(
        "bb-tools-env-profile-session",
        "env-profile",
        "stored-env-profile-session",
        |temp, command| {
            let malformed_config = temp.join("malformed-skills.yaml");
            fs::write(&malformed_config, "current_profile: [").expect("write malformed config");
            command
                .env("BB_SKILLS_CONFIG", &malformed_config)
                .env("BB_SKILLS_PROFILE", "env-profile");
        },
    );
}

#[test]
fn bb_tools_malformed_skills_config_falls_back_to_default_profile() {
    assert_bb_tools_session_credential(
        "bb-tools-default-profile-session",
        "default",
        "stored-default-profile-session",
        |temp, command| {
            let malformed_config = temp.join("malformed-skills.yaml");
            fs::write(&malformed_config, "current_profile: [").expect("write malformed config");
            command.env("BB_SKILLS_CONFIG", &malformed_config);
        },
    );
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
                "summary": "Cloudflare-backed internal Block App Kit CLI (local exec)"
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
