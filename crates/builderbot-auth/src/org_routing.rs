use anyhow::{Context, Result};
use url::{Host, Url};

use crate::config::normalize_kgoose_base_url_with_service_path;
#[cfg(test)]
use crate::config::DEFAULT_KGOOSE_SERVICE_PATH;

pub fn normalize_org(value: &str) -> Result<String> {
    let org = value.trim().to_ascii_lowercase();
    if org.is_empty() {
        anyhow::bail!("org cannot be empty");
    }
    let valid_chars = org
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid_chars || org.starts_with('-') || org.ends_with('-') {
        anyhow::bail!(
            "org must contain only lowercase ASCII letters, numbers, and hyphens, with no leading or trailing hyphen"
        );
    }
    Ok(org)
}

pub fn resolve_org_kgoose_base_url(
    base_url: &str,
    org: Option<&str>,
    local_dev: bool,
    service_path: &str,
) -> Result<String> {
    let base_url = normalize_kgoose_base_url_with_service_path(base_url, service_path);
    if local_dev {
        return Ok(base_url);
    }

    let Some(org) = org else {
        return Ok(base_url);
    };

    let org = normalize_org(org)?;
    let absolute = if base_url.contains("://") {
        base_url
    } else {
        format!("https://{base_url}")
    };
    let mut url = Url::parse(&absolute).context("kGoose base URL must be absolute")?;
    match url.host() {
        Some(Host::Domain(host)) if !is_loopback_domain(host) => {
            let routed_host = if host.starts_with(&format!("{org}.")) {
                host.to_string()
            } else {
                format!("{org}.{host}")
            };
            url.set_host(Some(&routed_host))
                .map_err(|_| anyhow::anyhow!("failed to route kGoose base URL for org"))?;
        }
        Some(Host::Domain(_)) | Some(Host::Ipv4(_)) | Some(Host::Ipv6(_)) => {}
        None => anyhow::bail!("kGoose base URL must include a host"),
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn is_loopback_domain(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_org_kgoose_base_url_routes_domain_base() {
        let routed = resolve_org_kgoose_base_url(
            "https://blockstaging.build",
            Some("test"),
            false,
            DEFAULT_KGOOSE_SERVICE_PATH,
        )
        .expect("route URL");

        assert_eq!(routed, "https://test.blockstaging.build");
    }

    #[test]
    fn resolve_org_kgoose_base_url_adds_scheme_when_missing() {
        let routed = resolve_org_kgoose_base_url(
            "blockstaging.build",
            Some("test"),
            false,
            DEFAULT_KGOOSE_SERVICE_PATH,
        )
        .expect("route URL");

        assert_eq!(routed, "https://test.blockstaging.build");
    }

    #[test]
    fn resolve_org_kgoose_base_url_keeps_already_routed_host() {
        let routed = resolve_org_kgoose_base_url(
            "https://test.blockstaging.build",
            Some("test"),
            false,
            DEFAULT_KGOOSE_SERVICE_PATH,
        )
        .expect("route URL");

        assert_eq!(routed, "https://test.blockstaging.build");
    }

    #[test]
    fn resolve_org_kgoose_base_url_keeps_loopback_hosts_unrouted() {
        let routed = resolve_org_kgoose_base_url(
            "http://127.0.0.1:5173",
            Some("test"),
            false,
            DEFAULT_KGOOSE_SERVICE_PATH,
        )
        .expect("route URL");

        assert_eq!(routed, "http://127.0.0.1:5173");
    }

    #[test]
    fn resolve_org_kgoose_base_url_skips_routing_without_org() {
        let routed = resolve_org_kgoose_base_url(
            "blockstaging.build",
            None,
            false,
            DEFAULT_KGOOSE_SERVICE_PATH,
        )
        .expect("resolve URL");

        assert_eq!(routed, "blockstaging.build");
    }

    #[test]
    fn resolve_org_kgoose_base_url_strips_custom_service_path() {
        let routed = resolve_org_kgoose_base_url(
            "https://blockstaging.build/cash-app/goose-square/",
            Some("test"),
            false,
            "/cash-app/goose-square",
        )
        .expect("route URL");

        assert_eq!(routed, "https://test.blockstaging.build");
    }

    #[test]
    fn normalize_org_cleans_and_validates() {
        assert_eq!(
            normalize_org(" Test-Org \n").expect("normalize"),
            "test-org"
        );
        assert!(normalize_org("-bad").is_err());
        assert!(normalize_org("bad_underscore").is_err());
    }
}
