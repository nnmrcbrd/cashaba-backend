# Backend Docker and VPS deployment

## Current app-only deployment

The current `docker-compose.yaml` runs the `app` service from
`mrnbnld/cashaba-backend:latest`, with host binding `127.0.0.1:8001:8000`.
It reads `/root/env/cashaba-backend/.env` on the VPS. Keep this file on the server;
the workflow uploads only `docker-compose.yaml` and `scripts/deploy.sh`.

The five separate **repository secrets** are `DOCKERHUB_USERNAME`,
`DOCKERHUB_TOKEN`, `SSH_HOST`, `SSH_USER`, and `SSH_PRIVATE_KEY`. The current
server paths require `SSH_USER=root`. The Docker Hub token needs Repo Read & Write
access, and its account must be able to push `mrnbnld/cashaba-backend`.

Main pushes and manual **Deploy** workflow runs validate the deployment files,
build/publish the runtime image, copy the files to `/root/docker/cashaba-backend`,
and execute:

```bash
bash /root/docker/cashaba-backend/scripts/deploy.sh
```

The script locks this deployment, checks Compose and the server environment,
pulls the image, and runs an unpublished preflight instance to verify production
settings and database health before replacing the running `app`. Compose waits
for the app's image health check to pass. Configuration, pull or preflight failures
stop before restarting the running service. A failed rollout returns an error.
The script does not dump environment values or container logs into Actions.

The VPS needs Bash, Docker Engine, a Compose plugin supporting `--wait`, and
`flock`. Host Nginx should proxy `https://api.casha-ba.online` to
`http://127.0.0.1:8001`. See [AUTH_COOKIES.md](AUTH_COOKIES.md) for frontend/API
origins and cookie settings. The database schema must already be migrated;
this app-only deployment does not initialize or migrate an existing database.

When the copy step reports `tar: empty archive`, confirm its source paths are
`docker-compose.yaml,scripts/deploy.sh`; this repository does not have nested
`docker/cashaba-backend` or `scripts/cashaba-backend` source folders.

## Previous managed-stack deployment reference

The remaining sections describe the earlier migration/Nginx Compose stack and
its separate images and environment files. Those commands are not used by the
current app-only workflow or its replacement `scripts/deploy.sh`.

This repository deploys the Express API only. It has no frontend build context,
image, service or checkout. The frontend can be hosted independently. This adapts
the reference repository's Docker Hub → SSH → Compose flow:
https://github.com/arielmaestrodev/portfolio-backend-api.

## What is included

- `Dockerfile`: Node 22 production API image and a separate `migrations` target.
- `.dockerignore`: excludes credentials, local dependencies, generated clients,
  development build outputs, certificates and test/audit evidence.
- `docker-compose.yaml`: API, one-off migrations and Nginx. API and database ports
  are never published directly. HTTP binds to loopback by default.
- `docker/docker-compose.build.yaml`: local image-build override for this repository.
- `docker/docker-compose.tls.yaml`: public HTTPS with mounted server certificates.
- `docker/docker-compose.database.yaml`: optional persistent PostgreSQL 17 with pgvector.
- `nginx.conf` and `docker/nginx/`: API reverse proxy; preserves `/api`, cookies,
  OAuth callbacks, webhook bodies, idempotency headers and streaming. Financial
  requests are never retried automatically by Nginx. Query strings are not logged.
- `.github/workflows/deploy.yaml`: verification, immutable Docker Hub image tags,
  optional VPS deployment through SSH with a verified host key.
- `scripts/deploy.sh`: server lock, configuration/SMTP/TLS checks, migrations,
  healthy API rollout and a public HTTPS database-health check.

The GitHub folder is **`.github/workflows`**, plural. The reference file is named
**`deploy.yaml`**, not `deloy.yaml`.

## 1. Prepare the VPS

The default workflow builds **Linux amd64** images. Use an amd64 Ubuntu/Debian VPS
with Docker Engine and Compose **2.24.4 or newer**. Docker's official installation
instructions are at https://docs.docker.com/engine/install/ubuntu/ and
https://docs.docker.com/engine/install/debian/.

After checking out/copying the backend on the VPS, run the supplied prerequisite
script with an existing deployment user:

```bash
sudo bash scripts/setup-vps.sh your-deploy-user
```

Reconnect over SSH afterward. Docker group membership grants control of Docker
and its host mounts; use the intended deployment user. Permit SSH and ports
80/443 in the VPS/provider firewall. Create an A record for your API domain.
No firewall rules, existing containers or database volumes are removed by the script.

## 2. Configure the server, without putting secrets in GitHub images

Copy the deployment files into `/opt/casha-ba-backend`, retaining the `docker/`
and `scripts/` directories. On the VPS, from that directory:

```bash
cp .env.production.example .env.production
cp .env.docker.example .env.docker
chmod 600 .env.production .env.docker
```

Fill `.env.production` on the VPS with the actual PostgreSQL URL, separate random
JWT secrets, SMTP credentials and the intended Gemini/Google/PayMongo settings.
The example disables billing until you explicitly configure the intended mode;
it does not change billing in your development application. Use `paymongo_test`
and a test key for capstone test checkout, or the existing supported billing mode.

Use the independently deployed frontend's exact HTTPS origin for `FRONTEND_URL`,
and the API origin for `BACKEND_URL`. For example:

```dotenv
FRONTEND_URL=https://app.your-domain.com
BACKEND_URL=https://api.your-domain.com
GOOGLE_REDIRECT_URI=https://api.your-domain.com/api/auth/google/callback
```

Register that callback in Google OAuth. The frontend's separate build must use
`NEXT_PUBLIC_API_URL=https://api.your-domain.com/api`. No frontend files are needed
on this backend server. The supplied Nginx container is the one trusted proxy;
`TRUST_PROXY_HOPS=1` matches that topology. Additional proxies require a separately
reviewed forwarding/trust configuration.

**Existing database:** keep `DATABASE_MODE=external` and point `DATABASE_URL` at
the existing migrated Casha-Ba database. This preserves accounts, financial
records, chats and indexed RAG vectors. The database must support pgvector and
the migration role must be allowed to create its extension if still needed.
Take a database backup before the first production migration. Migration commands
use `migrate deploy`; they never use reset, db push or migrate dev.

**New self-hosted database:** set `DATABASE_MODE=container`, choose a strong
`POSTGRES_PASSWORD` in `.env.docker`, and set the corresponding URL in
`.env.production`: `postgresql://cashaba:URL_ENCODED_PASSWORD@database:5432/cashaba`.
The PostgreSQL data volume survives normal container replacement. Do not run
`docker compose down --volumes` against a database you want to retain.

## 3. Configure HTTPS certificates

The production deployment script uses the TLS override. It expects real
`fullchain.pem` and `privkey.pem` files in `docker/tls/`, or in the directory
configured by `TLS_CERT_DIR`. These files are excluded from Git and Docker builds.

For a new server with ports 80/443 available, one option is Certbot standalone:

```bash
sudo apt-get install -y certbot
sudo certbot certonly --standalone -d api.your-domain.com
sudo install -m 0644 /etc/letsencrypt/live/api.your-domain.com/fullchain.pem /opt/casha-ba-backend/docker/tls/fullchain.pem
sudo install -m 0600 /etc/letsencrypt/live/api.your-domain.com/privkey.pem /opt/casha-ba-backend/docker/tls/privkey.pem
```

Configure certificate renewal for your chosen ACME method. A standalone renewal
needs port 80 to be available; use a DNS challenge for renewal without stopping
Nginx, or arrange a maintenance stop/start for standalone renewal. After renewal,
copy both renewed files into the mounted directory and run `nginx -t` followed
by `nginx -s reload` in the Nginx container. Mounting only a Let's Encrypt `live/`
directory does not work if its symlinks point to an unmounted `archive/` directory.

Default production ports are 80/443. These two independent stacks should use
separate servers/IPs when both directly bind those ports. Hosting both on one
VPS behind a shared host/domain router is a separate topology; do not run two
stacks claiming the same ports. The frontend can also be deployed on a managed host.

## 4. Build or select images

From the backend repository root, local builds use only this repository:

```bash
docker compose --env-file .env.docker -f docker-compose.yaml -f docker/docker-compose.build.yaml build
```

For CI images, set matching commit tags in `.env.docker` for the initial server
setup. Use the exact SHA printed in the successful workflow run:

```dotenv
BACKEND_IMAGE=your-dockerhub-user/cashaba-backend:sha-FULL_40_CHARACTER_COMMIT_SHA
MIGRATIONS_IMAGE=your-dockerhub-user/cashaba-backend:migrations-sha-FULL_40_CHARACTER_COMMIT_SHA
```

If images are private, run `docker login` on the VPS with a read-only registry
token. The workflow's publishing token is never sent to the VPS automatically.

## 5. Initialize only a verified NEW empty database

Skip this section for an existing database or a restored database backup.
The historical migration chain contains duplicate early init migrations; the
provided helper installs the retained baseline plus the raw RAG/pgvector schema,
then records all 18 retained migrations with Prisma and checks `migrate deploy`.
Only history through `20261009220000_trial_and_subscription_tiers` is represented
by this baseline; newer migrations run normally through `migrate deploy`.
It rejects a nonempty database before any baseline writes, and rolls back failed
baseline SQL. Never use it to repair an existing application's migration history.

For the optional container database, start it first (omit the database override
when using a new external database):

```bash
docker compose --env-file .env.docker -f docker-compose.yaml -f docker/docker-compose.database.yaml up -d --wait database
docker compose --env-file .env.docker -f docker-compose.yaml -f docker/docker-compose.database.yaml run --rm --no-deps migrations node docker/init-empty-database.mjs --confirm-empty
```

If Prisma history resolution fails after the baseline commits, initialization
will refuse a second baseline run. Inspect the new database and resolve only
the already-created baseline migrations using Prisma; do not drop tables or
apply duplicate init SQL. The CI workflow tests initialization and rejection
against its own disposable database.

A fresh database starts with an empty knowledge corpus. Restore the existing
database to keep the current RAG vectors, or explicitly run `npm run ai:index`
using the migration image after Gemini embedding quota is available. Indexing
uses approved public guides; it is never run automatically during deployment
and does not prove full live answer accuracy.

## 6. Enable GitHub Actions deployment

Configure **this backend repository** in Settings → Secrets and variables → Actions:

| Type | Name | Value |
| --- | --- | --- |
| Variable | `DOCKERHUB_USERNAME` | Docker Hub account/organization owning `cashaba-backend` |
| Secret | `DOCKERHUB_TOKEN` | Token allowed to push backend images |
| Secret | `SSH_HOST` | Backend VPS hostname or IPv4 address |
| Secret | `SSH_USER` | VPS deployment username |
| Secret | `SSH_PRIVATE_KEY` | Deployment SSH private key |
| Secret | `SSH_KNOWN_HOSTS` | Trusted host-key line(s), verified against the VPS fingerprint |
| Variable | `SSH_PORT` | Optional; defaults to `22` |
| Variable | `DEPLOY_PATH` | Optional; defaults to `/opt/casha-ba-backend` |
| Variable | `DEPLOY_ENABLED` | `true` to auto-deploy successful main pushes; otherwise deployment stays manual |

Pull requests build and verify without publishing or deploying. Verification
also runs a Linux Docker runtime smoke check with a synthetic unavailable database;
this checks image startup without contacting Gemini or an application database.
Main pushes
publish runtime and migration images. From Actions, select **Backend Docker and
VPS deployment → Run workflow → main → deploy=true** for a manual deployment.
The folder name must be `.github/workflows`; GitHub ignores `.github/workflow`.

The workflow uploads only deployment configuration/scripts, not `.env` files,
certificates, database backups or financial records. Images are tagged by the
commit SHA. A server-side `flock` prevents overlapping deploy scripts. Secrets
stay on the VPS or in GitHub's secret store; there are no embedded credentials.

## Deployment behavior and verification

The script pulls matching images, validates TLS/Nginx and production SMTP
configuration, applies pending migrations, waits for the API's database health
check, recreates Nginx and checks the real public HTTPS `/api/health` URL. It
records the release image tags in `.env.images` only after those checks pass.
It does not delete volumes, prune other containers or roll back SQL migrations.

If a rollout fails after migrations, inspect the failed release and private
server logs before retrying. An old image may be incompatible with a new schema;
there is no unconditional automatic database rollback or zero-downtime claim.
Normal subsequent CLI operations should use both env files:

```bash
docker compose --env-file .env.docker --env-file .env.images -f docker-compose.yaml -f docker/docker-compose.tls.yaml ps
```

Add `-f docker/docker-compose.database.yaml` if `DATABASE_MODE=container`.
After a real deployment, verify normal sign-in/refresh, ownership restrictions,
the configured OAuth callback, SMTP recovery, read-only AI and intended billing
test mode with the separately deployed frontend. The existing Gemini live
verification checkpoint remains pending; Docker does not change its quota or
turn incomplete AI checks into passed tests.
