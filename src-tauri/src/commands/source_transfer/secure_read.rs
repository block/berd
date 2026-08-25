use std::{
    ffi::OsStr,
    fs,
    io::{self, Read},
    path::{Component, Path},
};

pub(super) fn read_confined_utf8(
    root: &Path,
    relative: &Path,
    max_bytes: u64,
) -> io::Result<String> {
    read_confined_utf8_with_hook(root, relative, max_bytes, |_| {})
}

fn validated_relative_components(path: &Path) -> io::Result<Vec<&OsStr>> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(component) => components.push(component),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "source file path must stay within the authorized root",
                ));
            }
        }
    }
    if components.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "source file path must name a file",
        ));
    }
    Ok(components)
}

fn read_opened_file(mut file: fs::File, max_bytes: u64) -> io::Result<String> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("source file exceeds the maximum encoded size of {max_bytes} bytes"),
        ));
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref().take(max_bytes + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("source file exceeds the maximum encoded size of {max_bytes} bytes"),
        ));
    }
    String::from_utf8(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn directory_traversal_flags() -> libc::c_int {
    libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
}

#[cfg(all(
    unix,
    any(
        target_vendor = "apple",
        target_os = "aix",
        target_os = "freebsd",
        target_os = "illumos",
        target_os = "netbsd",
        target_os = "solaris"
    )
))]
fn directory_traversal_flags() -> libc::c_int {
    libc::O_SEARCH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
}

#[cfg(all(
    unix,
    not(any(
        target_vendor = "apple",
        target_os = "aix",
        target_os = "android",
        target_os = "freebsd",
        target_os = "illumos",
        target_os = "linux",
        target_os = "netbsd",
        target_os = "solaris"
    ))
))]
fn directory_traversal_flags() -> libc::c_int {
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
}

#[cfg(unix)]
fn open_root(root: &Path, after_opened_component: &mut impl FnMut(&Path)) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = fs::OpenOptions::new();
    options.read(true).custom_flags(directory_traversal_flags());
    let mut directory = options.open(Path::new("/"))?;
    let mut opened_path = std::path::PathBuf::from("/");
    let mut saw_root = false;
    for component in root.components() {
        match component {
            Component::RootDir if !saw_root => saw_root = true,
            Component::Normal(component) if saw_root => {
                directory = open_at(&directory, component, directory_traversal_flags())?;
                opened_path.push(component);
                after_opened_component(&opened_path);
            }
            Component::CurDir if saw_root => {}
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "authorized root must be an absolute normalized path",
                ));
            }
        }
    }
    if !saw_root || opened_path != root || !directory.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "authorized root is not an absolute regular directory",
        ));
    }
    Ok(directory)
}

#[cfg(unix)]
fn read_confined_utf8_with_hook(
    root: &Path,
    relative: &Path,
    max_bytes: u64,
    mut after_opened_component: impl FnMut(&Path),
) -> io::Result<String> {
    let components = validated_relative_components(relative)?;
    let (file_name, ancestors) = components.split_last().unwrap();
    let mut directory = open_root(root, &mut after_opened_component)?;

    let mut opened_path = std::path::PathBuf::new();
    for ancestor in ancestors {
        directory = open_at(&directory, ancestor, directory_traversal_flags())?;
        opened_path.push(ancestor);
        after_opened_component(&opened_path);
    }

    let file = open_at(
        &directory,
        file_name,
        libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )?;
    read_opened_file(file, max_bytes)
}

#[cfg(unix)]
fn open_at(directory: &fs::File, name: &OsStr, flags: libc::c_int) -> io::Result<fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let name = CString::new(name.as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "source file path contains a NUL byte",
        )
    })?;
    // SAFETY: openat does not retain the name pointer, and no creation flag requiring a mode is set.
    let descriptor = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor on success.
    Ok(unsafe { fs::File::from_raw_fd(descriptor) })
}

#[cfg(windows)]
fn open_root(root: &Path, after_opened_component: &mut impl FnMut(&Path)) -> io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use winapi::um::winbase::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};
    use winapi::um::winnt::{
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
        SYNCHRONIZE,
    };

    let root_anchor = root
        .ancestors()
        .last()
        .filter(|path| path.has_root())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "authorized root must be an absolute normalized path",
            )
        })?;
    let relative = root.strip_prefix(root_anchor).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "authorized root must be an absolute normalized path",
        )
    })?;
    let components = if relative.as_os_str().is_empty() {
        Vec::new()
    } else {
        validated_relative_components(relative)?
    };

    let mut options = fs::OpenOptions::new();
    options
        .access_mode(FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    let mut directory = options.open(root_anchor)?;
    let metadata = directory.metadata()?;
    if windows_metadata_is_reparse_point(&metadata) || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "authorized root is not a regular directory",
        ));
    }

    let mut opened_path = root_anchor.to_path_buf();
    for component in components {
        directory = windows_open_at(&directory, component, true)?;
        let metadata = directory.metadata()?;
        if windows_metadata_is_reparse_point(&metadata) || !metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "authorized root ancestor is not a regular directory",
            ));
        }
        opened_path.push(component);
        after_opened_component(&opened_path);
    }
    if opened_path != root {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "authorized root must be an absolute normalized path",
        ));
    }
    Ok(directory)
}

#[cfg(windows)]
fn read_confined_utf8_with_hook(
    root: &Path,
    relative: &Path,
    max_bytes: u64,
    mut after_opened_component: impl FnMut(&Path),
) -> io::Result<String> {
    let components = validated_relative_components(relative)?;
    let (file_name, ancestors) = components.split_last().unwrap();
    let mut directory = open_root(root, &mut after_opened_component)?;

    let mut opened_path = std::path::PathBuf::new();
    for ancestor in ancestors {
        directory = windows_open_at(&directory, ancestor, true)?;
        let metadata = directory.metadata()?;
        if windows_metadata_is_reparse_point(&metadata) || !metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "source file ancestor is not a regular directory",
            ));
        }
        opened_path.push(ancestor);
        after_opened_component(&opened_path);
    }

    let file = windows_open_at(&directory, file_name, false)?;
    let metadata = file.metadata()?;
    if windows_metadata_is_reparse_point(&metadata) || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "source file is not a regular file",
        ));
    }
    read_opened_file(file, max_bytes)
}

#[cfg(windows)]
fn windows_open_at(
    directory: &fs::File,
    name: &OsStr,
    directory_only: bool,
) -> io::Result<fs::File> {
    use ntapi::ntioapi::{
        FILE_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
    };
    use winapi::um::winnt::{FILE_GENERIC_READ, FILE_READ_ATTRIBUTES, FILE_TRAVERSE, SYNCHRONIZE};

    let mut create_options = FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT;
    if directory_only {
        create_options |= FILE_DIRECTORY_FILE;
    }
    let desired_access = if directory_only {
        FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE
    } else {
        FILE_GENERIC_READ
    };
    windows_open_at_with_options(directory, name, desired_access, FILE_OPEN, create_options)
}

#[cfg(windows)]
fn windows_open_at_with_options(
    directory: &fs::File,
    name: &OsStr,
    desired_access: u32,
    create_disposition: u32,
    create_options: u32,
) -> io::Result<fs::File> {
    use ntapi::ntioapi::{NtCreateFile, IO_STATUS_BLOCK};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use winapi::shared::ntdef::{
        HANDLE, NT_SUCCESS, OBJECT_ATTRIBUTES, OBJ_CASE_INSENSITIVE, UNICODE_STRING,
    };
    use winapi::um::winnt::{FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE};

    let mut name: Vec<u16> = name.encode_wide().collect();
    let name_bytes = name
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "source file path component is too long",
            )
        })?;
    let mut unicode_name = UNICODE_STRING {
        Length: name_bytes,
        MaximumLength: name_bytes,
        Buffer: name.as_mut_ptr(),
    };
    let mut attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: directory.as_raw_handle() as HANDLE,
        ObjectName: &mut unicode_name,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null_mut(),
        SecurityQualityOfService: std::ptr::null_mut(),
    };
    let mut handle: HANDLE = std::ptr::null_mut();
    // SAFETY: IO_STATUS_BLOCK is initialized before the synchronous call.
    let mut io_status: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    // SAFETY: all pointers reference initialized values for the duration of the synchronous call.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access,
            &mut attributes,
            &mut io_status,
            std::ptr::null_mut(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            create_disposition,
            create_options,
            std::ptr::null_mut(),
            0,
        )
    };
    if !NT_SUCCESS(status) {
        return Err(windows_nt_status_error(status));
    }
    // SAFETY: NtCreateFile returned a new owned handle on success.
    Ok(unsafe { fs::File::from_raw_handle(handle.cast()) })
}

#[cfg(windows)]
fn windows_metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use winapi::um::winnt::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(windows)]
fn windows_nt_status_error(status: winapi::shared::ntdef::NTSTATUS) -> io::Error {
    // SAFETY: RtlNtStatusToDosError accepts every NTSTATUS value.
    let error = unsafe { ntapi::ntrtl::RtlNtStatusToDosError(status) };
    io::Error::from_raw_os_error(error as i32)
}

#[cfg(not(any(unix, windows)))]
fn read_confined_utf8_with_hook(
    _root: &Path,
    relative: &Path,
    _max_bytes: u64,
    _after_opened_component: impl FnMut(&Path),
) -> io::Result<String> {
    validated_relative_components(relative)?;
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "secure source reads are not supported on this platform",
    ))
}

#[cfg(test)]
pub(super) fn read_confined_utf8_for_test(
    root: &Path,
    relative: &Path,
    max_bytes: u64,
    after_opened_component: impl FnMut(&Path),
) -> io::Result<String> {
    read_confined_utf8_with_hook(root, relative, max_bytes, after_opened_component)
}
