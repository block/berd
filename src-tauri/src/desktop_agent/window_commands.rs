//! Tauri commands backing the TS WindowPort seam (panelState.ts).
//!
//! The webview works exclusively in GLOBAL TOP-LEFT coordinates (the
//! channel contract). Conversions to/from AppKit's bottom-left space happen
//! here, and only via coordinate_space (the sole flip authority).

use serde::{Deserialize, Serialize};

use super::coordinate_space::{self as cs, Rect};
use super::panel;
use objc2::msg_send;
use objc2::runtime::AnyObject;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct RectDto {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl From<Rect> for RectDto {
    fn from(r: Rect) -> Self {
        Self {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
        }
    }
}

impl From<RectDto> for Rect {
    fn from(r: RectDto) -> Self {
        Rect::new(r.x, r.y, r.width, r.height)
    }
}

#[derive(Serialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct ScreenDto {
    pub frame: RectDto,
    pub visible_frame: RectDto,
    pub is_main: bool,
}

use super::main_thread::on_main;

fn ns_panel_ptr(app: &AppHandle) -> Result<usize, String> {
    let window = app
        .get_webview_window(super::WINDOW_LABEL)
        .ok_or("desktop-agent window missing")?;
    window
        .ns_window()
        .map(|p| p as usize)
        .map_err(|e| e.to_string())
}

/// Screens in global TOP-LEFT coordinates for the webview.
#[tauri::command]
pub fn desktop_agent_get_screens(app: AppHandle) -> Result<Vec<ScreenDto>, String> {
    on_main(&app, || {
        let screens = cs::screens();
        screens
            .iter()
            .enumerate()
            .map(|(i, s)| ScreenDto {
                frame: cs::top_left_rect_from_appkit(s.frame, &screens).into(),
                visible_frame: cs::top_left_rect_from_appkit(s.visible_frame, &screens).into(),
                // AppKit convention: the first screen in NSScreen.screens is
                // the one with the menu bar (the "main" for our purposes).
                is_main: i == 0,
            })
            .collect()
    })
}

/// Current panel frame in global TOP-LEFT coordinates.
#[tauri::command]
pub fn desktop_agent_get_panel_frame(app: AppHandle) -> Result<RectDto, String> {
    let ptr = ns_panel_ptr(&app)?;
    on_main(&app, move || {
        let screens = cs::screens();
        let frame: objc2_foundation::NSRect = unsafe {
            let panel = ptr as *mut AnyObject;
            msg_send![&*panel, frame]
        };
        let appkit = Rect::new(
            frame.origin.x,
            frame.origin.y,
            frame.size.width,
            frame.size.height,
        );
        cs::top_left_rect_from_appkit(appkit, &screens).into()
    })
}

/// Atomically resizes the panel and flips key-window eligibility — the
/// panel setState contract, including the anti-blink ordering: frame first, then
/// key status, in a single main-thread hop.
#[tauri::command]
pub fn desktop_agent_set_state(
    app: AppHandle,
    expanded: bool,
    frame: RectDto,
) -> Result<(), String> {
    let ptr = ns_panel_ptr(&app)?;
    panel::note_expanded(expanded);
    on_main(&app, move || {
        let screens = cs::screens();
        let appkit = cs::appkit_rect_from_top_left(frame.into(), &screens);
        unsafe {
            let p = ptr as *mut AnyObject;
            let ns_rect = objc2_foundation::NSRect::new(
                objc2_foundation::NSPoint::new(appkit.x, appkit.y),
                objc2_foundation::NSSize::new(appkit.width, appkit.height),
            );
            let _: () = msg_send![&mut *p, setFrame: ns_rect, display: true];
            if expanded {
                let _: () = msg_send![&mut *p, makeKeyWindow];
            } else {
                let is_key: objc2::runtime::Bool = msg_send![&*p, isKeyWindow];
                if is_key.as_bool() {
                    let _: () = msg_send![&mut *p, resignKeyWindow];
                }
            }
            // set_state doubles as the REVEAL for the built-hidden window:
            // the webview's post-restore setState is the first moment the
            // panel has both a correct frame and a painted transparent
            // webview. "Hide agent" destroys the panel now, so there is no
            // hidden-but-running state for frame updates.
            let _: () = msg_send![&mut *p, orderFrontRegardless];
        }
    })
}
