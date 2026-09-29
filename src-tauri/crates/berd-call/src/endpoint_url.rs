//! URL policy shared by saved voice endpoints and `berd-call` overrides.

use reqwest::Url;

#[derive(Clone, Copy)]
pub enum EndpointProtocol {
    WebSocket,
    Http,
}

pub fn is_allowed_endpoint_url(url: &Url, protocol: EndpointProtocol) -> bool {
    let scheme_allowed = match protocol {
        EndpointProtocol::WebSocket => matches!(url.scheme(), "ws" | "wss"),
        EndpointProtocol::Http => matches!(url.scheme(), "http" | "https"),
    };
    let loopback = url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    scheme_allowed
        && url.host_str().is_some()
        && (!matches!(url.scheme(), "http" | "ws") || loopback)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_protocol_and_loopback_policy() {
        assert!(is_allowed_endpoint_url(
            &Url::parse("ws://[::1]:18870/realtime").unwrap(),
            EndpointProtocol::WebSocket,
        ));
        assert!(is_allowed_endpoint_url(
            &Url::parse("http://localhost:18870/speech").unwrap(),
            EndpointProtocol::Http,
        ));
        for raw in [
            "http://example.test/speech",
            "http://user@example.test/speech",
            "https://example.test/speech#fragment",
        ] {
            assert!(!is_allowed_endpoint_url(
                &Url::parse(raw).unwrap(),
                EndpointProtocol::Http,
            ));
        }
        assert!(!is_allowed_endpoint_url(
            &Url::parse("https://example.test/speech").unwrap(),
            EndpointProtocol::WebSocket,
        ));
    }
}
