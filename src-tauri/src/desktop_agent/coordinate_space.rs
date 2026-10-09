//! Coordinate space conversions for the desktop agent panel.
//!
//! THE HARD RULE: this module is the sole
//! authority for CG top-left ↔ AppKit bottom-left conversions. No other
//! module does coordinate flips. The webview/TS layer works exclusively in
//! global top-left coordinates (the channel contract); Rust converts at
//! the AppKit boundary using these functions.
//!
//! Pure functions take screen geometry as parameters so they unit-test
//! without AppKit. Callers fetch live screens via `screens()` (main thread).

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
    pub fn max_x(&self) -> f64 {
        self.x + self.width
    }
    pub fn max_y(&self) -> f64 {
        self.y + self.height
    }
    pub fn mid_x(&self) -> f64 {
        self.x + self.width / 2.0
    }
    pub fn mid_y(&self) -> f64 {
        self.y + self.height / 2.0
    }
}

/// A display in AppKit global (bottom-left origin) coordinates.
#[derive(Debug, Clone, Copy)]
pub struct Screen {
    pub frame: Rect,
    pub visible_frame: Rect,
}

/// Total bounding height of all screens in AppKit global space — the flip
/// constant between AppKit and top-left conventions.
pub fn global_max_y(screens: &[Screen]) -> f64 {
    screens.iter().map(|s| s.frame.max_y()).fold(0.0, f64::max)
}

/// Top-left global rect -> AppKit global rect).
pub fn appkit_rect_from_top_left(rect: Rect, screens: &[Screen]) -> Rect {
    Rect::new(
        rect.x,
        global_max_y(screens) - rect.y - rect.height,
        rect.width,
        rect.height,
    )
}

/// AppKit global rect -> top-left global rect).
pub fn top_left_rect_from_appkit(rect: Rect, screens: &[Screen]) -> Rect {
    Rect::new(
        rect.x,
        global_max_y(screens) - rect.max_y(),
        rect.width,
        rect.height,
    )
}

/// AppKit global rect -> CoreGraphics/ScreenCaptureKit global space.
/// Unlike the channel contract above, CoreGraphics anchors Y to the PRIMARY
/// display's top-left, not the maximum Y across all displays. These
/// conventions coincide on one display but diverge when a display extends
/// above the primary..)
pub fn cg_rect_from_appkit(rect: Rect, screens: &[Screen]) -> Rect {
    let primary_max_y = screens.first().map(|s| s.frame.max_y()).unwrap_or(0.0);
    Rect::new(
        rect.x,
        primary_max_y - rect.max_y(),
        rect.width,
        rect.height,
    )
}

/// Inverse of `cg_rect_from_appkit`).
pub fn appkit_rect_from_cg(rect: Rect, screens: &[Screen]) -> Rect {
    let primary_max_y = screens.first().map(|s| s.frame.max_y()).unwrap_or(0.0);
    Rect::new(
        rect.x,
        primary_max_y - rect.max_y(),
        rect.width,
        rect.height,
    )
}

/// Clamp a rect inside bounds).
pub fn clamp(rect: Rect, bounds: Rect) -> Rect {
    let width = rect.width.min(bounds.width);
    let height = rect.height.min(bounds.height);
    Rect::new(
        rect.x.max(bounds.x).min(bounds.max_x() - width),
        rect.y.max(bounds.y).min(bounds.max_y() - height),
        width,
        height,
    )
}

/// Clamp a rect FULLY inside the visible frame of the best screen (most
/// overlap; tie broken by nearest center) — used for panel seating so the
/// avatar never clips a monitor edge.
pub fn clamp_within_visible_screens(rect: Rect, screens: &[Screen]) -> Rect {
    let Some(target) = best_screen_frame(rect, screens) else {
        return rect;
    };
    clamp(rect, target)
}

fn best_screen_frame(rect: Rect, screens: &[Screen]) -> Option<Rect> {
    screens.iter().map(|s| s.visible_frame).max_by(|lhs, rhs| {
        let la = intersection_area(rect, *lhs);
        let ra = intersection_area(rect, *rhs);
        if la != ra {
            la.partial_cmp(&ra).unwrap()
        } else {
            center_distance_squared(rect, *rhs)
                .partial_cmp(&center_distance_squared(rect, *lhs))
                .unwrap()
        }
    })
}

/// Title-bar band of a window frame, AppKit space.
pub fn title_bar_band(rect: Rect, height: f64) -> Rect {
    let h = height.min(rect.height);
    Rect::new(rect.x, rect.max_y() - h, rect.width, h)
}

/// Title-bar band for drop HIT-TESTING (not display). When the window's top
/// edge abuts the top of its screen's visible area (maximized windows), the
/// pointer naturally overshoots into the menu-bar strip — extend the band to
/// the physical screen top so the drop still counts.
pub fn title_bar_hit_band(rect: Rect, height: f64, screens: &[Screen]) -> Rect {
    let mut band = title_bar_band(rect, height);
    let screen = screens
        .iter()
        .max_by(|a, b| {
            intersection_area(a.frame, rect)
                .partial_cmp(&intersection_area(b.frame, rect))
                .unwrap()
        })
        .filter(|s| intersection_area(s.frame, rect) > 0.0);
    if let Some(screen) = screen {
        if rect.max_y() >= screen.visible_frame.max_y() - 1.0 && screen.frame.max_y() > band.max_y()
        {
            band.height += screen.frame.max_y() - band.max_y();
        }
    }
    band
}

/// Panel frame for an avatar perched on a window's title bar at a horizontal
/// offset ratio, straddling the top edge by `overlap`.
/// Left margin kept clear of the perched avatar so the window's
/// traffic-light buttons (close/minimize/zoom, ~62pt from the left edge)
/// stay clickable.
pub const TRAFFIC_LIGHT_CLEARANCE: f64 = 78.0;

// The canvas is 92pt centered in a 94pt panel. Include its 1pt bottom
// inset, not panel_height * (1 - anchor), so the butt line meets the edge.
pub fn avatar_perch_overlap(character: bool) -> f64 {
    if character {
        1.0 + 92.0 * (1.0 - 0.74)
    } else {
        12.0
    }
}

pub fn perch_frame(window: Rect, panel: (f64, f64), offset_ratio: f64, overlap: f64) -> Rect {
    let (pw, ph) = panel;
    let ratio = offset_ratio.clamp(0.0, 1.0);
    let target_x = window.x + window.width * ratio;
    let max_x = window.max_x() - pw;
    // Keep the traffic lights clear when the window is wide enough;
    // narrow windows degrade to the old flush-left clamp.
    let cleared_min = window.x + TRAFFIC_LIGHT_CLEARANCE;
    let min_x = if max_x >= cleared_min {
        cleared_min
    } else {
        window.x
    };
    let origin_x = if max_x >= min_x {
        (target_x - pw / 2.0).clamp(min_x, max_x)
    } else {
        window.mid_x() - pw / 2.0
    };
    Rect::new(origin_x, window.max_y() - overlap, pw, ph)
}

// (The outline no longer has its own dock position: the avatar always
// seats via perch_frame. The waiting-spot helper is gone with the
// waiting phase itself — minimize now ends the perch.)

/// Shared intersection helper.
pub fn intersection_area(lhs: Rect, rhs: Rect) -> f64 {
    let w = lhs.max_x().min(rhs.max_x()) - lhs.x.max(rhs.x);
    let h = lhs.max_y().min(rhs.max_y()) - lhs.y.max(rhs.y);
    if w <= 0.0 || h <= 0.0 {
        0.0
    } else {
        w * h
    }
}

fn center_distance_squared(lhs: Rect, rhs: Rect) -> f64 {
    let dx = lhs.mid_x() - rhs.mid_x();
    let dy = lhs.mid_y() - rhs.mid_y();
    dx * dx + dy * dy
}

/// Live screens in AppKit global coordinates. MAIN THREAD ONLY (AppKit).
pub fn screens() -> Vec<Screen> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSRect;
    use std::ffi::CString;

    fn to_rect(r: NSRect) -> Rect {
        Rect::new(r.origin.x, r.origin.y, r.size.width, r.size.height)
    }

    unsafe {
        let cls = objc2::runtime::AnyClass::get(&CString::new("NSScreen").unwrap()).unwrap();
        let arr: *mut AnyObject = msg_send![cls, screens];
        let count: usize = msg_send![&*arr, count];
        (0..count)
            .map(|i| {
                let screen: *mut AnyObject = msg_send![&*arr, objectAtIndex: i];
                let frame: NSRect = msg_send![&*screen, frame];
                let visible: NSRect = msg_send![&*screen, visibleFrame];
                Screen {
                    frame: to_rect(frame),
                    visible_frame: to_rect(visible),
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn single_screen() -> Vec<Screen> {
        vec![Screen {
            frame: Rect::new(0.0, 0.0, 1512.0, 982.0),
            visible_frame: Rect::new(0.0, 76.0, 1512.0, 874.0),
        }]
    }

    fn dual_screens() -> Vec<Screen> {
        // External display above the primary (the divergence case).
        vec![
            Screen {
                frame: Rect::new(0.0, 0.0, 1512.0, 982.0),
                visible_frame: Rect::new(0.0, 76.0, 1512.0, 874.0),
            },
            Screen {
                frame: Rect::new(0.0, 982.0, 2560.0, 1440.0),
                visible_frame: Rect::new(0.0, 982.0, 2560.0, 1415.0),
            },
        ]
    }

    #[test]
    fn character_seat_accounts_for_canvas_padding_and_chip_is_unchanged() {
        let window = Rect::new(100.0, 100.0, 800.0, 600.0);
        let seat = perch_frame(window, (94.0, 94.0), 0.5, avatar_perch_overlap(true));
        let butt_y = seat.y + 1.0 + 92.0 * (1.0 - 0.74);
        assert!((butt_y - (window.y + window.height)).abs() < 1e-9);
        assert_eq!(avatar_perch_overlap(false), 12.0);
    }

    #[test]
    fn round_trips_top_left_and_appkit() {
        for screens in [single_screen(), dual_screens()] {
            let top_left = Rect::new(100.0, 40.0, 90.0, 90.0);
            let appkit = appkit_rect_from_top_left(top_left, &screens);
            let back = top_left_rect_from_appkit(appkit, &screens);
            assert_eq!(back, top_left);
        }
    }

    #[test]
    fn top_left_origin_maps_to_global_top() {
        let screens = single_screen();
        let appkit = appkit_rect_from_top_left(Rect::new(0.0, 0.0, 90.0, 90.0), &screens);
        // Top-left (0,0) = AppKit y at globalMaxY - height.
        assert_eq!(appkit.y, 982.0 - 90.0);
    }

    #[test]
    fn stacked_display_uses_total_bounding_height() {
        let screens = dual_screens();
        assert_eq!(global_max_y(&screens), 982.0 + 1440.0);
        let appkit = appkit_rect_from_top_left(Rect::new(0.0, 0.0, 90.0, 90.0), &screens);
        assert_eq!(appkit.y, 2422.0 - 90.0);
    }

    #[test]
    fn cg_conversion_coincides_on_single_display() {
        let screens = single_screen();
        let appkit = Rect::new(100.0, 100.0, 300.0, 200.0);
        let cg = cg_rect_from_appkit(appkit, &screens);
        // Single display: CG top-left == globalMaxY flip.
        assert_eq!(cg, top_left_rect_from_appkit(appkit, &screens));
        assert_eq!(appkit_rect_from_cg(cg, &screens), appkit);
    }

    #[test]
    fn cg_conversion_diverges_with_display_above_primary() {
        let screens = dual_screens();
        let appkit = Rect::new(0.0, 1000.0, 100.0, 100.0); // on the upper display
        let cg = cg_rect_from_appkit(appkit, &screens);
        // CG anchors to the PRIMARY height (982), not globalMaxY (2422):
        // y = 982 - 1100 = -118 (above the primary's top in CG space).
        assert_eq!(cg.y, -118.0);
        assert_ne!(cg, top_left_rect_from_appkit(appkit, &screens));
        assert_eq!(appkit_rect_from_cg(cg, &screens), appkit);
    }

    #[test]
    fn clamp_keeps_rect_inside_bounds() {
        let bounds = Rect::new(0.0, 76.0, 1512.0, 874.0);
        let clamped = clamp(Rect::new(-50.0, 1000.0, 90.0, 90.0), bounds);
        assert_eq!(clamped.x, 0.0);
        assert_eq!(clamped.max_y(), bounds.max_y());
    }

    #[test]
    fn clamp_shrinks_oversized_rect() {
        let bounds = Rect::new(0.0, 0.0, 100.0, 100.0);
        let clamped = clamp(Rect::new(0.0, 0.0, 500.0, 50.0), bounds);
        assert_eq!(clamped.width, 100.0);
    }

    #[test]
    fn within_clamp_pulls_partially_clipped_rect_fully_inside() {
        let screens = single_screen();
        // Half off the left edge — the partial-visibility clamp tolerates
        // this; the full-containment clamp must not.
        let clipped = Rect::new(-45.0, 200.0, 90.0, 90.0);
        let contained = clamp_within_visible_screens(clipped, &screens);
        assert_eq!(contained, Rect::new(0.0, 200.0, 90.0, 90.0));
    }

    #[test]
    fn within_clamp_contains_rect_straddling_top_edge() {
        let screens = single_screen();
        // Perch straddle on a window flush with the visible top: seat pokes
        // above max_y (950). Must be pulled fully inside.
        let straddle = Rect::new(300.0, 920.0, 94.0, 94.0);
        let contained = clamp_within_visible_screens(straddle, &screens);
        assert_eq!(contained.max_y(), screens[0].visible_frame.max_y());
        assert_eq!(contained.x, 300.0);
    }

    #[test]
    fn within_clamp_leaves_fully_visible_rect_alone() {
        let screens = single_screen();
        let inside = Rect::new(300.0, 300.0, 94.0, 94.0);
        assert_eq!(clamp_within_visible_screens(inside, &screens), inside);
    }

    #[test]
    fn within_clamp_uses_best_screen_on_dual_displays() {
        let screens = dual_screens();
        // Mostly on the upper display, poking past its top edge (2397).
        let poking = Rect::new(100.0, 2360.0, 94.0, 94.0);
        let contained = clamp_within_visible_screens(poking, &screens);
        assert_eq!(contained.max_y(), screens[1].visible_frame.max_y());
    }

    #[test]
    fn within_clamp_empty_screens_is_identity() {
        let r = Rect::new(1.0, 2.0, 3.0, 4.0);
        assert_eq!(clamp_within_visible_screens(r, &[]), r);
    }

    #[test]
    fn title_bar_band_is_top_strip_in_appkit_space() {
        let window = Rect::new(100.0, 100.0, 800.0, 600.0);
        let band = title_bar_band(window, 40.0);
        // AppKit: top of the window is maxY.
        assert_eq!(band.y, 660.0);
        assert_eq!(band.height, 40.0);
        assert_eq!(band.width, 800.0);
    }

    #[test]
    fn hit_band_extends_through_menu_bar_for_maximized_windows() {
        let screens = single_screen();
        // Window top flush against the visible-area top (76 + 874 = 950).
        let window = Rect::new(0.0, 76.0, 1512.0, 874.0);
        let band = title_bar_hit_band(window, 40.0, &screens);
        // Extends to the physical screen top (982).
        assert_eq!(band.max_y(), 982.0);
        // A normal mid-screen window is untouched.
        let normal = Rect::new(100.0, 100.0, 800.0, 600.0);
        let normal_band = title_bar_hit_band(normal, 40.0, &screens);
        assert_eq!(normal_band, title_bar_band(normal, 40.0));
    }

    #[test]
    fn perch_frame_clamps_offset_and_straddles_top_edge() {
        let window = Rect::new(100.0, 100.0, 800.0, 600.0);
        // Centered drop at ratio 0.5.
        let mid = perch_frame(window, (90.0, 90.0), 0.5, 12.0);
        assert_eq!(mid.x, 100.0 + 400.0 - 45.0);
        // Straddle: panel bottom overlaps the window top by `overlap`.
        assert_eq!(mid.y, 700.0 - 12.0);
        // Ratio 1.0 clamps to the right edge.
        let right = perch_frame(window, (90.0, 90.0), 1.0, 12.0);
        assert_eq!(right.x, 900.0 - 90.0);
        // Ratio 0.0 clamps RIGHT of the traffic lights, not flush-left
        // (flush-left would cover close/minimize).
        let left = perch_frame(window, (90.0, 90.0), 0.0, 12.0);
        assert_eq!(left.x, 100.0 + TRAFFIC_LIGHT_CLEARANCE);
        // Window narrower than the panel centers on it.
        let narrow = perch_frame(Rect::new(0.0, 0.0, 50.0, 100.0), (90.0, 90.0), 0.0, 12.0);
        assert_eq!(narrow.x, 25.0 - 45.0);
    }

    #[test]
    fn intersection_area_of_disjoint_rects_is_zero() {
        assert_eq!(
            intersection_area(
                Rect::new(0.0, 0.0, 10.0, 10.0),
                Rect::new(20.0, 20.0, 10.0, 10.0)
            ),
            0.0
        );
    }
}
