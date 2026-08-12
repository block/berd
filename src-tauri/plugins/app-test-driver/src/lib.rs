use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::WebviewWindow;
use tauri::{AppHandle, Manager, Runtime};

const READY_FILE_NAME: &str = "app-test-driver.json";
const SERVER_POLL_INTERVAL: Duration = Duration::from_millis(50);

const SUPPORTED_ACTIONS: &[&str] = &[
    "snapshot",
    "active",
    "click",
    "fill",
    "keypress",
    "getText",
    "waitForText",
    "count",
    "scroll",
    "screenshot",
];

#[derive(Deserialize, Debug)]
struct TestCommand {
    #[serde(default)]
    token: String,
    action: String,
    selector: Option<String>,
    value: Option<String>,
    timeout: Option<u64>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
struct TestResult {
    success: bool,
    data: Option<String>,
    error: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
struct DriverReady {
    host: &'static str,
    port: u16,
    pid: u32,
}

#[derive(Debug)]
pub struct DriverConfig {
    token: String,
    ready_file: PathBuf,
}

impl DriverConfig {
    pub fn new(token: String, run_root: impl AsRef<Path>) -> Self {
        Self {
            token,
            ready_file: run_root.as_ref().join(READY_FILE_NAME),
        }
    }
}

#[derive(Debug)]
enum DriverMode {
    Legacy,
    Isolated(DriverConfig),
}

#[derive(Debug)]
struct DriverServer {
    ready_file: Option<PathBuf>,
    shutdown_tx: Mutex<Option<mpsc::Sender<()>>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl DriverServer {
    fn new(
        ready_file: Option<PathBuf>,
        shutdown_tx: mpsc::Sender<()>,
        worker: std::thread::JoinHandle<()>,
    ) -> Self {
        Self {
            ready_file,
            shutdown_tx: Mutex::new(Some(shutdown_tx)),
            worker: Mutex::new(Some(worker)),
        }
    }

    fn signal_shutdown(&self) {
        if let Some(shutdown_tx) = self
            .shutdown_tx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            let _ = shutdown_tx.send(());
        }
        if let Some(ready_file) = &self.ready_file {
            remove_ready_file(ready_file);
        }
    }

    fn shutdown(&self) {
        self.signal_shutdown();
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            if let Err(error) = worker.join() {
                log::warn!("[app-test-driver] Server thread panicked: {error:?}");
            }
        }
    }
}

impl Drop for DriverServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl TestResult {
    fn success(data: impl Into<String>) -> Self {
        Self {
            success: true,
            data: Some(data.into()),
            error: None,
        }
    }

    fn failure(error: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.into()),
        }
    }
}

#[tauri::command]
fn driver_result(state: tauri::State<'_, DriverState>, value: String) {
    let mut result = state.pending_result.lock().unwrap();
    *result = Some(value);
    state.signal.notify_one();
}

struct DriverState {
    command_lock: Mutex<()>,
    pending_result: Mutex<Option<String>>,
    signal: std::sync::Condvar,
}

impl DriverState {
    fn new() -> Self {
        Self {
            command_lock: Mutex::new(()),
            pending_result: Mutex::new(None),
            signal: std::sync::Condvar::new(),
        }
    }

    fn wait_for_result(&self, timeout_ms: u64) -> Option<String> {
        let timeout = std::time::Duration::from_millis(timeout_ms + 1000);
        let guard = self.pending_result.lock().unwrap();
        let (mut guard, _) = self
            .signal
            .wait_timeout_while(guard, timeout, |result| result.is_none())
            .unwrap();
        guard.take()
    }

    fn reset(&self) {
        *self.pending_result.lock().unwrap() = None;
    }
}

fn escape_js_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn with_wait_for(selector: &str, action_js: &str, timeout_ms: u64) -> String {
    let escaped = escape_js_string(selector);
    format!(
        r#"(async function() {{
            const sel = "{escaped}";
            const start = Date.now();
            while (Date.now() - start < {timeout_ms}) {{
                const el = document.querySelector(sel);
                if (el) {{
                    {action_js}
                }}
                await new Promise(r => setTimeout(r, 100));
            }}
            return "ERROR: timeout waiting for element: " + sel;
        }})()"#
    )
}

fn build_js(cmd: &TestCommand) -> Result<String, String> {
    let timeout_ms = cmd.timeout.unwrap_or(5000);
    let inner_js = match cmd.action.as_str() {
        "snapshot" => r#"
            (function() {
                const result = [];
                let eIdx = 0;
                let tIdx = 0;

                function isVisible(el) {
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && style.opacity !== '0';
                }

                function isInteractive(tag) {
                    return ['INPUT','BUTTON','SELECT','TEXTAREA','A'].includes(tag);
                }

                function walk(node, depth) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const tag = node.tagName;
                        if (['SCRIPT','STYLE','META','LINK','NOSCRIPT'].includes(tag)) return;
                        if (!isVisible(node)) return;

                        const indent = '  '.repeat(depth);
                        const tagLower = tag.toLowerCase();

                        if (isInteractive(tag)) {
                            eIdx++;
                            node.setAttribute('data-tid', 'e' + eIdx);
                            let info = '[e' + eIdx + '] ' + tagLower;
                            if (node.type) info += ' type="' + node.type + '"';
                            if (node.placeholder) info += ' placeholder="' + node.placeholder + '"';
                            if (node.value) info += ' value="' + node.value + '"';
                            if (node.href) info += ' href="' + node.href + '"';
                            const text = node.innerText?.trim();
                            if (text && text.length < 100) info += ' "' + text + '"';
                            result.push(indent + info);
                        } else {
                            const directText = Array.from(node.childNodes)
                                .filter(n => n.nodeType === Node.TEXT_NODE)
                                .map(n => n.textContent.trim())
                                .join(' ')
                                .trim();
                            if (directText && directText.length > 0 && directText.length < 200) {
                                tIdx++;
                                result.push(indent + '[t' + tIdx + '] ' + tagLower + ' "' + directText + '"');
                            }
                        }

                        for (const child of node.children) {
                            walk(child, depth + 1);
                        }
                    }
                }

                walk(document.body, 0);
                return result.join('\n');
            })()
        "#
        .to_string(),
        "active" => r#"
            (function() {
                const el = document.activeElement;
                if (!el) return "";
                const parts = [el.tagName.toLowerCase()];
                if (el.getAttribute("data-testid")) parts.push("data-testid=" + el.getAttribute("data-testid"));
                if (el.getAttribute("aria-label")) parts.push("aria-label=" + el.getAttribute("aria-label"));
                if (el.getAttribute("placeholder")) parts.push("placeholder=" + el.getAttribute("placeholder"));
                if (el.className && typeof el.className === "string") parts.push("class=" + el.className);
                return parts.join(" ");
            })()
        "#
        .to_string(),
        "click" => {
            let sel = cmd.selector.as_deref().unwrap_or("body");
            with_wait_for(sel, r#"el.click(); return "clicked";"#, timeout_ms)
        }
        "fill" => {
            let sel = cmd.selector.as_deref().unwrap_or("input");
            let val = escape_js_string(cmd.value.as_deref().unwrap_or(""));
            with_wait_for(
                sel,
                &format!(
                    r#"const proto = el instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                setter.call(el, "{val}");
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                return "filled";"#
                ),
                timeout_ms,
            )
        }
        "keypress" => {
            let sel = cmd.selector.as_deref().unwrap_or("body");
            let raw_key = cmd.value.as_deref().unwrap_or("Enter");
            let mut key = raw_key;
            let mut ctrl_key = false;
            let mut meta_key = false;
            let mut alt_key = false;
            let mut shift_key = false;
            if raw_key.contains('+') {
                for part in raw_key.split('+') {
                    match part {
                        "Control" | "Ctrl" => ctrl_key = true,
                        "Meta" | "Command" | "Cmd" => meta_key = true,
                        "Alt" | "Option" => alt_key = true,
                        "Shift" => shift_key = true,
                        value => key = value,
                    }
                }
            }
            let escaped_key = escape_js_string(key);
            with_wait_for(
                sel,
                &format!(
                    r#"const opts = {{ key: "{escaped_key}", code: "{escaped_key}", keyCode: "{escaped_key}" === "Enter" ? 13 : 0, ctrlKey: {ctrl_key}, metaKey: {meta_key}, altKey: {alt_key}, shiftKey: {shift_key}, bubbles: true, cancelable: true }};
                el.dispatchEvent(new KeyboardEvent('keydown', opts));
                el.dispatchEvent(new KeyboardEvent('keypress', opts));
                el.dispatchEvent(new KeyboardEvent('keyup', opts));
                return "keypressed";"#
                ),
                timeout_ms,
            )
        }
        "getText" => {
            let sel = cmd.selector.as_deref().unwrap_or("body");
            with_wait_for(sel, "return el.innerText;", timeout_ms)
        }
        "waitForText" => {
            let sel = cmd.selector.as_deref().unwrap_or("body");
            let text = escape_js_string(cmd.value.as_deref().unwrap_or(""));
            let escaped_sel = escape_js_string(sel);
            format!(
                r#"(async function() {{
                    const sel = "{escaped_sel}";
                    const text = "{text}";
                    const start = Date.now();
                    while (Date.now() - start < {timeout_ms}) {{
                        const el = document.querySelector(sel);
                        if (el && el.innerText.includes(text)) {{
                            return el.innerText;
                        }}
                        await new Promise(r => setTimeout(r, 100));
                    }}
                    return "ERROR: timeout waiting for text: " + text;
                }})()"#
            )
        }
        "count" => {
            let sel = cmd.selector.as_deref().unwrap_or("*");
            let escaped_sel = escape_js_string(sel);
            format!("String(document.querySelectorAll(\"{escaped_sel}\").length)")
        }
        "scroll" => {
            let direction = cmd.value.as_deref().unwrap_or("down");
            match direction {
                "up" => "window.scrollBy(0, -window.innerHeight); 'scrolled up'".to_string(),
                "top" => "window.scrollTo(0, 0); 'scrolled to top'".to_string(),
                "bottom" => {
                    "window.scrollTo(0, document.body.scrollHeight); 'scrolled to bottom'"
                        .to_string()
                }
                _ => "window.scrollBy(0, window.innerHeight); 'scrolled down'".to_string(),
            }
        }
        action => return Err(format!("Unsupported test driver action: {action}")),
    };

    Ok(format!(
        r#"
        (async function() {{
            try {{
                const result = await Promise.resolve({inner_js});
                await window.__TAURI_INTERNALS__.invoke('plugin:app-test-driver|driver_result', {{ value: String(result) }});
            }} catch(e) {{
                await window.__TAURI_INTERNALS__.invoke('plugin:app-test-driver|driver_result', {{ value: 'ERROR: ' + e.message }});
            }}
        }})();
        "#
    ))
}

fn constant_time_token_matches(expected: &[u8], actual: &[u8]) -> bool {
    let mut difference = expected.len() ^ actual.len();
    for index in 0..expected.len().max(actual.len()) {
        let expected_byte = expected.get(index).copied().unwrap_or_default();
        let actual_byte = actual.get(index).copied().unwrap_or_default();
        difference |= usize::from(expected_byte ^ actual_byte);
    }
    difference == 0
}

fn validate_command(cmd: &TestCommand, expected_token: &str) -> Result<(), TestResult> {
    if !constant_time_token_matches(expected_token.as_bytes(), cmd.token.as_bytes()) {
        return Err(TestResult::failure("Unauthorized test driver request"));
    }
    if !SUPPORTED_ACTIONS.contains(&cmd.action.as_str()) {
        return Err(TestResult::failure(format!(
            "Unsupported test driver action: {}",
            cmd.action
        )));
    }
    #[cfg(not(target_os = "macos"))]
    if cmd.action == "screenshot" {
        return Err(TestResult::failure(
            "Test driver screenshots are not supported on this platform",
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn get_ns_window_number<R: Runtime>(window: &WebviewWindow<R>) -> Option<u32> {
    let ns_window_ptr = window.ns_window().ok()?;
    let ns_window = unsafe { &*(ns_window_ptr as *const objc2_app_kit::NSWindow) };
    Some(ns_window.windowNumber() as u32)
}

#[cfg(target_os = "macos")]
fn take_screenshot<R: Runtime>(window: &WebviewWindow<R>, path: &str) -> TestResult {
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let window_id = match get_ns_window_number(window) {
        Some(id) => id,
        None => {
            return TestResult {
                success: false,
                data: None,
                error: Some("Failed to get window ID".into()),
            };
        }
    };

    match std::process::Command::new("screencapture")
        .args(["-x", "-l", &window_id.to_string(), path])
        .output()
    {
        Ok(output) if output.status.success() => TestResult {
            success: true,
            data: Some(format!("Screenshot saved to {}", path)),
            error: None,
        },
        Ok(output) => TestResult {
            success: false,
            data: None,
            error: Some(format!(
                "screencapture failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )),
        },
        Err(e) => TestResult {
            success: false,
            data: None,
            error: Some(format!("Failed to run screencapture: {}", e)),
        },
    }
}

fn write_result(stream: &mut impl Write, result: &TestResult) {
    let _ = writeln!(stream, "{}", serde_json::to_string(result).unwrap());
}

fn write_ready_file(path: &Path, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "test driver readiness path has no parent: {}",
                path.display()
            ),
        )
    })?;
    std::fs::create_dir_all(parent)?;

    let ready = DriverReady {
        host: "127.0.0.1",
        port,
        pid: std::process::id(),
    };
    let temporary_path = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let contents = serde_json::to_vec(&ready)?;
    std::fs::write(&temporary_path, contents)?;
    if let Err(error) = std::fs::rename(&temporary_path, path) {
        let _ = std::fs::remove_file(path);
        std::fs::rename(&temporary_path, path).map_err(|replacement_error| {
            std::io::Error::new(
                replacement_error.kind(),
                format!(
                    "failed to publish test driver readiness {} after replacing an existing file ({error}): {replacement_error}",
                    path.display()
                ),
            )
        })?;
    }
    Ok(())
}

fn remove_ready_file(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            log::warn!(
                "[app-test-driver] Failed to remove readiness file {}: {error}",
                path.display()
            );
        }
    }
}

fn start_server<R: Runtime>(
    app_handle: AppHandle<R>,
    token: Option<String>,
    listener: TcpListener,
    shutdown_rx: mpsc::Receiver<()>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || loop {
        if shutdown_rx.try_recv().is_ok() {
            break;
        }

        let (mut stream, _) = match listener.accept() {
            Ok(connection) => connection,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(SERVER_POLL_INTERVAL);
                continue;
            }
            Err(error) => {
                log::error!("[app-test-driver] Failed to accept connection: {error}");
                break;
            }
        };

        let app = app_handle.clone();
        let token = token.clone();

        std::thread::spawn(move || {
            let read_stream = match stream.try_clone() {
                Ok(stream) => stream,
                Err(error) => {
                    write_result(
                        &mut stream,
                        &TestResult::failure(format!(
                            "Failed to initialize test driver connection: {error}"
                        )),
                    );
                    return;
                }
            };
            let reader = BufReader::new(read_stream);

            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }

                let cmd: TestCommand = match serde_json::from_str(&line) {
                    Ok(command) => command,
                    Err(error) => {
                        write_result(
                            &mut stream,
                            &TestResult::failure(format!("Invalid JSON: {error}")),
                        );
                        continue;
                    }
                };

                if let Some(expected_token) = &token {
                    if let Err(result) = validate_command(&cmd, expected_token) {
                        write_result(&mut stream, &result);
                        continue;
                    }
                } else if !SUPPORTED_ACTIONS.contains(&cmd.action.as_str()) {
                    write_result(
                        &mut stream,
                        &TestResult::failure(format!(
                            "Unsupported test driver action: {}",
                            cmd.action
                        )),
                    );
                    continue;
                }
                log::info!("[app-test-driver] Received action: {}", cmd.action);

                let window = match app.get_webview_window("main") {
                    Some(window) => window,
                    None => {
                        write_result(&mut stream, &TestResult::failure("Main window not found"));
                        continue;
                    }
                };

                let state = app.state::<DriverState>();
                let _command_guard = state.command_lock.lock().unwrap();

                #[cfg(target_os = "macos")]
                if cmd.action == "screenshot" {
                    let path = cmd.value.as_deref().unwrap_or("screenshot.png");
                    write_result(&mut stream, &take_screenshot(&window, path));
                    continue;
                }

                state.reset();
                let js = match build_js(&cmd) {
                    Ok(js) => js,
                    Err(error) => {
                        write_result(&mut stream, &TestResult::failure(error));
                        continue;
                    }
                };
                if let Err(error) = window.eval(&js) {
                    write_result(
                        &mut stream,
                        &TestResult::failure(format!("eval failed: {error}")),
                    );
                    continue;
                }

                let timeout_ms = cmd.timeout.unwrap_or(5000);
                let result = state.wait_for_result(timeout_ms);
                let response = match result {
                    Some(data) if data.starts_with("ERROR:") => TestResult::failure(data),
                    Some(data) => TestResult::success(data),
                    None => TestResult::failure("Timeout waiting for result"),
                };
                write_result(&mut stream, &response);
            }
        });
    })
}

fn plugin<R: Runtime>(mode: DriverMode) -> tauri::plugin::TauriPlugin<R> {
    let mode = Arc::new(mode);
    tauri::plugin::Builder::new("app-test-driver")
        .invoke_handler(tauri::generate_handler![driver_result])
        .setup(move |app, _api| {
            let (listener, token, ready_file) = match mode.as_ref() {
                DriverMode::Legacy => {
                    let port = std::env::var("APP_TEST_DRIVER_PORT")
                        .unwrap_or_else(|_| "9999".to_string());
                    let address = format!("127.0.0.1:{port}");
                    let listener = match TcpListener::bind(&address) {
                        Ok(listener) => listener,
                        Err(error) => {
                            eprintln!("[app-test-driver] Failed to bind {address}: {error}");
                            return Ok(());
                        }
                    };
                    (listener, None, None)
                }
                DriverMode::Isolated(config) => {
                    remove_ready_file(&config.ready_file);
                    (
                        TcpListener::bind(("127.0.0.1", 0))?,
                        Some(config.token.clone()),
                        Some(config.ready_file.clone()),
                    )
                }
            };
            listener.set_nonblocking(true)?;
            let port = listener.local_addr()?.port();
            let (shutdown_tx, shutdown_rx) = mpsc::channel();

            app.manage(DriverState::new());
            let worker = start_server(app.clone(), token, listener, shutdown_rx);
            if let Some(ready_file) = &ready_file {
                if let Err(error) = write_ready_file(ready_file, port) {
                    let _ = shutdown_tx.send(());
                    let _ = worker.join();
                    return Err(error);
                }
            }

            app.manage(Arc::new(DriverServer::new(ready_file, shutdown_tx, worker)));
            log::info!("[app-test-driver] Listening on 127.0.0.1:{port}");
            Ok(())
        })
        .on_event(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                if let Some(server) = app.try_state::<Arc<DriverServer>>() {
                    server.signal_shutdown();
                }
            }
        })
        .build()
}

/// Start the legacy local driver on `APP_TEST_DRIVER_PORT` (default `9999`).
///
/// This mode intentionally preserves the app's normal profile and credential
/// storage and accepts the historical unauthenticated loopback protocol.
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    plugin(DriverMode::Legacy)
}

/// Start an authenticated driver with run-scoped readiness discovery.
pub fn init_isolated<R: Runtime>(config: DriverConfig) -> tauri::plugin::TauriPlugin<R> {
    plugin(DriverMode::Isolated(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(token: &str, action: &str) -> TestCommand {
        TestCommand {
            token: token.to_string(),
            action: action.to_string(),
            selector: None,
            value: None,
            timeout: None,
        }
    }

    #[test]
    fn token_match_checks_content_and_length() {
        assert!(constant_time_token_matches(b"secret", b"secret"));
        assert!(!constant_time_token_matches(b"secret", b"secrex"));
        assert!(!constant_time_token_matches(b"secret", b"secret-longer"));
        assert!(!constant_time_token_matches(b"secret-longer", b"secret"));
    }

    #[test]
    fn invalid_token_is_rejected_before_action_dispatch() {
        let error = validate_command(&command("wrong", "snapshot"), "right").unwrap_err();
        assert_eq!(
            error.error.as_deref(),
            Some("Unauthorized test driver request")
        );
    }

    #[test]
    fn unsupported_action_is_an_explicit_failure() {
        let cmd = command("token", "unknown");
        let error = validate_command(&cmd, "token").unwrap_err();
        assert_eq!(
            error.error.as_deref(),
            Some("Unsupported test driver action: unknown")
        );
        assert!(build_js(&cmd).is_err());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn screenshot_is_an_explicit_failure_off_macos() {
        let error = validate_command(&command("token", "screenshot"), "token").unwrap_err();
        assert_eq!(
            error.error.as_deref(),
            Some("Test driver screenshots are not supported on this platform")
        );
    }

    #[test]
    fn driver_binds_an_owned_ephemeral_port_and_shuts_down() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_ne!(port, 0);

        let (shutdown_tx, shutdown_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || loop {
            if shutdown_rx.try_recv().is_ok() {
                break;
            }
            match listener.accept() {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(SERVER_POLL_INTERVAL);
                }
                Err(error) => panic!("unexpected accept error: {error}"),
            }
        });
        shutdown_tx.send(()).unwrap();
        worker.join().unwrap();

        TcpListener::bind(("127.0.0.1", port)).unwrap();
    }

    #[test]
    fn readiness_file_publishes_selected_port_and_pid() {
        let root = unique_test_dir("readiness");
        let path = root.join(READY_FILE_NAME);

        write_ready_file(&path, 54321).unwrap();
        let ready: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(ready["host"], "127.0.0.1");
        assert_eq!(ready["port"], 54321);
        assert_eq!(ready["pid"], std::process::id());

        remove_ready_file(&path);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "app-test-driver-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ))
    }
}
