//! Panel foundation for the desktop agent: swizzles the panel window into
//! a non-activating NSPanel (via tauri-nspanel) and installs a runtime
//! subclass with the panel behaviors:
//!
//! - `canBecomeKeyWindow` gated on an "expanded" flag (collapsed avatar is
//!   never key; expanded popover may become key WITHOUT activating the app)
//! - key-status changes pushed to the webview as `desktop-agent:key-status`
//!   events (the click-outside-collapse signal)
//! - status window level, canJoinAllSpaces + fullScreenAuxiliary
//!
//! House rules:
//! - every AppKit touch happens on the main thread (`run_on_main_thread`)
//! - NSApplication::sharedApplication, never a fictional NSApp class
//!
//! Note: the subclass uses objc2's runtime `ClassBuilder` rather than
//! `define_class!` — the panel class must extend tauri-nspanel's
//! `RawNSPanel`, which is only known at runtime, so the static macro
//! cannot name it.

use std::cell::Cell;
use std::ffi::CString;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{msg_send, sel};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const SUBCLASS_NAME: &str = "BerdDesktopAgentPanel";
const PLUGIN_PANEL_CLASS: &str = "RawNSPanel";

const NS_NONACTIVATING_PANEL_MASK: usize = 1 << 7;
const NS_BORDERLESS_MASK: usize = 0;
const NS_STATUS_WINDOW_LEVEL: isize = 25;
const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
const FULLSCREEN_AUXILIARY: usize = 1 << 8;

/// Expanded flag read by the subclass's canBecomeKeyWindow override. A
/// process-global is acceptable: there is exactly one avatar panel.
static EXPANDED: AtomicBool = AtomicBool::new(false);

/// tao's original NSWindow class, captured in install() BEFORE any
/// swizzle so prepare_destroy() can restore it (see that function for
/// the teardown-crash story). Class pointers are 'static; usize keeps
/// the static plain. One panel, so one slot.
static ORIGINAL_CLASS: AtomicUsize = AtomicUsize::new(0);

/// AppHandle for pushing key-status events from the ObjC overrides.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

thread_local! {
    /// Re-entrancy guard: super calls from the overrides must not re-emit.
    static IN_KEY_HOOK: Cell<bool> = const { Cell::new(false) };
}

fn emit_key_status(is_key: bool) {
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("desktop-agent:key-status", is_key);
    }
}

extern "C" fn can_become_key_window(_this: *mut AnyObject, _cmd: Sel) -> Bool {
    Bool::new(EXPANDED.load(Ordering::Relaxed))
}

extern "C" fn can_become_main_window(_this: *mut AnyObject, _cmd: Sel) -> Bool {
    Bool::NO
}

extern "C" fn become_key_window(this: *mut AnyObject, _cmd: Sel) {
    unsafe {
        let superclass = AnyClass::get(&CString::new(PLUGIN_PANEL_CLASS).unwrap())
            .expect("plugin panel class registered");
        let this_ref = &mut *this;
        let _: () = msg_send![super(this_ref, superclass), becomeKeyWindow];
    }
    IN_KEY_HOOK.with(|guard| {
        if !guard.get() {
            guard.set(true);
            emit_key_status(true);
            guard.set(false);
        }
    });
}

extern "C" fn resign_key_window(this: *mut AnyObject, _cmd: Sel) {
    unsafe {
        let superclass = AnyClass::get(&CString::new(PLUGIN_PANEL_CLASS).unwrap())
            .expect("plugin panel class registered");
        let this_ref = &mut *this;
        let _: () = msg_send![super(this_ref, superclass), resignKeyWindow];
    }
    IN_KEY_HOOK.with(|guard| {
        if !guard.get() {
            guard.set(true);
            emit_key_status(false);
            guard.set(false);
        }
    });
}

fn subclass() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| {
        let superclass = AnyClass::get(&CString::new(PLUGIN_PANEL_CLASS).unwrap())
            .expect("tauri-nspanel must have registered RawNSPanel before subclassing");
        let mut builder = ClassBuilder::new(&CString::new(SUBCLASS_NAME).unwrap(), superclass)
            .expect("BerdDesktopAgentPanel class name must be unique");
        unsafe {
            builder.add_method(
                sel!(canBecomeKeyWindow),
                can_become_key_window as extern "C" fn(_, _) -> _,
            );
            builder.add_method(
                sel!(canBecomeMainWindow),
                can_become_main_window as extern "C" fn(_, _) -> _,
            );
            builder.add_method(
                sel!(becomeKeyWindow),
                become_key_window as extern "C" fn(_, _),
            );
            builder.add_method(
                sel!(resignKeyWindow),
                resign_key_window as extern "C" fn(_, _),
            );
        }
        builder.register()
    })
}

/// Observes display connect/disconnect/rearrange and tells the webview to
/// re-clamp the avatar (a disconnected display could otherwise strand the
/// panel off-screen).
unsafe fn install_screen_observer() {
    // install() runs on every desktop_agent_open (the panel can be
    // destroyed and recreated as the experiment toggles); the process-wide
    // observer must not stack, or every reopen would multiply
    // screens-changed emissions.
    static OBSERVER_INSTALLED: AtomicBool = AtomicBool::new(false);
    if OBSERVER_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    use block2::RcBlock;
    let center: *mut AnyObject = {
        let cls = AnyClass::get(&CString::new("NSNotificationCenter").unwrap()).unwrap();
        msg_send![cls, defaultCenter]
    };
    let name =
        objc2_foundation::NSString::from_str("NSApplicationDidChangeScreenParametersNotification");
    let block = RcBlock::new(move |_note: *mut AnyObject| {
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("desktop-agent:screens-changed", ());
        }
    });
    let _: *mut AnyObject = msg_send![
        &*center,
        addObserverForName: &*name,
        object: std::ptr::null::<AnyObject>(),
        queue: std::ptr::null::<AnyObject>(),
        usingBlock: &*block
    ];
    // The block must outlive this scope — the notification center holds it
    // for the process lifetime (observer is never removed by design; the
    // panel lives as long as the app).
    std::mem::forget(block);
}

/// One-time panel setup. Must run on the main thread (callers hop there).
pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    APP_HANDLE.get_or_init(|| window.app_handle().clone());

    // Fresh window: the process-global expanded flag must not leak the
    // previous panel's expanded state across a disable/enable cycle.
    EXPANDED.store(false, Ordering::Relaxed);

    let ns_window = window.ns_window()? as *mut AnyObject;
    let panel = NonNull::new(ns_window).expect("ns_window");
    unsafe {
        // Teardown prep, BEFORE any swizzle (see prepare_destroy — the
        // disable crash):
        // 1. Capture tao's original window class so destroy can restore
        //    it and the final dealloc runs the chain the window was
        //    BUILT with — never tauri-nspanel's RawNSPanel dealloc,
        //    which super-calls NSObject's dealloc DIRECTLY (skipping
        //    NSWindow's teardown) and corrupts AppKit state.
        // 2. One compensating retain: the plugin's from_window claims
        //    ownership of a +1 it was never given (Id::from_retained_ptr
        //    on tao's own reference) and parks a clone in its
        //    process-lived store. Without this, tao's release at destroy
        //    drops the count to 0 MID-close-machinery (dealloc under
        //    AppKit's feet → NSException at run-loop-cycle end → Rust
        //    abort). With it, the store's claim is real: the closed husk
        //    stays alive until the store replaces it on the next open.
        let original: *const AnyClass = objc2::ffi::object_getClass(panel.as_ptr().cast()).cast();
        ORIGINAL_CLASS.store(original as usize, Ordering::SeqCst);
        let _: *mut AnyObject = msg_send![&*panel.as_ptr(), retain];
    }

    // tauri-nspanel swizzle first (window -> RawNSPanel), then our
    // subclass on top.
    use tauri_nspanel::WebviewWindowExt;
    window
        .to_panel()
        .map_err(|e| tauri::Error::Anyhow(anyhow::anyhow!("to_panel failed: {e:?}")))?;

    unsafe {
        let cls = subclass();
        // Returns the previous class; we don't need it.
        let _ = objc2::ffi::object_setClass(panel.as_ptr().cast(), (cls as *const AnyClass).cast());
        configure(panel.as_ptr());
        install_screen_observer();
    }
    Ok(())
}

/// Un-swizzles the panel ahead of `window.destroy()` — the teardown half
/// of install()'s class surgery (first live disable crashed
/// with SIGABRT, a foreign NSException unwinding through tao's run-loop
/// observer).
///
/// Restoring tao's original class means every later message the dying
/// window receives — including its eventual dealloc, which fires when
/// tauri-nspanel's store drops its ShareId on the NEXT open — dispatches
/// through the implementation the window was created with. Neither the
/// plugin's broken dealloc nor our subclass stays in the chain. Safe to
/// call when the window is already gone (no-op). Synchronous main-thread
/// hop; callers invoke this IMMEDIATELY before destroy.
pub fn prepare_destroy(app: &AppHandle) {
    let Some(window) = app.get_webview_window(super::WINDOW_LABEL) else {
        return;
    };
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ptr = ns_window as usize;
    let _ = super::main_thread::on_main(app, move || unsafe {
        let original = ORIGINAL_CLASS.load(Ordering::SeqCst);
        if original != 0 {
            let _ = objc2::ffi::object_setClass(
                (ptr as *mut AnyObject).cast(),
                (original as *const AnyClass).cast(),
            );
        }
    });
}

/// Applies the panel flags. Main thread only.
unsafe fn configure(panel: *mut AnyObject) {
    let panel = &mut *panel;
    let _: () =
        msg_send![&mut *panel, setStyleMask: NS_BORDERLESS_MASK | NS_NONACTIVATING_PANEL_MASK];
    let _: () = msg_send![&mut *panel, setLevel: NS_STATUS_WINDOW_LEVEL];
    let _: () =
        msg_send![&mut *panel, setCollectionBehavior: CAN_JOIN_ALL_SPACES | FULLSCREEN_AUXILIARY];
    let _: () = msg_send![&mut *panel, setBecomesKeyOnlyIfNeeded: Bool::YES];
    let _: () = msg_send![&mut *panel, setHidesOnDeactivate: Bool::NO];
    let _: () = msg_send![&mut *panel, setOpaque: Bool::NO];
    let _: () = msg_send![&mut *panel, setHasShadow: Bool::NO];
    let _: () = msg_send![&mut *panel, setMovableByWindowBackground: Bool::NO];
    let _: () = msg_send![&mut *panel, setReleasedWhenClosed: Bool::NO];
}

/// Updates the expanded flag without touching the panel — used by
/// window_commands::set_state, which sequences the frame + key changes
/// itself in one main-thread hop (anti-blink ordering).
pub fn note_expanded(expanded: bool) {
    EXPANDED.store(expanded, Ordering::Relaxed);
}

pub fn is_expanded() -> bool {
    EXPANDED.load(Ordering::Relaxed)
}

/// Native performDrag handoff (returns immediately; the run loop stays
/// live). Invoked from a webview mousedown that has already
/// preventDefault-ed.
pub fn start_drag(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window(super::WINDOW_LABEL)
        .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("desktop-agent window missing")))?;
    let ns_window_ptr = window.ns_window()? as usize;
    app.run_on_main_thread(move || unsafe {
        let panel = ns_window_ptr as *mut AnyObject;
        let ns_app_class = AnyClass::get(&CString::new("NSApplication").unwrap()).unwrap();
        let shared: *mut AnyObject = msg_send![ns_app_class, sharedApplication];
        let event: *mut AnyObject = msg_send![&*shared, currentEvent];
        if !event.is_null() {
            let _: () = msg_send![&mut *panel, performWindowDragWithEvent: &*event];
        }
    })?;
    Ok(())
}
