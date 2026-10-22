//! ScreenCaptureKit still-image capture for perch mode.
//!
//! Decisions carried from the prototype: fresh capture per send; 1500px
//! long-edge cap; PNG; no quality knob. Window-scoped capture only — the
//! prototype's display-region path was deleted before the port.

use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, AllocAnyThread};
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSDictionary, NSError};
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDto {
    /// Base64 PNG.
    pub data: String,
    pub mime_type: String,
}

/// Window-scoped capture for perch mode:
/// SCContentFilter(desktopIndependentWindow:) — no display math, works
/// even when the window is occluded. Called from perch::desktop_agent_perch_capture.
pub async fn capture_window(window_id: u32) -> Result<CaptureDto, String> {
    let png = tauri::async_runtime::spawn_blocking(move || capture_window_blocking(window_id))
        .await
        .map_err(|e| e.to_string())??;
    use base64::Engine;
    Ok(CaptureDto {
        data: base64::engine::general_purpose::STANDARD.encode(png),
        mime_type: "image/png".into(),
    })
}

fn capture_window_blocking(window_id: u32) -> Result<Vec<u8>, String> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();

    let content_tx = tx.clone();
    let content_block = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            if content.is_null() {
                let message = unsafe {
                    error
                        .as_ref()
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "screen capture unavailable".into())
                };
                let _ = content_tx.send(Err(message));
                return;
            }
            let content = unsafe { &*content };
            // onScreenWindowsOnly=false below: a window that minimized or
            // left the Space between the follow tick and this capture must
            // still be findable — degrade at the SCK level, not by us
            // failing to find the window.
            let windows = unsafe { content.windows() };
            let window: Option<Retained<SCWindow>> = windows
                .iter()
                .find(|w| unsafe { w.windowID() } == window_id);
            let Some(window) = window else {
                let _ = content_tx.send(Err("The perched window is no longer available".into()));
                return;
            };
            let filter = unsafe {
                SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
            };
            let size = unsafe { filter.contentRect() }.size;
            let long_edge = size.width.max(size.height);
            let scale = if long_edge > 1500.0 {
                1500.0 / long_edge
            } else {
                1.0
            };
            let config = unsafe { SCStreamConfiguration::new() };
            unsafe {
                config.setWidth((size.width * scale).max(1.0) as usize);
                config.setHeight((size.height * scale).max(1.0) as usize);
                config.setShowsCursor(false);
                config.setScalesToFit(true);
                config.setPreservesAspectRatio(true);
            }
            let shot_tx = content_tx.clone();
            let shot_block = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
                if let Some(image) = NonNull::new(image) {
                    let _ = shot_tx.send(encode_png(unsafe { image.as_ref() }));
                } else {
                    let message = unsafe {
                        error
                            .as_ref()
                            .map(|e| e.localizedDescription().to_string())
                            .unwrap_or_else(|| "screenshot failed".into())
                    };
                    let _ = shot_tx.send(Err(message));
                }
            });
            unsafe {
                SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                    &filter,
                    &config,
                    Some(&shot_block),
                );
            }
        },
    );
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            false, false, &content_block,
        );
    }

    rx.recv_timeout(Duration::from_secs(15))
        .map_err(|_| "screen capture timed out".to_string())?
}

/// CGImage -> PNG bytes via NSBitmapImageRep.
///
/// Runs on a blocking thread with NO ambient autorelease pool, so one is
/// created explicitly and the alloc/init'd rep is released on every path
/// (an earlier shape leaked the rep — holding the full screenshot — on
/// every capture, plus the autoreleased NSData).
fn encode_png(image: &CGImage) -> Result<Vec<u8>, String> {
    objc2::rc::autoreleasepool(|_| unsafe {
        let cls =
            objc2::runtime::AnyClass::get(&std::ffi::CString::new("NSBitmapImageRep").unwrap())
                .ok_or("NSBitmapImageRep unavailable")?;
        let rep: *mut AnyObject = msg_send![cls, alloc];
        let image_ptr: *const CGImage = image;
        let rep: *mut AnyObject = msg_send![rep, initWithCGImage: image_ptr];
        if rep.is_null() {
            return Err("could not wrap screenshot".into());
        }
        let result = (|| {
            let props: Retained<NSDictionary> = NSDictionary::new();
            // NSBitmapImageFileTypePNG == 4
            let data: *mut AnyObject =
                msg_send![&*rep, representationUsingType: 4usize, properties: &*props];
            if data.is_null() {
                return Err("could not encode screenshot as PNG".into());
            }
            // NSData is autoreleased — the pool drains it; copy out first.
            let length: usize = msg_send![&*data, length];
            let bytes: *const u8 = msg_send![&*data, bytes];
            Ok(std::slice::from_raw_parts(bytes, length).to_vec())
        })();
        let _: () = msg_send![&*rep, release];
        result
    })
}
