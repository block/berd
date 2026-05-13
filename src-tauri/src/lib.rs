mod commands;
mod services;
mod types;

use services::distro_bundle::DistroBundleState;
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};
use tauri::{Manager, RunEvent};
use tauri_plugin_window_state::StateFlags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("perf", log::LevelFilter::Debug)
                .targets([tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                )])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        );

    #[cfg(feature = "app-test-driver")]
    let builder = builder.plugin(tauri_plugin_app_test_driver::init());

    builder
        .setup(|app| {
            app.manage(DistroBundleState::new(app.handle()));
            app.manage(commands::automations::AutomationStreamState::default());

            // Build a custom macOS application menu so that the app submenu,
            // "About" item, and "Quit" item use the capitalised product name
            // "Goose" instead of the lowercase Cargo binary name "goose".
            #[cfg(target_os = "macos")]
            {
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
            commands::doctor::run_doctor,
            commands::doctor::run_doctor_fix,
            commands::git::get_git_state,
            commands::git_changes::get_changed_files,
            commands::git::git_switch_branch,
            commands::git::git_stash,
            commands::git::git_init,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_create_branch,
            commands::git::git_create_worktree,
            commands::model_setup::authenticate_model_provider,
            commands::openai_realtime::get_openai_realtime_status,
            commands::openai_realtime::create_openai_realtime_session,
            commands::agent_setup::check_agent_installed,
            commands::agent_setup::check_agent_auth,
            commands::agent_setup::install_agent,
            commands::agent_setup::authenticate_agent,
            commands::path_resolver::resolve_path,
            commands::distro::get_distro_bundle,
            commands::system::get_home_dir,
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
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                app.state::<commands::automations::AutomationStreamState>()
                    .abort_all();
            }
        });
}
