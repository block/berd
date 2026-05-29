mod commands;
mod services;
mod types;

use services::{bundled_skills, distro_bundle::DistroBundleState};
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};
use tauri::{Manager, RunEvent};
#[cfg(target_os = "macos")]
use tauri::{WebviewWindow, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_window_state::StateFlags;

#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_POSITION: (f64, f64) = (14.0, 28.0);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("perf", log::LevelFilter::Debug)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("goose".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        );

    #[cfg(feature = "app-test-driver")]
    let builder = builder.plugin(tauri_plugin_app_test_driver::init());

    builder
        .setup(|app| {
            let deep_link_app = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    log::info!("Received deep link: {url}");
                }
                if let Some(window) = deep_link_app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
            });

            // Register the updater plugin only when a signing public key is
            // configured (i.e. release builds that include tauri.release.conf.json).
            let updater_pubkey_present = app
                .config()
                .plugins
                .0
                .get("updater")
                .and_then(|v| v.as_object())
                .and_then(|u| u.get("pubkey"))
                .and_then(|k| k.as_str())
                .is_some_and(|k| !k.trim().is_empty());

            if updater_pubkey_present {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            let distro_state = DistroBundleState::new(app.handle());
            if let Some(bundle) = distro_state.bundle() {
                let bundle = bundle.clone();
                tauri::async_runtime::spawn(async move {
                    match bundled_skills::seed_bundled_skills(&bundle) {
                        Ok(count) if count > 0 => {
                            log::info!("Seeded {count} bundled skill(s)");
                        }
                        Ok(_) => {}
                        Err(error) => log::warn!("Failed to seed bundled skills: {error}"),
                    }
                });
            }
            app.manage(distro_state);
            app.manage(commands::automations::AutomationStreamState::default());
            let layout_app_data_dir = app.path().app_data_dir()?;
            let layout_state = tauri::async_runtime::block_on(commands::layout::LayoutState::new(
                layout_app_data_dir,
            ))
            .map_err(std::io::Error::other)?;
            app.manage(layout_state);

            let artifacts_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = commands::artifacts::warm_artifacts_cache(artifacts_app).await {
                    log::warn!("Failed to warm artifact asset cache: {error}");
                }
            });

            // Build a custom macOS application menu so that the app submenu,
            // "About" item, and "Quit" item use the capitalised product name
            // "Goose" instead of the lowercase Cargo binary name "goose".
            #[cfg(target_os = "macos")]
            {
                refresh_traffic_light_position_on_window_changes(app);

                let app_menu = SubmenuBuilder::new(app, "Goose")
                    .about(Some(
                        AboutMetadataBuilder::new().name(Some("Goose")).build(),
                    ))
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit_with_text("Quit Goose")
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .close_window()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&view_menu)
                    .item(&window_menu)
                    .build()?;
                app.set_menu(menu)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agents::read_import_persona_file,
            commands::agents::read_agent_source_file,
            commands::avatars::get_avatar_library_snapshot,
            commands::avatars::get_cached_avatar_for_ref,
            commands::avatars::ensure_avatar_collection,
            commands::cache::clear_local_media_caches,
            commands::connections::list_connections,
            commands::automations::get_automation_tiles,
            commands::automations::get_automation_tile,
            commands::automations::get_automation_tile_results,
            commands::automations::create_automation_tile,
            commands::automations::push_automation_builder_messages,
            commands::automations::cancel_automation_builder_message,
            commands::automations::start_automation_builder_stream,
            commands::automations::stop_automation_builder_stream,
            commands::automations::update_automation_tile,
            commands::automations::delete_automation_tile,
            commands::automations::generate_automation_schedule,
            commands::automations::get_automation_session_messages,
            commands::acp::get_goose_serve_url,
            commands::acp::get_goose_serve_host_info,
            commands::project_icons::scan_project_icons,
            commands::project_icons::read_project_icon,
            commands::artifacts::get_artifacts,
            commands::doctor::run_doctor,
            commands::doctor::run_doctor_fix,
            commands::feedback::submit_feedback_issue,
            commands::git::get_git_state,
            commands::git_changes::get_changed_files,
            commands::git::git_switch_branch,
            commands::git::git_stash,
            commands::git::git_init,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_create_branch,
            commands::git::git_create_worktree,
            commands::layout::get_layout,
            commands::layout::save_layout_items,
            commands::layout::save_layout_camera,
            commands::layout::reset_layout,
            commands::migration::migration_status,
            commands::migration::backup_goose_config,
            commands::migration::mark_migration_complete,
            commands::migration::dismiss_migration_banner,
            commands::model_setup::authenticate_model_provider,
            commands::openai_realtime::get_openai_realtime_status,
            commands::openai_realtime::create_openai_realtime_session,
            commands::agent_setup::check_agent_installed,
            commands::agent_setup::check_agent_auth,
            commands::agent_setup::install_agent,
            commands::agent_setup::authenticate_agent,
            commands::path_resolver::resolve_path,
            commands::diagnostics::probe_kgoose_connectivity,
            commands::distro::get_distro_bundle,
            commands::system::get_home_dir,
            commands::system::open_in_chrome,
            commands::system::save_exported_session_file,
            commands::system::path_exists,
            commands::system::list_directory_entries,
            commands::system::inspect_attachment_paths,
            commands::system::list_files_for_mentions,
            commands::system::read_image_attachment,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                app.state::<commands::automations::AutomationStreamState>()
                    .abort_all();
                services::acp::goose_serve::GooseServeProcess::kill_singleton();
            }
        });
}

#[cfg(target_os = "macos")]
fn refresh_traffic_light_position_on_window_changes(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    schedule_traffic_light_position_refresh(&window);

    let window_for_events = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
                | WindowEvent::Focused(true)
        ) {
            schedule_traffic_light_position_refresh(&window_for_events);

            let delayed_window = window_for_events.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                schedule_traffic_light_position_refresh(&delayed_window);
            });
        }
    });
}

#[cfg(target_os = "macos")]
fn schedule_traffic_light_position_refresh(window: &WebviewWindow) {
    let window_for_main_thread = window.clone();
    let window_for_refresh = window.clone();
    let _ = window_for_main_thread.run_on_main_thread(move || {
        apply_traffic_light_position(&window_for_refresh);
    });
}

#[cfg(target_os = "macos")]
fn apply_traffic_light_position(window: &WebviewWindow) {
    let Ok(ns_window) = window.ns_window() else {
        return;
    };

    unsafe {
        let ns_window = &*ns_window.cast::<objc2_app_kit::NSWindow>();
        inset_traffic_lights(
            ns_window,
            TRAFFIC_LIGHT_POSITION.0,
            TRAFFIC_LIGHT_POSITION.1,
        );
    }
}

#[cfg(target_os = "macos")]
unsafe fn inset_traffic_lights(window: &objc2_app_kit::NSWindow, x: f64, y: f64) {
    use objc2_app_kit::{NSView, NSWindowButton};

    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(miniaturize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };

    let Some(title_bar_container_view) = close.superview().and_then(|view| view.superview()) else {
        return;
    };

    let close_rect = NSView::frame(&close);
    let title_bar_frame_height = close_rect.size.height + y;
    let mut title_bar_rect = NSView::frame(&title_bar_container_view);
    title_bar_rect.size.height = title_bar_frame_height;
    title_bar_rect.origin.y = window.frame().size.height - title_bar_frame_height;
    title_bar_container_view.setFrame(title_bar_rect);

    let space_between = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;
    let mut window_buttons = vec![close, miniaturize];
    if let Some(zoom) = window.standardWindowButton(NSWindowButton::ZoomButton) {
        window_buttons.push(zoom);
    }

    for (index, button) in window_buttons.into_iter().enumerate() {
        let mut rect = NSView::frame(&button);
        rect.origin.x = x + (index as f64 * space_between);
        button.setFrameOrigin(rect.origin);
    }
}
