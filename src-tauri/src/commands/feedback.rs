use crate::commands::doctor::DoctorReport;
use crate::services::log_export::{self, LogDirs};
use crate::services::{distro_bundle::DistroBundleState, kgoose};
use base64::Engine as _;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::State;

const FILE_ISSUE_ENDPOINT: &str = "feedback/v1/file-issue";
const FILE_ISSUE_WITH_ATTACHMENT_ENDPOINT: &str = "feedback/v1/file-issue-with-attachment";
const FEEDBACK_PROJECT_KEY: &str = "goose-internal";
const NETWORK_ACCESS_MESSAGE: &str =
    "Unable to submit feedback. Please check that you're connected to Cloudflare WARP and try again.";
const SUBMIT_FAILED_MESSAGE: &str = "Failed to submit feedback";
const MAX_ATTACHMENTS: usize = 5;
const MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_ATTACHMENT_BASE64_CHARS: usize = (MAX_ATTACHMENT_BYTES as usize).div_ceil(3) * 4;
const ALLOWED_IMAGE_EXTENSIONS: &[&str] =
    &["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif"];
const ALLOWED_IMAGE_MIME_TYPES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/tiff",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackAttachmentFile {
    name: String,
    base64: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn submit_feedback_issue(
    app: tauri::AppHandle,
    state: State<'_, DistroBundleState>,
    title: String,
    description: String,
    attachment_paths: Option<Vec<String>>,
    attachment_files: Option<Vec<FeedbackAttachmentFile>>,
    include_logs: Option<bool>,
    doctor_report: Option<DoctorReport>,
) -> Result<Value, Value> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(feedback_error(
            "validation",
            "Feedback title must not be empty",
        ));
    }
    let description = description.trim().to_string();
    if description.is_empty() {
        return Err(feedback_error(
            "validation",
            "Feedback description must not be empty",
        ));
    }

    let attachment_paths = normalized_attachment_paths(attachment_paths.unwrap_or_default());
    let attachment_files = attachment_files.unwrap_or_default();

    // Opt-in diagnostics. Both the log directories (resolved here because it
    // needs the AppHandle) and the doctor report — gathered up-front by the UI
    // and passed in — are folded into a single zip. Best-effort: if the log
    // directories can't be resolved we log and still attach whatever else we
    // have rather than failing the report.
    let (log_dirs, doctor_report_text) = if include_logs.unwrap_or(false) {
        let log_dirs = match log_export::resolve_log_dirs(&app) {
            Ok(dirs) => Some(dirs),
            Err(error) => {
                log::warn!("feedback: skipping diagnostic logs (resolve failed): {error}");
                None
            }
        };
        let doctor_report_text = doctor_report.map(|report| report.to_diagnostic_text());
        (log_dirs, doctor_report_text)
    } else {
        (None, None)
    };

    let has_diagnostics = log_dirs.is_some() || doctor_report_text.is_some();
    if !attachment_paths.is_empty() || !attachment_files.is_empty() || has_diagnostics {
        let form = tokio::task::spawn_blocking(move || {
            build_feedback_multipart_form(
                &title,
                &description,
                &attachment_paths,
                &attachment_files,
                log_dirs,
                doctor_report_text,
            )
        })
        .await
        .map_err(|error| {
            feedback_error(
                "submitFailed",
                &format!("Failed to prepare feedback attachments: {error}"),
            )
        })??;
        return kgoose::post_multipart_detailed(
            state.inner(),
            FILE_ISSUE_WITH_ATTACHMENT_ENDPOINT,
            form,
        )
        .await
        .map_err(|error| feedback_submission_error(FILE_ISSUE_WITH_ATTACHMENT_ENDPOINT, &error));
    }

    let body = json!({
        "title": title,
        "description": description,
        "labelIds": [],
        "project_key": FEEDBACK_PROJECT_KEY,
    });

    kgoose::post_json_detailed(state.inner(), FILE_ISSUE_ENDPOINT, body)
        .await
        .map_err(|error| feedback_submission_error(FILE_ISSUE_ENDPOINT, &error))
}

fn build_feedback_multipart_form(
    title: &str,
    description: &str,
    attachment_paths: &[PathBuf],
    attachment_files: &[FeedbackAttachmentFile],
    log_dirs: Option<LogDirs>,
    doctor_report_text: Option<String>,
) -> Result<Form, Value> {
    // Build the diagnostic zip first (best-effort). It is NOT routed through the
    // image extension/MIME allowlist — that path is image-only; the zip is
    // attached as its own `application/zip` part.
    let log_zip = if log_dirs.is_some() || doctor_report_text.is_some() {
        match log_export::build_logs_zip(log_dirs.as_ref(), doctor_report_text.as_deref()) {
            Ok(bytes) if bytes.len() as u64 > MAX_ATTACHMENT_BYTES => {
                log::warn!(
                    "feedback: skipping diagnostic logs ({} bytes exceeds attachment limit)",
                    bytes.len()
                );
                None
            }
            Ok(bytes) => Some(bytes),
            Err(error) => {
                log::warn!("feedback: skipping diagnostic logs: {error}");
                None
            }
        }
    } else {
        None
    };

    validate_attachment_count(
        attachment_paths.len() + attachment_files.len() + usize::from(log_zip.is_some()),
    )?;

    let mut total_size = 0_u64;
    let mut form = Form::new()
        .text("title", title.to_string())
        .text("description", description.to_string())
        .text("project_key", FEEDBACK_PROJECT_KEY.to_string());

    for path in attachment_paths {
        let attachment = read_image_attachment(path, &mut total_size)?;
        form = form.part("attachments", attachment);
    }
    for file in attachment_files {
        let attachment = read_browser_image_attachment(file, &mut total_size)?;
        form = form.part("attachments", attachment);
    }
    if let Some(bytes) = log_zip {
        form = form.part("attachments", build_log_zip_part(bytes)?);
    }

    Ok(form)
}

fn build_log_zip_part(bytes: Vec<u8>) -> Result<Part, Value> {
    Part::bytes(bytes)
        .file_name(log_export::LOG_ZIP_FILENAME.to_string())
        .mime_str("application/zip")
        .map_err(|error| {
            feedback_error(
                "submitFailed",
                &format!("Failed to prepare diagnostic logs attachment: {error}"),
            )
        })
}

fn validate_attachment_count(attachment_count: usize) -> Result<(), Value> {
    if attachment_count > MAX_ATTACHMENTS {
        return Err(feedback_error(
            "validation",
            &format!("Feedback supports up to {MAX_ATTACHMENTS} image attachments"),
        ));
    }
    Ok(())
}

fn read_browser_image_attachment(
    file: &FeedbackAttachmentFile,
    total_size: &mut u64,
) -> Result<Part, Value> {
    prepare_browser_image_attachment(file, total_size)?.into_part()
}

fn prepare_browser_image_attachment(
    file: &FeedbackAttachmentFile,
    total_size: &mut u64,
) -> Result<PreparedImageAttachment, Value> {
    validate_image_extension(&file.name)?;
    validate_attachment_base64_size(&file.name, &file.base64)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&file.base64)
        .map_err(|error| {
            feedback_error(
                "validation",
                &format!("Failed to decode attachment '{}': {error}", file.name),
            )
        })?;
    validate_attachment_size(&file.name, bytes.len() as u64, total_size)?;
    PreparedImageAttachment::new(file.name.clone(), bytes)
}

fn read_image_attachment(path: &Path, total_size: &mut u64) -> Result<Part, Value> {
    prepare_path_image_attachment(path, total_size)?.into_part()
}

fn prepare_path_image_attachment(
    path: &Path,
    total_size: &mut u64,
) -> Result<PreparedImageAttachment, Value> {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| feedback_error("validation", "Attachment path must include a filename"))?
        .to_string();

    validate_image_extension(&filename)?;

    let metadata = std::fs::metadata(path).map_err(|error| {
        feedback_error(
            "validation",
            &format!("Failed to inspect attachment '{filename}': {error}"),
        )
    })?;
    if !metadata.is_file() {
        return Err(feedback_error(
            "validation",
            &format!("Attachment '{filename}' is not a file"),
        ));
    }
    validate_attachment_size(&filename, metadata.len(), total_size)?;

    let bytes = std::fs::read(path).map_err(|error| {
        feedback_error(
            "validation",
            &format!("Failed to read attachment '{filename}': {error}"),
        )
    })?;

    PreparedImageAttachment::new(filename, bytes)
}

#[derive(Debug)]
struct PreparedImageAttachment {
    filename: String,
    mime_type: String,
    bytes: Vec<u8>,
}

impl PreparedImageAttachment {
    fn new(filename: String, bytes: Vec<u8>) -> Result<Self, Value> {
        let mime_type = sniff_image_mime(&filename, &bytes)?;
        Ok(Self {
            filename,
            mime_type,
            bytes,
        })
    }

    fn into_part(self) -> Result<Part, Value> {
        Part::bytes(self.bytes)
            .file_name(self.filename.clone())
            .mime_str(&self.mime_type)
            .map_err(|error| {
                feedback_error(
                    "validation",
                    &format!("Failed to prepare attachment '{}': {error}", self.filename),
                )
            })
    }
}

fn validate_attachment_size(filename: &str, size: u64, total_size: &mut u64) -> Result<(), Value> {
    if size > MAX_ATTACHMENT_BYTES {
        return Err(feedback_error(
            "validation",
            &format!("Attachment '{filename}' exceeds the 10 MB file limit"),
        ));
    }

    *total_size = total_size.saturating_add(size);
    if *total_size > MAX_TOTAL_ATTACHMENT_BYTES {
        return Err(feedback_error(
            "validation",
            "Feedback image attachments exceed the 50 MB total limit",
        ));
    }

    Ok(())
}

fn validate_attachment_base64_size(filename: &str, base64: &str) -> Result<(), Value> {
    if base64.len() > MAX_ATTACHMENT_BASE64_CHARS {
        return Err(feedback_error(
            "validation",
            &format!("Attachment '{filename}' exceeds the 10 MB file limit"),
        ));
    }
    Ok(())
}

fn sniff_image_mime(filename: &str, bytes: &[u8]) -> Result<String, Value> {
    let Some(kind) = infer::get(bytes) else {
        return Err(feedback_error(
            "validation",
            &format!("Attachment '{filename}' must be an image"),
        ));
    };

    let mime_type = kind.mime_type();
    if !ALLOWED_IMAGE_MIME_TYPES.contains(&mime_type) {
        return Err(feedback_error(
            "validation",
            &format!("Attachment '{filename}' must be an image"),
        ));
    }

    Ok(mime_type.to_string())
}

fn validate_image_extension(filename: &str) -> Result<(), Value> {
    let extension = Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    if ALLOWED_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Ok(());
    }

    Err(feedback_error(
        "validation",
        "Feedback image attachments must be jpg, png, gif, webp, bmp, or tiff files",
    ))
}

fn normalized_attachment_paths(paths: Vec<String>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        let key = attachment_path_key(&path);
        if seen.insert(key) {
            normalized.push(path);
        }
    }
    normalized
}

fn attachment_path_key(path: &Path) -> String {
    let comparable = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let raw = comparable.to_string_lossy().into_owned();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        raw.to_lowercase()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        raw
    }
}

fn feedback_error(code: &str, message: &str) -> Value {
    json!({ "code": code, "message": message })
}

fn feedback_submission_error(endpoint: &str, error: &kgoose::KgooseJsonError) -> Value {
    let (code, message) = if error.is_likely_access_failure() {
        ("networkAccess", NETWORK_ACCESS_MESSAGE)
    } else {
        ("submitFailed", SUBMIT_FAILED_MESSAGE)
    };
    log_feedback_failure(endpoint, code, error);
    feedback_error(code, message)
}

fn log_feedback_failure(endpoint: &str, code: &str, kgoose_error: &kgoose::KgooseJsonError) {
    let status = kgoose_error
        .status()
        .map(|status| status.as_u16().to_string())
        .unwrap_or_else(|| "none".to_string());
    let content_type = kgoose_error.content_type().unwrap_or("none");
    let request_error_category = kgoose_error
        .request_error_kind()
        .map(kgoose::KgooseRequestErrorKind::as_str)
        .unwrap_or("none");

    log::warn!(
        "feedback submission failed: failure_kind={} endpoint={} kgoose_error_kind={} status={} content_type={} request_error_category={}",
        code,
        endpoint,
        kgoose_error.kind(),
        status,
        content_type,
        request_error_category
    );
}

#[cfg(test)]
mod tests {
    use super::{
        build_feedback_multipart_form, normalized_attachment_paths,
        prepare_browser_image_attachment, prepare_path_image_attachment, FeedbackAttachmentFile,
        MAX_ATTACHMENT_BASE64_CHARS,
    };
    use base64::Engine as _;
    use serde_json::Value;
    use std::fs;
    use std::path::{Path, PathBuf};

    const PNG_1X1_BASE64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    #[test]
    fn rejects_uploads_that_are_too_many_too_large_or_not_real_images() {
        let paths = (0..6)
            .map(|index| PathBuf::from(format!("image-{index}.png")))
            .collect::<Vec<_>>();

        let error = build_feedback_multipart_form("title", "description", &paths, &[], None, None)
            .expect_err("too many attachments should fail");

        assert!(error_message(&error).contains("up to 5 image attachments"));

        let mut total_size = 0;
        let attachment = FeedbackAttachmentFile {
            name: "large.png".to_string(),
            base64: "a".repeat(MAX_ATTACHMENT_BASE64_CHARS + 1),
        };

        let error = prepare_browser_image_attachment(&attachment, &mut total_size)
            .expect_err("oversized base64 should fail");

        assert_eq!(total_size, 0);
        assert!(error_message(&error).contains("10 MB file limit"));

        let mut total_size = 0;
        let attachment = FeedbackAttachmentFile {
            name: "fake.png".to_string(),
            base64: base64::engine::general_purpose::STANDARD.encode(b"not an image"),
        };

        let error = prepare_browser_image_attachment(&attachment, &mut total_size)
            .expect_err("fake image should fail");

        assert!(error_message(&error).contains("must be an image"));
    }

    #[test]
    fn validates_extension_before_disk_inspection() {
        let mut total_size = 0;
        let error = prepare_path_image_attachment(
            Path::new("/path/that/does/not/exist/attachment.txt"),
            &mut total_size,
        )
        .expect_err("bad extension should fail before metadata");

        assert!(error_message(&error).contains("must be jpg"));
        assert!(!error_message(&error).contains("Failed to inspect"));
    }

    #[test]
    fn prepares_real_images_with_sniffed_mime_and_deduped_paths() {
        let png_bytes = png_bytes();
        let mut total_size = 0;
        let attachment = FeedbackAttachmentFile {
            name: "screenshot.jpg".to_string(),
            base64: base64::engine::general_purpose::STANDARD.encode(&png_bytes),
        };

        let prepared = prepare_browser_image_attachment(&attachment, &mut total_size)
            .expect("valid image should prepare");

        assert_eq!(prepared.mime_type, "image/png");

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let image_path = temp_dir.path().join("image.png");
        fs::write(&image_path, &png_bytes).expect("write image");
        let alternate_path = temp_dir.path().join(".").join("image.png");

        let paths = normalized_attachment_paths(vec![
            image_path.to_string_lossy().into_owned(),
            alternate_path.to_string_lossy().into_owned(),
            " ".to_string(),
        ]);

        assert_eq!(paths, vec![image_path]);
    }

    fn error_message(error: &Value) -> &str {
        error
            .get("message")
            .and_then(Value::as_str)
            .expect("error message")
    }

    fn png_bytes() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(PNG_1X1_BASE64)
            .expect("valid png fixture")
    }
}
