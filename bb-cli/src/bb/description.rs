use clap::Command;
use serde_json::{json, Value};

pub fn describe_command_tree(command: &Command) -> Value {
    let commands = command
        .get_subcommands()
        .filter(|subcommand| !subcommand.is_hide_set())
        .map(describe_command_tree)
        .collect::<Vec<_>>();
    let mut value = json!({
        "name": command.get_name(),
        "summary": command
            .get_about()
            .map(|about| about.to_string())
            .unwrap_or_default(),
    });
    if !commands.is_empty() {
        value["commands"] = json!(commands);
    }
    value
}
