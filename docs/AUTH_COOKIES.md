# Authentication cookies across subdomains

Casha-Ba returns access tokens in JSON and keeps them in frontend memory. Its
HttpOnly refresh cookie renews that access token. The frontend already sends
credentialed API requests. CORS and the refresh/logout origin check use the same
allowlist: `https://www.casha-ba.online`, `https://casha-ba.online` and
`https://api.casha-ba.online`, plus the configured `FRONTEND_URL` and any explicit
comma-separated `CORS_ALLOWED_ORIGINS`. Additional origins must be trusted.

To share the refresh cookie across `www.casha-ba.online` and `api.casha-ba.online`,
set these values in the VPS environment file, `/root/env/cashaba-backend/.env`:

```dotenv
NODE_ENV=production
FRONTEND_URL=https://www.casha-ba.online
BACKEND_URL=https://api.casha-ba.online
GOOGLE_REDIRECT_URI=https://api.casha-ba.online/api/auth/google/callback
COOKIE_DOMAIN=.casha-ba.online
```

Use your actual frontend origin, API origin and shared parent domain. Do not
include a scheme, port or path in `COOKIE_DOMAIN`. A backend can only set a cookie
for its own domain or a parent domain; unrelated frontend/backend domains cannot
share a parent-domain cookie. Leaving `COOKIE_DOMAIN` blank retains API host-only
cookies, which also work for credentialed requests to that API.

Login, token refresh and Google sign-in use `HttpOnly`, `Secure`, `SameSite=None`,
a seven-day lifetime and `Path=/api/auth` in production. Development uses
`SameSite=Lax`, no Secure flag and no domain, even if `COOKIE_DOMAIN` is set.
The Google OAuth state cookie retains its API-host scope and `SameSite=Lax`.

Logout, failed refresh, signup and password changes clear the refresh cookie with
the same domain and path used when setting it. The previous API host-only cookie
is also removed when issuing or clearing a shared-domain cookie, so it does not
conflict with the new cookie. Cookie deletion does not receive `maxAge` or
`expires`; Express supplies the expired timestamp.

Rebuild and publish the backend image, then pull it and recreate the `app`
container after changing the environment file. A GitHub source push alone does
not replace a running VPS image. Nginx must terminate HTTPS and proxy the API;
the current Compose file binds it to `127.0.0.1:8001` on the VPS.

Verify in the browser's Network and cookie-storage panels: sign in from the
frontend, inspect the API's `Set-Cookie`, reload to exercise `/api/auth/refresh`,
then sign out and confirm the refresh cookie is removed. The cookie is HttpOnly
and will not appear in `document.cookie`. The existing frontend-origin check
still protects refresh/logout requests; sharing a domain does not authorize
unlisted subdomain origins. Credentialed responses echo the exact allowed origin,
include `Vary: Origin`, and support OPTIONS preflights for authorization,
JSON and idempotency headers. The allowlist never uses `*` or hostname suffix
matching. Origin settings accept a trailing slash but no URL path, credentials,
query or fragment; browser Origin headers are compared exactly. Local development
continues to allow the configured `FRONTEND_URL` (default `http://localhost:3000`).

References: [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
and [Express cookie deletion](https://expressjs.com/en/5x/api/response/#res.clearCookie),
plus [Express CORS middleware](https://expressjs.com/en/resources/middleware/cors/).
