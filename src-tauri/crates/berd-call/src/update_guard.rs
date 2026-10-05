//! Coordinates a running standalone call with installation of a Berd app update.

use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

fn lock_file() -> io::Result<File> {
    // Use a stable user path: CLI and GUI launch environments may disagree on
    // TMPDIR, but both have the same home directory.
    let home = std::env::var_os("HOME")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))?;
    let directory = std::path::PathBuf::from(home).join("Library/Caches/Berd");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("berd-call-app-update.lock");
    lock_file_at(&path)
}

fn lock_file_at(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
}

/// Hold while the CLI session is alive, including its internal restarts.
pub fn hold_call() -> io::Result<File> {
    let file = lock_file()?;
    FileExt::lock_shared(&file)?;
    Ok(file)
}

/// Hold across app-bundle replacement so a call cannot start mid-install.
pub fn wait_until_no_call() -> io::Result<File> {
    let file = lock_file()?;
    FileExt::lock_exclusive(&file)?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_call_prevents_install_until_it_ends() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("update.lock");
        let call = lock_file_at(&path).unwrap();
        FileExt::lock_shared(&call).unwrap();
        let installer = lock_file_at(&path).unwrap();
        assert!(FileExt::try_lock_exclusive(&installer).is_err());
        drop(call);
        FileExt::try_lock_exclusive(&installer).unwrap();
    }
}
