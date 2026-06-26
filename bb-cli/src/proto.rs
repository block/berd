mod generated {
    #![allow(dead_code)]
    #![allow(deprecated)]
    #![allow(clippy::all)]

    include!(concat!(env!("OUT_DIR"), "/proto.rs"));
}

#[allow(unused_imports)]
pub use generated::*;

mod generated_serde {
    #![allow(deprecated)]
    #![allow(unused_imports)]

    use super::generated::squareup::cash::kgoose::api::v3::*;

    include!(concat!(
        env!("OUT_DIR"),
        "/squareup.cash.kgoose.api.v3.serde.rs"
    ));
}

pub const LIST_EXTENSIONS_PATH: &str = "/v3/list-extensions";
pub const LIST_TOOLS_PATH: &str = "/v3/list-tools";
pub const CALL_TOOL_PATH: &str = "/v3/call-tool";

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use prost::Message;
    use tonic::{Request, Response, Status};

    use super::squareup::cash::kgoose::api::v3::{
        self as kgoose_api_v3, tool_endpoint_service_server, user_content, CallToolRequest,
        CallToolResponse, ExecuteToolRequest, ExecuteToolResponse, ListExtensionsRequest,
        ListExtensionsResponse, ListToolsRequest, ListToolsResponse, Source, TextContent,
        ToolConfig, UserContent,
    };

    #[test]
    fn call_tool_request_round_trips_optional_fields_and_headers() {
        let request = CallToolRequest {
            extension_name: Some("jira".to_string()),
            tool_name: Some("add_comment".to_string()),
            arguments_json: Some(r#"{"text":"howdy"}"#.to_string()),
            headers: HashMap::from([("x-request-id".to_string(), "req-123".to_string())]),
            source: Some(Source::SqAgentTools.into()),
            tenancy: None,
        };

        let decoded =
            CallToolRequest::decode(request.encode_to_vec().as_slice()).expect("decode request");

        assert_eq!(decoded.extension_name.as_deref(), Some("jira"));
        assert_eq!(decoded.tool_name.as_deref(), Some("add_comment"));
        assert_eq!(
            decoded.arguments_json.as_deref(),
            Some(r#"{"text":"howdy"}"#)
        );
        assert_eq!(
            decoded.headers.get("x-request-id").map(String::as_str),
            Some("req-123")
        );
        assert_eq!(decoded.source(), Source::SqAgentTools);
    }

    #[test]
    fn generated_messages_include_imported_types() {
        let response = ListToolsResponse {
            extension_name: Some("jira".to_string()),
            extension_description: Some("Issue tracking tools".to_string()),
            tools: vec![ToolConfig {
                tool: Some("add_comment".to_string()),
                description: Some("Add a comment to an issue".to_string()),
                config_json: Some(
                    r#"{"type":"object","properties":{"text":{"type":"string"}}}"#.to_string(),
                ),
                meta_json: Some(r#"{"com.squareup.kgoose/mutates_state":true}"#.to_string()),
                mutates_state: Some(true),
                ..Default::default()
            }],
        };

        let decoded = ListToolsResponse::decode(response.encode_to_vec().as_slice())
            .expect("decode response");

        assert_eq!(decoded.extension_name.as_deref(), Some("jira"));
        assert_eq!(decoded.tools.len(), 1);
        assert_eq!(decoded.tools[0].tool.as_deref(), Some("add_comment"));
        assert_eq!(decoded.tools[0].mutates_state, Some(true));
    }

    #[test]
    fn call_tool_response_round_trips_imported_user_content() {
        let response = CallToolResponse {
            content: vec![UserContent {
                content: Some(user_content::Content::Text(TextContent {
                    text: Some("tool output".to_string()),
                })),
            }],
            is_error: Some(false),
            structured_content_json: Some(r#"{"ok":true}"#.to_string()),
        };

        let decoded =
            CallToolResponse::decode(response.encode_to_vec().as_slice()).expect("decode response");

        assert_eq!(decoded.is_error, Some(false));
        assert_eq!(
            decoded.structured_content_json.as_deref(),
            Some(r#"{"ok":true}"#)
        );

        match decoded
            .content
            .first()
            .and_then(|content| content.content.as_ref())
        {
            Some(user_content::Content::Text(text)) => {
                assert_eq!(text.text.as_deref(), Some("tool output"));
            }
            other => panic!("expected text user content, got {other:?}"),
        }
    }

    #[test]
    fn generated_service_uses_expected_name() {
        let _server =
            tool_endpoint_service_server::ToolEndpointServiceServer::new(TestToolEndpointService);

        assert_eq!(
            <tool_endpoint_service_server::ToolEndpointServiceServer<TestToolEndpointService> as tonic::server::NamedService>::NAME,
            "squareup.cash.kgoose.api.v3.ToolEndpointService"
        );
    }

    struct TestToolEndpointService;

    #[tonic::async_trait]
    impl tool_endpoint_service_server::ToolEndpointService for TestToolEndpointService {
        async fn list_extensions(
            &self,
            _request: Request<ListExtensionsRequest>,
        ) -> Result<Response<ListExtensionsResponse>, Status> {
            Ok(Response::new(ListExtensionsResponse::default()))
        }

        async fn list_tools(
            &self,
            _request: Request<ListToolsRequest>,
        ) -> Result<Response<ListToolsResponse>, Status> {
            Ok(Response::new(ListToolsResponse::default()))
        }

        async fn call_tool(
            &self,
            _request: Request<CallToolRequest>,
        ) -> Result<Response<CallToolResponse>, Status> {
            Ok(Response::new(CallToolResponse::default()))
        }

        async fn execute_tool(
            &self,
            _request: Request<ExecuteToolRequest>,
        ) -> Result<Response<ExecuteToolResponse>, Status> {
            Ok(Response::new(ExecuteToolResponse::default()))
        }
    }

    #[test]
    fn generated_client_module_is_available() {
        let _client: Option<
            kgoose_api_v3::tool_endpoint_service_client::ToolEndpointServiceClient<
                tonic::transport::Channel,
            >,
        > = None;
    }
}
