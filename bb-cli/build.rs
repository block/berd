use std::path::{Path, PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=protos");

    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    unsafe {
        std::env::set_var("PROTOC", protoc);
    }

    let proto_root = PathBuf::from("protos");
    let service_proto = proto_root.join("squareup/cash/kgoose/api/v3/tool_endpoint_service.proto");
    let messages_proto =
        proto_root.join("squareup/cash/kgoose/api/v3/tool_endpoint_messages.proto");
    let descriptor_path = PathBuf::from(std::env::var("OUT_DIR")?).join("proto_descriptor.bin");

    for proto in [&service_proto, &messages_proto] {
        ensure_proto_exists(proto)?;
    }

    tonic_prost_build::configure()
        .include_file("proto.rs")
        .file_descriptor_set_path(&descriptor_path)
        .extern_path(".google.protobuf.Struct", "::pbjson_types::Struct")
        .extern_path(".google.protobuf.Value", "::pbjson_types::Value")
        .extern_path(".google.protobuf.ListValue", "::pbjson_types::ListValue")
        .extern_path(".google.protobuf.NullValue", "::pbjson_types::NullValue")
        .compile_protos(&[service_proto, messages_proto], &[proto_root])?;

    let descriptor_set = std::fs::read(&descriptor_path)?;
    pbjson_build::Builder::new()
        .register_descriptors(&descriptor_set)?
        .preserve_proto_field_names()
        .build(&[
            ".squareup.cash.kgoose.api.v3.CallToolRequest",
            ".squareup.cash.kgoose.api.v3.CallToolResponse",
            ".squareup.cash.kgoose.api.v3.EmbeddedResource",
            ".squareup.cash.kgoose.api.v3.ExtensionInfo",
            ".squareup.cash.kgoose.api.v3.ImageContent",
            ".squareup.cash.kgoose.api.v3.ListExtensionsRequest",
            ".squareup.cash.kgoose.api.v3.ListExtensionsResponse",
            ".squareup.cash.kgoose.api.v3.ListToolsRequest",
            ".squareup.cash.kgoose.api.v3.ListToolsResponse",
            ".squareup.cash.kgoose.api.v3.ResourceAnnotations",
            ".squareup.cash.kgoose.api.v3.ResourceContents",
            ".squareup.cash.kgoose.api.v3.Role",
            ".squareup.cash.kgoose.api.v3.Source",
            ".squareup.cash.kgoose.api.v3.StructuredContent",
            ".squareup.cash.kgoose.api.v3.Tenancy",
            ".squareup.cash.kgoose.api.v3.TextContent",
            ".squareup.cash.kgoose.api.v3.ToolConfig",
            ".squareup.cash.kgoose.api.v3.UserContent",
        ])?;

    Ok(())
}

fn ensure_proto_exists(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if path.exists() {
        return Ok(());
    }

    Err(format!(
        "missing required proto `{}`; run `just download-protos` first",
        path.display()
    )
    .into())
}
