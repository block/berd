//! TCC permission seams for perch mode — Accessibility (AX window
//! tracking) and Screen Recording (window capture). ALL checks and
//! requests route through here so the prompting story stays auditable:
//! Accessibility prompts fire ONLY from the explicit perch drag gesture
//! (product rule — never at panel open, never at experiment enable).
//!
//! Grants attach to Berd's bundle id + code signature. Dev and release
//! builds are separate TCC identities, so dev rebuilds may re-ask even
//! after a release grant — document for QA, don't fight it.

#[derive(Debug, Clone)]
pub struct PermissionStatus {
    pub accessibility: bool,
}

// AX + CG permission APIs, linked directly — the objc2 wrapper crates gate
// some of these behind features; the raw symbols are stable C API.
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Non-prompting Accessibility check. Safe from any thread.
pub fn status() -> PermissionStatus {
    unsafe {
        PermissionStatus {
            accessibility: AXIsProcessTrusted(),
        }
    }
}

/// Prompts for Accessibility via the system dialog
/// (kAXTrustedCheckOptionPrompt). The grant takes effect for fresh checks
/// WITHOUT an app relaunch, but trust is keyed to code identity — debug
/// rebuilds may re-ask.
pub fn request_accessibility() -> bool {
    use objc2_foundation::{ns_string, NSDictionary, NSNumber, NSString};
    unsafe {
        let key: &NSString = ns_string!("AXTrustedCheckOptionPrompt");
        let value = NSNumber::new_bool(true);
        let options: objc2::rc::Retained<NSDictionary<NSString, NSNumber>> =
            NSDictionary::from_slices(&[key], &[&*value]);
        let ptr: *const NSDictionary<NSString, NSNumber> = &*options;
        AXIsProcessTrustedWithOptions(ptr.cast())
    }
}

/// Prompts for Screen Recording (system dialog on the first ask; a
/// Settings deep-link thereafter — macOS behavior, not ours). Sequoia
/// adds recurring re-approval prompts: a revocation mid-perch surfaces
/// as capture failure on the next send, which degrades to text-only —
/// never a blocked send.
pub fn request_screen_recording() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

#[tauri::command]
pub fn desktop_agent_request_permission(which: String) -> Result<bool, String> {
    match which.as_str() {
        "accessibility" => Ok(request_accessibility()),
        "screenRecording" => Ok(request_screen_recording()),
        other => Err(format!("unknown permission: {other}")),
    }
}
