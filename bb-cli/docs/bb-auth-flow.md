# BuilderBot Auth Flow

This is the intended browser-mediated CLI login flow. Web and CLI can use the same backend Auth0 login path, but the resulting credentials are typed and presented differently.

```mermaid
sequenceDiagram
    participant CLI
    participant Browser as User Browser
    participant Backend
    participant Auth0
    participant Store as Backend Data Store

    CLI->>CLI: Start 127.0.0.1 callback server and generate state + PKCE verifier
    CLI->>Browser: Open /v1/auth/login?type=cli&returnTo=...&state=...&code_challenge=...&code_challenge_method=S256
    Browser->>Backend: Begin correlated CLI login
    Backend->>Store: Store AuthTransaction with client state + PKCE challenge
    Backend-->>Browser: Set oauth state cookie, 302 to Auth0 authorize
    Browser->>Auth0: Complete Auth0 login
    Auth0-->>Browser: 302 to configured /v1/auth/callback with code and state
    Browser->>Backend: GET /v1/auth/callback with oauth state cookie
    Backend->>Auth0: Exchange code using stored PKCE verifier
    Auth0-->>Backend: ID/access token response
    Backend->>Store: Create short-lived code bound to client PKCE challenge
    Backend-->>Browser: 302 to 127.0.0.1 callback with code + client state
    Browser->>CLI: GET /callback?code=...&state=...
    CLI->>CLI: Compare state before accepting code
    CLI->>Backend: POST /v1/auth/login/exchange { code, code_verifier }
    Backend->>Store: Atomically verify challenge, expiry, and one-time use
    Backend->>Store: Create cli session credential
    Backend-->>CLI: Return cli session credential
    CLI->>Backend: API request with X-BB-Session-Credential: <cli session>
```

Security constraints:

- Web sessions are returned as secure cookies and accepted only as cookies.
- CLI sessions are returned by the exchange endpoint and accepted only via the `X-BB-Session-Credential` header.
- Durable session credentials are never placed in redirect URLs.
- The localhost redirect carries only a short-lived, single-use exchange code.
- The loopback callback accepts only `GET` requests to the exact callback path.
- Every CLI attempt uses independent high-entropy state and PKCE S256 material.
- Missing, malformed, wrong, stale, replayed, and cross-attempt callbacks are rejected without stopping the valid listener.
- The verifier is sent only to the exchange endpoint and is cleared with the attempt on success, failure, or cancellation.
- CLI `returnTo` targets must be `http://127.0.0.1:<port>` URLs without userinfo, query, or fragment.
