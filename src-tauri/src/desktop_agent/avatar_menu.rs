//! Avatar context menu — native menu popup on right-click of the agent.
//!
//! The webview owns the agent data (it fetched the persona list and needs
//! the full record to arm a selection); this side is deliberately dumb:
//! build a menu from the given (id, name) pairs plus caller-localized
//! labels, pop it at the mouse, and route clicks back as
//! `desktop-agent:menu-*` events (see handle_menu_event in mod.rs). Menu
//! item ids are namespaced `desktop-agent:` so other app menu ids can
//! never collide.

use serde::Deserialize;
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, ContextMenu, MenuBuilder, MenuItem, MenuItemBuilder,
};
use tauri::{AppHandle, Manager, Wry};

pub const AGENT_ID_PREFIX: &str = "desktop-agent:agent:";
/// The fresh-chat entry: arms a FRESH session (no agent) with the same
/// deferred start-a-session pattern. Routed as its own event — an agent
/// id could legitimately be anything, so fresh must not share namespace.
pub const FRESH_ITEM_ID: &str = "desktop-agent:fresh";
/// Settings deep-link: reveals the MAIN window and opens the General
/// section (where the Desktop Agent settings live). Routed in
/// handle_menu_event to the main webview, not the panel.
pub const SETTINGS_ITEM_ID: &str = "desktop-agent:settings";
/// Dismiss: hides the panel (the `showAgent` config) without ending its
/// chat. Routed back to the panel webview, which owns the config write;
/// the toggle chord or the settings toggle brings it back.
pub const DISMISS_ITEM_ID: &str = "desktop-agent:dismiss";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuAgent {
    pub agent_id: String,
    pub name: String,
}

/// Caller-localized labels for the fixed menu items (Rust stays
/// string-free; the webview owns i18n). Grouped so the command signature
/// stays within clippy's argument budget.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuLabels {
    pub header: String,
    pub fresh: String,
    pub settings: String,
    pub dismiss: String,
    pub empty: String,
}

/// Pops the agent menu at the current mouse position. `pending_agent_id`
/// gets a checkmark (a selection exists but no chat is created yet — the
/// menu reflects the armed state truthfully). With zero agents the list
/// slot shows a disabled `labels.empty` row (the fresh entry still
/// works; agents are created in the main window). A trailing settings
/// item deep-links to the General settings section in the MAIN window, and
/// a final dismiss item hides the agent. With `agent_selector` false (the
/// agent-selector experiment is off) only the settings and dismiss items
/// are shown.
#[tauri::command]
pub fn desktop_agent_avatar_menu_popup(
    app: AppHandle,
    agent_selector: bool,
    agents: Vec<MenuAgent>,
    pending_agent_id: Option<String>,
    pending_fresh: bool,
    labels: MenuLabels,
) -> Result<(), String> {
    let window = app
        .get_webview_window(super::WINDOW_LABEL)
        .ok_or("desktop-agent window missing")?;

    // Menu construction + popup are AppKit — main thread only (hard rule).
    app.clone()
        .run_on_main_thread(move || {
            let mut builder = MenuBuilder::new(&app);
            // Built up front and kept alive until the menu is built
            // (the builder borrows its items).
            let selector = if agent_selector {
                match build_selector_items(
                    &app,
                    &agents,
                    pending_agent_id.as_deref(),
                    pending_fresh,
                    &labels,
                ) {
                    Some(items) => Some(items),
                    None => return,
                }
            } else {
                None
            };
            if let Some(selector) = &selector {
                builder = builder
                    .item(&selector.header)
                    .separator()
                    .item(&selector.fresh)
                    .separator();
                for item in &selector.agents {
                    builder = builder.item(item);
                }
                if let Some(item) = &selector.empty {
                    builder = builder.item(item);
                }
                builder = builder.separator();
            }
            // Trailing settings deep-link: the panel has no settings
            // surface of its own — this routes to the main window's
            // General settings section (see handle_menu_event).
            let settings =
                match MenuItemBuilder::with_id(SETTINGS_ITEM_ID, &labels.settings).build(&app) {
                    Ok(item) => item,
                    Err(_) => return,
                };
            // Dismiss closes the menu out: hide the agent (chat kept).
            let dismiss =
                match MenuItemBuilder::with_id(DISMISS_ITEM_ID, &labels.dismiss).build(&app) {
                    Ok(item) => item,
                    Err(_) => return,
                };
            builder = builder.item(&settings).item(&dismiss);
            if let Ok(menu) = builder.build() {
                // Pops at the mouse location; the click routes through the
                // app-level on_menu_event handler registered in lib.rs.
                // popup() wants the Window, not the WebviewWindow.
                let _ = menu.popup(window.as_ref().window());
            }
        })
        .map_err(|e| e.to_string())
}

/// The agent-selector section: header, fresh entry, the agent list, and a
/// disabled explainer row when there are no agents. `None` only when a
/// required item fails to build (the menu is then skipped).
struct SelectorItems {
    header: MenuItem<Wry>,
    fresh: CheckMenuItem<Wry>,
    agents: Vec<CheckMenuItem<Wry>>,
    empty: Option<MenuItem<Wry>>,
}

fn build_selector_items(
    app: &AppHandle,
    agents: &[MenuAgent],
    pending_agent_id: Option<&str>,
    pending_fresh: bool,
    labels: &MenuLabels,
) -> Option<SelectorItems> {
    let header = MenuItemBuilder::with_id("desktop-agent:header", &labels.header)
        .enabled(false)
        .build(app)
        .ok()?;
    // The fresh entry leads: the reset-to-default choice — a fresh plain
    // session and the default avatar.
    let fresh = CheckMenuItemBuilder::with_id(FRESH_ITEM_ID, &labels.fresh)
        .checked(pending_fresh)
        .build(app)
        .ok()?;
    let agent_items = agents
        .iter()
        .filter_map(|agent| {
            let id = format!("{AGENT_ID_PREFIX}{}", agent.agent_id);
            CheckMenuItemBuilder::with_id(id, &agent.name)
                .checked(pending_agent_id == Some(agent.agent_id.as_str()))
                .build(app)
                .ok()
        })
        .collect();
    // Zero agents: a disabled explainer row where the list would be — the
    // fresh entry above still works; agents are created in the main window.
    let empty = if agents.is_empty() {
        MenuItemBuilder::with_id("desktop-agent:empty", &labels.empty)
            .enabled(false)
            .build(app)
            .ok()
    } else {
        None
    };
    Some(SelectorItems {
        header,
        fresh,
        agents: agent_items,
        empty,
    })
}
