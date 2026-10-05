//! Shared factory for the perch overlay NSPanels — the targeting
//! highlight band and the settled perch outline share one creation path
//! (they had grown near-identical blocks in the prototype). Both overlays
//! use one profile: borderless, non-activating, status level, joins all
//! Spaces (fullscreen-auxiliary), transparent, shadowless,
//! mouse-transparent, never released on close.
//!
//! These are plain AppKit objects, NOT tauri windows: created lazily,
//! hidden via orderOut, and never destroyed. Experiment disable hides
//! them (perch::teardown) rather than tearing them down — two tiny
//! borderless panels; revisit only if enable/disable cycling shows leaks.
//!
//! Main thread only (AppKit rule).

use std::ffi::CString;

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2_foundation::{NSPoint, NSRect, NSSize};

const NS_BORDERLESS: usize = 0;
const NS_NONACTIVATING_PANEL_MASK: usize = 1 << 7;
const NS_STATUS_WINDOW_LEVEL: isize = 25;
const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
const FULLSCREEN_AUXILIARY: usize = 1 << 8;
const NS_BACKING_BUFFERED: usize = 2;

pub(super) enum OverlayColor {
    /// systemYellow — the transient targeting highlight.
    Yellow,
    /// lightGray — the settled perch outline. The resting border should
    /// recede, not shout; yellow stays the transient affordance color.
    LightGray,
}

pub(super) enum OverlayAppearance {
    /// Stroke outline (the perch outline). `alpha` < 1.0 makes the
    /// border translucent.
    Stroke {
        width: f64,
        radius: f64,
        color: OverlayColor,
        alpha: f64,
    },
    /// Translucent fill (the targeting highlight band).
    Fill { color: OverlayColor, alpha: f64 },
}

unsafe fn ns_color(cls: &AnyClass, color: &OverlayColor, alpha: f64) -> *mut AnyObject {
    let base: *mut AnyObject = match color {
        OverlayColor::Yellow => msg_send![cls, systemYellowColor],
        OverlayColor::LightGray => msg_send![cls, lightGrayColor],
    };
    if alpha >= 1.0 {
        return base;
    }
    msg_send![&*base, colorWithAlphaComponent: alpha]
}

/// Creates a configured overlay panel (always mouse-transparent — both
/// overlays are pure indication, never interaction). Caller owns
/// showing/hiding/frame.
///
/// # Safety
/// Main thread only. The returned pointer is a +1 retained NSPanel with
/// `releasedWhenClosed:NO`; per the module header it is cached for the
/// process lifetime and never released.
pub(super) unsafe fn create_overlay_panel(appearance: &OverlayAppearance) -> *mut AnyObject {
    let cls = AnyClass::get(&CString::new("NSPanel").unwrap()).unwrap();
    let panel: *mut AnyObject = msg_send![cls, alloc];
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(10.0, 10.0));
    let style = NS_BORDERLESS | NS_NONACTIVATING_PANEL_MASK;
    let panel: *mut AnyObject = msg_send![
        panel,
        initWithContentRect: frame,
        styleMask: style,
        backing: NS_BACKING_BUFFERED,
        defer: Bool::NO
    ];
    let _: () = msg_send![&mut *panel, setLevel: NS_STATUS_WINDOW_LEVEL];
    let _: () =
        msg_send![&mut *panel, setCollectionBehavior: CAN_JOIN_ALL_SPACES | FULLSCREEN_AUXILIARY];
    let _: () = msg_send![&mut *panel, setOpaque: Bool::NO];
    let _: () = msg_send![&mut *panel, setHasShadow: Bool::NO];
    let _: () = msg_send![&mut *panel, setHidesOnDeactivate: Bool::NO];
    let _: () = msg_send![&mut *panel, setReleasedWhenClosed: Bool::NO];
    let _: () = msg_send![&mut *panel, setIgnoresMouseEvents: Bool::YES];

    let color_cls = AnyClass::get(&CString::new("NSColor").unwrap()).unwrap();
    match appearance {
        OverlayAppearance::Stroke {
            width,
            radius,
            color,
            alpha,
        } => {
            let clear: *mut AnyObject = msg_send![color_cls, clearColor];
            let _: () = msg_send![&mut *panel, setBackgroundColor: &*clear];
            let content: *mut AnyObject = msg_send![&*panel, contentView];
            let _: () = msg_send![&mut *content, setWantsLayer: Bool::YES];
            let layer: *mut AnyObject = msg_send![&*content, layer];
            if !layer.is_null() {
                let _: () = msg_send![&mut *layer, setBorderWidth: *width];
                let _: () = msg_send![&mut *layer, setCornerRadius: *radius];
                let stroke = ns_color(color_cls, color, *alpha);
                let cg: *mut AnyObject = msg_send![&*stroke, CGColor];
                let _: () = msg_send![&mut *layer, setBorderColor: &*cg];
            }
        }
        OverlayAppearance::Fill { color, alpha } => {
            let fill = ns_color(color_cls, color, *alpha);
            let _: () = msg_send![&mut *panel, setBackgroundColor: &*fill];
        }
    }
    panel
}
