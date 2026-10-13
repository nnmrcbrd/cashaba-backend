# Backend Docker and VPS deployment

This repository deploys the Express API. The frontend is hosted separately.

## Files used

- `Dockerfile`: Node 22 runtime image and a separate, manually used migrations target.
- `docker-compose.yaml`: the single `app` service using `mrnbnld/cashaba-backend:latest`.
- `docker/docker-compose.build.yaml`: optional local build override for that same service.
- `.env.example`: the application configuration template, retained for local and VPS setup.
- `.github/workflows/deploy.yaml`: validates, builds, publishes and deploys main.
- `scripts/deploy.sh`: checks the VPS setup and image readiness before replacing the app.
- `nginx.conf`: host Nginx HTTP proxy reference; use its location block in the existing HTTPS virtual host.

The old managed database/Nginx Compose overrides and their duplicate environment
templates have been removed. Database maintenance helpers remain available for
explicit administration; the deployment does not run them automatically.

## Ports and server environment

The API listens on **8000 inside the container**. Compose forwards VPS loopback
port **8001** to it with `127.0.0.1:8001:8000`. The image health check also uses
container port 8000. Keep `PORT=8000`.

Compose requires the private server file `/root/env/cashaba-backend/.env`.
Use `.env.example` as the starting template and configure the actual database,
separate JWT secrets, SMTP, OAuth, Gemini and intended billing mode on the VPS.
Use these production settings:

```dotenv
NODE_ENV=production
PORT=8000
FRONTEND_URL=https://www.casha-ba.online
BACKEND_URL=https://api.casha-ba.online
GOOGLE_REDIRECT_URI=https://api.casha-ba.online/api/auth/google/callback
COOKIE_DOMAIN=.casha-ba.online
RATE_LIMIT_STORE=postgres
TRUST_PROXY_HOPS=1
```

Keep real environment files out of GitHub and images. See
[AUTH_COOKIES.md](AUTH_COOKIES.md) for cross-domain sign-in settings.
The database schema must already be migrated. For database setup and migration
history, follow [prisma/README.md](../prisma/README.md). The separate Docker
`migrations` target is available for manual database administration.

## GitHub Actions

Create these five separate **repository secrets**:

| Name | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub username that can publish `mrnbnld/cashaba-backend` |
| `DOCKERHUB_TOKEN` | Docker Hub access token with repository read and write access |
| `SSH_HOST` | VPS hostname or IP address |
| `SSH_USER` | `root`, matching the current server paths |
| `SSH_PRIVATE_KEY` | Private key whose matching public key is authorized on that VPS |

Push main or manually run the **Deploy** workflow on main. It validates the
backend files without loading the VPS-only environment file, runs deployment
regressions, and publishes the runtime image. It copies only
`docker-compose.yaml` and `scripts/deploy.sh` to `/root/docker/cashaba-backend`,
then executes:

```bash
bash /root/docker/cashaba-backend/scripts/deploy.sh
```

The VPS needs Bash, Docker Engine, a Compose plugin supporting `--wait`, and
`flock`. The server environment remains at `/root/env/cashaba-backend/.env`.
The script checks it privately, pulls the image and starts an isolated,
unpublished preflight instance. Production settings and database health must
pass before it recreates `app`. Compose then waits for the image health check.
Configuration, pull and preflight failures stop before restarting the app.
A failed rollout reports an error. Deployment does not initialize or migrate
the database, upload environment files, or change host Nginx.

## Manual commands

From the backend repository root:

```bash
docker build --target runtime -t mrnbnld/cashaba-backend:latest .
```

On the VPS, where the required server environment file is configured:

```bash
cd /root/docker/cashaba-backend
docker compose pull app
docker compose up -d --wait app
docker compose ps
```

For a local Compose image build, the override adds `build` to the same `app` service:

```bash
docker compose -f docker-compose.yaml -f docker/docker-compose.build.yaml build app
```

Local containers also need a local environment-file override; the repository's
main Compose file intentionally points at the VPS environment path. A plain
`docker build` does not require that environment file.

Host Nginx should proxy `https://api.casha-ba.online` to `http://127.0.0.1:8001`.
Keep the server's existing TLS certificate and HTTPS configuration; `nginx.conf`
is a proxy reference and is not installed or reloaded automatically. Verify
`nginx -t` before applying a deliberate host configuration change.

If copying reports `tar: empty archive`, the repository source paths must be
`docker-compose.yaml,scripts/deploy.sh`, without extra nested source folders.
