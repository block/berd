use serde::{Deserialize, Serialize};

/// One `bb config` preference key. [`PREFERENCE_KEYS`] is the single source
/// of truth for the key list: `bb config` builds its help text and
/// unknown-key errors from it.
pub struct PreferenceKeySpec {
    pub key: &'static str,
    pub help: &'static str,
}

/// Keep in sync with the fields of [`BuilderBotPreferences`] below.
pub const PREFERENCE_KEYS: &[PreferenceKeySpec] = &[
    PreferenceKeySpec {
        key: "org",
        help: "Org used for access",
    },
    PreferenceKeySpec {
        key: "targets",
        help: "comma-separated default install targets (default: agents)",
    },
    PreferenceKeySpec {
        key: "install_strategy",
        help: "symlink | copy (default: symlink)",
    },
    PreferenceKeySpec {
        key: "no_auto_updates",
        help: "true | false (default: false)",
    },
];

/// User preferences stored in `~/.bb/config.yaml`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BuilderBotPreferences {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_strategy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_auto_updates: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drift guard for PREFERENCE_KEYS: the exhaustive struct literal stops
    /// compiling when a BuilderBotPreferences field is added, and the
    /// assertions catch a missing or stale key entry.
    #[test]
    fn preference_keys_match_builderbot_preferences_fields() {
        let populated = BuilderBotPreferences {
            org: Some("test".to_string()),
            targets: vec!["agents".to_string()],
            install_strategy: Some("symlink".to_string()),
            no_auto_updates: Some(false),
        };
        let yaml = serde_yaml::to_value(&populated).expect("serialize preferences");
        let fields = yaml
            .as_mapping()
            .expect("preferences serialize to a mapping")
            .keys()
            .map(|key| key.as_str().expect("string key").to_string())
            .collect::<Vec<_>>();
        let keys = PREFERENCE_KEYS
            .iter()
            .map(|spec| spec.key)
            .collect::<Vec<_>>();
        for field in &fields {
            assert!(
                keys.contains(&field.as_str()),
                "BuilderBotPreferences field `{field}` is missing from PREFERENCE_KEYS"
            );
        }
        for key in &keys {
            assert!(
                fields.iter().any(|field| field == key),
                "PREFERENCE_KEYS entry `{key}` has no BuilderBotPreferences field"
            );
        }
    }
}
