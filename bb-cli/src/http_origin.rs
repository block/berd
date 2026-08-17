//! Origin binding for the HTTP clients that carry BuilderBot credentials.
//!
//! Our authenticated clients install credentials as *default headers*, which
//! reqwest replays on every redirect hop. reqwest only strips the headers it
//! knows are sensitive (`Authorization`, `Cookie`, ...) when a redirect leaves
//! the origin, so custom headers such as `X-BB-Session-Credential` would
//! otherwise follow a redirect to any host the server names. Every client that
//! sends a credential therefore binds it to the origin it was issued for.

use anyhow::{Context, Result};
use reqwest::redirect::Policy;
use url::Url;

/// Redirect hops an authenticated client follows before giving up. Matches
/// reqwest's own default limit.
pub const MAX_REDIRECTS: usize = 10;

pub fn parse_http_url(value: &str, label: &str) -> Result<Url> {
    let url = Url::parse(value).with_context(|| format!("parse {label} `{value}`"))?;
    ensure_http_url(&url, label)?;
    Ok(url)
}

pub fn ensure_http_url(url: &Url, label: &str) -> Result<()> {
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        anyhow::bail!("{label} must be an absolute HTTP(S) URL: `{url}`");
    }
    Ok(())
}

pub fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

/// Names an origin the way our diagnostics should: scheme, host, and port only,
/// never the path or query, which can carry request-specific data.
pub fn origin_label(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// Follows redirects only within `origin`, so a credential attached as a
/// default header can never leave the host it was issued for.
pub fn same_origin_redirect_policy(origin: Url) -> Policy {
    same_origin_redirect_policy_with(origin, |_| {
        "refusing authenticated cross-origin redirect".to_string()
    })
}

/// [`same_origin_redirect_policy`] with a caller-supplied description of the
/// refusal. `describe_refusal` receives the redirect target so the caller can
/// explain the specific hop, which reqwest's redirect error cannot: it reports
/// the URL the redirect came *from*, not the one we declined to follow.
pub fn same_origin_redirect_policy_with<F>(origin: Url, describe_refusal: F) -> Policy
where
    F: Fn(&Url) -> String + Send + Sync + 'static,
{
    Policy::custom(move |attempt| {
        if attempt.previous().len() > MAX_REDIRECTS {
            attempt.error("too many redirects")
        } else if same_origin(attempt.url(), &origin) {
            attempt.follow()
        } else {
            let refusal = describe_refusal(attempt.url());
            attempt.error(refusal)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).expect("parse test URL")
    }

    #[test]
    fn same_origin_compares_scheme_host_and_effective_port() {
        assert!(same_origin(
            &url("https://kgoose.sqprod.co/a"),
            &url("https://kgoose.sqprod.co:443/b")
        ));
        assert!(!same_origin(
            &url("http://kgoose.sqprod.co/a"),
            &url("https://kgoose.sqprod.co/a")
        ));
        assert!(!same_origin(
            &url("https://kgoose.sqprod.co/a"),
            &url("https://evil.example.com/a")
        ));
        assert!(!same_origin(
            &url("http://127.0.0.1:1234/a"),
            &url("http://127.0.0.1:4321/a")
        ));
    }

    #[test]
    fn origin_label_omits_path_and_query() {
        assert_eq!(
            origin_label(&url("https://kgoose.sqprod.co/v3/call-tool?token=secret")),
            "https://kgoose.sqprod.co"
        );
        assert_eq!(
            origin_label(&url("http://127.0.0.1:8080/v3")),
            "http://127.0.0.1:8080"
        );
    }

    #[test]
    fn ensure_http_url_rejects_non_http_schemes_and_hostless_urls() {
        assert!(ensure_http_url(&url("https://example.com"), "test URL").is_ok());
        assert!(ensure_http_url(&url("file:///etc/passwd"), "test URL").is_err());
        assert!(parse_http_url("not a url", "test URL").is_err());
    }
}
