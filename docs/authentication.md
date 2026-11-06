# Authentication

The current hackathon integration uses the dedicated **`/integrations/voice` API**
and an organizer-issued team secret. Start with [the voice integration guide](voice-integration.md)
for access, caller identity, routes, payloads and idempotent writes. No Auth0 login
or token refresh is needed for that integration.

The JavaScript starter has not yet been migrated. Its existing endpoints and
Auth0 implementation are documented below for reference.

<details>
<summary>Legacy Auth0 authentication (existing starter code)</summary>

# Authentication

## Team setup

Use the supplied staging Auth0 configuration and your staging passenger account. After running `npm run setup`, fill in `.env`:

- `AUTH0_DOMAIN`: the supplied hostname, without `https://`.
- `AUTH0_CLIENT_ID`: the supplied public client ID.
- `AUTH0_AUDIENCE`: the exact supplied API audience.
- `AUTH0_REDIRECT_URI`: keep `http://localhost:3000/callback` for local development. A hosted callback must be registered before use.

The starter uses PKCE and needs **no client secret**. Keep passwords, tokens and your generated `STARTER_API_KEY` out of commits.

## Team: what happens

1. Run the starter and open `http://localhost:3000`.
2. Supply the team key and start login. The server creates a random state and PKCE verifier/challenge. An HttpOnly, SameSite cookie binds the callback to this browser.
3. Auth0 authenticates the staging passenger in the browser. Passwords never pass through the starter.
4. The callback exchanges the code with its PKCE verifier, requesting `openid profile email offline_access` during authorization.
5. The server keeps the access token and rotating refresh token **only in memory**.
6. On API calls within 30 seconds of expiry, the server exchanges the refresh token and replaces both tokens. Concurrent requests share a single refresh operation.

A refresh request goes to Auth0, not mobie:

```http
POST https://<AUTH0_DOMAIN>/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&client_id=<CLIENT_ID>&refresh_token=<LATEST_REFRESH_TOKEN>
```

This is already implemented. Never keep using an old rotating refresh token. If an exchange fails or its result is lost, the starter requires a fresh login rather than retrying a possibly consumed token. `expires_in` controls expiry; do not assume all tokens last 24 hours.

The access token is passed to mobie as `Authorization: Bearer ...`; an ID token or a machine-to-machine token is not a substitute for a staging user's API access token. The starter does not use ID-token claims to identify users: the mobie resource server validates the access token and resolves the user.

## Sessions and deployment

There is one test passenger session per process. All phone calls use that account. There is no automatic mapping from caller phone number to user identity, and no database/session persistence. Restarting, watching/reloading code, or logging out clears the session. Use one process/replica per team; multiple replicas would need shared token storage and refresh coordination.

`POST /api/logout` clears local credentials; it does not revoke the Auth0 grant or log the browser out of Auth0. A subsequent login uses `prompt=login`.

The team key gates the starter API and the start of login. Do not put it in URLs or public screenshots. The callback is validated using state and the browser cookie. Use HTTPS for any public deployment, and configure the exact public callback. No cross-origin browser API access is enabled; phone platforms call server-to-server.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Callback URL mismatch | Exact protocol, hostname, port and `/callback` match the registered URL |
| Invalid state | Use the same browser/hostname; restart login instead of reloading an old callback |
| Missing refresh token | Check the supplied client configuration and contact hackathon support |
| Access denied during authorization | Check your staging account and supplied client ID; contact hackathon support if access is still denied |
| Starter says use STARTER_API_KEY | You sent the wrong bearer token to the starter |
| mobie returns 401 | Audience, issuer, staging tenant and token expiry; log in again |
| Login lost after editing code | Watch mode restarted the process; use `npm start` for demonstrations |
| API request fails after a timeout | Inspect state before retrying any booking; no automatic write retry |

Official references: [PKCE](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce/add-login-using-the-authorization-code-flow-with-pkce), [refresh rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/use-refresh-token-rotation).

</details>
