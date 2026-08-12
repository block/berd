use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

pub(super) fn push_tool_manager_dirs(paths: &mut Vec<PathBuf>) {
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".amp/bin"));
        paths.push(home.join(".local/bin"));
        paths.push(home.join(".npm-global/bin"));
        paths.push(home.join(".local/share/mise/shims"));
        paths.push(home.join(".volta/bin"));
        paths.push(home.join(".asdf/shims"));
    }
    paths.push(PathBuf::from("/usr/local/bin"));
    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/opt/homebrew/bin"));
        paths.push(PathBuf::from("/opt/local/bin"));
    }
    if let Some(home) = dirs::home_dir() {
        push_latest_versioned_bin(paths, &home.join(".nvm/versions/node"), "bin");
        push_latest_versioned_bin(
            paths,
            &home.join(".local/share/fnm/node-versions"),
            "installation/bin",
        );
    }
}

fn push_latest_versioned_bin(paths: &mut Vec<PathBuf>, root: &Path, bin_subpath: &str) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut versions: Vec<_> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .collect();
    versions.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    if let Some(latest) = versions.first() {
        paths.push(latest.path().join(bin_subpath));
    }
}

pub(super) fn dedupe_paths(paths: &mut Vec<PathBuf>) {
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
}

pub(super) fn build_terminal_path(path: Option<&str>) -> String {
    super::build_extended_path(path, &[], false)
}
