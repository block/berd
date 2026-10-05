//! Perch mode: targeting, AX resolve, attach, follow, dismount. The
//! avatar panel is dragged over another app's window and "seats" on its
//! title bar; a native follow loop keeps it there; window capture and
//! artifact-URL extraction ride sends while perched.
//!
//! Hard rules carried from the prototype's review history:
//!
//! - Type guard on EVERY CF cast (CF objects can't be blindly downcast).
//!   Enforced through objc2-core-foundation: owned (Copy-rule) returns
//!   ride `CFRetained<CFType>` (RAII release) and every concrete view
//!   goes through the crate's CFGetTypeID-checked `downcast_ref` —
//!   never a hand-rolled pointer cast. AXUIElement has no crate wrapper
//!   and stays a raw pointer with manual retain/release.
//! - AX window resolve: FRAME MATCH IS AUTHORITATIVE; title only
//!   disambiguates multiple frame matches and never vetoes a sole match
//!   (Chrome decorates AX titles differently from CG titles).
//! - performDrag returns immediately (async handoff) — drop detection
//!   happens at webview pointer-up via end_targeting's hit-test.
//! - AXEnhancedUserInterface set once at perch-on (err -25208 expected
//!   and ignored); deliberately never unset.
//! - Follow + highlight stay native: nothing per-move crosses the
//!   webview. Following is a 100ms main-thread AX reconciliation poll.
//!
//! Berd lifecycle deviations from the prototype (whose panel WAS the main
//! window and lived for the process):
//! - The panel window is resolved fresh wherever it is needed (never a
//!   cached NSWindow ptr in a long-lived loop): `desktop_agent_close`
//!   (experiment disable) can DESTROY the panel mid-perch.
//! - `teardown` stops both loops, hides both overlays, and releases the
//!   AX element — called from `desktop_agent_close` BEFORE the window is
//!   destroyed.
//! - Events are targeted at the panel webview (`emit_to`), namespaced
//!   `desktop-agent:*`.

use std::cell::RefCell;
use std::ffi::{c_void, CString};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect,
    CFURL,
};
use objc2_core_graphics::{
    kCGNullWindowID, CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo,
    CGWindowListOption,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::coordinate_space as cs;
use super::main_thread::on_main;

// ---------------------------------------------------------------------------
// Raw AX FFI. AXUIElement has no objc2 wrapper, so its symbols stay
// hand-declared and AX element pointers stay raw (retained/released
// manually, never dereferenced). AXValue IS a plain CF object — it gets
// a local CF-type shim below so it rides the crate's owned `CFRetained`
// + CFGetTypeID-checked `downcast_ref` like every other CF type.

#[repr(C)]
struct AXUIElementOpaque(c_void);
type AXUIElementRef = *const AXUIElementOpaque;

/// AXValue as a crate-native CF type (the objc2 generators don't cover
/// HIServices). Mirrors the shape the crate's own `cf_type!` types use:
/// opaque, unconstructible, `!Send`/`!Sync`.
#[repr(C)]
struct AXValue {
    inner: [u8; 0],
    _p: core::cell::UnsafeCell<
        core::marker::PhantomData<(
            *const core::cell::UnsafeCell<()>,
            core::marker::PhantomPinned,
        )>,
    >,
}

// SAFETY: AXValue is a CoreFoundation object — CFRetain/CFRelease-safe
// (Apple documents AXValueRef as a CFTypeRef).
unsafe impl objc2_core_foundation::Type for AXValue {}
// SAFETY: AXValueGetTypeID uniquely identifies AXValue instances; this
// is exactly the contract ConcreteType encodes, and what lets
// `downcast_ref::<AXValue>` type-guard the cast.
unsafe impl objc2_core_foundation::ConcreteType for AXValue {
    fn type_id() -> objc2_core_foundation::CFTypeID {
        unsafe { AXValueGetTypeID() }
    }
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: *const c_void, // CFStringRef
        value: *mut *const c_void,
    ) -> i32;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: *const c_void,
        value: *const c_void,
    ) -> i32;
    fn AXValueGetValue(value: &AXValue, value_type: u32, out: *mut c_void) -> bool;
    fn AXValueGetTypeID() -> objc2_core_foundation::CFTypeID;
    fn CFRetain(cf: *const c_void) -> *const c_void;
    fn CFRelease(cf: *const c_void);
}

const K_AX_VALUE_CGPOINT: u32 = 1;
const K_AX_VALUE_CGSIZE: u32 = 2;

fn cf_str(s: &str) -> CFRetained<CFString> {
    CFString::from_str(s)
}

/// Borrows an untyped CF pointer as `CFType`, tied to its owner's
/// lifetime (Get rule: the value is owned by `owner` — a dictionary or
/// array — and must not outlive it). The ONE place a raw CF pointer
/// becomes a reference; every typed view then goes through the crate's
/// CFGetTypeID-checked `downcast_ref`.
///
/// # Safety
/// `ptr` must be null or a live CF object owned by `owner`.
unsafe fn cf_borrow<O: ?Sized>(_owner: &O, ptr: *const c_void) -> Option<&CFType> {
    NonNull::new(ptr.cast_mut()).map(|p| p.cast::<CFType>().as_ref())
}

/// AX attribute read. The result is OWNED (+1, Copy rule) — CFRetained
/// releases it on drop; typed views go through `downcast_ref` (the
/// type-guard hard rule).
unsafe fn ax_copy(element: AXUIElementRef, attribute: &str) -> Option<CFRetained<CFType>> {
    let attr = cf_str(attribute);
    let mut out: *const c_void = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(
        element,
        CFRetained::as_ptr(&attr).as_ptr() as *const c_void,
        &mut out,
    );
    if err != 0 {
        return None;
    }
    let ptr = NonNull::new(out.cast_mut())?.cast::<CFType>();
    // SAFETY: the copy succeeded with a non-null object we own (+1).
    Some(CFRetained::from_raw(ptr))
}

unsafe fn ax_frame(element: AXUIElementRef) -> Option<cs::Rect> {
    let pos_ref = ax_copy(element, "AXPosition")?;
    let size_ref = ax_copy(element, "AXSize")?;
    // Type guard via the crate-checked downcast (the AXValue shim above
    // implements ConcreteType over AXValueGetTypeID). CFRetained drops
    // both owned values on every exit path.
    let pos = pos_ref.downcast_ref::<AXValue>()?;
    let size_value = size_ref.downcast_ref::<AXValue>()?;
    let mut point = CGPoint { x: 0.0, y: 0.0 };
    let mut size = objc2_core_foundation::CGSize {
        width: 0.0,
        height: 0.0,
    };
    if !AXValueGetValue(pos, K_AX_VALUE_CGPOINT, &mut point as *mut _ as *mut c_void)
        || !AXValueGetValue(
            size_value,
            K_AX_VALUE_CGSIZE,
            &mut size as *mut _ as *mut c_void,
        )
    {
        return None;
    }
    // AX frames are CG top-left space.
    Some(cs::Rect::new(point.x, point.y, size.width, size.height))
}

unsafe fn ax_title(element: AXUIElementRef) -> Option<String> {
    let title_ref = ax_copy(element, "AXTitle")?;
    let title = title_ref.downcast_ref::<CFString>()?; // type guard
    Some(title.to_string())
}

/// AX attribute as a URL string: CFURL or CFString accepted (Chrome
/// exposes AXDocument as a string, Safari's AXURL is a CFURL). Both
/// branches are crate-checked downcasts.
unsafe fn ax_url(element: AXUIElementRef, attribute: &str) -> Option<String> {
    let value_ref = ax_copy(element, attribute)?;
    if let Some(url) = value_ref.downcast_ref::<CFURL>() {
        // The crate renamed CFURLGetString to a crate-private method;
        // the deprecated public wrapper is the sanctioned owned
        // accessor for now.
        #[allow(deprecated)]
        let url_string = objc2_core_foundation::CFURLGetString(url)?;
        return Some(url_string.to_string());
    }
    if let Some(s) = value_ref.downcast_ref::<CFString>() {
        let trimmed = s.to_string().trim().to_string();
        return if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
    }
    None // type guard
}

/// AXChildren as raw element pointers (AX elements have no crate
/// wrapper): each child is retained beyond the array's lifetime; the BFS
/// releases them as it visits.
unsafe fn ax_children(element: AXUIElementRef) -> Vec<AXUIElementRef> {
    let Some(children_ref) = ax_copy(element, "AXChildren") else {
        return Vec::new();
    };
    let Some(array) = children_ref.downcast_ref::<CFArray>() else {
        return Vec::new(); // type guard
    };
    (0..array.count())
        .map(|i| array.value_at_index(i) as AXUIElementRef)
        .filter(|e| !e.is_null())
        .inspect(|&e| {
            CFRetain(e as *const c_void);
        })
        .collect()
}

unsafe fn ax_role(element: AXUIElementRef) -> Option<String> {
    let role_ref = ax_copy(element, "AXRole")?;
    let role = role_ref.downcast_ref::<CFString>()?; // type guard
    Some(role.to_string())
}

unsafe fn ax_bool(element: AXUIElementRef, attribute: &str) -> Option<bool> {
    let value_ref = ax_copy(element, attribute)?;
    Some(value_ref.downcast_ref::<CFBoolean>()?.value()) // type guard
}

// Spiked bounds: the BFS must never make a send feel slow.
const ARTIFACT_URL_MAX_DEPTH: usize = 20;
const ARTIFACT_URL_MAX_NODES: usize = 8000;
const ARTIFACT_URL_MAX_MS: u128 = 150;

/// Frontmost tab's URL from the perched window: AXDocument on the window
/// element first (Chrome, ~0.1ms, works minimized), else a bounded BFS to
/// AXWebArea -> AXURL/AXDocument (Safari — needs AXEnhancedUserInterface,
/// set at perch-on). Every failure is None; a send never blocks on this.
unsafe fn artifact_url_from(element: AXUIElementRef) -> Option<String> {
    if let Some(document) = ax_url(element, "AXDocument") {
        return Some(document);
    }
    let started = std::time::Instant::now();
    let mut queue: std::collections::VecDeque<(AXUIElementRef, usize)> =
        std::collections::VecDeque::new();
    // Root is borrowed (caller owns it); children are retained by
    // ax_children and released as visited.
    let mut visited = 0usize;
    let mut found: Option<String> = None;
    for child in ax_children(element) {
        queue.push_back((child, 1));
    }
    while let Some((node, depth)) = queue.pop_front() {
        visited += 1;
        let over_budget =
            visited > ARTIFACT_URL_MAX_NODES || started.elapsed().as_millis() > ARTIFACT_URL_MAX_MS;
        if !over_budget && found.is_none() {
            if ax_role(node).as_deref() == Some("AXWebArea") {
                found = ax_url(node, "AXURL").or_else(|| ax_url(node, "AXDocument"));
            } else if depth < ARTIFACT_URL_MAX_DEPTH {
                for child in ax_children(node) {
                    queue.push_back((child, depth + 1));
                }
            }
        }
        // Every dequeued node was retained by ax_children — release it
        // whether or not we're still searching (leak-free on all exits).
        CFRelease(node as *const c_void);
    }
    found
}

// ---------------------------------------------------------------------------
// Window enumeration (CGWindowList — layer 0, own PID excluded)

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PerchableWindow {
    pub window_id: u32,
    pub pid: i32,
    pub app_name: String,
    pub title: String,
    /// AppKit global space.
    #[serde(skip)]
    pub appkit_frame: cs::Rect,
}

/// Borrowed dictionary lookup (Get rule: the value is owned by `dict`).
/// Typed views go through the crate's checked `downcast_ref`.
fn dict_get<'a>(dict: &'a CFDictionary, key: &str) -> Option<&'a CFType> {
    let key_cf = cf_str(key);
    let mut value: *const c_void = std::ptr::null();
    let found = unsafe {
        dict.value_if_present(
            CFRetained::as_ptr(&key_cf).as_ptr() as *const c_void,
            &mut value,
        )
    };
    if !found {
        return None;
    }
    // SAFETY: value_if_present returned true — `value` is a live CF
    // object owned by `dict`.
    unsafe { cf_borrow(dict, value) }
}

fn dict_i64(dict: &CFDictionary, key: &str) -> Option<i64> {
    dict_get(dict, key)?.downcast_ref::<CFNumber>()?.as_i64()
}

fn dict_string(dict: &CFDictionary, key: &str) -> Option<String> {
    Some(dict_get(dict, key)?.downcast_ref::<CFString>()?.to_string())
}

/// Enumerates perchable windows (layer 0, on-screen, own PID excluded),
/// frames converted to AppKit space. Excluding our own PID excludes ALL
/// Berd windows — main, session windows, and the panel itself: no
/// self-perch, no captures of the conversation feeding itself.
/// Main thread only (uses NSScreen).
unsafe fn perchable_windows() -> Vec<PerchableWindow> {
    let own_pid = std::process::id() as i64;
    let screens = cs::screens();
    // Owned array (Copy rule) — CFRetained releases it on drop.
    let Some(list) = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        kCGNullWindowID,
    ) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for i in 0..list.count() {
        // Get rule: the item is owned by `list`; borrow + checked downcast.
        let Some(item) = cf_borrow(&list, list.value_at_index(i)) else {
            continue;
        };
        let Some(dict) = item.downcast_ref::<CFDictionary>() else {
            continue; // type guard
        };
        if dict_i64(dict, "kCGWindowLayer") != Some(0) {
            continue;
        }
        let pid = match dict_i64(dict, "kCGWindowOwnerPID") {
            Some(pid) if pid != own_pid => pid,
            _ => continue,
        };
        let window_id = match dict_i64(dict, "kCGWindowNumber") {
            Some(id) => id as u32,
            None => continue,
        };
        let bounds = match dict_get(dict, "kCGWindowBounds")
            .and_then(|b| b.downcast_ref::<CFDictionary>())
        {
            Some(bounds_dict) => {
                let mut rect = CGRect::default();
                if !CGRectMakeWithDictionaryRepresentation(Some(bounds_dict), &mut rect) {
                    continue;
                }
                rect
            }
            None => continue,
        };
        // Tiny windows are chrome/popups, not perch targets.
        if bounds.size.width < 120.0 || bounds.size.height < 80.0 {
            continue;
        }
        let cg = cs::Rect::new(
            bounds.origin.x,
            bounds.origin.y,
            bounds.size.width,
            bounds.size.height,
        );
        out.push(PerchableWindow {
            window_id,
            pid: pid as i32,
            app_name: dict_string(dict, "kCGWindowOwnerName").unwrap_or_default(),
            title: dict_string(dict, "kCGWindowName").unwrap_or_default(),
            appkit_frame: cs::appkit_rect_from_cg(cg, &screens),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// AX resolve (frame authoritative; title disambiguates only)

/// Frame-match tolerance for AX window resolution.
const AX_FRAME_TOLERANCE: f64 = 6.0;

/// Pure matching predicate (extracted for testing): FRAME MATCH IS
/// AUTHORITATIVE. Title only disambiguates multiple frame matches and
/// never vetoes a sole match (Chrome decorates AX titles differently from
/// CG titles). Returns the index of the chosen candidate.
pub(crate) fn choose_ax_match(
    candidate_frames: &[(cs::Rect, Option<String>)],
    target_frame: cs::Rect,
    target_title: &str,
) -> Option<usize> {
    let frame_matches: Vec<usize> = candidate_frames
        .iter()
        .enumerate()
        .filter(|(_, (frame, _))| {
            (frame.x - target_frame.x).abs() <= AX_FRAME_TOLERANCE
                && (frame.y - target_frame.y).abs() <= AX_FRAME_TOLERANCE
                && (frame.width - target_frame.width).abs() <= AX_FRAME_TOLERANCE
                && (frame.height - target_frame.height).abs() <= AX_FRAME_TOLERANCE
        })
        .map(|(i, _)| i)
        .collect();
    match frame_matches.len() {
        0 => None,
        1 => Some(frame_matches[0]), // sole frame match wins; title never vetoes
        _ => frame_matches
            .iter()
            .find(|&&i| {
                // Both sides trimmed before comparing.
                candidate_frames[i].1.as_deref().map(str::trim) == Some(target_title.trim())
            })
            .copied()
            .or(Some(frame_matches[0])),
    }
}

unsafe fn resolve_ax_window(target: &PerchableWindow) -> Option<AXUIElementRef> {
    let app = AXUIElementCreateApplication(target.pid);
    if app.is_null() {
        return None;
    }
    // Single exit below releases `app` on EVERY path.
    let result = (|| {
        // Owned (Copy rule) — drops at closure end, AFTER the chosen
        // element is retained.
        let windows_ref = ax_copy(app, "AXWindows")?;
        let array = windows_ref.downcast_ref::<CFArray>()?; // type guard
        let screens = cs::screens();
        // AX frames are CG top-left; compare in CG space.
        let target_ax = cs::cg_rect_from_appkit(target.appkit_frame, &screens);

        let mut elements: Vec<AXUIElementRef> = Vec::new();
        let mut candidates: Vec<(cs::Rect, Option<String>)> = Vec::new();
        for i in 0..array.count() {
            let element = array.value_at_index(i) as AXUIElementRef;
            if element.is_null() {
                continue;
            }
            if let Some(frame) = ax_frame(element) {
                elements.push(element);
                candidates.push((frame, ax_title(element)));
            }
        }
        let chosen = choose_ax_match(&candidates, target_ax, &target.title).map(|i| elements[i]);
        // Retain the chosen element beyond the array's lifetime.
        chosen.inspect(|&e| {
            CFRetain(e as *const c_void);
        })
    })();
    CFRelease(app as *const c_void);
    result
}

// ---------------------------------------------------------------------------
// Perch state + overlay panels

struct PerchedState {
    element: AXUIElementRef,
    window_id: u32,
    app_name: String,
    title: String,
    offset_ratio: f64,
    overlap: f64,
}

thread_local! {
    static PERCHED: RefCell<Option<PerchedState>> = const { RefCell::new(None) };
    static HIGHLIGHT_PANEL: RefCell<Option<usize>> = const { RefCell::new(None) };
    static OUTLINE_PANEL: RefCell<Option<usize>> = const { RefCell::new(None) };
    static TARGET_CANDIDATES: RefCell<Vec<PerchableWindow>> = const { RefCell::new(Vec::new()) };
}

static TARGETING: AtomicBool = AtomicBool::new(false);
static FOLLOWING: AtomicBool = AtomicBool::new(false);
static LAST_WINDOW_FRAME: Mutex<Option<cs::Rect>> = Mutex::new(None);

const TITLE_BAR_HEIGHT: f64 = 40.0;

/// Matches the panel's inner_size (mod.rs) — the seat math needs the
/// avatar footprint, not the live NSWindow frame (which the webview may
/// have expanded into the popover).
const AVATAR_SIZE: f64 = 94.0;

/// The panel's NSWindow, resolved FRESH — never cache across awaits or
/// loop ticks: `desktop_agent_close` can destroy the window mid-perch.
fn panel_ns_window(app: &AppHandle) -> Option<usize> {
    app.get_webview_window(super::WINDOW_LABEL)
        .and_then(|w| w.ns_window().ok())
        .map(|p| p as usize)
}

unsafe fn ensure_highlight_panel() -> *mut AnyObject {
    let existing = HIGHLIGHT_PANEL.with(|p| *p.borrow());
    if let Some(ptr) = existing {
        return ptr as *mut AnyObject;
    }
    let panel = super::overlay_panel::create_overlay_panel(
        &super::overlay_panel::OverlayAppearance::Fill {
            color: super::overlay_panel::OverlayColor::Yellow,
            alpha: 0.35,
        },
    );
    HIGHLIGHT_PANEL.with(|p| *p.borrow_mut() = Some(panel as usize));
    panel
}

unsafe fn hide_highlight() {
    let existing = HIGHLIGHT_PANEL.with(|p| *p.borrow());
    if let Some(ptr) = existing {
        let panel = ptr as *mut AnyObject;
        let _: () = msg_send![&mut *panel, orderOut: std::ptr::null::<AnyObject>()];
    }
}

unsafe fn mouse_location() -> cs::Rect {
    let cls = AnyClass::get(&CString::new("NSEvent").unwrap()).unwrap();
    let point: NSPoint = msg_send![cls, mouseLocation];
    cs::Rect::new(point.x, point.y, 0.0, 0.0)
}

/// Pure occlusion-aware hit test (extracted for testing). Candidates are
/// FRONT-TO-BACK (CG list order), each as (title band, full frame). The
/// first candidate whose title band contains the point wins — but a
/// candidate whose BODY contains the point OCCLUDES everything behind it,
/// so the walk stops there (otherwise the walk would match title bars
/// buried under the stack, highlighting windows nobody could see and
/// seating perches nobody intended).
///
/// Occluders are the layer-0 candidates themselves: floating panels /
/// chrome (other layers, tiny windows) never occlude here — acceptable,
/// they're excluded from perching for the same reason.
pub(crate) fn choose_hit_candidate(
    bands_and_frames: &[(cs::Rect, cs::Rect)],
    point: (f64, f64),
) -> Option<usize> {
    let (x, y) = point;
    let contains = |r: &cs::Rect| x >= r.x && x <= r.max_x() && y >= r.y && y <= r.max_y();
    for (i, (band, frame)) in bands_and_frames.iter().enumerate() {
        if contains(band) {
            return Some(i);
        }
        if contains(frame) {
            // The point is on this window's body: every window behind it
            // is covered at this point. No perch.
            return None;
        }
    }
    None
}

/// Hit-test the current mouse location against candidates' title-bar hit
/// bands (AppKit space), occlusion-aware.
unsafe fn hit_test_title_bands(candidates: &[PerchableWindow]) -> Option<PerchableWindow> {
    let mouse = mouse_location();
    let screens = cs::screens();
    let bands_and_frames: Vec<(cs::Rect, cs::Rect)> = candidates
        .iter()
        .map(|c| {
            (
                cs::title_bar_hit_band(c.appkit_frame, TITLE_BAR_HEIGHT, &screens),
                c.appkit_frame,
            )
        })
        .collect();
    choose_hit_candidate(&bands_and_frames, (mouse.x, mouse.y)).map(|i| candidates[i].clone())
}

// ---------------------------------------------------------------------------
// Commands

/// Starts targeting: snapshots candidates and runs a 10Hz native
/// highlight loop for the duration of the drag (the run loop stays live
/// during performDrag).
#[tauri::command]
pub fn desktop_agent_perch_begin_targeting(app: AppHandle) -> Result<(), String> {
    if TARGETING.swap(true, Ordering::Relaxed) {
        return Ok(());
    }
    let app_for_loop = app.clone();
    on_main(&app, || unsafe {
        TARGET_CANDIDATES.with(|c| *c.borrow_mut() = perchable_windows());
    })?;
    tauri::async_runtime::spawn(async move {
        while TARGETING.load(Ordering::Relaxed) {
            let _ = app_for_loop.run_on_main_thread(|| unsafe {
                let candidates = TARGET_CANDIDATES.with(|c| c.borrow().clone());
                let panel = ensure_highlight_panel();
                if let Some(hit) = hit_test_title_bands(&candidates) {
                    let band = cs::title_bar_band(hit.appkit_frame, TITLE_BAR_HEIGHT);
                    let rect = NSRect::new(
                        NSPoint::new(band.x, band.y),
                        NSSize::new(band.width, band.height),
                    );
                    let _: () = msg_send![&mut *panel, setFrame: rect, display: Bool::YES];
                    let _: () = msg_send![&mut *panel, orderFrontRegardless];
                } else {
                    let _: () = msg_send![&mut *panel, orderOut: std::ptr::null::<AnyObject>()];
                }
            });
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PerchCandidateDto {
    pub app_name: String,
    pub title: String,
}

/// Ends targeting (pointer-up). Hides the highlight and returns the
/// candidate under the mouse, if any. The webview then calls perch_on.
#[tauri::command]
pub fn desktop_agent_perch_end_targeting(
    app: AppHandle,
) -> Result<Option<PerchCandidateDto>, String> {
    TARGETING.store(false, Ordering::Relaxed);
    on_main(&app, || unsafe {
        hide_highlight();
        let candidates = TARGET_CANDIDATES.with(|c| c.borrow().clone());
        let hit = hit_test_title_bands(&candidates);
        if let Some(hit) = hit {
            // Stash the full candidate for perch_on (avoids re-enumeration).
            TARGET_CANDIDATES.with(|c| *c.borrow_mut() = vec![hit.clone()]);
            Some(PerchCandidateDto {
                app_name: hit.app_name,
                title: hit.title,
            })
        } else {
            TARGET_CANDIDATES.with(|c| c.borrow_mut().clear());
            None
        }
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PerchResultDto {
    pub app_name: String,
    pub title: String,
}

/// Attach path: resolves the AX window, seats the avatar panel on the
/// title bar at the drop offset (mouse X relative to the window), starts
/// the follow loop. Seats the panel exactly once.
fn attach_to_target(
    app: &AppHandle,
    target: PerchableWindow,
    overlap: f64,
) -> Result<PerchResultDto, String> {
    let panel_ptr = panel_ns_window(app).ok_or("desktop-agent window missing")?;

    let result = on_main(app, move || unsafe {
        let Some(element) = resolve_ax_window(&target) else {
            return Err("ax_resolve_failed".to_string());
        };
        // Set-once, never unset. -25208 expected (already set / not
        // settable) and ignored.
        let app_element = AXUIElementCreateApplication(target.pid);
        if !app_element.is_null() {
            let key = cf_str("AXEnhancedUserInterface");
            let true_ref = objc2_core_foundation::kCFBooleanTrue;
            let _ = AXUIElementSetAttributeValue(
                app_element,
                CFRetained::as_ptr(&key).as_ptr() as *const c_void,
                true_ref
                    .map(|b| b as *const _ as *const c_void)
                    .unwrap_or(std::ptr::null()),
            );
            CFRelease(app_element as *const c_void);
        }

        let window_frame = target.appkit_frame;
        // Drop offset: mouse X relative to the window.
        let mouse = mouse_location();
        let offset_ratio = if window_frame.width > 0.0 {
            ((mouse.x - window_frame.x) / window_frame.width).clamp(0.0, 1.0)
        } else {
            0.5
        };
        *LAST_WINDOW_FRAME.lock().unwrap() = Some(window_frame);
        PERCHED.with(|p| {
            // Defensive release: PerchedState holds a raw retained
            // AXUIElementRef with no Drop impl — overwriting a live perch
            // without releasing the old element leaks it. Correctness
            // must not depend on every caller dismounting first.
            if let Some(previous) = p.borrow_mut().take() {
                CFRelease(previous.element as *const c_void);
            }
            *p.borrow_mut() = Some(PerchedState {
                element,
                window_id: target.window_id,
                app_name: target.app_name.clone(),
                title: target.title.clone(),
                offset_ratio,
                overlap,
            })
        });
        apply_perched_presentation(
            panel_ptr,
            window_frame,
            offset_ratio,
            target.window_id,
            overlap,
        );
        Ok(PerchResultDto {
            app_name: target.app_name,
            title: target.title,
        })
    })??;

    start_follow_loop(app.clone());
    Ok(result)
}

/// TCC gate: the ONLY place an Accessibility prompt can fire, and it is
/// reachable ONLY from the explicit perch drop gesture (product rule —
/// never at panel open, never at experiment enable).
#[tauri::command]
pub fn desktop_agent_perch_on(
    app: AppHandle,
    character_seat: Option<bool>,
) -> Result<PerchResultDto, String> {
    if !super::permissions::status().accessibility {
        // Explanation-first flow is the webview's job; this is the gate.
        super::permissions::request_accessibility();
        return Err("accessibility_denied".into());
    }
    // Take (not peek) the end_targeting hit — the mailbox is consumed so
    // a future perch_on can't re-attach to a stale snapshot.
    let target = on_main(&app, || {
        TARGET_CANDIDATES.with(|c| {
            let mut candidates = c.borrow_mut();
            let first = candidates.first().cloned();
            candidates.clear();
            first
        })
    })?;
    let Some(target) = target else {
        return Err("no perch candidate".to_string());
    };
    attach_to_target(
        &app,
        target,
        cs::avatar_perch_overlap(character_seat.unwrap_or(false)),
    )
}

/// Seats the avatar panel + outline — the one place presentation
/// happens. Main thread only.
///
/// CONTRACT: callers invoke this while holding a PERCHED borrow (the
/// follow tick holds borrow_mut). This function MUST NOT touch PERCHED —
/// everything it needs arrives as parameters. Adding a PERCHED.with(...)
/// here is a guaranteed RefCell panic on the main thread mid-follow.
unsafe fn apply_perched_presentation(
    panel_ptr: usize,
    window_frame: cs::Rect,
    offset_ratio: f64,
    window_id: u32,
    overlap: f64,
) {
    let panel = panel_ptr as *mut AnyObject;
    show_outline(window_frame, window_id);
    let seat = cs::perch_frame(
        window_frame,
        (AVATAR_SIZE, AVATAR_SIZE),
        offset_ratio,
        overlap,
    );
    // Never clip a monitor edge: a window dragged against the top/side of
    // a display would otherwise seat the avatar partly offscreen. Full
    // containment beats seat fidelity; the outline is NOT clamped — it
    // mirrors the window frame, which may legitimately extend offscreen.
    let avatar = cs::clamp_within_visible_screens(seat, &cs::screens());
    let rect = NSRect::new(
        NSPoint::new(avatar.x, avatar.y),
        NSSize::new(avatar.width, avatar.height),
    );
    let _: () = msg_send![&mut *panel, setFrame: rect, display: Bool::YES];
    let _: () = msg_send![&mut *panel, orderFrontRegardless];
}

unsafe fn ensure_outline_panel() -> *mut AnyObject {
    let existing = OUTLINE_PANEL.with(|p| *p.borrow());
    if let Some(ptr) = existing {
        return ptr as *mut AnyObject;
    }
    let panel = super::overlay_panel::create_overlay_panel(
        // 3pt stroke, 9pt radius. Light grey and translucent — the
        // settled outline should recede, not shout; yellow stays the
        // transient targeting affordance.
        &super::overlay_panel::OverlayAppearance::Stroke {
            width: 3.0,
            radius: 9.0,
            color: super::overlay_panel::OverlayColor::LightGray,
            alpha: 0.55,
        },
    );
    OUTLINE_PANEL.with(|p| *p.borrow_mut() = Some(panel as usize));
    panel
}

/// NSWindowOrderingMode::NSWindowAbove.
const NS_WINDOW_ABOVE: isize = 1;
/// NSNormalWindowLevel.
const NS_NORMAL_WINDOW_LEVEL: isize = 0;

unsafe fn show_outline(window_frame: cs::Rect, window_id: u32) {
    let outline = ensure_outline_panel();
    let rect = NSRect::new(
        NSPoint::new(window_frame.x, window_frame.y),
        NSSize::new(window_frame.width, window_frame.height),
    );
    let _: () = msg_send![&mut *outline, setFrame: rect, display: Bool::YES];
    // Z-order: the outline sits DIRECTLY above the perched window in the
    // global order — NOT floating over everything. At status level it
    // drew across windows covering an unfocused perch; at normal level,
    // ordered relative to the target's window number, whatever occludes
    // the window occludes the outline too. (The avatar panel stays
    // always-on-top by design — it is the grabbable affordance.)
    let _: () = msg_send![&mut *outline, setLevel: NS_NORMAL_WINDOW_LEVEL];
    let _: () =
        msg_send![&mut *outline, orderWindow: NS_WINDOW_ABOVE, relativeTo: window_id as isize];
}

/// Re-asserts the outline's above-the-window ordering without touching
/// its frame. Called every steady-state follow tick: clicking around
/// reshuffles the global z-order without any frame change, which would
/// otherwise leave the outline stranded above (or below) the wrong
/// neighbors.
unsafe fn reassert_outline_order(window_id: u32) {
    let existing = OUTLINE_PANEL.with(|p| *p.borrow());
    if let Some(ptr) = existing {
        let outline = ptr as *mut AnyObject;
        let visible: Bool = msg_send![&*outline, isVisible];
        if visible.as_bool() {
            let _: () = msg_send![&mut *outline, orderWindow: NS_WINDOW_ABOVE, relativeTo: window_id as isize];
        }
    }
}

unsafe fn hide_outline() {
    let existing = OUTLINE_PANEL.with(|p| *p.borrow());
    if let Some(ptr) = existing {
        let outline = ptr as *mut AnyObject;
        let _: () = msg_send![&mut *outline, orderOut: std::ptr::null::<AnyObject>()];
    }
}

/// Outcome of one follow tick, decided entirely on the main thread.
enum TickOutcome {
    /// AX frame read, panel reseated if the window moved.
    Followed,
    /// AX frame read failed (window likely closing) — count toward misses.
    Miss,
    /// PERCHED is gone (dismount happened) — stop silently, no event: the
    /// dismount path already owns the state transition (emitting here
    /// raced drag-off and teleported the avatar home mid-drag).
    Dismounted,
    /// Window minimized: the perch ENDS (product rule — a perch is a
    /// context grant, and a minimized window is no longer clearly
    /// indicated on screen; auto-unperching prevents accidental
    /// screenshot sends). The avatar stays where it was seated.
    Minimized,
}

/// 100ms reconciliation poll: AX frame read -> reseat panel on change.
/// Window gone (AX read fails twice) -> dismount + perch-ended event.
fn start_follow_loop(app: AppHandle) {
    if FOLLOWING.swap(true, Ordering::Relaxed) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut misses = 0u32;
        while FOLLOWING.load(Ordering::Relaxed) {
            // ONE main-thread hop per tick: read AX, reseat, and report
            // the outcome back over a channel.
            let (tx, rx) = mpsc::channel::<TickOutcome>();
            let app_for_tick = app.clone();
            let hop = app.run_on_main_thread(move || {
                let outcome = unsafe {
                    // FOLLOWING re-checked INSIDE the hop: a dismount that
                    // landed between the loop check and this closure must
                    // not touch the panel or emit anything.
                    if !FOLLOWING.load(Ordering::Relaxed) {
                        TickOutcome::Dismounted
                    } else {
                        // Resolved per tick, NOT cached across the loop:
                        // experiment disable destroys the panel window.
                        let panel_ptr = panel_ns_window(&app_for_tick);
                        PERCHED.with(|p| {
                            let mut borrow = p.borrow_mut();
                            let Some(state) = borrow.as_mut() else {
                                return TickOutcome::Dismounted;
                            };
                            // Minimize ends the perch (product rule):
                            // AXMinimized is the reliable check — the
                            // frame read can keep answering for minimized
                            // windows.
                            let minimized = ax_bool(state.element, "AXMinimized").unwrap_or(false);
                            let frame_readable = ax_frame(state.element);
                            match (minimized, frame_readable) {
                                (true, _) => TickOutcome::Minimized,
                                (false, Some(ax_cg_frame)) => {
                                    let screens = cs::screens();
                                    let window_frame =
                                        cs::appkit_rect_from_cg(ax_cg_frame, &screens);
                                    let previous = *LAST_WINDOW_FRAME.lock().unwrap();
                                    if previous != Some(window_frame) {
                                        *LAST_WINDOW_FRAME.lock().unwrap() = Some(window_frame);
                                        if let Some(panel_ptr) = panel_ptr {
                                            apply_perched_presentation(
                                                panel_ptr,
                                                window_frame,
                                                state.offset_ratio,
                                                state.window_id,
                                                state.overlap,
                                            );
                                        }
                                    } else {
                                        // Steady state: no frame change,
                                        // but clicks reshuffle the global
                                        // z-order — keep the outline glued
                                        // directly above its window.
                                        reassert_outline_order(state.window_id);
                                    }
                                    TickOutcome::Followed
                                }
                                (false, None) => TickOutcome::Miss,
                            }
                        })
                    }
                };
                let _ = tx.send(outcome);
            });
            let outcome = if hop.is_ok() {
                rx.recv_timeout(Duration::from_secs(1))
                    .unwrap_or(TickOutcome::Miss)
            } else {
                TickOutcome::Miss
            };
            match outcome {
                TickOutcome::Followed => misses = 0,
                TickOutcome::Dismounted => break, // no event — dismount owns it
                TickOutcome::Minimized => {
                    // Auto-unperch on minimize: the grant ends, the avatar
                    // STAYS where it was seated (reason tells the webview
                    // not to fly it home — a minimize is not a close).
                    end_perch_internal(&app);
                    let _ = app.emit_to(
                        super::WINDOW_LABEL,
                        "desktop-agent:perch-ended",
                        "minimized",
                    );
                    break;
                }
                TickOutcome::Miss => {
                    misses += 1;
                    // Window gone: two consecutive misses end the perch
                    // and notify the webview exactly once.
                    if misses >= 2 {
                        end_perch_internal(&app);
                        let _ = app.emit_to(
                            super::WINDOW_LABEL,
                            "desktop-agent:perch-ended",
                            "windowGone",
                        );
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
}

fn end_perch_internal(app: &AppHandle) {
    FOLLOWING.store(false, Ordering::Relaxed);
    let _ = on_main(app, || unsafe {
        hide_outline(); // the outline never survives the perch (all exit paths)
        PERCHED.with(|p| {
            if let Some(state) = p.borrow_mut().take() {
                CFRelease(state.element as *const c_void);
            }
        });
        *LAST_WINDOW_FRAME.lock().unwrap() = None;
    });
}

/// Full perch teardown for `desktop_agent_close` (experiment disable):
/// stops BOTH loops, hides BOTH overlays, releases the AX element. Must
/// run BEFORE the panel window is destroyed — the follow loop's next tick
/// re-checks FOLLOWING inside the hop and exits without touching the
/// dying window. No events: the webview is going away with the window.
pub fn teardown(app: &AppHandle) {
    TARGETING.store(false, Ordering::Relaxed);
    let _ = on_main(app, || unsafe {
        hide_highlight();
        TARGET_CANDIDATES.with(|c| c.borrow_mut().clear());
    });
    end_perch_internal(app);
}

/// Dismount: stop following, clear state. The panel stays where it is
/// (the webview decides whether to return to the saved position —
/// drag-off leaves it at the drop).
#[tauri::command]
pub fn desktop_agent_perch_dismount(app: AppHandle) -> Result<(), String> {
    end_perch_internal(&app);
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PerchStatusDto {
    pub perched: bool,
    pub app_name: Option<String>,
    pub title: Option<String>,
}

/// Dev-reload reconciliation: a webview reload does not end the grant —
/// the native perch never stopped; the UI re-syncs from this. A full app
/// relaunch always starts unperched (no persisted perch, by product
/// ruling — a perch is a context grant and must never re-establish
/// itself unnoticed). An optional renderer hint updates ONLY an existing
/// grant's seat; it can never attach a target or request TCC permission.
#[tauri::command]
pub fn desktop_agent_perch_status(
    app: AppHandle,
    character_seat: Option<bool>,
) -> Result<PerchStatusDto, String> {
    let panel_ptr = panel_ns_window(&app);
    on_main(&app, move || {
        if let Some(character) = character_seat {
            PERCHED.with(|p| {
                if let Some(state) = p.borrow_mut().as_mut() {
                    let overlap = cs::avatar_perch_overlap(character);
                    if state.overlap == overlap {
                        return;
                    }
                    state.overlap = overlap;
                    if let (Some(panel), Some(frame)) =
                        (panel_ptr, *LAST_WINDOW_FRAME.lock().unwrap())
                    {
                        unsafe {
                            apply_perched_presentation(
                                panel,
                                frame,
                                state.offset_ratio,
                                state.window_id,
                                state.overlap,
                            );
                        }
                    }
                }
            });
        }
        PERCHED.with(|p| {
            let borrow = p.borrow();
            match borrow.as_ref() {
                Some(state) => PerchStatusDto {
                    perched: true,
                    app_name: Some(state.app_name.clone()),
                    title: Some(state.title.clone()),
                },
                None => PerchStatusDto {
                    perched: false,
                    app_name: None,
                    title: None,
                },
            }
        })
    })
}

/// Window-scoped SCK capture of the perched window: works even when
/// occluded. Returns None when unperched; errors degrade to text-only
/// sends in the webview.
#[tauri::command]
pub async fn desktop_agent_perch_capture(
    app: AppHandle,
) -> Result<Option<super::capture::CaptureDto>, String> {
    let window_id = on_main(&app, || {
        PERCHED.with(|p| p.borrow().as_ref().map(|s| s.window_id))
    })?;
    let Some(window_id) = window_id else {
        return Ok(None);
    };
    match super::capture::capture_window(window_id).await {
        Ok(capture) => Ok(Some(capture)),
        Err(error) => Err(error),
    }
}

/// Frontmost tab URL of the perched window, fresh per send (tabs change).
/// None when unperched; every failure degrades to None — a send never
/// blocks on this.
#[tauri::command]
pub fn desktop_agent_perch_artifact_url(app: AppHandle) -> Result<Option<String>, String> {
    on_main(&app, || unsafe {
        PERCHED.with(|p| {
            p.borrow()
                .as_ref()
                .and_then(|state| artifact_url_from(state.element))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // choose_ax_match: frame match is authoritative; title only
    // disambiguates; title never vetoes a sole frame match (the Chrome
    // lesson).

    fn frame(x: f64) -> cs::Rect {
        cs::Rect::new(x, 100.0, 800.0, 600.0)
    }

    #[test]
    fn sole_frame_match_wins_despite_title_mismatch() {
        // The Chrome case: CG title is ellipsis-truncated, AX title is
        // decorated — they never string-match, and must not need to.
        let candidates = vec![(frame(0.0), Some("Doc — Chrome — Profile".to_string()))];
        let chosen = choose_ax_match(&candidates, frame(0.0), "Doc — Chr…");
        assert_eq!(chosen, Some(0));
    }

    #[test]
    fn no_frame_match_returns_none() {
        let candidates = vec![(frame(500.0), Some("Anything".to_string()))];
        assert_eq!(choose_ax_match(&candidates, frame(0.0), "Anything"), None);
    }

    #[test]
    fn title_disambiguates_multiple_frame_matches() {
        let candidates = vec![
            (frame(0.0), Some("Wrong".to_string())),
            (frame(0.0), Some("Right".to_string())),
        ];
        assert_eq!(choose_ax_match(&candidates, frame(0.0), "Right"), Some(1));
    }

    #[test]
    fn multiple_matches_without_title_match_fall_back_to_first() {
        let candidates = vec![(frame(0.0), Some("A".to_string())), (frame(0.0), None)];
        assert_eq!(choose_ax_match(&candidates, frame(0.0), "Z"), Some(0));
    }

    #[test]
    fn tolerance_admits_near_matches_and_rejects_beyond() {
        let near = vec![(cs::Rect::new(5.0, 100.0, 800.0, 600.0), None)];
        assert_eq!(choose_ax_match(&near, frame(0.0), ""), Some(0));
        let far = vec![(cs::Rect::new(7.0, 100.0, 800.0, 600.0), None)];
        assert_eq!(choose_ax_match(&far, frame(0.0), ""), None);
    }

    // choose_hit_candidate: occlusion-aware title-band hit test.
    // Candidates front-to-back; a body containing the point occludes
    // everything behind it. AppKit space: y grows UP, so a window's title
    // band is at the TOP of its frame (max_y side).

    /// (band, frame) for a window whose frame is (x, y, w, h) with a 24pt
    /// title band at the top.
    fn window(x: f64, y: f64, w: f64, h: f64) -> (cs::Rect, cs::Rect) {
        let f = cs::Rect::new(x, y, w, h);
        (cs::Rect::new(x, y + h - 24.0, w, 24.0), f)
    }

    #[test]
    fn hit_topmost_band_wins() {
        let stack = vec![
            window(0.0, 0.0, 800.0, 600.0),
            window(50.0, 50.0, 800.0, 600.0),
        ];
        // Point on the front window's band.
        assert_eq!(choose_hit_candidate(&stack, (400.0, 588.0)), Some(0));
    }

    #[test]
    fn buried_band_under_front_body_is_not_a_hit() {
        // Back window's band (its top strip) sits under the FRONT
        // window's body: front spans y 0..600, back's band is at
        // y ~476..500 within front's x-range. A naive walk skips front
        // (point not on its band) and matches back — the
        // invisible-highlight bug this predicate exists to prevent.
        let front = window(0.0, 0.0, 800.0, 600.0);
        let back = window(100.0, -100.0, 800.0, 600.0); // band at y 476..500
        assert_eq!(choose_hit_candidate(&[front, back], (400.0, 490.0)), None);
    }

    #[test]
    fn band_visible_beside_front_window_still_hits() {
        // Same stack, but the point is OUTSIDE the front window's x-range
        // — the back window's band is genuinely visible there.
        let front = window(0.0, 0.0, 800.0, 600.0);
        let back = window(100.0, -100.0, 800.0, 600.0);
        assert_eq!(
            choose_hit_candidate(&[front, back], (850.0, 490.0)),
            Some(1)
        );
    }

    #[test]
    fn point_on_nothing_is_none() {
        let stack = vec![window(0.0, 0.0, 800.0, 600.0)];
        assert_eq!(choose_hit_candidate(&stack, (2000.0, 2000.0)), None);
    }

    #[test]
    fn empty_candidates_is_none() {
        assert_eq!(choose_hit_candidate(&[], (10.0, 10.0)), None);
    }
}
