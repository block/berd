use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "macos")]
use std::time::Duration;
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::Manager;

const BB_LINK_PATH: &str = "/usr/local/bin/bb";
#[cfg(target_os = "macos")]
const AUTO_INSTALL_DELAY: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BbCliStatus {
    installed: bool,
    needs_repair: bool,
    can_install: bool,
    link_path: String,
    bundled_path: Option<String>,
    current_target: Option<String>,
    found_on_path: Option<String>,
    bundled_version: Option<String>,
    message: String,
    detail: String,
}

#[tauri::command]
pub fn get_bb_cli_status(app: AppHandle) -> BbCliStatus {
    bb_cli_status(&app)
}

#[tauri::command]
pub fn install_bb_cli(app: AppHandle) -> Result<BbCliStatus, String> {
    let bundled = bundled_bb_path(&app).ok_or_else(|| {
        "Could not resolve the bundled bb CLI path. Is this app packaged with bb?".to_string()
    })?;

    if !is_executable(&bundled) {
        return Err(format!(
            "The bundled bb CLI is missing or not executable at {}",
            bundled.display()
        ));
    }

    install_bb_symlink(&bundled)?;
    Ok(bb_cli_status(&app))
}

#[cfg(target_os = "macos")]
pub fn schedule_bb_cli_auto_install(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(AUTO_INSTALL_DELAY);

        let status = bb_cli_status(&app);
        if status.installed {
            log::info!("bb CLI link already points to the bundled command.");
            return;
        }
        if !status.can_install {
            log::warn!("Skipping bb CLI auto-install: {}", status.detail);
            return;
        }
        let Some(bundled_path) = bundled_bb_path(&app) else {
            log::warn!("Skipping bb CLI auto-install: bundled bb path is unavailable.");
            return;
        };
        if !is_stable_installed_app_resource(&bundled_path) {
            log::info!(
                "Skipping bb CLI auto-install because Goose is not running from an installed Applications bundle."
            );
            return;
        }

        match install_bb_cli(app) {
            Ok(next_status) if next_status.installed => {
                log::info!("Installed bb CLI link at {}.", next_status.link_path);
            }
            Ok(next_status) => {
                log::warn!(
                    "bb CLI auto-install finished but did not install: {}",
                    next_status.detail
                );
            }
            Err(error) => log::warn!("Failed to auto-install bb CLI link: {error}"),
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn schedule_bb_cli_auto_install(_app: &AppHandle) {}

fn bb_cli_status(app: &AppHandle) -> BbCliStatus {
    let bundled = bundled_bb_path(app);
    let bundled_version = bundled.as_deref().and_then(bb_version);
    let current_target = std::fs::read_link(BB_LINK_PATH)
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    let resolved_current = current_target
        .as_deref()
        .map(|path| resolve_path(Path::new(path)));
    let resolved_bundled = bundled.as_deref().map(resolve_path);
    let found_on_path = command_output("/usr/bin/which", &["bb"]);

    let bundled_path = bundled
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    let bundled_executable = bundled.as_deref().is_some_and(is_executable);
    let installed = resolved_current.is_some()
        && resolved_bundled.is_some()
        && resolved_current == resolved_bundled;
    let link_exists = Path::new(BB_LINK_PATH).exists() || current_target.is_some();
    let needs_repair = !installed && (link_exists || found_on_path.is_some());
    let can_install = bundled_executable;

    let (message, detail) = if installed {
        (
            "CLI installed".to_string(),
            format!("{BB_LINK_PATH} points to the bundled bb command."),
        )
    } else if current_target.is_some() {
        (
            "CLI link needs repair".to_string(),
            format!(
                "{BB_LINK_PATH} currently points to {}.",
                resolved_current
                    .as_deref()
                    .unwrap_or("an unreadable target")
            ),
        )
    } else if link_exists {
        (
            "CLI path needs replacement".to_string(),
            format!("{BB_LINK_PATH} exists but is not the bundled bb command."),
        )
    } else if let Some(path) = &found_on_path {
        (
            "CLI found elsewhere".to_string(),
            format!("A bb command was found at {path}."),
        )
    } else if bundled_executable {
        (
            "CLI not installed".to_string(),
            format!("Install a {BB_LINK_PATH} link to the bundled bb command."),
        )
    } else {
        (
            "Bundled CLI missing".to_string(),
            bundled_path
                .as_ref()
                .map(|path| format!("Expected an executable bb command at {path}."))
                .unwrap_or_else(|| {
                    "This app bundle does not expose a bb CLI resource.".to_string()
                }),
        )
    };

    BbCliStatus {
        installed,
        needs_repair,
        can_install,
        link_path: BB_LINK_PATH.to_string(),
        bundled_path,
        current_target,
        found_on_path,
        bundled_version,
        message,
        detail,
    }
}

fn bundled_bb_path(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        app.path().resource_dir().ok().map(|dir| dir.join("bb"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

fn bb_version(path: &Path) -> Option<String> {
    command_output(path, &["--version"])
}

fn command_output<P: AsRef<std::ffi::OsStr>>(program: P, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn resolve_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

#[cfg(target_os = "macos")]
fn is_stable_installed_app_resource(path: &Path) -> bool {
    let Some(resources_dir) = path.parent() else {
        return false;
    };
    let Some(contents_dir) = resources_dir.parent() else {
        return false;
    };
    let Some(app_bundle) = contents_dir.parent() else {
        return false;
    };
    if app_bundle.extension().and_then(|ext| ext.to_str()) != Some("app") {
        return false;
    }

    app_bundle
        .parent()
        .is_some_and(|parent| parent == Path::new("/Applications"))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(metadata) = std::fs::metadata(path) else {
            return false;
        };
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

fn install_bb_symlink(cli_path: &Path) -> Result<(), String> {
    if try_install_bb_symlink(cli_path).is_ok() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        macos::install_bb_symlink_with_authorization(cli_path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Installing the bb CLI link is only supported on macOS right now.".to_string())
    }
}

fn try_install_bb_symlink(cli_path: &Path) -> std::io::Result<()> {
    let link = Path::new(BB_LINK_PATH);
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::symlink_metadata(link).is_ok() {
        std::fs::remove_file(link)?;
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(cli_path, link)
    }
    #[cfg(not(unix))]
    {
        let _ = cli_path;
        Err(std::io::Error::other("symlinks are unsupported"))
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{Path, BB_LINK_PATH};
    use libc::{c_char, c_int, c_void, pid_t};
    use std::ffi::CString;
    use std::ptr;

    type AuthorizationRef = *mut c_void;
    type CFStringRef = *const c_void;
    type CFTypeRef = *const c_void;
    type OSStatus = i32;

    const ERR_AUTHORIZATION_SUCCESS: OSStatus = 0;
    const ERR_AUTHORIZATION_DENIED: OSStatus = -60005;
    const K_AUTHORIZATION_FLAG_DEFAULTS: u32 = 0;
    const K_AUTHORIZATION_FLAG_INTERACTION_ALLOWED: u32 = 1 << 0;
    const K_AUTHORIZATION_FLAG_EXTEND_RIGHTS: u32 = 1 << 1;
    const K_AUTHORIZATION_FLAG_DESTROY_RIGHTS: u32 = 1 << 3;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const BB_SYMLINK_AUTH_RIGHT: &str = "com.squareup.goose-internal.symlink";
    const BB_SYMLINK_AUTH_PROMPT: &str =
        "Goose is trying to install its command line interface (CLI) tool.";
    const AUTHENTICATE_AS_ADMIN_RULE: &str = "authenticate-admin";

    #[repr(C)]
    struct AuthorizationItem {
        name: *const c_char,
        value_length: u32,
        value: *mut c_void,
        flags: u32,
    }

    #[repr(C)]
    struct AuthorizationRights {
        count: u32,
        items: *mut AuthorizationItem,
    }

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn AuthorizationCreate(
            rights: *const AuthorizationRights,
            environment: *const c_void,
            flags: u32,
            authorization: *mut AuthorizationRef,
        ) -> OSStatus;
        fn AuthorizationCopyRights(
            authorization: AuthorizationRef,
            rights: *const AuthorizationRights,
            environment: *const c_void,
            flags: u32,
            authorized_rights: *mut *mut AuthorizationRights,
        ) -> OSStatus;
        fn AuthorizationRightGet(
            right_name: *const c_char,
            right_definition: *mut *mut c_void,
        ) -> OSStatus;
        fn AuthorizationRightSet(
            authorization: AuthorizationRef,
            right_name: *const c_char,
            right_definition: CFTypeRef,
            description_key: CFStringRef,
            bundle: *const c_void,
            locale_table_name: CFStringRef,
        ) -> OSStatus;
        fn AuthorizationExecuteWithPrivileges(
            authorization: AuthorizationRef,
            path_to_tool: *const c_char,
            options: u32,
            arguments: *mut *mut c_char,
            communications_pipe: *mut *mut c_void,
        ) -> OSStatus;
        fn AuthorizationFree(authorization: AuthorizationRef, flags: u32) -> OSStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }

    pub fn install_bb_symlink_with_authorization(cli_path: &Path) -> Result<(), String> {
        let auth = authorization()?;
        let result = run_install_commands(auth, cli_path);
        unsafe {
            AuthorizationFree(auth, K_AUTHORIZATION_FLAG_DESTROY_RIGHTS);
        }
        result
    }

    fn authorization() -> Result<AuthorizationRef, String> {
        let mut auth: AuthorizationRef = ptr::null_mut();
        let status = unsafe {
            AuthorizationCreate(
                ptr::null(),
                ptr::null(),
                K_AUTHORIZATION_FLAG_DEFAULTS,
                &mut auth,
            )
        };
        if status != ERR_AUTHORIZATION_SUCCESS || auth.is_null() {
            return Err(format!("AuthorizationCreate failed with status {status}."));
        }

        let right_name = CString::new(BB_SYMLINK_AUTH_RIGHT).expect("static right name");
        if let Err(error) = ensure_symlink_authorization_right(auth, &right_name) {
            unsafe {
                AuthorizationFree(auth, K_AUTHORIZATION_FLAG_DESTROY_RIGHTS);
            }
            return Err(error);
        }

        let mut item = AuthorizationItem {
            name: right_name.as_ptr(),
            value_length: 0,
            value: ptr::null_mut(),
            flags: 0,
        };
        let rights = AuthorizationRights {
            count: 1,
            items: &mut item,
        };
        let flags = K_AUTHORIZATION_FLAG_EXTEND_RIGHTS | K_AUTHORIZATION_FLAG_INTERACTION_ALLOWED;
        let status =
            unsafe { AuthorizationCopyRights(auth, &rights, ptr::null(), flags, ptr::null_mut()) };
        if status != ERR_AUTHORIZATION_SUCCESS {
            unsafe {
                AuthorizationFree(auth, K_AUTHORIZATION_FLAG_DESTROY_RIGHTS);
            }
            return Err(format!(
                "AuthorizationCopyRights failed with status {status}."
            ));
        }

        Ok(auth)
    }

    fn ensure_symlink_authorization_right(
        auth: AuthorizationRef,
        right_name: &CString,
    ) -> Result<(), String> {
        let status = unsafe { AuthorizationRightGet(right_name.as_ptr(), ptr::null_mut()) };
        if status == ERR_AUTHORIZATION_SUCCESS {
            return Ok(());
        }
        if status != ERR_AUTHORIZATION_DENIED {
            return Err(format!(
                "AuthorizationRightGet failed with status {status}."
            ));
        }

        let prompt = CString::new(BB_SYMLINK_AUTH_PROMPT).expect("static authorization prompt");
        let prompt = unsafe {
            CFStringCreateWithCString(ptr::null(), prompt.as_ptr(), K_CF_STRING_ENCODING_UTF8)
        };
        if prompt.is_null() {
            return Err("Failed to create authorization prompt.".to_string());
        }

        let rule = CString::new(AUTHENTICATE_AS_ADMIN_RULE).expect("static authorization rule");
        let rule = unsafe {
            CFStringCreateWithCString(ptr::null(), rule.as_ptr(), K_CF_STRING_ENCODING_UTF8)
        };
        if rule.is_null() {
            unsafe {
                CFRelease(prompt);
            }
            return Err("Failed to create authorization rule.".to_string());
        }

        let status = unsafe {
            AuthorizationRightSet(
                auth,
                right_name.as_ptr(),
                rule as CFTypeRef,
                prompt,
                ptr::null(),
                ptr::null(),
            )
        };
        unsafe {
            CFRelease(rule);
            CFRelease(prompt);
        }
        if status != ERR_AUTHORIZATION_SUCCESS {
            return Err(format!(
                "AuthorizationRightSet failed with status {status}."
            ));
        }

        Ok(())
    }

    fn run_install_commands(auth: AuthorizationRef, cli_path: &Path) -> Result<(), String> {
        run_privileged_tool(auth, "/bin/mkdir", &["-p", "/usr/local/bin"])?;
        let cli_path = cli_path.to_str().ok_or_else(|| {
            format!(
                "Bundled CLI path is not valid UTF-8: {}",
                cli_path.display()
            )
        })?;
        run_privileged_tool(auth, "/bin/ln", &["-sfn", cli_path, BB_LINK_PATH])
    }

    fn run_privileged_tool(
        auth: AuthorizationRef,
        tool: &str,
        args: &[&str],
    ) -> Result<(), String> {
        let tool = CString::new(tool).map_err(|error| error.to_string())?;
        let c_args = args
            .iter()
            .map(|arg| CString::new(*arg).map_err(|error| error.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let mut raw_args = c_args
            .iter()
            .map(|arg| arg.as_ptr() as *mut c_char)
            .chain(std::iter::once(ptr::null_mut()))
            .collect::<Vec<_>>();

        #[allow(deprecated)]
        let status = unsafe {
            AuthorizationExecuteWithPrivileges(
                auth,
                tool.as_ptr(),
                K_AUTHORIZATION_FLAG_DEFAULTS,
                raw_args.as_mut_ptr(),
                ptr::null_mut(),
            )
        };
        if status != ERR_AUTHORIZATION_SUCCESS {
            return Err(format!(
                "AuthorizationExecuteWithPrivileges failed with status {status}."
            ));
        }

        let mut wait_status: c_int = 0;
        let pid: pid_t = unsafe { libc::wait(&mut wait_status) };
        if pid == -1 {
            return Err("Failed waiting for privileged install command.".to_string());
        }
        if !libc::WIFEXITED(wait_status) {
            return Err("Privileged install command did not exit normally.".to_string());
        }
        let exit_status = libc::WEXITSTATUS(wait_status);
        if exit_status != 0 {
            return Err(format!(
                "Privileged install command exited with status {exit_status}."
            ));
        }
        Ok(())
    }
}
