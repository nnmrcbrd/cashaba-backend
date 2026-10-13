# Authentication cookies across subdomains

Casha-Ba returns access tokens in JSON and keeps them in frontend memory. Its
HttpOnly refresh cookie renews that access token. The frontend already sends
credentialed API requests, and the backend allows the exact `FRONTEND_URL` origin.

To share the refresh cookie across `www.cloomero.cloud` and `api.cloomero.cloud`,
set these values in the VPS environment file, `/root/env/cashaba-backend/.env`:

```dotenv
NODE_ENV=production
FRONTEND_URL=https://www.cloomero.cloud
BACKEND_URL=https://api.cloomero.cloud
GOOGLE_REDIRECT_URI=https://api.cloomero.cloud/api/auth/google/callback
COOKIE_DOMAIN=.cloomero.cloud
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
other subdomain origins.

References: [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
and [Express cookie deletion](https://expressjs.com/en/5x/api/response/#res.clearCookie).
