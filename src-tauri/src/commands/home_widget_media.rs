use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const MEDIA_DIRECTORY: &str = "home-widget-media";
const MAX_PHOTO_BYTES: u64 = 50 * 1024 * 1024;

// Imports are copy-only so a layout save failure or revision conflict can
// never destroy the previously confirmed photo. Orphan reconciliation is
// tracked separately and must retain every path referenced by persisted layout.

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoImportError {
    code: &'static str,
}

impl PhotoImportError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

type PhotoImportResult<T> = Result<T, PhotoImportError>;

fn validate_photo_source(path: &Path) -> PhotoImportResult<&'static str> {
    let metadata = fs::metadata(path).map_err(|_| PhotoImportError::new("readFailed"))?;
    if !metadata.is_file() {
        return Err(PhotoImportError::new("notAFile"));
    }
    if metadata.len() > MAX_PHOTO_BYTES {
        return Err(PhotoImportError::new("tooLarge"));
    }

    let kind = infer::get_from_path(path)
        .map_err(|_| PhotoImportError::new("readFailed"))?
        .ok_or_else(|| PhotoImportError::new("unsupportedType"))?;

    match kind.mime_type() {
        "image/avif" => Ok("avif"),
        "image/gif" => Ok("gif"),
        "image/jpeg" => Ok("jpg"),
        "image/png" => Ok("png"),
        "image/webp" => Ok("webp"),
        _ => Err(PhotoImportError::new("unsupportedType")),
    }
}

#[tauri::command]
pub async fn import_home_widget_photo(
    app: AppHandle,
    source_path: String,
) -> PhotoImportResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_home_widget_photo_blocking(&app, source_path)
    })
    .await
    .map_err(|_| PhotoImportError::new("importFailed"))?
}

fn import_home_widget_photo_blocking(
    app: &AppHandle,
    source_path: String,
) -> PhotoImportResult<String> {
    let source = PathBuf::from(source_path);
    let extension = validate_photo_source(&source)?;

    let media_root = app
        .path()
        .app_data_dir()
        .map_err(|_| PhotoImportError::new("importFailed"))?
        .join(MEDIA_DIRECTORY);
    fs::create_dir_all(&media_root).map_err(|_| PhotoImportError::new("importFailed"))?;

    let destination = media_root.join(format!("{}.{}", Uuid::new_v4(), extension));
    fs::copy(&source, &destination).map_err(|_| PhotoImportError::new("importFailed"))?;

    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_destination_extension_from_supported_file_content() {
        let root = std::env::temp_dir().join(format!("berd-photo-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let png_named_jpeg = root.join("photo.jpg");
        fs::write(
            &png_named_jpeg,
            [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0],
        )
        .unwrap();

        assert_eq!(validate_photo_source(&png_named_jpeg).unwrap(), "png");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_detected_image_formats_the_widget_does_not_support() {
        let root = std::env::temp_dir().join(format!("berd-photo-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let tiff_named_jpeg = root.join("photo.jpg");
        fs::write(&tiff_named_jpeg, [b'I', b'I', 42, 0, 8, 0, 0, 0]).unwrap();

        assert!(validate_photo_source(&tiff_named_jpeg).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_directories_and_files_over_the_size_limit() {
        let root = std::env::temp_dir().join(format!("berd-photo-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let directory_error = validate_photo_source(&root).unwrap_err();
        assert_eq!(directory_error.code, "notAFile");

        let oversized = root.join("oversized.png");
        let file = fs::File::create(&oversized).unwrap();
        file.set_len(MAX_PHOTO_BYTES + 1).unwrap();
        let size_error = validate_photo_source(&oversized).unwrap_err();
        assert_eq!(size_error.code, "tooLarge");

        let _ = fs::remove_dir_all(root);
    }
}
