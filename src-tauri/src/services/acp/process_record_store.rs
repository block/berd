use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_RECORD_BYTES: u64 = 4 * 1024;
#[cfg(unix)]
const RECORD_DIR_MODE: u32 = 0o700;
#[cfg(unix)]
const RECORD_FILE_MODE: u32 = 0o600;

#[derive(Debug)]
pub(super) struct VerifiedRecord {
    pub(super) bytes: Vec<u8>,
    identity: platform::FileIdentity,
    #[cfg(windows)]
    file: File,
}

#[derive(Debug)]
pub(super) struct VerifiedReadError {
    pub(super) message: String,
    /// Present only after the object passed type/ownership/ACL validation.
    pub(super) verified: Option<VerifiedRecord>,
}

#[derive(Debug)]
pub(super) struct ProcessRecordStore {
    root: PathBuf,
    handle: platform::RootHandle,
}

impl ProcessRecordStore {
    pub(super) fn open(root: PathBuf) -> Result<Self, String> {
        let handle = platform::open_root(&root)?;
        Ok(Self { root, handle })
    }

    pub(super) fn new_record_path(&self, owner_pid: u32, executable_hash: u64) -> PathBuf {
        self.root.join(format!(
            "{owner_pid}-{executable_hash:016x}-{}.json",
            uuid::Uuid::new_v4().simple()
        ))
    }

    pub(super) fn publish(&self, destination: &Path, bytes: &[u8]) -> Result<(), String> {
        let stored_len = bytes
            .len()
            .checked_add(1)
            .ok_or_else(|| format!("process record exceeds {MAX_RECORD_BYTES} bytes"))?;
        if stored_len as u64 > MAX_RECORD_BYTES {
            return Err(format!("process record exceeds {MAX_RECORD_BYTES} bytes"));
        }
        ensure_direct_child(&self.root, destination)?;
        let temp = self.root.join(format!(
            ".process-record-{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let mut temp_identity = None;
        let result = (|| {
            let mut file = platform::create(
                &self.root,
                &self.handle,
                temp.file_name().expect("temp has a name"),
            )?;
            temp_identity = Some(platform::file_identity(&file)?);
            file.write_all(bytes)
                .and_then(|_| file.write_all(b"\n"))
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("failed to write {}: {error}", temp.display()))?;
            platform::rename(
                &self.handle,
                &file,
                temp.file_name().expect("temp has a name"),
                destination.file_name().expect("destination has a name"),
            )?;
            platform::sync(&self.handle)?;
            Ok(())
        })();
        if result.is_err() {
            if let Some(identity) = temp_identity.as_ref() {
                let _ = platform::remove(&self.root, &self.handle, &temp, Some(identity));
            }
        }
        result
    }

    pub(super) fn read_verified_for_cleanup(
        &self,
        path: &Path,
    ) -> Result<VerifiedRecord, VerifiedReadError> {
        let read = (|| -> Result<VerifiedRecord, VerifiedReadError> {
            ensure_direct_child(&self.root, path).map_err(|message| VerifiedReadError {
                message,
                verified: None,
            })?;
            let file = platform::open(&self.root, &self.handle, path).map_err(|message| {
                VerifiedReadError {
                    message,
                    verified: None,
                }
            })?;
            let metadata = file.metadata().map_err(|error| VerifiedReadError {
                message: format!("failed to inspect {}: {error}", path.display()),
                verified: None,
            })?;
            platform::validate_metadata(path, &metadata).map_err(|message| VerifiedReadError {
                message,
                verified: None,
            })?;
            let identity = platform::file_identity(&file).map_err(|message| VerifiedReadError {
                message,
                verified: None,
            })?;
            if metadata.len() > MAX_RECORD_BYTES {
                #[cfg(unix)]
                let record = VerifiedRecord {
                    bytes: Vec::new(),
                    identity,
                };
                #[cfg(windows)]
                let record = VerifiedRecord {
                    bytes: Vec::new(),
                    identity,
                    file,
                };
                return Err(VerifiedReadError {
                    message: format!(
                        "process record {} exceeds {MAX_RECORD_BYTES} bytes",
                        path.display()
                    ),
                    verified: Some(record),
                });
            }
            let mut bytes = Vec::with_capacity(metadata.len() as usize);
            (&file)
                .take(MAX_RECORD_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| VerifiedReadError {
                    message: format!("failed to read {}: {error}", path.display()),
                    verified: None,
                })?;
            if bytes.len() as u64 > MAX_RECORD_BYTES {
                #[cfg(unix)]
                let record = VerifiedRecord { bytes, identity };
                #[cfg(windows)]
                let record = VerifiedRecord {
                    bytes,
                    identity,
                    file,
                };
                return Err(VerifiedReadError {
                    message: format!(
                        "process record {} exceeds {MAX_RECORD_BYTES} bytes",
                        path.display()
                    ),
                    verified: Some(record),
                });
            }
            #[cfg(unix)]
            return Ok(VerifiedRecord { bytes, identity });
            #[cfg(windows)]
            Ok(VerifiedRecord {
                bytes,
                identity,
                file,
            })
        })();
        read
    }

    #[cfg(test)]
    pub(super) fn read_verified(&self, path: &Path) -> Result<VerifiedRecord, String> {
        self.read_verified_for_cleanup(path)
            .map_err(|error| error.message)
    }

    #[cfg(test)]
    pub(super) fn read(&self, path: &Path) -> Result<Vec<u8>, String> {
        self.read_verified(path).map(|record| record.bytes)
    }

    pub(super) fn entries(&self) -> Result<Vec<PathBuf>, String> {
        platform::entries(&self.root, &self.handle)
    }

    pub(super) fn remove_verified(
        &self,
        path: &Path,
        verified: &VerifiedRecord,
    ) -> Result<(), String> {
        platform::remove_verified(&self.root, &self.handle, path, verified)
    }

    #[cfg(test)]
    pub(super) fn remove(&self, path: &Path) -> Result<(), String> {
        platform::remove(&self.root, &self.handle, path, None)
    }
}

fn ensure_direct_child(root: &Path, path: &Path) -> Result<(), String> {
    if path.parent() != Some(root) || path.file_name().is_none() {
        return Err(format!("process record escapes {}", root.display()));
    }
    Ok(())
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::ffi::{CString, OsStr, OsString};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};

    fn device_id<T>(device: T) -> u64
    where
        T: TryInto<u64>,
        T::Error: std::fmt::Debug,
    {
        device
            .try_into()
            .expect("filesystem device identifier must fit in u64")
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(super) struct FileIdentity {
        device: u64,
        inode: u64,
    }

    pub(super) fn file_identity(file: &File) -> Result<FileIdentity, String> {
        let metadata = file
            .metadata()
            .map_err(|error| format!("failed to identify process record: {error}"))?;
        Ok(FileIdentity {
            device: device_id(metadata.dev()),
            inode: metadata.ino(),
        })
    }

    #[derive(Debug)]
    pub(super) struct RootHandle(OwnedFd);

    fn c_name(name: &OsStr) -> Result<CString, String> {
        CString::new(name.as_bytes()).map_err(|_| "process record name contains NUL".to_string())
    }

    fn name_for(root: &Path, path: &Path) -> Result<CString, String> {
        super::ensure_direct_child(root, path)?;
        c_name(path.file_name().expect("direct child has a name"))
    }

    pub(super) fn open_root(path: &Path) -> Result<RootHandle, String> {
        if !path.exists() {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true).mode(RECORD_DIR_MODE);
            builder
                .create(path)
                .map_err(|error| format!("failed to create {}: {error}", path.display()))?;
        }
        let c_path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| format!("{} contains NUL", path.display()))?;
        // SAFETY: c_path is NUL terminated and flags require an actual directory.
        let fd = unsafe {
            libc::open(
                c_path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(format!(
                "failed to safely open {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: open returned a new owned descriptor.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: stat points to writable storage and fd is valid.
        if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(format!(
                "failed to inspect {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: successful fstat initialized stat.
        let stat = unsafe { stat.assume_init() };
        if stat.st_uid != unsafe { libc::geteuid() } {
            return Err(format!(
                "process record root {} has the wrong owner",
                path.display()
            ));
        }
        if stat.st_mode & 0o777 != RECORD_DIR_MODE as libc::mode_t {
            // SAFETY: fd is our validated directory handle.
            if unsafe { libc::fchmod(fd.as_raw_fd(), RECORD_DIR_MODE as libc::mode_t) } != 0 {
                return Err(format!(
                    "failed to make {} owner-private: {}",
                    path.display(),
                    std::io::Error::last_os_error()
                ));
            }
        }
        let mut checked = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: checked points to writable storage and fd is valid.
        if unsafe { libc::fstat(fd.as_raw_fd(), checked.as_mut_ptr()) } != 0 {
            return Err(format!(
                "failed to re-inspect {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: successful fstat initialized checked.
        if unsafe { checked.assume_init() }.st_mode & 0o777 != RECORD_DIR_MODE as libc::mode_t {
            return Err(format!(
                "process record root {} is not owner-private",
                path.display()
            ));
        }
        Ok(RootHandle(fd))
    }

    pub(super) fn create(
        _root_path: &Path,
        root: &RootHandle,
        name: &OsStr,
    ) -> Result<File, String> {
        let name = c_name(name)?;
        // SAFETY: root is retained, name is a single NUL-terminated component.
        let fd = unsafe {
            libc::openat(
                root.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                RECORD_FILE_MODE as libc::c_uint,
            )
        };
        if fd < 0 {
            return Err(format!(
                "failed to create process record: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: openat returned a new owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file
            .metadata()
            .map_err(|e| format!("failed to inspect new process record: {e}"))?;
        validate_metadata(Path::new(name.to_str().unwrap_or("<record>")), &metadata)?;
        Ok(file)
    }

    fn open_file(root: &RootHandle, name: &CString) -> std::io::Result<File> {
        // SAFETY: root is retained and name is a direct child.
        let fd = unsafe {
            libc::openat(
                root.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: openat returned a new owned descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub(super) fn open(root_path: &Path, root: &RootHandle, path: &Path) -> Result<File, String> {
        let name = name_for(root_path, path)?;
        open_file(root, &name)
            .map_err(|error| format!("failed to safely open {}: {error}", path.display()))
    }

    fn unlink_name(root: &RootHandle, name: &CString) -> std::io::Result<()> {
        // SAFETY: root is retained and name is a root-relative direct child.
        if unsafe { libc::unlinkat(root.0.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn rename_with_unlink<F>(
        root: &RootHandle,
        source: &File,
        from: &OsStr,
        to: &OsStr,
        mut unlink: F,
    ) -> Result<(), String>
    where
        F: FnMut(&RootHandle, &CString) -> std::io::Result<()>,
    {
        let from = c_name(from)?;
        let to = c_name(to)?;
        let source_identity = file_identity(source)?;
        let mut current = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: current is writable and from is a root-relative name.
        if unsafe {
            libc::fstatat(
                root.0.as_raw_fd(),
                from.as_ptr(),
                current.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(format!(
                "failed to bind process record publication: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: successful fstatat initialized current.
        let current = unsafe { current.assume_init() };
        if source_identity
            != (FileIdentity {
                device: device_id(current.st_dev),
                inode: current.st_ino,
            })
        {
            return Err("temporary process record changed before publication".to_string());
        }
        // linkat is an atomic no-replace publication primitive: it fails if
        // the destination exists, then unlinkat removes the temporary name.
        // Both operations are anchored to the retained same-directory fd, and
        // the source name was just verified against the retained source handle.
        if unsafe {
            libc::linkat(
                root.0.as_raw_fd(),
                from.as_ptr(),
                root.0.as_raw_fd(),
                to.as_ptr(),
                0,
            )
        } != 0
        {
            return Err(format!(
                "failed to publish process record without replacement: {}",
                std::io::Error::last_os_error()
            ));
        }
        if let Err(temp_error) = unlink(root, &from) {
            // Publication created `to` as a second name for the retained source.
            // Roll it back before the caller cleans the identity-bound temp name,
            // otherwise both names retain nlink == 2 and fail metadata validation.
            let rollback_error = unlink(root, &to).err();
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "published process record but failed to remove temporary name: {temp_error}; \
                     failed to roll back destination: {rollback_error}"
                ),
                None => format!(
                    "published process record but failed to remove temporary name: {temp_error}; \
                     rolled back destination"
                ),
            });
        }
        Ok(())
    }

    pub(super) fn rename(
        root: &RootHandle,
        source: &File,
        from: &OsStr,
        to: &OsStr,
    ) -> Result<(), String> {
        rename_with_unlink(root, source, from, to, unlink_name)
    }

    #[cfg(test)]
    pub(super) fn unlink_name_for_test(root: &RootHandle, name: &CString) -> std::io::Result<()> {
        unlink_name(root, name)
    }

    #[cfg(test)]
    pub(super) fn rename_with_unlink_for_test<F>(
        root: &RootHandle,
        source: &File,
        from: &OsStr,
        to: &OsStr,
        unlink: F,
    ) -> Result<(), String>
    where
        F: FnMut(&RootHandle, &CString) -> std::io::Result<()>,
    {
        rename_with_unlink(root, source, from, to, unlink)
    }

    fn duplicate_root(root: &RootHandle) -> std::io::Result<libc::c_int> {
        // SAFETY: F_DUPFD_CLOEXEC returns an independent close-on-exec descriptor.
        let duplicate = unsafe { libc::fcntl(root.0.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if duplicate < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(duplicate)
    }

    #[cfg(test)]
    pub(super) fn duplicate_root_for_test(root: &RootHandle) -> std::io::Result<libc::c_int> {
        duplicate_root(root)
    }

    pub(super) fn entries(root_path: &Path, root: &RootHandle) -> Result<Vec<PathBuf>, String> {
        let duplicate = duplicate_root(root)
            .map_err(|error| format!("failed to duplicate process record directory: {error}"))?;
        // SAFETY: fdopendir takes ownership of duplicate.
        let directory = unsafe { libc::fdopendir(duplicate) };
        if directory.is_null() {
            unsafe { libc::close(duplicate) };
            return Err(format!(
                "failed to enumerate process records: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut paths = Vec::new();
        let result = loop {
            errno::set_errno(errno::Errno(0));
            // SAFETY: directory remains valid until closed below.
            let entry = unsafe { libc::readdir(directory) };
            if entry.is_null() {
                let read_error = errno::errno();
                if read_error.0 != 0 {
                    break Err(format!(
                        "failed while enumerating process records: {}",
                        std::io::Error::from_raw_os_error(read_error.0)
                    ));
                }
                break Ok(paths);
            }
            // SAFETY: d_name is NUL-terminated for a valid dirent.
            let bytes = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            let name = OsString::from_vec(bytes.to_vec());
            let c = match c_name(&name) {
                Ok(c) => c,
                Err(error) => break Err(error),
            };
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    root.0.as_raw_fd(),
                    c.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } == 0
            {
                // SAFETY: successful fstatat initialized stat.
                let stat = unsafe { stat.assume_init() };
                if stat.st_mode & libc::S_IFMT == libc::S_IFREG {
                    paths.push(root_path.join(name));
                }
            }
        };
        // SAFETY: directory was returned by fdopendir and closes duplicate.
        unsafe { libc::closedir(directory) };
        result
    }

    pub(super) fn remove(
        root_path: &Path,
        root: &RootHandle,
        path: &Path,
        expected: Option<&FileIdentity>,
    ) -> Result<(), String> {
        let name = name_for(root_path, path)?;
        let file = match open_file(root, &name) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(format!("failed to safely open {}: {error}", path.display()));
            }
        };
        validate_metadata(
            path,
            &file
                .metadata()
                .map_err(|e| format!("failed to inspect {}: {e}", path.display()))?,
        )?;
        let opened_identity = file_identity(&file)?;
        if expected.is_some_and(|expected| *expected != opened_identity) {
            return Err("process record changed since it was read".to_string());
        }
        let mut current = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: current is writable and name is root-relative.
        if unsafe {
            libc::fstatat(
                root.0.as_raw_fd(),
                name.as_ptr(),
                current.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(format!(
                "failed to bind process record deletion: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: successful fstatat initialized current.
        let current = unsafe { current.assume_init() };
        if opened_identity
            != (FileIdentity {
                device: device_id(current.st_dev),
                inode: current.st_ino,
            })
        {
            return Err("process record changed before deletion".to_string());
        }
        // SAFETY: root is retained and name identifies the validated object.
        if unsafe { libc::unlinkat(root.0.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("failed to remove {}: {error}", path.display()));
            }
        }
        Ok(())
    }

    pub(super) fn remove_verified(
        root_path: &Path,
        root: &RootHandle,
        path: &Path,
        verified: &VerifiedRecord,
    ) -> Result<(), String> {
        remove(root_path, root, path, Some(&verified.identity))
    }

    pub(super) fn sync(root: &RootHandle) -> Result<(), String> {
        // SAFETY: root is a valid retained directory descriptor.
        if unsafe { libc::fsync(root.0.as_raw_fd()) } != 0 {
            return Err(format!(
                "failed to sync process record directory: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    pub(super) fn validate_metadata(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || metadata.nlink() != 1
        {
            return Err(format!(
                "process record {} is not an owner-private regular file",
                path.display()
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::OsStr;
    use std::fs::OpenOptions;
    use std::mem::{offset_of, size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::ptr::{null, null_mut};
    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows_sys::Wdk::Storage::FileSystem::{
        FileIdBothDirectoryInformation, NtCreateFile, NtQueryDirectoryFile, FILE_CREATE,
        FILE_ID_BOTH_DIR_INFORMATION, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
        FILE_SYNCHRONOUS_IO_NONALERT,
    };
    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE,
        STATUS_NO_MORE_FILES, STATUS_OBJECT_NAME_NOT_FOUND, UNICODE_STRING,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetExplicitEntriesFromAclW, GetSecurityInfo, SetEntriesInAclW, SetSecurityInfo,
        EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
        TRUSTEE_W,
    };
    #[cfg(test)]
    use windows_sys::Win32::Security::{CreateWellKnownSid, WinWorldSid, SECURITY_MAX_SID_SIZE};
    use windows_sys::Win32::Security::{
        EqualSid, GetSecurityDescriptorControl, GetTokenInformation, TokenUser, ACL,
        DACL_SECURITY_INFORMATION, NO_INHERITANCE, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSID, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, FileRenameInfo, GetFileInformationByHandle,
        SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ALL_ACCESS,
        FILE_APPEND_DATA, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_RENAME_INFO,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES,
        FILE_WRITE_DATA, READ_CONTROL, SYNCHRONIZE, WRITE_DAC,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(super) struct FileIdentity(u32, u64);

    pub(super) fn file_identity(file: &File) -> Result<FileIdentity, String> {
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // SAFETY: `file` owns a valid handle and `info` points to writable storage.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, info.as_mut_ptr()) }
            == 0
        {
            return Err(format!(
                "failed to identify process record: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: a successful call initialized the complete structure.
        let info = unsafe { info.assume_init() };
        let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        Ok(FileIdentity(info.dwVolumeSerialNumber, index))
    }

    #[derive(Debug)]
    pub(super) struct RootHandle {
        directory: File,
    }

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: this wrapper uniquely owns the handle.
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    fn nt_success(status: i32) -> bool {
        status >= 0
    }

    fn current_user_sid() -> Result<(Vec<u8>, PSID), String> {
        let mut token = null_mut();
        // SAFETY: token points to writable handle storage.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(format!(
                "failed to open process token: {}",
                std::io::Error::last_os_error()
            ));
        }
        let token = Handle(token);
        let mut length = 0;
        // SAFETY: probing required size with a null buffer is documented.
        unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut length) };
        if std::io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
        {
            return Err(format!(
                "failed to size token user: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut buffer = vec![0u8; length as usize];
        // SAFETY: buffer has the size returned by the preceding probe.
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                length,
                &mut length,
            )
        } == 0
        {
            return Err(format!(
                "failed to read token user: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: successful TokenUser query initialized TOKEN_USER in buffer.
        let sid = unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        Ok((buffer, sid))
    }

    fn secure_for_current_user(file: &File) -> Result<(), String> {
        let (_sid_buffer, sid) = current_user_sid()?;
        let mut acl: *mut ACL = null_mut();
        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: sid.cast(),
            },
        };
        // SAFETY: access and acl are valid; Windows allocates acl.
        let status = unsafe { SetEntriesInAclW(1, &access, null(), &mut acl) };
        if status != ERROR_SUCCESS {
            return Err(format!("failed to create owner-only ACL: {status}"));
        }
        // SAFETY: the retained file handle and ACL remain valid for this call.
        let status = unsafe {
            SetSecurityInfo(
                file.as_raw_handle() as HANDLE,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null(),
            )
        };
        // SAFETY: SetEntriesInAclW allocated acl with LocalAlloc.
        unsafe { LocalFree(acl.cast()) };
        if status != ERROR_SUCCESS {
            return Err(format!("failed to set owner-only ACL by handle: {status}"));
        }
        validate_owner_and_acl(file)
    }

    fn validate_owner_and_acl(file: &File) -> Result<(), String> {
        let (_sid_buffer, current_sid) = current_user_sid()?;
        let mut owner: PSID = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        // SAFETY: output pointers and retained handle are valid.
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle() as HANDLE,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("failed to inspect ACL by handle: {status}"));
        }
        let mut entry_count = 0;
        let mut entries: *mut EXPLICIT_ACCESS_W = null_mut();
        let mut control = 0;
        let mut revision = 0;
        let protected = !descriptor.is_null()
            && unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) }
                != 0
            && control & SE_DACL_PROTECTED != 0;
        let entries_status = if dacl.is_null() {
            1
        } else {
            // SAFETY: dacl is owned by descriptor; Windows allocates entries.
            unsafe { GetExplicitEntriesFromAclW(dacl, &mut entry_count, &mut entries) }
        };
        let one_current_user_grant = entries_status == ERROR_SUCCESS
            && entry_count == 1
            && !entries.is_null()
            && unsafe {
                (*entries).grfAccessMode == GRANT_ACCESS
                    && (*entries).grfAccessPermissions & FILE_ALL_ACCESS == FILE_ALL_ACCESS
                    && (*entries).Trustee.TrusteeForm == TRUSTEE_IS_SID
                    && !(*entries).Trustee.ptstrName.is_null()
                    && EqualSid((*entries).Trustee.ptstrName.cast(), current_sid) != 0
            };
        if !entries.is_null() {
            // SAFETY: GetExplicitEntriesFromAclW allocated entries with LocalAlloc.
            unsafe { LocalFree(entries.cast()) };
        }
        let valid = protected
            && !owner.is_null()
            && unsafe { EqualSid(owner, current_sid) } != 0
            && one_current_user_grant;
        // SAFETY: GetSecurityInfo allocated descriptor with LocalAlloc.
        unsafe { LocalFree(descriptor) };
        if !valid {
            return Err(
                "process record object is not owned solely by the current user".to_string(),
            );
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn assert_everyone_full_control(path: &Path) -> Result<(), String> {
        let file = OpenOptions::new()
            .read(true)
            .access_mode(READ_CONTROL)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .map_err(|error| format!("failed to open mutated ACL object: {error}"))?;
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle() as HANDLE,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("failed to inspect mutated ACL: {status}"));
        }
        let mut world = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
        let mut world_len = world.len() as u32;
        if unsafe {
            CreateWellKnownSid(
                WinWorldSid,
                null_mut(),
                world.as_mut_ptr().cast(),
                &mut world_len,
            )
        } == 0
        {
            unsafe { LocalFree(descriptor) };
            return Err(format!(
                "failed to construct Everyone SID: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut entry_count = 0;
        let mut entries: *mut EXPLICIT_ACCESS_W = null_mut();
        let entries_status = if dacl.is_null() {
            1
        } else {
            unsafe { GetExplicitEntriesFromAclW(dacl, &mut entry_count, &mut entries) }
        };
        let hostile = entries_status == ERROR_SUCCESS
            && !entries.is_null()
            && (0..entry_count as usize).any(|index| unsafe {
                let entry = &*entries.add(index);
                entry.grfAccessMode == GRANT_ACCESS
                    && entry.grfAccessPermissions & FILE_ALL_ACCESS == FILE_ALL_ACCESS
                    && entry.Trustee.TrusteeForm == TRUSTEE_IS_SID
                    && !entry.Trustee.ptstrName.is_null()
                    && EqualSid(entry.Trustee.ptstrName.cast(), world.as_mut_ptr().cast()) != 0
            });
        if !entries.is_null() {
            unsafe { LocalFree(entries.cast()) };
        }
        unsafe { LocalFree(descriptor) };
        if !hostile {
            return Err("mutated ACL lacks an explicit Everyone full-control grant".to_string());
        }
        Ok(())
    }

    fn open_directory(path: &Path) -> Result<File, String> {
        OpenOptions::new()
            .read(true)
            .access_mode(
                FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC | SYNCHRONIZE,
            )
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .map_err(|e| format!("failed to safely open {}: {e}", path.display()))
    }

    #[derive(Debug)]
    enum RelativeFileError {
        Invalid(String),
        NtStatus(i32),
    }

    impl std::fmt::Display for RelativeFileError {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::Invalid(message) => formatter.write_str(message),
                Self::NtStatus(status) => write!(
                    formatter,
                    "failed to open process record by retained root: NTSTATUS {status:#x}"
                ),
            }
        }
    }

    fn relative_file(
        root: &RootHandle,
        name: &OsStr,
        desired_access: u32,
        disposition: u32,
    ) -> Result<File, RelativeFileError> {
        let mut name_w: Vec<u16> = name.encode_wide().collect();
        if name_w.is_empty()
            || name_w
                .iter()
                .any(|unit| *unit == 0 || *unit == b'\\' as u16 || *unit == b'/' as u16)
        {
            return Err(RelativeFileError::Invalid(
                "process record name is not a single Windows path component".to_string(),
            ));
        }
        let bytes = name_w
            .len()
            .checked_mul(size_of::<u16>())
            .and_then(|value| u16::try_from(value).ok())
            .ok_or_else(|| {
                RelativeFileError::Invalid("process record name is too long".to_string())
            })?;
        let unicode = UNICODE_STRING {
            Length: bytes,
            MaximumLength: bytes,
            Buffer: name_w.as_mut_ptr(),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: root.directory.as_raw_handle() as HANDLE,
            ObjectName: &unicode,
            Attributes: 0x40, // OBJ_CASE_INSENSITIVE
            SecurityDescriptor: null(),
            SecurityQualityOfService: null(),
        };
        let mut io_status: IO_STATUS_BLOCK = unsafe { zeroed() };
        let mut handle = null_mut();
        // SAFETY: all structures live for the call; the name is root-relative.
        let status = unsafe {
            NtCreateFile(
                &mut handle,
                desired_access,
                &attributes,
                &mut io_status,
                null(),
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                disposition,
                FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
                null(),
                0,
            )
        };
        if !nt_success(status) {
            return Err(RelativeFileError::NtStatus(status));
        }
        // SAFETY: successful NtCreateFile returned one newly owned handle.
        Ok(unsafe { File::from_raw_handle(handle.cast()) })
    }

    pub(super) fn open_root(path: &Path) -> Result<RootHandle, String> {
        fs::create_dir_all(path)
            .map_err(|e| format!("failed to create {}: {e}", path.display()))?;
        let directory = open_directory(path)?;
        let metadata = directory
            .metadata()
            .map_err(|e| format!("failed to inspect {}: {e}", path.display()))?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "process record root {} is not a real directory",
                path.display()
            ));
        }
        secure_for_current_user(&directory)?;
        Ok(RootHandle { directory })
    }

    pub(super) fn create(
        _root_path: &Path,
        root: &RootHandle,
        name: &OsStr,
    ) -> Result<File, String> {
        validate_owner_and_acl(&root.directory)?;
        let file = relative_file(
            root,
            name,
            FILE_WRITE_DATA
                | FILE_APPEND_DATA
                | FILE_READ_ATTRIBUTES
                | FILE_WRITE_ATTRIBUTES
                | READ_CONTROL
                | WRITE_DAC
                | SYNCHRONIZE
                | DELETE,
            FILE_CREATE,
        )
        .map_err(|error| error.to_string())?;
        secure_for_current_user(&file)?;
        validate_metadata(
            Path::new(name),
            &file
                .metadata()
                .map_err(|e| format!("failed to inspect new process record: {e}"))?,
        )?;
        Ok(file)
    }

    pub(super) fn open(root_path: &Path, root: &RootHandle, path: &Path) -> Result<File, String> {
        super::ensure_direct_child(root_path, path)?;
        validate_owner_and_acl(&root.directory)?;
        let file = relative_file(
            root,
            path.file_name().expect("direct child has a name"),
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE | DELETE,
            FILE_OPEN,
        )
        .map_err(|error| error.to_string())?;
        validate_owner_and_acl(&file)?;
        Ok(file)
    }

    pub(super) fn rename(
        root: &RootHandle,
        source: &File,
        _from: &OsStr,
        to: &OsStr,
    ) -> Result<(), String> {
        validate_owner_and_acl(&root.directory)?;
        validate_owner_and_acl(source)?;
        let name: Vec<u16> = to.encode_wide().collect();
        if name.is_empty()
            || name
                .iter()
                .any(|unit| *unit == 0 || *unit == b'\\' as u16 || *unit == b'/' as u16)
        {
            return Err("process record destination is not a single component".to_string());
        }
        let name_bytes = name
            .len()
            .checked_mul(size_of::<u16>())
            .ok_or_else(|| "destination name is too long".to_string())?;
        let total = offset_of!(FILE_RENAME_INFO, FileName)
            .checked_add(name_bytes)
            .ok_or_else(|| "rename buffer is too large".to_string())?;
        let words = total.div_ceil(size_of::<usize>());
        let mut storage = vec![0usize; words];
        let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // SAFETY: storage is aligned and sized for header plus complete UTF-16 name.
        unsafe {
            (*info).Anonymous.ReplaceIfExists = 0;
            (*info).RootDirectory = root.directory.as_raw_handle() as HANDLE;
            (*info).FileNameLength = u32::try_from(name_bytes)
                .map_err(|_| "destination name is too long".to_string())?;
            std::ptr::copy_nonoverlapping(
                name.as_ptr(),
                std::ptr::addr_of_mut!((*info).FileName).cast(),
                name.len(),
            );
        }
        // SAFETY: source is the exact temp handle; rename target is relative to retained root; replacement is disabled.
        if unsafe {
            SetFileInformationByHandle(
                source.as_raw_handle() as HANDLE,
                FileRenameInfo,
                storage.as_ptr().cast(),
                u32::try_from(total).map_err(|_| "rename buffer is too large".to_string())?,
            )
        } == 0
        {
            return Err(format!(
                "failed to publish process record by handle: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    fn read_directory_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
        let end = offset
            .checked_add(4)
            .ok_or_else(|| "directory offset overflow".to_string())?;
        let value = bytes
            .get(offset..end)
            .ok_or_else(|| "truncated directory entry".to_string())?;
        Ok(u32::from_le_bytes(
            value.try_into().expect("four-byte slice"),
        ))
    }

    fn parse_directory_entries(bytes: &[u8]) -> Result<Vec<(String, u32)>, String> {
        let name_offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileName);
        let attributes_offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileAttributes);
        let name_length_offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileNameLength);
        let mut entries = Vec::new();
        let mut offset = 0usize;
        while offset < bytes.len() {
            let remaining = &bytes[offset..];
            if remaining.len() < name_offset {
                return Err("truncated directory entry header".to_string());
            }
            let next = read_directory_u32(remaining, 0)? as usize;
            let attributes = read_directory_u32(remaining, attributes_offset)?;
            let name_len = read_directory_u32(remaining, name_length_offset)? as usize;
            if !name_len.is_multiple_of(2) {
                return Err("misaligned UTF-16 directory name".to_string());
            }
            let record_end = name_offset
                .checked_add(name_len)
                .ok_or_else(|| "directory entry overflow".to_string())?;
            let name_bytes = remaining
                .get(name_offset..record_end)
                .ok_or_else(|| "truncated directory name".to_string())?;
            let units: Vec<u16> = name_bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            let name = String::from_utf16(&units)
                .map_err(|_| "invalid UTF-16 directory name".to_string())?;
            entries.push((name, attributes));
            if next == 0 {
                if record_end != remaining.len() {
                    return Err("unexplained trailing directory bytes".to_string());
                }
                offset = bytes.len();
            } else {
                let minimum_next = record_end
                    .checked_add(7)
                    .map(|value| value & !7)
                    .ok_or_else(|| "directory entry overflow".to_string())?;
                if next < minimum_next || !next.is_multiple_of(8) || next > remaining.len() {
                    return Err("overlapping or misaligned directory entry".to_string());
                }
                offset = offset
                    .checked_add(next)
                    .ok_or_else(|| "directory offset overflow".to_string())?;
            }
        }
        Ok(entries)
    }

    fn is_enumerable_record(name: &str, attributes: u32) -> bool {
        name != "."
            && name != ".."
            && attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) == 0
    }

    pub(super) fn entries(root_path: &Path, root: &RootHandle) -> Result<Vec<PathBuf>, String> {
        validate_owner_and_acl(&root.directory)?;
        let mut paths = Vec::new();
        let mut restart = 1;
        loop {
            let mut storage = vec![0usize; 64 * 1024 / size_of::<usize>()];
            let mut io_status: IO_STATUS_BLOCK = unsafe { zeroed() };
            // SAFETY: buffer and IO status are writable; synchronous retained directory handle remains valid.
            let status = unsafe {
                NtQueryDirectoryFile(
                    root.directory.as_raw_handle() as HANDLE,
                    null_mut(),
                    None,
                    null(),
                    &mut io_status,
                    storage.as_mut_ptr().cast(),
                    (storage.len() * size_of::<usize>()) as u32,
                    FileIdBothDirectoryInformation,
                    0,
                    null(),
                    restart,
                )
            };
            restart = 0;
            if status == STATUS_NO_MORE_FILES {
                break;
            }
            if !nt_success(status) {
                return Err(format!(
                    "failed to enumerate retained process record root: NTSTATUS {status:#x}"
                ));
            }
            let capacity = storage.len() * size_of::<usize>();
            let used = io_status.Information;
            if used == 0 || used > capacity {
                return Err("invalid process record directory byte count".to_string());
            }
            // SAFETY: storage is live and used is bounded by capacity.
            let bytes = unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), used) };
            for (name, attributes) in parse_directory_entries(bytes)? {
                if is_enumerable_record(&name, attributes) {
                    paths.push(root_path.join(name));
                }
            }
        }
        Ok(paths)
    }

    pub(super) fn remove_verified(
        root_path: &Path,
        _root: &RootHandle,
        path: &Path,
        verified: &VerifiedRecord,
    ) -> Result<(), String> {
        super::ensure_direct_child(root_path, path)?;
        validate_metadata(
            path,
            &verified
                .file
                .metadata()
                .map_err(|e| format!("failed to inspect retained {}: {e}", path.display()))?,
        )?;
        if file_identity(&verified.file)? != verified.identity {
            return Err("retained process record identity changed".to_string());
        }
        delete_handle(path, &verified.file)
    }

    fn delete_handle(path: &Path, file: &File) -> Result<(), String> {
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
        // SAFETY: disposition applies to the exact retained and validated handle.
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle() as HANDLE,
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(format!(
                "failed to remove {} by retained handle: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    pub(super) fn remove(
        root_path: &Path,
        root: &RootHandle,
        path: &Path,
        expected: Option<&FileIdentity>,
    ) -> Result<(), String> {
        super::ensure_direct_child(root_path, path)?;
        let file = match relative_file(
            root,
            path.file_name().expect("direct child has a name"),
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE | DELETE,
            FILE_OPEN,
        ) {
            Ok(file) => file,
            Err(RelativeFileError::NtStatus(STATUS_OBJECT_NAME_NOT_FOUND)) => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        validate_metadata(
            path,
            &file
                .metadata()
                .map_err(|e| format!("failed to inspect {}: {e}", path.display()))?,
        )?;
        let opened_identity = file_identity(&file)?;
        if expected.is_some_and(|expected| *expected != opened_identity) {
            return Err("process record changed since it was read".to_string());
        }
        delete_handle(path, &file)
    }

    pub(super) fn sync(_root: &RootHandle) -> Result<(), String> {
        // The exact temporary file is flushed before handle-relative rename.
        // Windows does not provide a portable directory-fsync equivalent.
        Ok(())
    }

    #[cfg(test)]
    mod parser_tests {
        use super::*;

        fn entry(name: &[u16]) -> Vec<u8> {
            let name_offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileName);
            let length_offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileNameLength);
            let mut bytes = vec![0u8; name_offset + name.len() * 2];
            bytes[length_offset..length_offset + 4]
                .copy_from_slice(&((name.len() * 2) as u32).to_le_bytes());
            for (pair, unit) in bytes[name_offset..].chunks_exact_mut(2).zip(name) {
                pair.copy_from_slice(&unit.to_le_bytes());
            }
            bytes
        }

        #[test]
        fn rejects_truncated_fixed_header() {
            assert!(parse_directory_entries(&[0; 4]).is_err());
        }

        #[test]
        fn rejects_odd_utf16_length() {
            let mut bytes = entry(&[b'a' as u16]);
            let offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileNameLength);
            bytes[offset..offset + 4].copy_from_slice(&1u32.to_le_bytes());
            assert!(parse_directory_entries(&bytes).is_err());
        }

        #[test]
        fn rejects_truncated_or_overflowing_record_end() {
            let mut bytes = entry(&[b'a' as u16]);
            let offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileNameLength);
            bytes[offset..offset + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            assert!(parse_directory_entries(&bytes).is_err());
        }

        #[test]
        fn rejects_overlapping_next_offset() {
            let mut bytes = entry(&[b'a' as u16]);
            bytes[0..4].copy_from_slice(&8u32.to_le_bytes());
            assert!(parse_directory_entries(&bytes).is_err());
        }

        #[test]
        fn rejects_misaligned_next_offset() {
            let mut bytes = entry(&[b'a' as u16]);
            let next = bytes.len() + 1;
            bytes[0..4].copy_from_slice(&(next as u32).to_le_bytes());
            bytes.resize(next, 0);
            assert!(parse_directory_entries(&bytes).is_err());
        }

        #[test]
        fn rejects_next_offset_beyond_used_bytes() {
            let mut bytes = entry(&[b'a' as u16]);
            let next = ((bytes.len() + 7) & !7) + 8;
            bytes[0..4].copy_from_slice(&(next as u32).to_le_bytes());
            assert!(parse_directory_entries(&bytes).is_err());
        }

        #[test]
        fn filters_directories_reparse_points_and_dot_entries() {
            assert!(is_enumerable_record("record.json", FILE_ATTRIBUTE_NORMAL));
            assert!(!is_enumerable_record(
                "directory.json",
                FILE_ATTRIBUTE_DIRECTORY
            ));
            assert!(!is_enumerable_record(
                "reparse.json",
                FILE_ATTRIBUTE_REPARSE_POINT
            ));
            assert!(!is_enumerable_record(".", FILE_ATTRIBUTE_NORMAL));
            assert!(!is_enumerable_record("..", FILE_ATTRIBUTE_NORMAL));
        }

        #[test]
        fn rejects_terminal_trailing_bytes_even_when_zero() {
            let mut bytes = entry(&[b'a' as u16]);
            bytes.push(0);
            assert!(parse_directory_entries(&bytes).is_err());
            *bytes.last_mut().unwrap() = 1;
            assert!(parse_directory_entries(&bytes).is_err());
        }
    }

    pub(super) fn validate_metadata(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "process record {} is not a non-reparse regular file",
                path.display()
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversize_records_before_creating_a_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root).unwrap();
        let destination = store.new_record_path(1, 2);
        assert!(store
            .publish(&destination, &vec![b'x'; MAX_RECORD_BYTES as usize + 1])
            .is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn rejects_payload_that_only_exceeds_limit_after_newline() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root).unwrap();
        let destination = store.new_record_path(1, 2);
        assert!(store
            .publish(&destination, &vec![b'x'; MAX_RECORD_BYTES as usize])
            .is_err());
        assert!(!destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn enumeration_duplicate_is_close_on_exec() {
        use std::os::fd::RawFd;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root).unwrap();
        let duplicate: RawFd = super::platform::duplicate_root_for_test(&store.handle).unwrap();
        // SAFETY: duplicate remains open until the explicit close below.
        let flags = unsafe { libc::fcntl(duplicate, libc::F_GETFD) };
        assert!(flags >= 0);
        assert_ne!(flags & libc::FD_CLOEXEC, 0);
        // SAFETY: duplicate is owned by this test.
        assert_eq!(unsafe { libc::close(duplicate) }, 0);
    }

    #[cfg(windows)]
    fn install_junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd.exe")
            .args([
                "/d",
                "/c",
                "mklink",
                "/J",
                &link.to_string_lossy(),
                &target.to_string_lossy(),
            ])
            .status()
            .expect("run mklink");
        assert!(status.success(), "create test junction");
    }

    #[cfg(windows)]
    #[test]
    fn retained_handle_controls_create_enumerate_read_and_delete_after_root_swap() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let retained = temp.path().join("retained");
        let decoy = temp.path().join("decoy");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        fs::rename(&root, &retained).unwrap();
        fs::create_dir(&decoy).unwrap();
        install_junction(&root, &decoy);

        let apparent = store.new_record_path(1, 2);
        store.publish(&apparent, b"secure").unwrap();
        let name = apparent.file_name().unwrap();
        assert_eq!(fs::read(retained.join(name)).unwrap(), b"secure\n");
        assert!(!decoy.join(name).exists());
        assert_eq!(store.entries().unwrap(), vec![apparent.clone()]);
        assert_eq!(store.read(&apparent).unwrap(), b"secure\n");
        fs::write(decoy.join(name), b"decoy").unwrap();
        store.remove(&apparent).unwrap();
        assert!(!retained.join(name).exists());
        assert_eq!(fs::read(decoy.join(name)).unwrap(), b"decoy");
    }

    #[cfg(windows)]
    #[test]
    fn reparse_child_is_rejected_without_touching_target() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        let target = root.join("target.txt");
        fs::write(&target, b"canary").unwrap();
        let link = root.join("link.json");
        let status = std::process::Command::new("cmd.exe")
            .args([
                "/d",
                "/c",
                "mklink",
                &link.to_string_lossy(),
                &target.to_string_lossy(),
            ])
            .status()
            .expect("run mklink");
        assert!(status.success(), "create test symlink");
        assert!(store.read(&link).is_err());
        assert!(store.remove(&link).is_err());
        assert_eq!(fs::read(target).unwrap(), b"canary");
    }

    #[cfg(windows)]
    fn replace_dacl_with_everyone_full_control(path: &Path) {
        let status = std::process::Command::new("icacls.exe")
            .arg(path)
            .args(["/inheritance:r", "/grant:r", "*S-1-1-0:(F)"])
            .status()
            .expect("run icacls");
        assert!(status.success(), "mutate test DACL");
        super::platform::assert_everyone_full_control(path)
            .expect("hostile Everyone full-control ACE must be present");
    }

    #[cfg(windows)]
    #[test]
    fn destination_substitution_cannot_replace_existing_record() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        let destination = root.join("destination.json");
        store.publish(&destination, b"attacker").unwrap();
        let temp_name = std::ffi::OsStr::new("controlled-temp.tmp");
        let mut source = super::platform::create(&root, &store.handle, temp_name).unwrap();
        source.write_all(b"original\n").unwrap();
        source.sync_all().unwrap();

        assert!(super::platform::rename(
            &store.handle,
            &source,
            temp_name,
            destination.file_name().unwrap(),
        )
        .is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"attacker\n");
        assert_eq!(fs::read(root.join(temp_name)).unwrap(), b"original\n");
    }

    #[cfg(windows)]
    #[test]
    fn temp_name_substitution_publishes_exact_retained_handle() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        let temp_name = std::ffi::OsStr::new("controlled-temp.tmp");
        let temp_path = root.join(temp_name);
        let displaced = root.join("displaced.tmp");
        let destination = root.join("destination.json");
        let mut source = super::platform::create(&root, &store.handle, temp_name).unwrap();
        source.write_all(b"original\n").unwrap();
        source.sync_all().unwrap();
        fs::rename(&temp_path, &displaced).unwrap();
        fs::write(&temp_path, b"substitute\n").unwrap();

        super::platform::rename(
            &store.handle,
            &source,
            temp_name,
            destination.file_name().unwrap(),
        )
        .unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"original\n");
        assert_eq!(fs::read(&temp_path).unwrap(), b"substitute\n");
        assert!(!displaced.exists());
    }

    #[cfg(windows)]
    #[test]
    fn mutated_root_dacl_is_rejected_before_create() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        replace_dacl_with_everyone_full_control(&root);
        let destination = store.new_record_path(1, 2);

        assert!(store.publish(&destination, b"record").is_err());
        assert!(!destination.exists());
    }

    #[cfg(windows)]
    #[test]
    fn mutated_record_dacl_is_rejected_before_read_or_path_delete() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root).unwrap();
        let record = store.new_record_path(1, 2);
        store.publish(&record, b"record").unwrap();
        replace_dacl_with_everyone_full_control(&record);

        assert!(store.read(&record).is_err());
        assert!(store.remove(&record).is_err());
        assert_eq!(fs::read(&record).unwrap(), b"record\n");
    }

    #[cfg(windows)]
    #[test]
    fn exact_handle_deletion_removes_displaced_record_not_successor() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        let record = store.new_record_path(1, 2);
        store.publish(&record, b"original").unwrap();
        let verified = store.read_verified(&record).unwrap();
        let displaced = root.join("displaced.json");
        fs::rename(&record, &displaced).unwrap();
        store.publish(&record, b"successor").unwrap();

        store.remove_verified(&record, &verified).unwrap();

        assert!(!displaced.exists());
        assert_eq!(fs::read(&record).unwrap(), b"successor\n");
    }

    #[test]
    fn destination_collision_never_replaces_existing_record() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root).unwrap();
        let destination = store.new_record_path(1, 2);
        store.publish(&destination, b"first").unwrap();
        assert!(store.publish(&destination, b"second").is_err());
        assert_eq!(store.read(&destination).unwrap(), b"first\n");
    }

    #[test]
    fn publish_read_remove_round_trip_is_complete_and_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root).unwrap();
        let destination = store.new_record_path(1, 2);
        store
            .publish(&destination, br#"{"owner_pid":1,"serve_pid":2}"#)
            .unwrap();
        assert_eq!(
            store.read(&destination).unwrap(),
            b"{\"owner_pid\":1,\"serve_pid\":2}\n"
        );
        assert_eq!(store.entries().unwrap(), vec![destination.clone()]);
        store.remove(&destination).unwrap();
        assert!(!destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn existing_owner_private_root_is_repaired_to_writable_mode() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();

        let store = ProcessRecordStore::open(root.clone()).unwrap();
        let destination = store.new_record_path(1, 2);
        store.publish(&destination, b"{}").unwrap();

        assert_eq!(
            fs::metadata(root).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[cfg(unix)]
    #[test]
    fn removing_missing_record_uses_structured_not_found_result() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();

        store.remove(&root.join("missing.json")).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn temp_name_substitution_is_rejected_before_publication() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        let temp_name = std::ffi::OsStr::new("controlled-temp.tmp");
        let temp_path = root.join(temp_name);
        let displaced = root.join("displaced.tmp");
        let destination = root.join("destination.json");
        let mut source = super::platform::create(&root, &store.handle, temp_name).unwrap();
        source.write_all(b"original\n").unwrap();
        source.sync_all().unwrap();
        fs::rename(&temp_path, &displaced).unwrap();
        fs::write(&temp_path, b"substitute\n").unwrap();

        assert!(super::platform::rename(
            &store.handle,
            &source,
            temp_name,
            destination.file_name().unwrap(),
        )
        .is_err());

        assert!(!destination.exists());
        assert_eq!(fs::read(&temp_path).unwrap(), b"substitute\n");
        assert_eq!(fs::read(&displaced).unwrap(), b"original\n");
    }

    #[cfg(unix)]
    #[test]
    fn failed_temp_unlink_rolls_back_published_destination() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::MetadataExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        let temp_name = std::ffi::OsStr::new("controlled-temp.tmp");
        let temp_path = root.join(temp_name);
        let destination = root.join("destination.json");
        let mut source = super::platform::create(&root, &store.handle, temp_name).unwrap();
        source.write_all(b"original\n").unwrap();
        source.sync_all().unwrap();
        let identity = super::platform::file_identity(&source).unwrap();
        let from_name = std::ffi::CString::new(temp_name.as_bytes()).unwrap();
        let mut injected = false;

        let error = super::platform::rename_with_unlink_for_test(
            &store.handle,
            &source,
            temp_name,
            destination.file_name().unwrap(),
            |root, name| {
                if !injected && name == &from_name {
                    injected = true;
                    return Err(std::io::Error::from_raw_os_error(libc::EACCES));
                }
                super::platform::unlink_name_for_test(root, name)
            },
        )
        .unwrap_err();

        assert!(error.contains("rolled back destination"));
        assert!(!destination.exists());
        assert_eq!(fs::metadata(&temp_path).unwrap().nlink(), 1);
        assert_eq!(fs::read(&temp_path).unwrap(), b"original\n");
        super::platform::remove(&root, &store.handle, &temp_path, Some(&identity)).unwrap();
        assert!(!temp_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn temp_cleanup_rejects_successor_substitution() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        let temp_name = std::ffi::OsStr::new("controlled-temp.tmp");
        let temp_path = root.join(temp_name);
        let displaced = root.join("displaced.tmp");
        let mut source = super::platform::create(&root, &store.handle, temp_name).unwrap();
        source.write_all(b"original\n").unwrap();
        source.sync_all().unwrap();
        let identity = super::platform::file_identity(&source).unwrap();
        fs::rename(&temp_path, &displaced).unwrap();
        fs::write(&temp_path, b"successor\n").unwrap();
        fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600)).unwrap();

        assert!(
            super::platform::remove(&root, &store.handle, &temp_path, Some(&identity),).is_err()
        );

        assert_eq!(fs::read(&temp_path).unwrap(), b"successor\n");
        assert_eq!(fs::read(&displaced).unwrap(), b"original\n");
    }

    #[cfg(unix)]
    #[test]
    fn verified_removal_rejects_successor_substitution() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        let record = store.new_record_path(1, 2);
        store.publish(&record, b"original").unwrap();
        let verified = store.read_verified(&record).unwrap();
        let displaced = root.join("displaced.json");
        fs::rename(&record, &displaced).unwrap();
        fs::write(&record, b"successor\n").unwrap();
        fs::set_permissions(&record, fs::Permissions::from_mode(0o600)).unwrap();

        assert!(store.remove_verified(&record, &verified).is_err());
        assert_eq!(fs::read(&record).unwrap(), b"successor\n");
        assert_eq!(fs::read(&displaced).unwrap(), b"original\n");
    }

    #[cfg(unix)]
    #[test]
    fn planted_symlink_never_changes_its_target() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root).unwrap();
        let canary = temp.path().join("canary");
        fs::write(&canary, b"unchanged").unwrap();
        let destination = store.new_record_path(1, 2);
        symlink(&canary, &destination).unwrap();
        assert!(store.publish(&destination, b"hostile").is_err());
        assert_eq!(fs::read(&canary).unwrap(), b"unchanged");
        assert!(store.read(&destination).is_err());
        assert!(store.remove(&destination).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_fifo_hardlink_and_world_readable_records() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();

        let fifo = root.join("fifo.json");
        let fifo_c = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: fifo_c is a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        assert!(store.read(&fifo).is_err());
        assert!(store.remove(&fifo).is_err());

        let original = root.join("original.json");
        fs::write(&original, b"{}").unwrap();
        fs::set_permissions(&original, fs::Permissions::from_mode(0o600)).unwrap();
        let linked = root.join("linked.json");
        fs::hard_link(&original, &linked).unwrap();
        assert!(store.read(&linked).is_err());
        assert!(store.remove(&linked).is_err());

        let permissive = root.join("permissive.json");
        fs::write(&permissive, b"{}").unwrap();
        fs::set_permissions(&permissive, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(store.read(&permissive).is_err());
        assert!(store.remove(&permissive).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn bounded_read_rejects_an_oversized_existing_record() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        let record = root.join("oversized.json");
        fs::write(&record, vec![b'x'; MAX_RECORD_BYTES as usize + 1]).unwrap();
        fs::set_permissions(&record, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(store.read(&record).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn oversize_verified_cleanup_rejects_successor_substitution() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        let record = root.join("oversized.json");
        fs::write(&record, vec![b'x'; MAX_RECORD_BYTES as usize + 1]).unwrap();
        fs::set_permissions(&record, fs::Permissions::from_mode(0o600)).unwrap();
        let error = store.read_verified_for_cleanup(&record).unwrap_err();
        let verified = error.verified.expect("validated oversize object retained");
        let displaced = root.join("oversized-displaced.json");
        fs::rename(&record, &displaced).unwrap();
        fs::write(&record, b"successor\n").unwrap();
        fs::set_permissions(&record, fs::Permissions::from_mode(0o600)).unwrap();

        assert!(store.remove_verified(&record, &verified).is_err());
        assert_eq!(fs::read(&record).unwrap(), b"successor\n");
        assert_eq!(
            fs::metadata(&displaced).unwrap().len(),
            MAX_RECORD_BYTES + 1
        );
    }

    #[cfg(unix)]
    #[test]
    fn retained_directory_handle_defeats_root_path_swap() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let retained = temp.path().join("retained");
        let decoy = temp.path().join("decoy");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        fs::rename(&root, &retained).unwrap();
        fs::create_dir(&decoy).unwrap();
        symlink(&decoy, &root).unwrap();

        let apparent = store.new_record_path(1, 2);
        store.publish(&apparent, b"secure").unwrap();
        let name = apparent.file_name().unwrap();
        assert_eq!(fs::read(retained.join(name)).unwrap(), b"secure\n");
        assert!(!decoy.join(name).exists());
        assert_eq!(store.read(&apparent).unwrap(), b"secure\n");
        store.remove(&apparent).unwrap();
        assert!(!retained.join(name).exists());
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_publications_are_complete_and_distinct() {
        use std::sync::Arc;

        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(ProcessRecordStore::open(temp.path().join("records")).unwrap());
        let workers: Vec<_> = (0..16)
            .map(|index| {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    let path = store.new_record_path(index, index as u64);
                    let payload = format!("record-{index}");
                    store.publish(&path, payload.as_bytes()).unwrap();
                    (path, payload)
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(store.entries().unwrap().len(), results.len());
        for (path, payload) in results {
            assert_eq!(
                store.read(&path).unwrap(),
                format!("{payload}\n").as_bytes()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn directory_and_records_are_owner_private_under_permissive_umask() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("records");
        let store = ProcessRecordStore::open(root.clone()).unwrap();
        let destination = store.new_record_path(1, 2);
        store.publish(&destination, b"{}").unwrap();
        assert_eq!(
            fs::metadata(root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(destination).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
