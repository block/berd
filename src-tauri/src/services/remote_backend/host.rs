//! Validated SSH destination parsing.
//!
//! Everything the renderer sends is treated as untrusted. A destination is
//! accepted only when it is an exact alias from the user's parsed ssh config,
//! or matches a strict `[user@]host[:port]` shape. The strictness exists to
//! keep option injection (`-oProxyCommand=...`) and shell metacharacters out
//! of the ssh argv; the destination is always passed as its own argv element
//! after `--`, and the port always via `-p`.

use super::error::{RemoteBackendError, RemoteBackendErrorKind};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteHostSpec {
    destination: String,
    port: Option<u16>,
}

impl RemoteHostSpec {
    /// The `[user@]host` string handed to ssh as the destination argv element.
    pub fn destination(&self) -> &str {
        &self.destination
    }

    /// Explicit port for `-p`, when the input carried one.
    pub fn port(&self) -> Option<u16> {
        self.port
    }

    /// Stable registry key for this host as the user expressed it.
    pub fn key(&self) -> String {
        match self.port {
            Some(port) => format!("{}:{port}", self.destination),
            None => self.destination.clone(),
        }
    }

    pub fn parse(input: &str, known_aliases: &[String]) -> Result<Self, RemoteBackendError> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(invalid("host must not be empty"));
        }
        if trimmed.len() > 255 {
            return Err(invalid("host is too long"));
        }
        if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(invalid(
                "host must not contain whitespace or control characters",
            ));
        }
        const FORBIDDEN: &[char] = &['\'', '"', '`', ';', '$', '\\', '=', '|', '&', '<', '>'];
        if trimmed.contains(FORBIDDEN) {
            return Err(invalid("host contains forbidden characters"));
        }
        if trimmed.starts_with('-') {
            return Err(invalid("host must not start with '-'"));
        }

        // An exact ssh-config alias wins verbatim (aliases can contain shapes
        // our fallback grammar rejects, e.g. uncommon characters).
        if known_aliases.iter().any(|alias| alias == trimmed) {
            return Ok(Self {
                destination: trimmed.to_string(),
                port: None,
            });
        }

        let (user, rest) = match trimmed.split_once('@') {
            Some((user, rest)) => (Some(user), rest),
            None => (None, trimmed),
        };

        if let Some(user) = user {
            if user.is_empty() {
                return Err(invalid("user must not be empty"));
            }
            if user.starts_with('-') {
                return Err(invalid("user must not start with '-'"));
            }
            if !user
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            {
                return Err(invalid("user contains unsupported characters"));
            }
        }

        let (host, port) = split_host_port(rest)?;
        if host.is_empty() {
            return Err(invalid("host must not be empty"));
        }
        if host.starts_with('-') {
            return Err(invalid("host must not start with '-'"));
        }
        let host_ok = if host.starts_with('[') && host.ends_with(']') {
            // Bracketed IPv6 literal.
            host[1..host.len() - 1]
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':')
        } else {
            host.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        };
        if !host_ok {
            return Err(invalid("host contains unsupported characters"));
        }

        let destination = match user {
            Some(user) => format!("{user}@{host}"),
            None => host.to_string(),
        };
        Ok(Self { destination, port })
    }
}

fn split_host_port(rest: &str) -> Result<(&str, Option<u16>), RemoteBackendError> {
    // Bracketed IPv6 may carry a port after the bracket: [::1]:2222.
    if let Some(bracket_end) = rest.find(']') {
        let host = &rest[..=bracket_end];
        let tail = &rest[bracket_end + 1..];
        if tail.is_empty() {
            return Ok((host, None));
        }
        let port = tail
            .strip_prefix(':')
            .ok_or_else(|| invalid("unexpected characters after IPv6 literal"))?;
        return Ok((host, Some(parse_port(port)?)));
    }

    match rest.split_once(':') {
        Some((host, port)) => Ok((host, Some(parse_port(port)?))),
        None => Ok((rest, None)),
    }
}

fn parse_port(port: &str) -> Result<u16, RemoteBackendError> {
    let parsed: u16 = port
        .parse()
        .map_err(|_| invalid("port must be a number between 1 and 65535"))?;
    if parsed == 0 {
        return Err(invalid("port must be a number between 1 and 65535"));
    }
    Ok(parsed)
}

fn invalid(message: &str) -> RemoteBackendError {
    RemoteBackendError::new(RemoteBackendErrorKind::InvalidHost, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aliases(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn accepts_known_alias_verbatim() {
        let spec = RemoteHostSpec::parse("devbox", &aliases(&["devbox"])).unwrap();
        assert_eq!(spec.destination(), "devbox");
        assert_eq!(spec.port(), None);
    }

    #[test]
    fn accepts_user_host_and_port() {
        let spec = RemoteHostSpec::parse("damien@dev.example.com:2222", &[]).unwrap();
        assert_eq!(spec.destination(), "damien@dev.example.com");
        assert_eq!(spec.port(), Some(2222));
        assert_eq!(spec.key(), "damien@dev.example.com:2222");
    }

    #[test]
    fn accepts_bracketed_ipv6_with_port() {
        let spec = RemoteHostSpec::parse("[::1]:2222", &[]).unwrap();
        assert_eq!(spec.destination(), "[::1]");
        assert_eq!(spec.port(), Some(2222));
    }

    #[test]
    fn rejects_option_injection() {
        for input in [
            "-oProxyCommand=evil",
            "-v",
            "user@-oProxyCommand=evil",
            "-@host",
        ] {
            assert!(
                RemoteHostSpec::parse(input, &[]).is_err(),
                "should reject {input}"
            );
        }
    }

    #[test]
    fn rejects_shell_metacharacters_and_whitespace() {
        for input in [
            "host;rm -rf /",
            "host command",
            "host\ncommand",
            "host$(x)",
            "host`x`",
            "host|x",
            "host&x",
            "host>x",
            "a=b",
            "user name@host",
        ] {
            assert!(
                RemoteHostSpec::parse(input, &[]).is_err(),
                "should reject {input:?}"
            );
        }
    }

    #[test]
    fn rejects_bad_ports() {
        assert!(RemoteHostSpec::parse("host:0", &[]).is_err());
        assert!(RemoteHostSpec::parse("host:65536", &[]).is_err());
        assert!(RemoteHostSpec::parse("host:abc", &[]).is_err());
    }

    #[test]
    fn rejects_empty_and_oversized() {
        assert!(RemoteHostSpec::parse("", &[]).is_err());
        assert!(RemoteHostSpec::parse("   ", &[]).is_err());
        let long = "a".repeat(256);
        assert!(RemoteHostSpec::parse(&long, &[]).is_err());
    }

    #[test]
    fn alias_lookup_does_not_bypass_forbidden_characters() {
        // Even a hostile alias list cannot smuggle metacharacters through.
        assert!(RemoteHostSpec::parse("evil;alias", &aliases(&["evil;alias"])).is_err());
        assert!(RemoteHostSpec::parse("-evil", &aliases(&["-evil"])).is_err());
    }
}
