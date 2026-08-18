use serde::Serialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
};
use tauri::{Manager, State};

use crate::services::{bundled_agents, distro_bundle::DistroBundleState};

const MAX_PERSONA_IMPORT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_AGENT_IMAGE_IMPORT_BYTES: u64 = 10 * 1024 * 1024;
const PERSONA_MARKDOWN_SUFFIX: &str = ".persona.md";
const AGENT_MARKDOWN_SUFFIX: &str = ".md";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFileReadResult {
    pub file_contents: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedBundledAgentAllocation {
    pub path: String,
    pub source_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBinaryFileReadResult {
    pub file_bytes: Vec<u8>,
    pub file_name: String,
}

fn validate_import_persona_path(source_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(source_path);
    let metadata = validate_existing_regular_file(&path, "import")?;
    validate_supported_import_extension(&path)?;
    validate_file_size(metadata.len(), "Persona import file")?;
    canonicalize_path(&path, "import")
}

fn validate_import_agent_image_path(source_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(source_path);
    let metadata = validate_existing_regular_file(&path, "agent image import")?;
    let lower_name = lower_file_name(&path)?;
    if !lower_name.ends_with(".png") {
        return Err("Unsupported file type. Expected a PNG file.".to_string());
    }
    if metadata.len() > MAX_AGENT_IMAGE_IMPORT_BYTES {
        return Err("Agent image import file must be 10 MB or smaller.".to_string());
    }
    canonicalize_path(&path, "agent image import")
}

fn validate_agent_source_path(
    source_path: &str,
    agents_root: Option<&Path>,
) -> Result<PathBuf, String> {
    let trusted_root = match agents_root {
        Some(root) => root.to_path_buf(),
        None => dirs::home_dir()
            .ok_or_else(|| "Failed to resolve home directory for agent source read".to_string())?
            .join(".agents")
            .join("agents"),
    };
    validate_agent_source_path_with_roots(source_path, &[trusted_root])
}

fn validate_agent_source_path_with_roots(
    source_path: &str,
    trusted_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let path = PathBuf::from(source_path);
    let metadata = validate_existing_regular_file(&path, "agent source")?;
    validate_supported_agent_source_extension(&path)?;
    validate_file_size(metadata.len(), "Agent source file")?;
    let canonical_path = canonicalize_path(&path, "agent source")?;

    let trusted_root = trusted_roots.iter().find_map(|root| {
        let canonical_root = root.canonicalize().ok()?;
        canonical_path
            .starts_with(&canonical_root)
            .then_some(canonical_root)
    });
    if trusted_root.is_none() {
        return Err(format!(
            "Agent source file '{}' is outside the trusted agent source directory",
            path.display()
        ));
    }

    Ok(canonical_path)
}

fn validate_existing_regular_file(
    path: &Path,
    context: &'static str,
) -> Result<std::fs::Metadata, String> {
    if path.as_os_str().is_empty() {
        return Err(format!("Selected {context} file path is empty"));
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|err| {
        format!(
            "Failed to access {context} file '{}': {}",
            path.display(),
            err
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Selected {context} path '{}' is a symbolic link. Choose the target file directly.",
            path.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!(
            "Selected {context} path '{}' is not a file",
            path.display()
        ));
    }
    Ok(metadata)
}

fn canonicalize_path(path: &Path, context: &'static str) -> Result<PathBuf, String> {
    path.canonicalize().map_err(|err| {
        format!(
            "Failed to resolve {context} file '{}': {}",
            path.display(),
            err
        )
    })
}

fn lower_file_name(path: &Path) -> Result<String, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Selected file is missing a valid filename".to_string())?;
    Ok(file_name.to_ascii_lowercase())
}

fn validate_supported_import_extension(path: &Path) -> Result<(), String> {
    let lower_name = lower_file_name(path)?;
    if !lower_name.ends_with(".json") && !lower_name.ends_with(PERSONA_MARKDOWN_SUFFIX) {
        return Err("Unsupported file type. Expected a .persona.md or .json file.".to_string());
    }
    Ok(())
}

fn validate_supported_agent_source_extension(path: &Path) -> Result<(), String> {
    let lower_name = lower_file_name(path)?;
    if !lower_name.ends_with(AGENT_MARKDOWN_SUFFIX) {
        return Err("Unsupported agent source file type. Expected a .md file.".to_string());
    }
    Ok(())
}

fn validate_file_size(size: u64, label: &'static str) -> Result<(), String> {
    if size > MAX_PERSONA_IMPORT_BYTES {
        return Err(format!(
            "{label} must be 4 MB or smaller. Selected file is {size} bytes."
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn list_managed_bundled_agent_allocations(
    app: tauri::AppHandle,
    state: State<'_, DistroBundleState>,
) -> Result<Vec<ManagedBundledAgentAllocation>, String> {
    let bundle = state
        .bundle()
        .ok_or_else(|| "Bundled agent distribution is unavailable".to_string())?;
    let e2e_agents_dir = app
        .try_state::<crate::services::e2e_mode::E2eMode>()
        .map(|mode| mode.goose_agents_dir());
    Ok(
        bundled_agents::verified_managed_agent_allocations(bundle, e2e_agents_dir.as_deref())?
            .into_iter()
            .map(|(path, source_id)| ManagedBundledAgentAllocation { path, source_id })
            .collect(),
    )
}

#[tauri::command]
pub fn repair_bundled_agent(
    app: tauri::AppHandle,
    file_name: String,
    state: State<'_, DistroBundleState>,
) -> Result<(), String> {
    let bundle = state
        .bundle()
        .ok_or_else(|| "Bundled agent distribution is unavailable".to_string())?;
    let e2e_agents_dir = app
        .try_state::<crate::services::e2e_mode::E2eMode>()
        .map(|mode| mode.goose_agents_dir());
    bundled_agents::repair_bundled_agent(bundle, e2e_agents_dir.as_deref(), &file_name)
}

#[tauri::command]
pub fn read_import_persona_file(source_path: String) -> Result<ImportFileReadResult, String> {
    let path = validate_import_persona_path(&source_path)?;
    read_persona_file(path, "import")
}

#[tauri::command]
pub fn read_import_agent_image(source_path: String) -> Result<ImportBinaryFileReadResult, String> {
    let path = validate_import_agent_image_path(&source_path)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Selected file is missing a valid filename".to_string())?
        .to_string();
    let file = std::fs::File::open(&path)
        .map_err(|err| format!("Failed to open agent image '{}': {err}", path.display()))?;
    let mut file_bytes = Vec::new();
    file.take(MAX_AGENT_IMAGE_IMPORT_BYTES + 1)
        .read_to_end(&mut file_bytes)
        .map_err(|err| format!("Failed to read agent image '{}': {err}", path.display()))?;
    if file_bytes.len() as u64 > MAX_AGENT_IMAGE_IMPORT_BYTES {
        return Err("Agent image import file must be 10 MB or smaller.".to_string());
    }
    Ok(ImportBinaryFileReadResult {
        file_bytes,
        file_name,
    })
}

#[tauri::command]
pub fn read_agent_source_file(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<ImportFileReadResult, String> {
    let e2e_agents_dir = app
        .try_state::<crate::services::e2e_mode::E2eMode>()
        .map(|mode| mode.goose_agents_dir());
    let path = validate_agent_source_path(&source_path, e2e_agents_dir.as_deref())?;
    read_persona_file(path, "agent source")
}

#[cfg(test)]
fn read_agent_source_file_with_roots(
    source_path: String,
    trusted_roots: &[PathBuf],
) -> Result<ImportFileReadResult, String> {
    let path = validate_agent_source_path_with_roots(&source_path, trusted_roots)?;
    read_persona_file(path, "agent source")
}

fn read_persona_file(path: PathBuf, context: &'static str) -> Result<ImportFileReadResult, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Selected file is missing a valid filename".to_string())?
        .to_string();
    let file_bytes = std::fs::read(&path).map_err(|err| {
        format!(
            "Failed to read {context} file '{}': {}",
            path.display(),
            err
        )
    })?;
    let file_contents =
        String::from_utf8(file_bytes).map_err(|_| "File is not valid UTF-8 text".to_string())?;

    Ok(ImportFileReadResult {
        file_contents,
        file_name,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        read_agent_source_file_with_roots, read_import_agent_image, read_import_persona_file,
        validate_agent_source_path_with_roots, validate_import_agent_image_path,
        validate_import_persona_path, MAX_AGENT_IMAGE_IMPORT_BYTES, MAX_PERSONA_IMPORT_BYTES,
    };
    use tempfile::{tempdir, Builder};

    #[test]
    fn validate_import_persona_path_rejects_unsupported_files() {
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
    fn validate_import_persona_path_accepts_json_and_persona_markdown_files() {
        let file = Builder::new()
            .prefix("persona-import-")
            .suffix(".json")
            .tempfile()
            .unwrap();
        std::fs::write(file.path(), b"{}").unwrap();

        let validated = validate_import_persona_path(file.path().to_str().unwrap()).unwrap();

        assert_eq!(validated, file.path().canonicalize().unwrap());

        let file = Builder::new()
            .prefix("persona-import-")
            .suffix(".persona.md")
            .tempfile()
            .unwrap();
        std::fs::write(file.path(), b"---\nname: scout\n---").unwrap();

        let validated = validate_import_persona_path(file.path().to_str().unwrap()).unwrap();

        assert_eq!(validated, file.path().canonicalize().unwrap());
    }

    #[test]
    fn validate_import_persona_path_rejects_plain_markdown_files() {
        let file = Builder::new()
            .prefix("persona-import-")
            .suffix(".md")
            .tempfile()
            .unwrap();

        let result = validate_import_persona_path(file.path().to_str().unwrap());

        assert!(result.is_err());
    }

    #[test]
    fn validate_import_agent_image_path_accepts_agent_png() {
        let file = Builder::new()
            .prefix("scout-")
            .suffix(".agent.png")
            .tempfile()
            .unwrap();
        std::fs::write(file.path(), b"png bytes").unwrap();

        let validated = validate_import_agent_image_path(file.path().to_str().unwrap()).unwrap();

        assert_eq!(validated, file.path().canonicalize().unwrap());
    }

    #[test]
    fn validate_import_agent_image_path_accepts_plain_png_for_compatibility_detection() {
        let file = Builder::new().suffix(".png").tempfile().unwrap();

        let validated = validate_import_agent_image_path(file.path().to_str().unwrap()).unwrap();

        assert_eq!(validated, file.path().canonicalize().unwrap());
    }

    #[test]
    fn read_import_agent_image_rejects_oversized_files() {
        let file = Builder::new().suffix(".agent.png").tempfile().unwrap();
        file.as_file()
            .set_len(MAX_AGENT_IMAGE_IMPORT_BYTES + 1)
            .unwrap();

        let result = read_import_agent_image(file.path().to_string_lossy().into_owned());

        assert!(result.unwrap_err().contains("10 MB or smaller"));
    }

    #[test]
    fn read_import_agent_image_returns_binary_bytes() {
        let file = Builder::new().suffix(".agent.png").tempfile().unwrap();
        std::fs::write(file.path(), [0x89, 0x50, 0x4e, 0x47]).unwrap();

        let result = read_import_agent_image(file.path().to_string_lossy().into_owned()).unwrap();

        assert_eq!(result.file_bytes, [0x89, 0x50, 0x4e, 0x47]);
        assert!(result.file_name.ends_with(".agent.png"));
    }

    #[test]
    fn validate_agent_source_path_rejects_files_outside_trusted_root() {
        let trusted_root = tempdir().unwrap();
        let file = Builder::new()
            .prefix("agent-source-")
            .suffix(".md")
            .tempfile()
            .unwrap();

        let result = validate_agent_source_path_with_roots(
            file.path().to_str().unwrap(),
            &[trusted_root.path().to_path_buf()],
        );

        assert!(result.unwrap_err().contains("outside the trusted"));
    }

    #[test]
    fn validate_agent_source_path_rejects_json_files() {
        let trusted_root = tempdir().unwrap();
        let file_path = trusted_root.path().join("scout.json");
        std::fs::write(&file_path, b"{}").unwrap();

        let result = validate_agent_source_path_with_roots(
            file_path.to_str().unwrap(),
            &[trusted_root.path().to_path_buf()],
        );

        assert!(result.unwrap_err().contains("Expected a .md file"));
    }

    #[test]
    fn validate_agent_source_path_accepts_plain_markdown_files_inside_trusted_root() {
        let trusted_root = tempdir().unwrap();
        let file_path = trusted_root.path().join("scout.md");
        std::fs::write(&file_path, b"---\nname: Scout\n---\n\nPrompt").unwrap();

        let validated = validate_agent_source_path_with_roots(
            file_path.to_str().unwrap(),
            &[trusted_root.path().to_path_buf()],
        )
        .unwrap();

        assert_eq!(validated, file_path.canonicalize().unwrap());
    }

    #[test]
    fn validate_agent_source_path_accepts_persona_markdown_files_inside_trusted_root() {
        let trusted_root = tempdir().unwrap();
        let file_path = trusted_root.path().join("scout.persona.md");
        std::fs::write(&file_path, b"---\nname: Scout\n---\n\nPrompt").unwrap();

        let validated = validate_agent_source_path_with_roots(
            file_path.to_str().unwrap(),
            &[trusted_root.path().to_path_buf()],
        )
        .unwrap();

        assert_eq!(validated, file_path.canonicalize().unwrap());
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

    #[cfg(unix)]
    #[test]
    fn validate_agent_source_path_rejects_symbolic_links() {
        let trusted_root = tempdir().unwrap();
        let target = trusted_root.path().join("target.md");
        let link = trusted_root.path().join("link.md");
        std::fs::write(&target, b"---\nname: Scout\n---\n\nPrompt").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let result = validate_agent_source_path_with_roots(
            link.to_str().unwrap(),
            &[trusted_root.path().to_path_buf()],
        );

        assert!(result.unwrap_err().contains("symbolic link"));
    }

    #[test]
    fn validate_agent_source_path_rejects_oversized_files() {
        let trusted_root = tempdir().unwrap();
        let file_path = trusted_root.path().join("large.md");
        std::fs::write(&file_path, b"").unwrap();
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&file_path)
            .unwrap();
        file.set_len(MAX_PERSONA_IMPORT_BYTES + 1).unwrap();

        let result = validate_agent_source_path_with_roots(
            file_path.to_str().unwrap(),
            &[trusted_root.path().to_path_buf()],
        );

        assert!(result.unwrap_err().contains("4 MB or smaller"));
    }

    #[test]
    fn isolated_agent_root_rejects_normal_home_agent_sources() {
        let tmp = tempdir().unwrap();
        let isolated_root = tmp
            .path()
            .join("run")
            .join("goose")
            .join(".agents")
            .join("agents");
        let normal_root = tmp.path().join("home").join(".agents").join("agents");
        std::fs::create_dir_all(&isolated_root).unwrap();
        std::fs::create_dir_all(&normal_root).unwrap();
        let isolated_agent = isolated_root.join("isolated.md");
        let normal_agent = normal_root.join("normal.md");
        std::fs::write(&isolated_agent, b"---\nname: Isolated\n---\n\nPrompt").unwrap();
        std::fs::write(&normal_agent, b"---\nname: Normal\n---\n\nSecret").unwrap();

        let isolated = validate_agent_source_path_with_roots(
            isolated_agent.to_str().unwrap(),
            std::slice::from_ref(&isolated_root),
        )
        .unwrap();
        assert_eq!(isolated, isolated_agent.canonicalize().unwrap());

        let error =
            validate_agent_source_path_with_roots(normal_agent.to_str().unwrap(), &[isolated_root])
                .unwrap_err();
        assert!(error.contains("outside the trusted"));
        assert_eq!(
            std::fs::read_to_string(normal_agent).unwrap(),
            "---\nname: Normal\n---\n\nSecret"
        );
    }

    #[test]
    fn read_agent_source_file_rejects_invalid_utf8_in_trusted_root() {
        let trusted_root = tempdir().unwrap();
        let file_path = trusted_root.path().join("bad.md");
        std::fs::write(&file_path, [0xff]).unwrap();

        let result = read_agent_source_file_with_roots(
            file_path.to_string_lossy().into_owned(),
            &[trusted_root.path().to_path_buf()],
        );

        assert_eq!(result.unwrap_err(), "File is not valid UTF-8 text");
    }

    #[test]
    fn read_agent_source_file_returns_valid_trusted_markdown() {
        let trusted_root = tempdir().unwrap();
        let file_path = trusted_root.path().join("scout.md");
        std::fs::write(&file_path, b"---\nname: Scout\n---\n\nPrompt").unwrap();

        let result = read_agent_source_file_with_roots(
            file_path.to_string_lossy().into_owned(),
            &[trusted_root.path().to_path_buf()],
        )
        .unwrap();

        assert_eq!(result.file_contents, "---\nname: Scout\n---\n\nPrompt");
        assert_eq!(result.file_name, "scout.md");
    }
}
