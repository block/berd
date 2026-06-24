//! End-to-end tests for the sq `agent-tools` binary. The `bb` binary suite
//! lives in `bb_e2e.rs`; shared mock server infrastructure lives in `common/`.

mod common;

use std::fs;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[cfg(unix)]
use common::temp_test_dir;
#[cfg(unix)]
use common::write_fake_executable;
use common::{
    calculate_tool_schema, list_tools_response, output_text, post_message_tool_schema,
    tool_response, tool_response_with_extension_description, unique_suffix,
    write_extensions_catalog, MockResponse, MockServer, CALL_TOOL_PATH, LIST_EXTENSIONS_PATH,
    LIST_TOOLS_PATH,
};

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
fn tool_help_surfaces_schema_derived_flags() {
    let server = MockServer::start(vec![list_tools_response(
        "utils",
        calculate_tool_schema(true),
    )]);

    let output = server
        .command()
        .args(["utils", "calculate", "--help"])
        .output()
        .expect("run agent-tools help");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(stdout.contains("--numbers <NUMBER>"));
    assert!(stdout.contains("--operation <TEXT>"));
    assert!(stdout.contains("--round-up"));
    assert!(stdout.contains("--no-round-up"));
    assert!(stdout.contains("--json <JSON>"));
    assert!(stdout.contains("--raw"));
    assert!(stdout.contains("--header <KEY=VALUE>"));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, LIST_TOOLS_PATH);
    assert_eq!(requests[0].body["extension_name"], json!("utils"));
}

#[test]
fn tool_help_prints_full_untruncated_description() {
    let long_description = "Look up table metadata to inform downstream queries.\n\n\
        IMPORTANT: Table Meta Data tells you about the structure of a data table, \
        what it is used for, what tables it joins with, who owns it and uses it frequently. \
        Table names are returned in order of search relevance, with the total users recently \
        active and table verification status weighted into the ranking signal so that \
        well-trafficked, human-verified tables surface ahead of stale or unverified ones.\n\n\
        Workflow guidance the agent must follow:\n\
        1. If the table name is unknown, use the user question as search text to find \
        relevant tables that would best answer the analysis question. Enrich the search \
        text with relevant business keywords, brand context, and any known column \
        synonyms so the semantic search can ground its match against the catalog.\n\
        2. If the table name is known - either from the user or the output of \
        query_expert_search - include the table_name argument. The table name MUST be \
        provided in the canonical DATABASE.SCHEMA.TABLE_NAME format. Lowercase input is \
        accepted and will be normalized server-side.\n\
        3. Use the table_owner argument to filter on tables owned by a specific LDAP \
        username such as PAZAR. This is useful for tracing table provenance during \
        on-call investigations or when you need to escalate a verification request.\n\
        4. Read the entire TABLE DESCRIPTION and COLUMN SCHEMA returned to understand \
        what the table contains, how it is partitioned, and which columns are safe to \
        join against without producing fan-out results in your analytics query.\n\n\
        Notes on verification status: VERIFIED tables have been reviewed by a human \
        steward; UNVERIFIED tables may still be useful but should be cross-checked. \
        Brands cover Block, Square, Cash App, Afterpay, Tidal, and Bitkey.\n\
        UNIQUE-MARKER-FOR-FULL-DESCRIPTION-BODY";
    let server = MockServer::start(vec![tool_response(
        "query-expert",
        "find_table_meta_data",
        long_description,
        json!({"type": "object", "properties": {}}).to_string(),
    )]);

    let output = server
        .command()
        .args(["query-expert", "find-table-meta-data", "--help"])
        .output()
        .expect("run tool help");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(
        stdout.contains("UNIQUE-MARKER-FOR-FULL-DESCRIPTION-BODY"),
        "expected full tool description in --help output, got: {stdout}"
    );
    assert!(stdout.contains("Workflow guidance the agent must follow"));
    assert!(stdout.contains("DATABASE.SCHEMA.TABLE_NAME"));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, LIST_TOOLS_PATH);
}

#[test]
fn extension_help_truncates_long_description_and_advertises_describe() {
    let description = format!(
        "{} {}\n\n{}",
        "Slack tools for chat.",
        "Use this extension to search channels, read threads, and post messages.".repeat(20),
        "This second paragraph should only appear in --describe output."
    );
    let server = MockServer::start(vec![tool_response_with_extension_description(
        "slack",
        &description,
        "search_messages",
        "Search Slack messages",
        json!({
            "type": "object",
            "properties": {}
        })
        .to_string(),
    )]);

    let output = server
        .command()
        .args(["slack", "--help"])
        .output()
        .expect("run extension help");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(stdout.contains("Slack tools for chat."));
    assert!(stdout.contains("describe"));
    assert!(stdout.contains("Print the full extension description/instructions."));
    assert!(stdout.contains("search-messages"));
    assert!(stdout.contains("..."));
    assert!(!stdout.contains("This second paragraph should only appear in --describe output."));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, LIST_TOOLS_PATH);
    assert_eq!(requests[0].body["extension_name"], json!("slack"));
}

#[test]
fn extension_describe_prints_full_extension_description() {
    let description = "Slack tools for chat.\n\nUse this extension to search channels,\nread threads, and post messages on behalf of the connected account.";
    let server = MockServer::start(vec![tool_response_with_extension_description(
        "slack",
        description,
        "search_messages",
        "Search Slack messages",
        json!({
            "type": "object",
            "properties": {}
        })
        .to_string(),
    )]);

    let output = server
        .command()
        .args(["slack", "describe"])
        .output()
        .expect("run extension describe");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(stdout.trim_end(), description);
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, LIST_TOOLS_PATH);
    assert_eq!(requests[0].body["extension_name"], json!("slack"));
}

#[test]
fn write_extensions_accepts_new_list_extensions_auth_fields() {
    let server = MockServer::start(vec![MockResponse::json(json!({
        "extensions": [
            {
                "name": "slack",
                "description": "Slack tools",
                "tool_count": 12,
                "anyToolRequiresUserAuth": true,
                "authSatisfiedForCaller": true
            },
            {
                "name": "airtable",
                "description": "Airtable tools",
                "tool_count": 4,
                "any_tool_requires_user_auth": false,
                "auth_satisfied_for_caller": false
            }
        ]
    }))]);
    let output_path = std::env::temp_dir().join(format!(
        "write-extensions-{}-{}.yaml",
        std::process::id(),
        unique_suffix()
    ));

    let output = server
        .command()
        .arg("--write-extensions")
        .arg(&output_path)
        .output()
        .expect("run write extensions");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);
    let catalog = fs::read_to_string(&output_path).expect("read generated catalog");
    fs::remove_file(&output_path).expect("remove generated catalog");

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    assert!(stderr.is_empty(), "stderr was: {stderr}");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, LIST_EXTENSIONS_PATH);
    assert!(catalog.contains("name: airtable"));
    assert!(catalog.contains("about: Airtable tools"));
    assert!(catalog.contains("name: slack"));
    assert!(catalog.contains("about: Slack tools"));
}

#[test]
fn tool_invocation_posts_expected_payload_and_headers() {
    let server = MockServer::start(vec![
        list_tools_response("utils", calculate_tool_schema(false)),
        MockResponse::json(json!({
            "content": [{"text": {"text": "{\"sum\":5}"}}],
            "is_error": false
        })),
    ]);

    let output = server
        .command()
        .args([
            "--playpen",
            "baxen",
            "--goosemcp-playpen",
            "smohammed",
            "utils",
            "calculate",
            "--numbers",
            "2",
            "3",
            "--operation",
            "add",
            "--header",
            "x-debug=true",
        ])
        .output()
        .expect("run agent-tools tool");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(
        serde_json::from_str::<Value>(stdout.trim()).expect("parse response JSON"),
        json!({"sum": 5})
    );

    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].path, LIST_TOOLS_PATH);
    assert_eq!(requests[1].path, CALL_TOOL_PATH);
    assert_eq!(
        requests[1].headers.get("baggage").map(String::as_str),
        Some("kgoose-playpen=baxen,envoy-route--goosemcp=playpen-smohammed")
    );
    assert_eq!(
        requests[1].headers.get("content-type").map(String::as_str),
        Some("application/json")
    );
    assert_eq!(requests[1].body["extension_name"], json!("utils"));
    assert_eq!(requests[1].body["tool_name"], json!("calculate"));
    assert_eq!(requests[1].body["headers"]["x-debug"], json!("true"));
    assert_eq!(
        serde_json::from_str::<Value>(
            requests[1].body["arguments_json"]
                .as_str()
                .expect("tool arguments_json"),
        )
        .expect("parse arguments_json"),
        json!({"numbers": [2, 3], "operation": "add"})
    );
}

#[test]
fn tool_invocation_forwards_sts_access_token_as_identity_token() {
    let server = MockServer::start(vec![
        list_tools_response("utils", calculate_tool_schema(false)),
        MockResponse::json(json!({
            "content": [{"text": {"text": "{\"sum\":5}"}}],
            "is_error": false
        })),
    ]);

    let output = server
        .command()
        .env("STS_ACCESS_TOKEN", "test-sidecar-token")
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
        .expect("run agent-tools tool");
    let requests = server.finish();
    let (_stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]
            .headers
            .get("x-forwarded-identity-token")
            .map(String::as_str),
        Some("test-sidecar-token")
    );
    assert_eq!(
        requests[1]
            .headers
            .get("x-forwarded-identity-token")
            .map(String::as_str),
        Some("test-sidecar-token")
    );
}

#[test]
fn tool_invocation_forwards_stored_session_credential_to_kgoose_calls() {
    let server = MockServer::start(vec![
        list_tools_response("utils", calculate_tool_schema(false)),
        MockResponse::json(json!({
            "content": [{"text": {"text": "{\"sum\":5}"}}],
            "is_error": false
        })),
    ]);
    let temp = std::env::temp_dir().join(format!("sq-kgoose-cli-session-{}", unique_suffix()));
    fs::create_dir_all(&temp).expect("create temp dir");
    let storage_path = temp.join("auth-sessions.json");
    let storage_key =
        browser_auth_storage_key("default", &format!("{}/cash-app/goose", server.base_url));
    fs::write(
        &storage_path,
        serde_json::to_string_pretty(&json!({
            storage_key: {
                "sessionCredential": "stored-kgoose-session",
                "expiresAt": "2026-06-15T00:00:00Z"
            }
        }))
        .expect("serialize storage"),
    )
    .expect("write auth storage");

    let output = server
        .command()
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
        .expect("run agent-tools tool");
    let requests = server.finish();
    let (_stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]
            .headers
            .get("x-bb-session-credential")
            .map(String::as_str),
        Some("stored-kgoose-session")
    );
    assert_eq!(
        requests[1]
            .headers
            .get("x-bb-session-credential")
            .map(String::as_str),
        Some("stored-kgoose-session")
    );
    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn tool_invocation_prefers_structured_output_over_duplicate_content() {
    let server = MockServer::start(vec![
        list_tools_response("utils", calculate_tool_schema(false)),
        MockResponse::json(json!({
            "content": [
                {"text": {"text": "# Messages\n- hello"}},
                {"structured_content": {"data": {"result": {"messages": [{"text": "hello"}]}}}}
            ],
            "is_error": false,
            "structured_content_json": "{\"result\":{\"messages\":[{\"text\":\"hello\"}]}}"
        })),
    ]);

    let output = server
        .command()
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
        .expect("run agent-tools tool");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(
        serde_json::from_str::<Value>(stdout.trim()).expect("parse response JSON"),
        json!({
            "result": {
                "messages": [{"text": "hello"}]
            }
        })
    );
}

#[test]
fn tool_invocation_raw_prints_full_response_envelope() {
    let response = json!({
        "content": [
            {"text": {"text": "{\"sum\":5}"}}
        ],
        "is_error": false,
        "structured_content_json": "{\"sum\":5}"
    });
    let server = MockServer::start(vec![
        list_tools_response("utils", calculate_tool_schema(false)),
        MockResponse::json(response.clone()),
    ]);

    let output = server
        .command()
        .args([
            "utils",
            "calculate",
            "--numbers",
            "2",
            "3",
            "--operation",
            "add",
            "--raw",
        ])
        .output()
        .expect("run agent-tools tool");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(
        serde_json::from_str::<Value>(stdout.trim()).expect("parse raw response JSON"),
        response
    );
}

#[test]
fn tool_invocation_error_response_exits_nonzero() {
    let server = MockServer::start(vec![
        list_tools_response("utils", calculate_tool_schema(false)),
        MockResponse::json(json!({
            "content": [{"text": {"text": "backend tool failed"}}],
            "is_error": true
        })),
    ]);

    let output = server
        .command()
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
        .expect("run agent-tools tool");
    let _requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stdout.is_empty(), "stdout was: {stdout}");
    assert!(stderr.contains("backend tool failed"));
}

#[test]
fn optional_boolean_defaults_do_not_crash_invocation() {
    let server = MockServer::start(vec![
        tool_response(
            "slack",
            "post_message",
            "Post a Slack message",
            post_message_tool_schema(),
        ),
        MockResponse::json(json!({
            "content": [{"text": {"text": "{\"ok\":true}"}}],
            "is_error": false
        })),
    ]);

    let output = server
        .command()
        .args(["slack", "post-message", "--channel-id", "C123"])
        .output()
        .expect("run agent-tools tool");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(
        serde_json::from_str::<Value>(stdout.trim()).expect("parse rendered JSON"),
        json!({"ok": true})
    );
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].body["tool_name"], json!("post_message"));
    assert_eq!(
        serde_json::from_str::<Value>(
            requests[1].body["arguments_json"]
                .as_str()
                .expect("tool arguments_json"),
        )
        .expect("parse arguments_json"),
        json!({"channel_id": "C123"})
    );
}

#[cfg(unix)]
#[test]
fn root_metadata_commands_do_not_read_auth_storage() {
    let temp = temp_test_dir("agent-tools-metadata-auth-storage");
    let malformed_storage = temp.join("auth-sessions.json");
    fs::write(&malformed_storage, "not json").expect("write malformed auth storage");

    for args in [
        vec!["--version"],
        vec!["--summary"],
        vec!["--describe-commands"],
    ] {
        let server = MockServer::start(vec![]);
        let output = server
            .command()
            .env("BB_AUTH_STORAGE", "file")
            .env("BB_AUTH_STORAGE_FILE", &malformed_storage)
            .args(args)
            .output()
            .expect("run metadata command");
        let requests = server.finish();
        let (_stdout, stderr) = output_text(&output);

        assert!(output.status.success(), "stderr was: {stderr}");
        assert!(requests.is_empty(), "requests were: {requests:#?}");
    }

    fs::remove_dir_all(temp).expect("remove temp dir");
}

#[test]
fn describe_commands_uses_static_catalog_without_network() {
    let server = MockServer::start(vec![]);
    let catalog_path = write_extensions_catalog(
        "describe-commands",
        r#"
- name: secret
  about: Needs more auth
- name: utils
  about: Utility helpers
"#,
    );

    let output = server
        .command()
        .env("KGOOSE_EXTENSIONS_CATALOG", &catalog_path)
        .arg("--describe-commands")
        .output()
        .expect("run describe-commands");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);
    fs::remove_file(&catalog_path).expect("remove extensions catalog");

    assert!(output.status.success(), "stderr was: {stderr}");
    let description = serde_json::from_str::<Value>(&stdout).expect("parse describe output");
    assert_eq!(description["name"], json!("agent-tools"));
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

#[cfg(unix)]
#[test]
fn appkit_no_args_passes_through_to_real_cli() {
    let fake_bin = temp_test_dir("appkit-no-args-passthrough");
    write_fake_executable(
        &fake_bin,
        "appkit",
        "#!/bin/sh\nprintf 'appkit:%s\\n' \"$*\"\n",
    );
    let server = MockServer::start(vec![]);

    let output = server
        .command()
        .env("PATH", &fake_bin)
        .args(["appkit"])
        .output()
        .expect("run appkit no args");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);
    fs::remove_dir_all(&fake_bin).expect("remove fake bin");

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(stdout.trim(), "appkit:");
    assert!(requests.is_empty(), "requests were: {requests:#?}");
}

#[cfg(unix)]
#[test]
fn appkit_help_flag_passes_through_to_real_cli() {
    let fake_bin = temp_test_dir("appkit-help-passthrough");
    write_fake_executable(
        &fake_bin,
        "appkit",
        "#!/bin/sh\nprintf 'appkit:%s\\n' \"$*\"\n",
    );
    let server = MockServer::start(vec![]);

    let output = server
        .command()
        .env("PATH", &fake_bin)
        .args(["appkit", "--help"])
        .output()
        .expect("run appkit --help");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);
    fs::remove_dir_all(&fake_bin).expect("remove fake bin");

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(stdout.trim(), "appkit:--help");
    assert!(requests.is_empty(), "requests were: {requests:#?}");
}

#[cfg(unix)]
#[test]
fn appkit_on_path_is_preferred_over_uvx() {
    let fake_bin = temp_test_dir("appkit-preferred");
    write_fake_executable(
        &fake_bin,
        "appkit",
        "#!/bin/sh\nprintf 'appkit:%s\\n' \"$*\"\n",
    );
    write_fake_executable(&fake_bin, "uvx", "#!/bin/sh\nprintf 'uvx:%s\\n' \"$*\"\n");
    let server = MockServer::start(vec![]);

    let output = server
        .command()
        .env("PATH", &fake_bin)
        .args(["appkit", "deploy", "my-site", "./build"])
        .output()
        .expect("run fake appkit");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);
    fs::remove_dir_all(&fake_bin).expect("remove fake bin");

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(stdout.trim(), "appkit:deploy my-site ./build");
    assert!(!stdout.contains("uvx:"));
    assert!(requests.is_empty(), "requests were: {requests:#?}");
}

#[cfg(unix)]
#[test]
fn appkit_owned_sq_flags_are_forwarded_before_bootstrap() {
    let fake_bin = temp_test_dir("appkit-owned-flags");
    write_fake_executable(
        &fake_bin,
        "appkit",
        "#!/bin/sh\nprintf 'appkit:%s\\n' \"$*\"\n",
    );
    let server = MockServer::start(vec![]);

    let output = server
        .command()
        .env("PATH", &fake_bin)
        .env("KGOOSE_TIMEOUT", "not-a-number")
        .args([
            "appkit",
            "deploy",
            "--timeout",
            "also-not-a-number",
            "--summary",
        ])
        .output()
        .expect("run fake appkit with sq-looking args");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);
    fs::remove_dir_all(&fake_bin).expect("remove fake bin");

    assert!(output.status.success(), "stderr was: {stderr}");
    assert_eq!(
        stdout.trim(),
        "appkit:deploy --timeout also-not-a-number --summary"
    );
    assert!(requests.is_empty(), "requests were: {requests:#?}");
}

#[cfg(unix)]
#[test]
fn appkit_falls_back_to_uvx_and_preserves_environment() {
    let fake_bin = temp_test_dir("appkit-uvx-fallback");
    write_fake_executable(
        &fake_bin,
        "uvx",
        "#!/bin/sh\nprintf 'uvx:%s\\n' \"$*\"\nprintf 'sts:%s\\n' \"${STS_ACCESS_TOKEN:-}\"\n",
    );
    let server = MockServer::start(vec![]);

    let output = server
        .command()
        .env("PATH", &fake_bin)
        .env("STS_ACCESS_TOKEN", "test-sts-token")
        .args(["appkit", "deploy", "my-site", "./build"])
        .output()
        .expect("run fake uvx fallback");
    let requests = server.finish();
    let (stdout, stderr) = output_text(&output);
    fs::remove_dir_all(&fake_bin).expect("remove fake bin");

    assert!(output.status.success(), "stderr was: {stderr}");
    assert!(stdout.contains("uvx:--from mcp_block_app_kit appkit deploy my-site ./build"));
    assert!(stdout.contains("sts:test-sts-token"));
    assert!(requests.is_empty(), "requests were: {requests:#?}");
}

#[test]
fn appkit_missing_binary_prints_clear_error() {
    let server = MockServer::start(vec![]);

    let output = server
        .command()
        .env("PATH", "")
        .args(["appkit", "list"])
        .output()
        .expect("run missing appkit command");
    let requests = server.finish();
    let (_stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stderr.contains("appkit or uvx not found"));
    assert!(stderr.contains("sq agent-tools can run mcp_block_app_kit on demand"));
    assert!(requests.is_empty(), "requests were: {requests:#?}");
}

#[test]
fn inaccessible_extension_errors_are_humanized_in_e2e_flow() {
    let server = MockServer::start(vec![MockResponse::text(
        404,
        "Extension 'notion' not found or not authorized",
    )]);

    let output = server
        .command()
        .args(["--playpen", "baxen", "notion", "--help"])
        .output()
        .expect("run help for inaccessible extension");
    let requests = server.finish();
    let (_stdout, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(stderr.contains("Can't inspect `notion` in playpen `baxen`"));
    assert!(stderr.contains("wouldn't return its tools"));
    assert!(stderr.contains("G2 Connections settings"));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, LIST_TOOLS_PATH);
}
