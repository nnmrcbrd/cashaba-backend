#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# SCP preserves docker-compose.yaml and scripts/deploy.sh under this directory.
# The application's private .env stays at /root/env/cashaba-backend/.env.
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.yaml"
[[ -f "$COMPOSE_FILE" ]] || { echo 'Missing docker-compose.yaml beside the uploaded scripts directory' >&2; exit 1; }
for dependency in docker flock; do
  command -v "$dependency" >/dev/null || { echo "Required VPS command is unavailable: $dependency" >&2; exit 1; }
done
docker compose version >/dev/null || { echo 'Install the Docker Compose plugin on the VPS first' >&2; exit 1; }
exec 9>"$ROOT/.deploy.lock"
flock -w 600 9 || { echo 'Another backend deployment holds the server lock' >&2; exit 1; }

compose() {
  docker compose --project-directory "$ROOT" -f "$COMPOSE_FILE" "$@"
}

# Check the VPS env_file and Compose configuration without printing credentials.
if ! compose config --quiet >/dev/null 2>&1; then
  echo 'Compose configuration failed. Verify /root/env/cashaba-backend/.env exists and is valid.' >&2
  exit 1
fi
compose pull app

# Start an isolated, unpublished instance of the pulled image first. This
# validates production settings and SELECT 1 database health before replacing
# the running API. It does not migrate, reset or write financial records.
if ! compose run --rm --no-deps -T app node --input-type=module -e '
  console.error = () => {};
  try {
    await import("./dist/server.mjs");
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await fetch("http://127.0.0.1:8000/api/health", { signal: AbortSignal.timeout(3000) });
        if (response.ok) process.exit(0);
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch {}
  process.exit(1);
'; then
  echo 'Backend preflight failed. Check production configuration and database connectivity on the VPS.' >&2
  exit 1
fi

# Only this backend service is recreated; host Nginx and database stay in place.
compose up -d --no-deps --force-recreate --wait --wait-timeout 180 app
echo 'Backend deployment completed. The app is healthy on VPS loopback port 8001.'
