//! `bb skills doctor`: independent diagnostic probes with optional repair.
//!
//! Every probe reports pass/warn/fail independently — the doctor never aborts
//! because one probe (like server reachability) failed; that is exactly when
//! diagnostics matter most.

use std::fs;

use anyhow::Result;
use serde::Serialize;
use serde_json::{json, Value};

use super::skills_api::MarketplaceClient;
use super::skills_config::{kgoose_service_url, SkillsConfig, SkillsFileConfig};
use super::skills_install::{find_orphaned_work_dirs, link_targets, read_installed};
use super::skills_models::{CapabilitiesResponse, InstalledSkillMetadata, MeResponse};
use super::skills_targets::{inspect_link, LinkState, Scope, TargetRegistry};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Debug, Serialize)]
pub struct Check {
    pub name: &'static str,
    pub status: CheckStatus,
    pub detail: String,
}

#[derive(Debug, Default)]
pub struct DoctorReport {
    pub checks: Vec<Check>,
    pub fixed: Vec<String>,
}

impl DoctorReport {
    fn add(&mut self, name: &'static str, status: CheckStatus, detail: impl Into<String>) {
        self.checks.push(Check {
            name,
            status,
            detail: detail.into(),
        });
    }

    pub fn ok(&self) -> bool {
        self.checks
            .iter()
            .all(|check| check.status != CheckStatus::Fail)
    }
}

pub fn run_doctor(config: &SkillsConfig, fix: bool) -> Result<(DoctorReport, Value)> {
    let mut report = DoctorReport::default();

    // Config file parses and the selected profile exists.
    match SkillsFileConfig::read(&config.config_path) {
        Ok(file_config) => {
            report.add(
                "config_file",
                CheckStatus::Pass,
                format!("parsed {}", config.config_path.display()),
            );
            if file_config.profiles.contains_key(&config.profile)
                || config.profile == super::skills_config::DEFAULT_PROFILE_NAME
            {
                report.add("profile", CheckStatus::Pass, config.profile.clone());
            } else {
                report.add(
                    "profile",
                    CheckStatus::Warn,
                    format!(
                        "profile `{}` is not defined in {}",
                        config.profile,
                        config.config_path.display()
                    ),
                );
            }
        }
        Err(err) => {
            report.add("config_file", CheckStatus::Fail, format!("{err:#}"));
            report.add("profile", CheckStatus::Warn, "skipped: config unreadable");
        }
    }

    // Server reachable + capabilities, distinguishing auth failures from the
    // server being down.
    let mut registry_from_server: Option<TargetRegistry> = None;
    let service_url = kgoose_service_url(&config.kgoose_base_url, &config.kgoose_service_path);
    match MarketplaceClient::new(config) {
        Ok(client) => {
            if client.has_auth() {
                report.add("auth", CheckStatus::Pass, "stored CLI auth session");
            } else {
                report.add("auth", CheckStatus::Warn, "no stored CLI auth session");
            }
            match client.get_json::<CapabilitiesResponse>("/v1/marketplace/capabilities") {
                Ok(capabilities) => {
                    report.add("server", CheckStatus::Pass, service_url.clone());
                    if capabilities.target_registry.is_empty() {
                        report.add(
                            "capabilities",
                            CheckStatus::Warn,
                            "server returned an empty target registry",
                        );
                    } else {
                        report.add(
                            "capabilities",
                            CheckStatus::Pass,
                            format!(
                                "targets: {}",
                                capabilities
                                    .target_registry
                                    .keys()
                                    .cloned()
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ),
                        );
                        registry_from_server = Some(TargetRegistry {
                            targets: capabilities.target_registry,
                            source: "server",
                        });
                    }
                }
                Err(err) => {
                    let message = format!("{err:#}");
                    let status_check = if message.contains("401") || message.contains("403") {
                        ("auth", "server reachable but credentials were rejected")
                    } else {
                        ("unreachable", "server unreachable")
                    };
                    report.add(
                        "server",
                        CheckStatus::Fail,
                        format!("{} ({}): {message}", status_check.1, service_url),
                    );
                    report.add(
                        "capabilities",
                        CheckStatus::Warn,
                        "skipped: server check failed",
                    );
                }
            }
            // Authenticated identity, only meaningful when a session credential resolved.
            if client.has_auth() {
                match client.get_json::<MeResponse>("/v1/marketplace/me") {
                    Ok(me) => report.add(
                        "identity",
                        CheckStatus::Pass,
                        format!("{} @ {}", me.subject, me.tenant_id),
                    ),
                    Err(err) => report.add("identity", CheckStatus::Fail, format!("{err:#}")),
                }
            }
        }
        Err(err) => {
            report.add("server", CheckStatus::Fail, format!("{err:#}"));
        }
    }

    // Packages dir exists/writable.
    let packages_dir = config.packages_dir();
    if packages_dir.is_dir() {
        let probe = packages_dir.join(".bb-doctor-probe");
        match fs::write(&probe, b"probe") {
            Ok(()) => {
                let _ = fs::remove_file(&probe);
                report.add(
                    "packages_dir",
                    CheckStatus::Pass,
                    format!("writable: {}", packages_dir.display()),
                );
            }
            Err(err) => report.add(
                "packages_dir",
                CheckStatus::Fail,
                format!("not writable: {err}"),
            ),
        }
    } else if fix {
        match fs::create_dir_all(&packages_dir) {
            Ok(()) => {
                report
                    .fixed
                    .push(format!("created {}", packages_dir.display()));
                report.add(
                    "packages_dir",
                    CheckStatus::Pass,
                    format!("created: {}", packages_dir.display()),
                );
            }
            Err(err) => report.add("packages_dir", CheckStatus::Fail, format!("{err}")),
        }
    } else {
        report.add(
            "packages_dir",
            CheckStatus::Warn,
            format!(
                "missing: {} (run `bb skills doctor --fix` or install a skill)",
                packages_dir.display()
            ),
        );
    }

    // Per-package metadata parses.
    let installed: Vec<InstalledSkillMetadata> = match read_installed(config, Scope::Global) {
        Ok(installed) => {
            report.add(
                "metadata",
                CheckStatus::Pass,
                format!("{} installed skill(s) parsed", installed.len()),
            );
            installed
        }
        Err(err) => {
            report.add("metadata", CheckStatus::Fail, format!("{err:#}"));
            Vec::new()
        }
    };

    // Target links point at the canonical packages.
    let registry = registry_from_server.unwrap_or_else(|| TargetRegistry::load_offline(config));
    let mut link_problems = Vec::new();
    let mut relinked = 0usize;
    for meta in &installed {
        let package_dir = config.packages_dir().join(&meta.slug);
        let Ok(resolved) = registry.resolve(&meta.targets, Scope::Global) else {
            link_problems.push(format!(
                "{}: targets {:?} not in registry",
                meta.slug, meta.targets
            ));
            continue;
        };
        for target in &resolved {
            for base_dir in &target.base_dirs {
                let link_path = base_dir.join(&meta.slug);
                match inspect_link(&link_path, &package_dir) {
                    LinkState::Ok => {}
                    LinkState::Unmanaged => link_problems.push(format!(
                        "{}: {} exists but is unmanaged",
                        meta.slug,
                        link_path.display()
                    )),
                    LinkState::Missing | LinkState::Broken => {
                        if fix {
                            match link_targets(
                                &package_dir,
                                std::slice::from_ref(target),
                                &meta.slug,
                            ) {
                                Ok(_) => relinked += 1,
                                Err(err) => link_problems.push(format!(
                                    "{}: could not repair {}: {err:#}",
                                    meta.slug,
                                    link_path.display()
                                )),
                            }
                        } else {
                            link_problems.push(format!(
                                "{}: {} is missing or broken",
                                meta.slug,
                                link_path.display()
                            ));
                        }
                    }
                }
            }
        }
    }
    if relinked > 0 {
        report
            .fixed
            .push(format!("re-linked {relinked} target link(s)"));
    }
    if link_problems.is_empty() {
        report.add(
            "target_links",
            CheckStatus::Pass,
            format!("checked against {} registry", registry.source),
        );
    } else {
        report.add("target_links", CheckStatus::Warn, link_problems.join("; "));
    }

    // Orphaned staging/backup directories from crashed installs.
    let orphans = find_orphaned_work_dirs(&packages_dir);
    if orphans.is_empty() {
        report.add("orphaned_dirs", CheckStatus::Pass, "none");
    } else if fix {
        let mut removed = 0usize;
        for orphan in &orphans {
            if fs::remove_dir_all(orphan).is_ok() {
                removed += 1;
            }
        }
        report
            .fixed
            .push(format!("removed {removed} orphaned staging/backup dir(s)"));
        report.add(
            "orphaned_dirs",
            CheckStatus::Pass,
            format!("removed {removed}"),
        );
    } else {
        report.add(
            "orphaned_dirs",
            CheckStatus::Warn,
            format!(
                "{} leftover staging/backup dir(s); run `bb skills doctor --fix`",
                orphans.len()
            ),
        );
    }

    // Stable JSON shape: a checklist array plus the resolved configuration,
    // so CI and agents can assert on it.
    let payload = json!({
        "ok": report.ok(),
        "local_dev": config.local_dev,
        "profile": config.profile,
        "config_path": config.config_path,
        "kgoose_base_url": config.kgoose_base_url,
        "kgoose_service_path": config.kgoose_service_path,
        "bb_home": config.bb_home,
        "bb_skills_home": config.skills_home,
        "installed_count": installed.len(),
        "checks": report.checks,
        "fixed": report.fixed,
    });
    Ok((report, payload))
}
