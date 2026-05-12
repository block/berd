use serde::Serialize;
use std::path::PathBuf;

const MAX_PERSONA_IMPORT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFileReadResult {
    pub file_contents: String,
    pub file_name: String,
}

fn validate_import_persona_path(source_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(source_path);

    if path.as_os_str().is_empty() {
        return Err("Selected file path is empty".to_string());
    }

    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|err| format!("Failed to access import file '{}': {}", path.display(), err))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Selected import path '{}' is a symbolic link. Choose the target file directly.",
            path.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!(
            "Selected import path '{}' is not a file",
            path.display()
        ));
    }
    let canonical_path = path.canonicalize().map_err(|err| {
        format!(
            "Failed to resolve import file '{}': {}",
            path.display(),
            err
        )
    })?;

    let extension = canonical_path
        .extension()
        .and_then(|ext| ext.to_str())
        .ok_or_else(|| "Unsupported file type. Expected a .json file.".to_string())?;
    if !extension.eq_ignore_ascii_case("json") {
        return Err("Unsupported file type. Expected a .json file.".to_string());
    }
    if metadata.len() > MAX_PERSONA_IMPORT_BYTES {
        return Err(format!(
            "Persona import file must be 4 MB or smaller. Selected file is {} bytes.",
            metadata.len()
        ));
    }

    Ok(canonical_path)
}

#[tauri::command]
pub fn read_import_persona_file(source_path: String) -> Result<ImportFileReadResult, String> {
    let path = validate_import_persona_path(&source_path)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Selected file is missing a valid filename".to_string())?
        .to_string();
    let file_bytes = std::fs::read(&path)
        .map_err(|err| format!("Failed to read import file '{}': {}", path.display(), err))?;
    let file_contents =
        String::from_utf8(file_bytes).map_err(|_| "File is not valid UTF-8 text".to_string())?;

    Ok(ImportFileReadResult {
        file_contents,
        file_name,
    })
}

#[cfg(test)]
mod tests {
    use super::{read_import_persona_file, validate_import_persona_path, MAX_PERSONA_IMPORT_BYTES};
    use tempfile::{tempdir, Builder};

    #[test]
    fn validate_import_persona_path_rejects_non_json_files() {
        let file = Builder::new()
            .prefix("persona-import-")
            .suffix(".txt")
            .tempfile()
            .unwrap();

        let result = validate_import_persona_path(file.path().to_str().unwrap());

        assert!(result.is_err());
    }

    #[test]
    fn validate_import_persona_path_rejects_directories() {
        let directory = tempdir().unwrap();

        let result = validate_import_persona_path(directory.path().to_str().unwrap());

        assert!(result.is_err());
    }

    #[test]
    fn validate_import_persona_path_accepts_json_files() {
        let file = Builder::new()
            .prefix("persona-import-")
            .suffix(".json")
            .tempfile()
            .unwrap();
        std::fs::write(file.path(), b"{}").unwrap();

        let validated = validate_import_persona_path(file.path().to_str().unwrap()).unwrap();

        assert_eq!(validated, file.path().canonicalize().unwrap());
    }

    #[test]
    fn read_import_persona_file_rejects_oversized_files() {
        let file = Builder::new()
            .prefix("persona-import-")
            .suffix(".json")
            .tempfile()
            .unwrap();
        file.as_file()
            .set_len(MAX_PERSONA_IMPORT_BYTES + 1)
            .unwrap();

        let result = read_import_persona_file(file.path().to_string_lossy().into_owned());

        assert!(result.unwrap_err().contains("4 MB or smaller"));
    }

    #[test]
    fn read_import_persona_file_rejects_invalid_utf8() {
        let file = Builder::new()
            .prefix("persona-import-")
            .suffix(".json")
            .tempfile()
            .unwrap();
        std::fs::write(file.path(), [0xff]).unwrap();

        let result = read_import_persona_file(file.path().to_string_lossy().into_owned());

        assert_eq!(result.unwrap_err(), "File is not valid UTF-8 text");
    }

    #[test]
    fn read_import_persona_file_returns_utf8_contents() {
        let file = Builder::new()
            .prefix("persona-import-")
            .suffix(".json")
            .tempfile()
            .unwrap();
        std::fs::write(file.path(), b"{\"name\":\"Scout\"}").unwrap();

        let result = read_import_persona_file(file.path().to_string_lossy().into_owned()).unwrap();

        assert_eq!(result.file_contents, "{\"name\":\"Scout\"}");
        assert_eq!(
            result.file_name,
            file.path().file_name().unwrap().to_string_lossy()
        );
    }

    #[cfg(unix)]
    #[test]
    fn validate_import_persona_path_rejects_symbolic_links() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("target.json");
        let link = directory.path().join("link.json");
        std::fs::write(&target, b"{}").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let result = validate_import_persona_path(link.to_str().unwrap());

        assert!(result.unwrap_err().contains("symbolic link"));
    }
}
