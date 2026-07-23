mod commands;
mod deep_links;
mod services;
mod types;

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Mutex, OnceLock};

    pub(crate) fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }
}

#[cfg(target_os = "macos")]
use objc2::AnyThread;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplication, NSImage};
#[cfg(target_os = "macos")]
use objc2_foundation::{MainThreadMarker, NSProcessInfo, NSString};
use services::{bundled_agents, bundled_skills, distro_bundle::DistroBundleState};
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};
use tauri::{Manager, RunEvent};
#[cfg(target_os = "macos")]
use tauri::{WebviewWindow, WindowEvent};
use tauri_plugin_window_state::StateFlags;

#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_POSITION: (f64, f64) = (14.0, 28.0);
const APP_LOG_MAX_FILE_SIZE_BYTES: u128 = 10 * 1024 * 1024;
#[cfg(target_os = "macos")]
const APP_DISPLAY_NAME: &str = "Berd";
#[cfg(target_os = "macos")]
const DEV_APP_NAME_ENV: &str = "BERD_DEV_APP_NAME";
#[cfg(target_os = "macos")]
const DEV_APP_ICON_ENV: &str = "BERD_DEV_APP_ICON";

fn install_panic_logging_hook() {
    std::panic::set_hook(Box::new(|info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let backtrace = backtrace.to_string();
        let panic_message = info.to_string();
        let message = format!("PANIC: {panic_message}\nbacktrace:\n{backtrace}");
        services::diagnostic_log::record_panic(panic_message, backtrace.clone());
        eprintln!("{message}");
        log::error!("{message}");
    }));
}

#[cfg(target_os = "macos")]
fn set_process_name() {
    let app_name = std::env::var(DEV_APP_NAME_ENV).unwrap_or_else(|_| APP_DISPLAY_NAME.to_string());
    let app_name = app_name.trim();
    if app_name.is_empty() {
        return;
    }

    NSProcessInfo::processInfo().setProcessName(&NSString::from_str(app_name));
}

#[cfg(target_os = "macos")]
fn set_dev_dock_icon() {
    let Ok(icon_path) = std::env::var(DEV_APP_ICON_ENV) else {
        return;
    };
    let icon_path = icon_path.trim();
    if icon_path.is_empty() {
        return;
    }

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };

    let Some(icon) =
        NSImage::initWithContentsOfFile(NSImage::alloc(), &NSString::from_str(icon_path))
    else {
        log::warn!("Failed to load dev app icon from {icon_path}");
        return;
    };

    let ns_app = NSApplication::sharedApplication(mtm);
    unsafe {
        ns_app.setApplicationIconImage(Some(&icon));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_logging_hook();
    #[cfg(target_os = "macos")]
    set_process_name();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("perf", log::LevelFilter::Debug)
                .max_file_size(APP_LOG_MAX_FILE_SIZE_BYTES)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("berd".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        );

    #[cfg(feature = "app-test-driver")]
    let builder = builder.plugin(tauri_plugin_app_test_driver::init());

    #[cfg(feature = "berdctl")]
    let builder = builder.plugin(tauri_plugin_berdctl::init());

    builder
        .setup(|app| {
            // Register every command-backed state in the Tauri state map
            // before any blocking, async, or filesystem work below. The main
            // window is created hidden, but its webview still loads and races
            // ahead on Tokio threads (e.g. `runChatRuntimeStartup` spawning
            // goose serve and calling `refresh_runtime_config`). If a blocking
            // step such as the move-to-/Applications prompt runs first, those
            // handlers read the state map before `manage()` has run and fail
            // with "state not managed". These `manage()` calls are cheap and
            // side-effect-free, so running them first guarantees the state is
            // present even while a later step blocks the setup thread.
            let app_data_dir = app.path().app_data_dir()?;

            let bundled_runtime_config_path = match app.path().resource_dir() {
                Ok(resource_dir) => Some(
                    resource_dir.join(commands::runtime_config::BUNDLED_RUNTIME_CONFIG_FILE_NAME),
                ),
                Err(error) => {
                    log::warn!(
                        "Failed to resolve resource dir for bundled runtime config: {error}"
                    );
                    None
                }
            };

            app.manage(commands::runtime_config::RuntimeConfigState::new(
                app_data_dir.clone(),
                bundled_runtime_config_path,
            ));
            // Construct and register the distro bundle up front (goose serve and
            // runtime-config readiness both depend on it). Seeding its bundled
            // skills/agents is filesystem work and is deferred below.
            app.manage(DistroBundleState::new(app.handle()));
            app.manage(commands::automations::AutomationStreamState::default());
            app.manage(commands::terminal::TerminalState::default());
            app.manage(commands::window_session::WindowSessionRegistry::default());
            app.manage(commands::agent_setup::AgentSetupRegistry::default());
            app.manage(commands::model_setup::ModelSetupRegistry::default());

            // `LayoutState::new` opens (and creates) the layout database, so the
            // one-time legacy app-data migration must run first to copy any
            // pre-rename database before a fresh, empty one is created here.
            services::app_data_migration::migrate_legacy_app_data(app.handle());
            let layout_state = tauri::async_runtime::block_on(commands::layout::LayoutState::new(
                app_data_dir.clone(),
            ))
            .map_err(std::io::Error::other)?;
            app.manage(layout_state);

            // With all command state registered, it is now safe to run blocking,
            // async, network, or filesystem work.
            //
            // The move-to-/Applications prompt is intentionally NOT run here.
            // Its synchronous `NSAlert.runModal()` would block this setup
            // closure on the main thread until the user dismisses it, stalling
            // the menu, lifecycle, and updater wiring below and widening the
            // window in which the racing webview observes a partially set-up
            // app. It is deferred to `RunEvent::Ready` (see `run` below), which
            // fires on the main thread once setup has returned and the event
            // loop is running.

            #[cfg(not(feature = "no-bb-cli-install"))]
            commands::cli::schedule_bb_cli_auto_install(app.handle());

            services::diagnostic_log::record_event(
                services::diagnostic_log::DiagnosticLevel::Info,
                services::diagnostic_log::DiagnosticCategory::Startup,
                "app_setup",
                None,
                std::collections::BTreeMap::new(),
            );

            #[cfg(target_os = "macos")]
            {
                if let Err(error) =
                    commands::notifications::init_completion_notifications(app.handle())
                {
                    log::warn!("Failed to initialize completion notifications: {error}");
                }
            }

            deep_links::install(app);

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

            services::berdctl_discovery::sweep_stale_discovery_files(&app_data_dir);

            // Seed the bundled skills/agents from the distro bundle registered
            // above. This touches the filesystem, so it runs after the prompt.
            //
            // The avatar refs the seed reports come from the bundle's source
            // files, which can differ from the installed copies when a user has
            // edited a bundled agent's avatar; warming them keeps the bundled
            // avatar available regardless.
            let mut bundled_avatar_refs: Vec<String> = Vec::new();
            {
                let distro_state = app.state::<DistroBundleState>();
                if let Some(bundle) = distro_state.bundle() {
                    let skills_bundle = bundle.clone();
                    tauri::async_runtime::spawn(async move {
                        match bundled_skills::seed_bundled_skills(&skills_bundle) {
                            Ok(count) if count > 0 => {
                                log::info!("Seeded {count} bundled skill(s)");
                            }
                            Ok(_) => {}
                            Err(error) => log::warn!("Failed to seed bundled skills: {error}"),
                        }
                    });

                    match bundled_agents::seed_bundled_agents(bundle) {
                        Ok(result) => {
                            if result.seeded_count > 0 {
                                log::info!("Seeded {} bundled agent(s)", result.seeded_count);
                            }
                            bundled_avatar_refs = result.avatar_refs_to_warm;
                        }
                        Err(error) => log::warn!("Failed to seed bundled agents: {error}"),
                    }
                }
            }
            app.manage(commands::global_shortcut::GlobalShortcutHandlerState::default());

            // Collect avatar refs from ALL agents (bundled + user-created) so
            // that startup warming recovers any missing avatar media, e.g. after
            // a data migration or cache clear. This runs independently of the
            // bundled-seed outcome above so that user-created agents' avatars are
            // still recovered when no distro bundle is present or seeding failed.
            {
                let mut all_avatar_refs = bundled_avatar_refs;
                for user_ref in bundled_agents::collect_all_agent_avatar_refs() {
                    if !all_avatar_refs.contains(&user_ref) {
                        all_avatar_refs.push(user_ref);
                    }
                }

                if !all_avatar_refs.is_empty() {
                    let avatars_app = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        match commands::avatars::warm_avatar_refs(avatars_app, all_avatar_refs)
                            .await
                        {
                            Ok(count) if count > 0 => {
                                log::info!("Warmed {count} agent avatar(s)");
                            }
                            Ok(_) => {}
                            Err(error) => {
                                log::warn!("Failed to warm agent avatar cache: {error}");
                            }
                        }
                    });
                }
            }

            let artifacts_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = commands::artifacts::warm_artifacts_cache(artifacts_app).await {
                    log::warn!("Failed to warm artifact asset cache: {error}");
                }
            });

            // Surface WKWebView renderer memory and detect silent OOM reaps.
            services::renderer_monitor::start(app.handle().clone());

            // Build a custom macOS application menu so that the app submenu,
            // "About" item, and "Quit" item use the product name "Berd"
            // instead of the Cargo binary name.
            #[cfg(target_os = "macos")]
            {
                set_dev_dock_icon();
                refresh_traffic_light_position_on_window_changes(app);
                attach_main_window_lifecycle(app);

                let app_menu = SubmenuBuilder::new(app, "Berd")
                    .about_with_text(
                        "About Berd",
                        Some(AboutMetadataBuilder::new().name(Some("Berd")).build()),
                    )
                    .separator()
                    .services()
                    .separator()
                    .hide_with_text("Hide Berd")
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit_with_text("Quit Berd")
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
                    .maximize_with_text("Zoom")
                    .separator()
                    .close_window()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&view_menu)
                    .item(&window_menu)
                    .build()?;
                app.set_menu(menu)?;

                // Register the Window submenu as macOS's windowsMenu so that
                // the system injects standard window management items (Fill,
                // Center, Move & Resize, Full Screen Tile, Bring All to Front,
                // etc.) automatically.
                //
                if let Some(mtm) = MainThreadMarker::new() {
                    let ns_app = NSApplication::sharedApplication(mtm);
                    if let Some(main_menu) = ns_app.mainMenu() {
                        let window_title = NSString::from_str("Window");
                        if let Some(window_item) = main_menu.itemWithTitle(&window_title) {
                            if let Some(window_ns_menu) = window_item.submenu() {
                                ns_app.setWindowsMenu(Some(&window_ns_menu));
                            }
                        }
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agents::read_import_persona_file,
            commands::agents::read_agent_source_file,
            commands::auth::auth_status,
            commands::auth::start_login,
            commands::auth::login,
            commands::auth::cancel_login,
            commands::auth::logout,
            commands::avatars::get_avatar_library_snapshot,
            commands::avatars::get_cached_avatar_for_ref,
            commands::avatars::get_cached_avatars_for_refs,
            commands::avatars::ensure_avatar_collection,
            commands::cache::clear_local_media_caches,
            commands::cli::get_bb_cli_status,
            #[cfg(not(feature = "no-bb-cli-install"))]
            commands::cli::install_bb_cli,
            commands::global_shortcut::launch_global_shortcut_handler,
            commands::global_shortcut::stop_global_shortcut_handler,
            commands::connections::list_connections,
            commands::connections::disconnect_connection,
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
            commands::automations::refresh_automation_tile,
            commands::automations::generate_automation_schedule,
            commands::automations::get_automation_session_messages,
            commands::builderbot::get_builderbot_tasks,
            commands::builderbot::get_builderbot_scheduled_triggers,
            commands::builderbot::get_builderbot_routing_rules,
            commands::builderbot::update_builderbot_scheduled_trigger,
            commands::builderbot::update_builderbot_routing_rule,
            commands::telemetry::send_telemetry_batch,
            commands::whoami::whoami,
            commands::acp::get_goose_serve_url,
            commands::acp::get_goose_serve_host_info,
            commands::project_icons::scan_project_icons,
            commands::project_icons::read_project_icon,
            commands::renderer::log_renderer_event,
            commands::artifacts::get_artifacts,
            commands::doctor::run_doctor,
            commands::doctor::run_doctor_fresh,
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
            commands::git::git_has_ignored_files,
            commands::git::git_count_branch_commits_not_in_base,
            commands::git::git_delete_branch,
            commands::git::git_create_worktree,
            commands::git::git_remove_worktree,
            commands::home_widget_media::import_home_widget_photo,
            commands::layout::get_layout,
            commands::layout::save_layout_items,
            commands::layout::save_layout_camera,
            commands::layout::reset_layout,
            commands::migration::migration_status,
            commands::migration::backup_goose_config,
            commands::migration::mark_migration_complete,
            commands::migration::mark_legacy_extension_cleanup_complete,
            commands::migration::dismiss_migration_banner,
            commands::model_setup::start_model_setup,
            commands::model_setup::get_model_setup_status,
            commands::model_setup::list_model_setup_status,
            commands::model_setup::clear_model_setup_status,
            commands::notifications::show_completion_notification,
            commands::openai_realtime::get_openai_realtime_status,
            commands::openai_realtime::create_openai_realtime_session,
            commands::agent_setup::start_agent_setup,
            commands::agent_setup::get_agent_setup_status,
            commands::agent_setup::list_agent_setup_status,
            commands::agent_setup::clear_agent_setup_status,
            commands::path_resolver::resolve_path,
            commands::path_resolver::check_directories_exist,
            commands::diagnostics::probe_kgoose_connectivity,
            commands::diagnostics::write_diagnostic_event,
            commands::distro::get_distro_bundle,
            commands::runtime_config::get_runtime_config,
            commands::runtime_config::set_fake_runtime_config,
            commands::runtime_config::clear_fake_runtime_config,
            commands::runtime_config::refresh_runtime_config,
            commands::security_threshold::get_security_threshold,
            commands::security_threshold::set_security_threshold,
            commands::system::get_home_dir,
            commands::system::open_in_chrome,
            commands::system::save_exported_agent_file,
            commands::system::save_exported_session_file,
            commands::system::save_exported_session_files,
            commands::system::path_exists,
            commands::system::ensure_directory,
            commands::system::list_directory_entries,
            commands::system::inspect_attachment_paths,
            commands::system::search_file_mentions,
            commands::system::read_image_attachment,
            commands::system::read_text_file,
            commands::terminal::start_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::stop_terminal,
            commands::updates::finalize_update_relaunch,
            commands::window_session::get_session_window_support,
            commands::window_session::open_session_window,
            commands::window_session::release_session,
            commands::window_session::join_session_handoff,
            commands::window_session::publish_session_handoff_snapshot,
            commands::window_session::finish_session_handoff,
            commands::window_session::read_session_handoff_snapshot,
            commands::window_session::recover_session_handoff,
            commands::window_session::focus_session_window,
            commands::window_session::list_session_windows,
            commands::agent_skills::list_agent_skills,
            commands::skill_marketplace::skill_cli_status,
            commands::skill_marketplace::list_remote_skills,
            commands::skill_marketplace::show_remote_skill,
            commands::skill_marketplace::install_remote_skill,
            commands::workspace_context::load_workspace_context,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Exit => {
                app.state::<commands::automations::AutomationStreamState>()
                    .abort_all();
                app.state::<commands::global_shortcut::GlobalShortcutHandlerState>()
                    .stop();
                app.state::<commands::terminal::TerminalState>().stop_all();
                services::acp::goose_serve::GooseServeProcess::kill_singleton();
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
            // Offer to move into /Applications when launched from installer
            // media (DMG, a read-only/translocated location, or another
            // non-installed download). Deferred out of `setup` to here so the
            // synchronous `NSAlert.runModal()` runs on the main thread only
            // once setup has returned and the event loop is running, keeping
            // setup non-blocking. Fires once. Accepting copies the bundle,
            // relaunches the installed copy, and exits this process.
            #[cfg(target_os = "macos")]
            RunEvent::Ready => {
                services::installer_media::maybe_prompt_move_to_applications(app);
            }
            _ => {}
        });
}

#[cfg(target_os = "macos")]
fn refresh_traffic_light_position_on_window_changes(app: &tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        attach_traffic_light_management(&window);
    }
}

#[cfg(target_os = "macos")]
fn attach_main_window_lifecycle(app: &tauri::App) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };

    let app_handle = app.handle().clone();
    main.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let has_secondary_window = app_handle
                .webview_windows()
                .keys()
                .any(|label| label != "main");

            if has_secondary_window {
                api.prevent_close();
                if let Some(main) = app_handle.get_webview_window("main") {
                    let _ = main.hide();
                }
            }
        }
    });
}

#[cfg(target_os = "macos")]
pub(crate) fn attach_traffic_light_management(window: &WebviewWindow) {
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };

    schedule_traffic_light_position_refresh(window);

    let window_for_events = window.clone();
    let resize_generation = Arc::new(AtomicU64::new(0));
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) => {
            let generation = resize_generation.fetch_add(1, Ordering::Relaxed) + 1;
            let delayed_window = window_for_events.clone();
            let delayed_generation = resize_generation.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                if delayed_generation.load(Ordering::Relaxed) == generation {
                    schedule_traffic_light_position_refresh(&delayed_window);
                }
            });
        }
        WindowEvent::ScaleFactorChanged { .. } | WindowEvent::Focused(true) => {
            resize_generation.fetch_add(1, Ordering::Relaxed);
            schedule_traffic_light_position_refresh(&window_for_events);

            let delayed_window = window_for_events.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                schedule_traffic_light_position_refresh(&delayed_window);
            });
        }
        _ => {}
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
