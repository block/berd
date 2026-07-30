use anyhow::Result;
use clap::ArgMatches;

use super::skills_api::{exit_codes, failure, failure_info, SilentJsonExit};
use super::skills_config::SkillsConfig;

pub fn ensure_org_configured(config: &SkillsConfig) -> Result<()> {
    if config.local_dev || config.org.is_some() {
        return Ok(());
    }
    Err(missing_org_error())
}

pub fn missing_org_error() -> anyhow::Error {
    failure(
        exit_codes::AUTH_REQUIRED,
        "org_required",
        "bb org is not configured; run `bb auth login` or `bb config set org <org>`",
    )
}

pub fn run(
    matches: &ArgMatches,
    dispatch: fn(&SkillsConfig, &ArgMatches) -> Result<()>,
) -> Result<()> {
    let config = SkillsConfig::resolve(matches)?;
    run_resolved(&config, matches, dispatch)
}

pub fn run_for_config(
    matches: &ArgMatches,
    dispatch: fn(&SkillsConfig, &ArgMatches) -> Result<()>,
) -> Result<()> {
    let config = SkillsConfig::resolve_for_config(matches)?;
    run_resolved(&config, matches, dispatch)
}

fn run_resolved(
    config: &SkillsConfig,
    matches: &ArgMatches,
    dispatch: fn(&SkillsConfig, &ArgMatches) -> Result<()>,
) -> Result<()> {
    match dispatch(config, matches) {
        Ok(()) => Ok(()),
        Err(error) if config.json => {
            let (exit_code, payload) = failure_info(&error);
            eprintln!("{payload}");
            Err(anyhow::Error::new(SilentJsonExit(exit_code)))
        }
        Err(error) => Err(error),
    }
}
