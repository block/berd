# BuilderBot Auth Flow

This is the intended browser-mediated CLI login flow. Web and CLI can use the same backend Auth0 login path, but the resulting credentials are typed and presented differently.

```mermaid
sequenceDiagram
    participant CLI
    participant Browser as User Browser
    participant Backend
    participant Auth0
    participant Store as Backend Data Store

    CLI->>CLI: Start localhost callback server
    CLI->>Browser: Open /auth/login?type=cli&returnTo=http://127.0.0.1:<port>/callback
    Browser->>Backend: Begin CLI login
    Backend->>Store: Store AuthTransaction with type=cli and loopback returnTo
    Backend-->>Browser: Set oauth state cookie, 302 to Auth0 authorize
    Browser->>Auth0: Complete Auth0 login
    Auth0-->>Browser: 302 to configured /auth/callback with code and state
    Browser->>Backend: GET /auth/callback with oauth state cookie
    Backend->>Auth0: Exchange code using stored PKCE verifier
    Auth0-->>Backend: ID/access token response
    Backend->>Store: Create short-lived one-time code for CLI login
    Backend-->>Browser: 302 to localhost callback with code
    Browser->>CLI: GET /callback?code=...
    CLI->>Backend: POST /auth/login/exchange { code }
    Backend->>Store: Verify code is valid, unused, unexpired, and type=cli
    Backend->>Store: Create cli session credential
    Backend-->>CLI: Return cli session credential
    CLI->>Backend: API request with X-BB-Session-Credential: <cli session>
```

Security constraints:

- Web sessions are returned as secure cookies and accepted only as cookies.
- CLI sessions are returned by the exchange endpoint and accepted only via the `X-BB-Session-Credential` header.
- Durable session credentials are never placed in redirect URLs.
- The localhost redirect carries only a short-lived, single-use exchange code.
- CLI `returnTo` targets must be loopback URLs.
