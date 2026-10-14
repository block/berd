//! The one main-thread hop helper. AppKit rule: every AppKit-touching
//! call runs on the main thread; this helper hops there and returns the
//! closure's value over a channel.

use std::sync::mpsc;

use tauri::AppHandle;

pub fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}
