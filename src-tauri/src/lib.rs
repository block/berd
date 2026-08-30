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
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};
#[cfg(target_os = "macos")]
use tauri::WebviewWindow;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;

#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_POSITION: (f64, f64) = (14.0, 28.0);
const APP_LOG_MAX_FILE_SIZE_BYTES: u128 = 10 * 1024 * 1024;
/// Archived log files kept once `berd.log` hits the size cap. `KeepSome`
/// counts archives only — the active `berd.log` is always kept on top, so
/// this retains three files total. The plugin's default strategy is
/// `KeepOne`, which *deletes* the full file rather than archiving it — that
/// would wipe the captured `goose serve` stderr (crash backtraces included)
/// mid-incident.
const APP_LOG_ARCHIVES_KEPT: usize = 2;
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

    let context = tauri::generate_context!();
    let e2e_mode = services::e2e_mode::E2eMode::from_process_env(&context.config().identifier)
        .unwrap_or_else(|error| panic!("invalid isolated E2E configuration: {error}"));
    if let Some(mode) = &e2e_mode {
        mode.enforce_process_env()
            .unwrap_or_else(|error| panic!("failed to initialize isolated E2E mode: {error}"));
    }

    let builder = tauri::Builder::default();

    // Single-instance enforcement: on Windows, a second launch exits early
    // and focuses the existing window instead of starting a duplicate app
    // (log files, db connections, goose serve, etc.). macOS handles this
    // via RunEvent::Reopen further below.
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("perf", log::LevelFilter::Debug)
                .max_file_size(APP_LOG_MAX_FILE_SIZE_BYTES)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(
                    APP_LOG_ARCHIVES_KEPT,
                ))
                .targets([
                    // The Stdout formatter greys dev-time telemetry-viewer
                    // records; the LogDir target keeps no formatter so the
                    // ANSI escapes never reach `berd.log`.
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout)
                        .format(commands::renderer::stdout_log_format),
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
    let builder = if let Some(mode) = &e2e_mode {
        let driver_config = tauri_plugin_app_test_driver::DriverConfig::new(
            mode.driver_token().to_owned(),
            mode.driver_run_root(),
        );
        builder.plugin(tauri_plugin_app_test_driver::init_isolated(driver_config))
    } else {
        builder.plugin(tauri_plugin_app_test_driver::init())
    };

    #[cfg(feature = "berdctl")]
    let builder = builder.plugin(tauri_plugin_berdctl::init());

    if let Some(mode) = &e2e_mode {
        mode.log_enabled();
    }

    let builder = if let Some(mode) = e2e_mode {
        builder.manage(mode)
    } else {
        builder
    };

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

            let bundled_runtime_config_path = app
                .try_state::<services::e2e_mode::E2eMode>()
                .and_then(|mode| mode.runtime_config_path().map(PathBuf::from))
                .or_else(|| match app.path().resource_dir() {
                    Ok(resource_dir) => Some(
                        resource_dir
                            .join(commands::runtime_config::BUNDLED_RUNTIME_CONFIG_FILE_NAME),
                    ),
                    Err(error) => {
                        log::warn!(
                            "Failed to resolve resource dir for bundled runtime config: {error}"
                        );
                        None
                    }
                });

            app.manage(commands::runtime_config::RuntimeConfigState::new(
                app_data_dir.clone(),
                bundled_runtime_config_path,
            ));
            app.manage(
                commands::feedback_survey::SessionFeedbackSurveyCooldownState::new(
                    app_data_dir.clone(),
                ),
            );
            // Construct and register the distro bundle up front (goose serve and
            // runtime-config readiness both depend on it). Seeding its bundled
            // skills/agents is filesystem work and is deferred below.
            app.manage(DistroBundleState::new(app.handle()));
            app.manage(bundled_skills::BundledSkillsState::default());
            #[cfg(feature = "block-automations")]
            app.manage(commands::automations::AutomationStreamState::default());
            app.manage(commands::terminal::TerminalState::default());
            app.manage(commands::window_session::WindowSessionRegistry::default());
            app.manage(commands::agent_setup::AgentSetupRegistry::default());
            app.manage(commands::model_setup::ModelSetupRegistry::default());
            app.manage(commands::pocket_voice::PocketVoiceState::default());
            app.manage(commands::siri_voice::SiriVoiceState::default());
            app.manage(commands::openai_audio::OpenAiVoiceState::default());
            app.manage(commands::native_voice::NativeVoiceState::default());
            app.manage(commands::voice_capture::VoiceCaptureState::default());
            app.manage(commands::telemetry::TelemetryAuthState::new(
                app_data_dir.clone(),
            ));
            let (installation_cohort_sender, installation_cohort_state) =
                services::installation_cohort::installation_cohort_channel();
            app.manage(installation_cohort_state);
            let current_layout_exists =
                services::installation_cohort::layout_database_exists(&app_data_dir);
            let legacy_layout_exists = if app.try_state::<services::e2e_mode::E2eMode>().is_some() {
                Ok(false)
            } else {
                services::app_data_migration::legacy_layout_database_exists(app.handle())
            };
            let installation_cohort =
                services::installation_cohort::initialize_installation_cohort(
                    &app_data_dir,
                    current_layout_exists,
                    legacy_layout_exists,
                )
                .unwrap_or_else(|error| {
                    log::warn!("Failed to initialize installation cohort: {error}");
                    services::installation_cohort::InstallationCohort::Unknown
                });
            installation_cohort_sender.send_replace(
                services::installation_cohort::InstallationCohortReadiness::Ready(
                    installation_cohort,
                ),
            );
            let release_channel_state = commands::updates::ReleaseChannelState::load(app.handle())?;
            app.manage(release_channel_state);

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

            #[cfg(all(feature = "block-agent-tools", not(feature = "no-bb-cli-install")))]
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

            // Seed bundled skills and agents from the distro bundle registered
            // above. This touches the filesystem, so it runs after the prompt.
            let e2e_agents_dir = app
                .try_state::<services::e2e_mode::E2eMode>()
                .map(|mode| mode.goose_agents_dir());
            let migrate_bundled_skills_from_home = e2e_agents_dir.is_none();
            {
                let distro_state = app.state::<DistroBundleState>();
                let bundled_skills_state = app
                    .state::<bundled_skills::BundledSkillsState>()
                    .inner()
                    .clone();
                if let Some(bundle) = distro_state.bundle() {
                    let skills_bundle = bundle.clone();
                    let skills_app_data_dir = app_data_dir.clone();
                    tauri::async_runtime::spawn(async move {
                        match bundled_skills::seed_bundled_skills(
                            &skills_bundle,
                            &skills_app_data_dir,
                            migrate_bundled_skills_from_home,
                        ) {
                            Ok(count) if count > 0 => {
                                log::info!("Seeded {count} bundled skill(s)");
                            }
                            Ok(_) => {}
                            Err(error) => log::warn!("Failed to seed bundled skills: {error}"),
                        }
                        bundled_skills_state.mark_ready();
                    });

                    match bundled_agents::seed_bundled_agents(bundle, e2e_agents_dir.as_deref()) {
                        Ok(result) => {
                            if result.seeded_count > 0 {
                                log::info!("Seeded {} bundled agent(s)", result.seeded_count);
                            }
                        }
                        Err(error) => log::warn!("Failed to seed bundled agents: {error}"),
                    }
                } else {
                    bundled_skills_state.mark_ready();
                }
            }
            app.manage(commands::global_shortcut::GlobalShortcutHandlerState::default());

            // Refresh the complete avatar catalog immediately, then every 12
            // hours. Asset verification is content-addressed, so unchanged
            // files remain local while newly published assets are downloaded.
            commands::avatars::spawn_avatar_cache_refresh(app.handle().clone());

            let artifacts_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = commands::artifacts::warm_artifacts_cache(artifacts_app).await {
                    log::warn!("Failed to warm artifact asset cache: {error}");
                }
            });

            // Install or upgrade the Berd-managed ACP bridges (claude, codex)
            // to the latest published version in the background: each floats
            // to `<pkg>@latest` from the private npm registry onto the managed
            // Node runtime in app data; failures are logged and retried next
            // launch while any previously installed version keeps working.
            services::acp_tools_reconciler::spawn_startup_reconcile(app.handle());

            // Surface WKWebView renderer memory and detect silent OOM reaps.
            services::renderer_monitor::start(app.handle().clone());

            attach_main_window_lifecycle(app);

            // Build a custom macOS application menu so that the app submenu,
            // "About" item, and "Quit" item use the product name "Berd"
            // instead of the Cargo binary name.
            #[cfg(target_os = "macos")]
            {
                set_dev_dock_icon();
                refresh_traffic_light_position_on_window_changes(app);

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
            commands::pr_tracker::open_pr_tracker_url,
            commands::pr_tracker::resolve_pr_tracker_projects,
            commands::pr_tracker::list_pr_tracker_pull_requests,
            commands::agents::read_import_persona_file,
            commands::agents::read_import_agent_file,
            commands::agents::read_import_agent_image,
            commands::agents::read_agent_source_file,
            commands::agents::repair_bundled_agent,
            #[cfg(feature = "block-builderbot")]
            commands::auth::auth_status,
            #[cfg(feature = "block-builderbot")]
            commands::auth::start_login,
            #[cfg(feature = "block-builderbot")]
            commands::auth::login,
            #[cfg(feature = "block-builderbot")]
            commands::auth::cancel_login,
            #[cfg(feature = "block-builderbot")]
            commands::auth::logout,
            #[cfg(feature = "block-builderbot")]
            commands::auth::list_auth_workspaces,
            #[cfg(feature = "block-builderbot")]
            commands::auth::switch_auth_workspace,
            commands::avatars::get_avatar_library_snapshot,
            commands::avatars::refresh_avatar_cache,
            commands::avatars::get_cached_avatar_for_ref,
            commands::avatars::get_cached_avatars_for_refs,
            commands::avatars::read_cached_avatar_animation,
            commands::avatars::import_user_avatar_data_url,
            commands::avatars::delete_user_avatar,
            commands::cache::clear_local_media_caches,
            #[cfg(feature = "block-agent-tools")]
            commands::cli::get_bb_cli_status,
            #[cfg(not(feature = "no-bb-cli-install"))]
            #[cfg(feature = "block-agent-tools")]
            commands::cli::install_bb_cli,
            commands::global_shortcut::launch_global_shortcut_handler,
            commands::global_shortcut::stop_global_shortcut_handler,
            #[cfg(feature = "block-managed-connections")]
            commands::connections::list_connections,
            #[cfg(feature = "block-managed-connections")]
            commands::connections::disconnect_connection,
            #[cfg(feature = "block-automations")]
            commands::automations::get_automation_tiles,
            #[cfg(feature = "block-automations")]
            commands::automations::get_automation_tile,
            #[cfg(feature = "block-automations")]
            commands::automations::get_automation_tile_results,
            #[cfg(feature = "block-automations")]
            commands::automations::create_automation_tile,
            #[cfg(feature = "block-automations")]
            commands::automations::push_automation_builder_messages,
            #[cfg(feature = "block-automations")]
            commands::automations::cancel_automation_builder_message,
            #[cfg(feature = "block-automations")]
            commands::automations::start_automation_builder_stream,
            #[cfg(feature = "block-automations")]
            commands::automations::stop_automation_builder_stream,
            #[cfg(feature = "block-automations")]
            commands::automations::update_automation_tile,
            #[cfg(feature = "block-automations")]
            commands::automations::delete_automation_tile,
            #[cfg(feature = "block-automations")]
            commands::automations::refresh_automation_tile,
            #[cfg(feature = "block-automations")]
            commands::automations::generate_automation_schedule,
            #[cfg(feature = "block-automations")]
            commands::automations::get_automation_session_messages,
            #[cfg(feature = "block-builderbot")]
            commands::builderbot::get_builderbot_tasks,
            #[cfg(feature = "block-builderbot")]
            commands::builderbot::get_builderbot_scheduled_triggers,
            #[cfg(feature = "block-builderbot")]
            commands::builderbot::get_builderbot_routing_rules,
            #[cfg(feature = "block-builderbot")]
            commands::builderbot::update_builderbot_scheduled_trigger,
            #[cfg(feature = "block-builderbot")]
            commands::builderbot::update_builderbot_routing_rule,
            commands::telemetry::export_otel_logs,
            commands::telemetry::get_telemetry_resource,
            commands::telemetry::get_telemetry_settings,
            commands::telemetry::set_telemetry_enabled,
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
            #[cfg(feature = "block-feedback")]
            commands::feedback::submit_feedback_issue,
            commands::feedback_survey::claim_session_feedback_survey_cooldown,
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
            commands::pull_requests::get_pull_request_summaries,
            commands::home_widget_media::import_home_widget_photo,
            commands::installation::get_installation_cohort,
            commands::layout::get_layout,
            commands::layout::save_layout_items,
            commands::layout::save_layout_camera,
            commands::layout::reset_layout,
            commands::migration::migration_status,
            commands::migration::backup_goose_config,
            commands::migration::mark_migration_complete,
            commands::migration::mark_legacy_extension_cleanup_complete,
            commands::migration::dismiss_migration_banner,
            commands::message_queues::load_message_queues,
            commands::message_queues::persist_message_queues,
            commands::message_queues::persist_message_queue_updates,
            commands::model_setup::start_model_setup,
            commands::model_setup::get_model_setup_status,
            commands::local_mcp_inventory::list_local_mcp_inventory,
            commands::model_setup::list_model_setup_status,
            commands::model_setup::clear_model_setup_status,
            commands::notifications::show_completion_notification,
            #[cfg(feature = "block-voice-dictation")]
            commands::openai_realtime::get_openai_realtime_status,
            #[cfg(feature = "block-voice-dictation")]
            commands::openai_realtime::create_openai_realtime_session,
            #[cfg(feature = "block-voice-dictation")]
            commands::openai_realtime::claim_voice_dictation_microphone,
            #[cfg(feature = "block-voice-dictation")]
            commands::openai_realtime::release_voice_dictation_microphone,
            commands::agent_setup::start_agent_setup,
            commands::agent_setup::get_agent_setup_status,
            commands::agent_setup::list_agent_setup_status,
            commands::agent_setup::clear_agent_setup_status,
            commands::path_resolver::resolve_path,
            commands::path_resolver::canonicalize_authorized_workspace_directory,
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
            commands::system::save_exported_agent_image,
            commands::system::save_exported_session_file,
            commands::system::save_exported_session_files,
            commands::system::path_exists,
            commands::system::ensure_directory,
            commands::system::list_directory_entries,
            commands::system::inspect_attachment_paths,
            commands::system::search_file_mentions,
            commands::system::read_image_attachment,
            commands::system::read_text_file,
            commands::system::stat_file,
            commands::terminal::start_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::stop_terminal,
            commands::updates::get_release_runtime,
            commands::updates::check_release_update,
            commands::updates::prepare_channel_switch,
            commands::updates::confirm_channel_switch,
            commands::updates::download_and_install_release,
            commands::updates::complete_channel_switch_install,
            commands::updates::cancel_channel_switch,
            commands::updates::finalize_update_relaunch,
            commands::pocket_voice::get_pocket_voice_status,
            commands::pocket_voice::install_voice_model,
            commands::pocket_voice::select_pocket_voice,
            commands::pocket_voice::set_pocket_playback_speed,
            commands::pocket_voice::preview_pocket_voice,
            commands::pocket_voice::speak_pocket_voice,
            commands::pocket_voice::start_pocket_voice_stream,
            commands::pocket_voice::append_pocket_voice_stream,
            commands::pocket_voice::flush_pocket_voice_stream,
            commands::pocket_voice::finish_pocket_voice_stream,
            commands::pocket_voice::stop_pocket_voice,
            commands::pocket_voice::remove_voice_model,
            commands::openai_audio::get_openai_voice_status,
            commands::openai_audio::set_openai_stt_api_key,
            commands::openai_audio::clear_openai_stt_api_key,
            commands::openai_audio::set_openai_tts_api_key,
            commands::openai_audio::clear_openai_tts_api_key,
            commands::openai_audio::start_openai_voice_stream,
            commands::openai_audio::append_openai_voice_stream,
            commands::openai_audio::flush_openai_voice_stream,
            commands::openai_audio::finish_openai_voice_stream,
            commands::openai_audio::stop_openai_voice,
            commands::openai_audio::set_openai_playback_speed,
            commands::siri_voice::get_siri_voice_status,
            commands::siri_voice::select_siri_voice,
            commands::siri_voice::download_siri_voice,
            commands::siri_voice::set_siri_playback_speed,
            commands::siri_voice::preview_siri_voice,
            commands::siri_voice::start_siri_voice_stream,
            commands::siri_voice::append_siri_voice_stream,
            commands::siri_voice::flush_siri_voice_stream,
            commands::siri_voice::finish_siri_voice_stream,
            commands::siri_voice::stop_siri_voice,
            commands::mac_speech::get_mac_speech_status,
            commands::mac_speech::install_mac_speech_model,
            commands::microphone_permission::get_microphone_permission_status,
            commands::microphone_permission::open_microphone_privacy_settings,
            commands::native_voice::get_native_voice_conversation_status,
            commands::native_voice::block_native_voice_conversation_starts,
            commands::native_voice::release_native_voice_conversation_start_block,
            commands::native_voice::set_native_voice_microphone_muted,
            commands::native_voice::set_native_voice_assistant_speaking,
            commands::native_voice::drain_native_voice_conversation_transcripts,
            commands::native_voice::acknowledge_native_voice_conversation_transcript,
            commands::native_voice::reject_native_voice_conversation_transcript,
            commands::native_voice::start_native_voice_conversation,
            commands::native_voice::stop_native_voice_conversation,
            commands::native_voice::stop_native_voice_conversation_for_replacement,
            commands::native_voice::push_native_voice_audio,
            commands::voice_buddy::open_voice_conversation_session,
            commands::voice_buddy::show_voice_conversation_controls,
            commands::voice_buddy::set_voice_conversation_controls_suppressed,
            commands::voice_buddy::stop_voice_conversation_from_buddy,
            commands::notifications::should_suppress_completion_notification,
            commands::voice_capture::register_voice_renderer_instance,
            commands::voice_capture::set_voice_renderer_foreground_session,
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
            commands::agent_skills::list_berd_app_skills,
            commands::skill_marketplace::skill_cli_status,
            commands::skill_marketplace::list_remote_skills,
            commands::skill_marketplace::show_remote_skill,
            commands::skill_marketplace::install_remote_skill,
            commands::workspace_context::load_workspace_context,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Exit => {
                #[cfg(feature = "block-automations")]
                app.state::<commands::automations::AutomationStreamState>()
                    .abort_all();
                app.state::<commands::global_shortcut::GlobalShortcutHandlerState>()
                    .stop();
                app.state::<commands::terminal::TerminalState>().stop_all();
                app.state::<commands::native_voice::NativeVoiceState>()
                    .stop_for_app_exit();
                app.state::<commands::siri_voice::SiriVoiceState>()
                    .stop_for_app_exit();
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

fn attach_main_window_lifecycle(app: &tauri::App) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };

    let app_handle = app.handle().clone();
    main.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            commands::native_voice::handle_voice_owner_window_destroyed(&app_handle, "main");
            return;
        }
        if let WindowEvent::CloseRequested { api, .. } = event {
            let has_secondary_window = app_handle
                .webview_windows()
                .keys()
                .any(|label| label != "main" && label != commands::voice_buddy::WINDOW_LABEL);
            let active_voice_owner_window_label = app_handle
                .state::<commands::native_voice::NativeVoiceState>()
                .active_session_lifecycle_target()
                .map(|(_, owner_window_label, _)| owner_window_label);
            let controls_match_active_voice =
                commands::voice_buddy::matches_active_lifecycle(&app_handle);
            let preserve_for_voice = commands::voice_buddy::should_preserve_main_for_voice(
                active_voice_owner_window_label.as_deref(),
                controls_match_active_voice,
            );
            let stale_controls_cleanup_failed = if !preserve_for_voice {
                commands::voice_buddy::destroy_stale_for_main_close(&app_handle)
                    .inspect_err(|error| {
                        log::error!("Failed to remove stale voice controls on main close: {error}");
                    })
                    .is_err()
            } else {
                false
            };

            if stale_controls_cleanup_failed && !cfg!(target_os = "macos") {
                app_handle.exit(0);
                return;
            }

            let should_preserve = preserve_for_voice
                || (cfg!(target_os = "macos")
                    && (has_secondary_window || stale_controls_cleanup_failed));

            if should_preserve {
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
