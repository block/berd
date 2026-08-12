use std::{
    collections::HashSet,
    ffi::OsString,
    path::{Path, PathBuf},
};

pub(super) fn push_tool_manager_dirs(paths: &mut Vec<PathBuf>) {
    let appdata = dirs::data_dir();
    if let Some(appdata) = &appdata {
        paths.push(appdata.join("npm"));
    }
    if let Some(fnm_root) = windows_fnm_root(std::env::vars_os(), appdata.as_deref()) {
        push_windows_fnm_bin(paths, &fnm_root);
    }
    if let Some(local_appdata) = dirs::data_local_dir() {
        paths.push(local_appdata.join("Volta").join("bin"));
    }
}

pub(crate) fn windows_fnm_root(
    env: impl IntoIterator<Item = (OsString, OsString)>,
    appdata: Option<&Path>,
) -> Option<PathBuf> {
    env.into_iter()
        .find_map(|(key, value)| {
            let value_text = value.to_string_lossy();
            (key.to_string_lossy().eq_ignore_ascii_case("FNM_DIR")
                && !value_text.trim().is_empty()
                && !crate::services::shell_env::contains_hermit_path_component(&value_text))
            .then(|| PathBuf::from(value))
        })
        .or_else(|| appdata.map(|root| root.join("fnm")))
}

pub(crate) fn push_windows_fnm_bin(paths: &mut Vec<PathBuf>, fnm_root: &Path) {
    let installations = fnm_root.join("node-versions");
    if let Some(default) = validated_fnm_alias_installation(fnm_root, "default", &installations) {
        paths.push(default);
    } else if let Some(latest) = latest_semver_bin(&installations, "installation") {
        paths.push(latest);
    }
}

fn validated_fnm_alias_installation(
    fnm_root: &Path,
    alias: &str,
    installations: &Path,
) -> Option<PathBuf> {
    let resolved = fnm_root.join("aliases").join(alias).canonicalize().ok()?;
    let installations = installations.canonicalize().ok()?;
    (resolved.is_dir()
        && resolved.starts_with(&installations)
        && resolved.join("node.exe").is_file())
    .then_some(resolved)
}

fn parse_numeric_node_version(value: &str) -> Option<semver::Version> {
    let value = value.trim_start_matches(['v', 'V']);
    let normalized = match value.split('.').count() {
        1 => format!("{value}.0.0"),
        2 => format!("{value}.0"),
        _ => value.to_string(),
    };
    semver::Version::parse(&normalized).ok()
}

pub(crate) fn latest_semver_bin(root: &Path, bin_subpath: &str) -> Option<PathBuf> {
    std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let version = parse_numeric_node_version(entry.file_name().to_str()?)?;
            let path = entry.path().join(bin_subpath);
            (path.is_dir() && path.join("node.exe").is_file()).then_some((version, path))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
        .map(|(_, path)| path)
}

pub(super) fn dedupe_paths(paths: &mut Vec<PathBuf>) {
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.to_string_lossy().to_ascii_lowercase()));
}

pub(super) fn build_terminal_path(path: Option<&str>) -> String {
    super::build_extended_path(path, &[], true)
}
