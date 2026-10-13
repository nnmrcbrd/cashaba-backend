#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# The workflow uploads this script with Compose/Nginx files to an isolated
# release directory. No frontend checkout, image or service is used here.
IMAGE="${1:?Pass the immutable backend image tag}"
MIGRATION_IMAGE="${2:?Pass its matching migration image tag}"
ROOT="${DEPLOY_PATH:-/opt/casha-ba-backend}"
BUNDLE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

[[ "$ROOT" =~ ^/[A-Za-z0-9/_-]+$ && "$ROOT" != / ]] || { echo 'Invalid deployment path' >&2; exit 1; }
[[ "$IMAGE" =~ ^[a-z0-9][a-z0-9_./-]*:sha-([a-f0-9]{40})$ ]] || { echo 'An immutable backend sha tag is required' >&2; exit 1; }
SHA="${BASH_REMATCH[1]}"
[[ "$MIGRATION_IMAGE" == "${IMAGE%:sha-*}:migrations-sha-$SHA" ]] || { echo 'Migration and backend images must match' >&2; exit 1; }
command -v docker >/dev/null
command -v flock >/dev/null
mkdir -p "$ROOT"
exec 9>"$ROOT/.deploy.lock"
flock -w 600 9 || { echo 'Another deployment holds the server lock' >&2; exit 1; }

[[ -f "$ROOT/.env.production" && -f "$ROOT/.env.docker" ]] || { echo 'Configure .env.production and .env.docker on the VPS first' >&2; exit 1; }
mkdir -p "$ROOT/docker/nginx" "$ROOT/scripts"
if [[ "$BUNDLE" != "$ROOT" ]]; then
  cp "$BUNDLE/docker-compose.yaml" "$BUNDLE/nginx.conf" "$ROOT/"
  cp "$BUNDLE/docker/docker-compose.tls.yaml" "$BUNDLE/docker/docker-compose.database.yaml" "$BUNDLE/docker/nginx-tls.conf" "$ROOT/docker/"
  cp "$BUNDLE/docker/nginx/http.conf" "$BUNDLE/docker/nginx/routes.conf" "$ROOT/docker/nginx/"
  cp "$BUNDLE/scripts/deploy.sh" "$ROOT/scripts/deploy.sh"
fi

NEXT="$(mktemp "$ROOT/.env.images.next.XXXXXX")"
trap 'rm -f -- "$NEXT"' EXIT
printf 'BACKEND_IMAGE=%s\nMIGRATIONS_IMAGE=%s\n' "$IMAGE" "$MIGRATION_IMAGE" > "$NEXT"
FILES=(-f "$ROOT/docker-compose.yaml" -f "$ROOT/docker/docker-compose.tls.yaml")
DATABASE_MODE="$(awk -F= '$1 == "DATABASE_MODE" {sub(/\r$/, "", $2); print $2}' "$ROOT/.env.docker")"
case "${DATABASE_MODE:-external}" in
  external) ;;
  container) FILES+=(-f "$ROOT/docker/docker-compose.database.yaml") ;;
  *) echo 'DATABASE_MODE must be external or container' >&2; exit 1 ;;
esac
compose() {
  docker compose --project-directory "$ROOT" --env-file "$ROOT/.env.docker" --env-file "$NEXT" "${FILES[@]}" "$@"
}

compose config --quiet
# Pull before changing running containers; use docker login on the VPS if private.
compose pull
compose run --rm --no-deps nginx nginx -t
if [[ "$DATABASE_MODE" == container ]]; then
  compose up -d --wait --wait-timeout 120 database
fi
# Checks production configuration and SMTP connectivity, without calling Gemini.
compose run --rm --no-deps migrations npm run check:production
# This is migrate deploy, never migrate dev/reset or automatic empty initialization.
compose run --rm --no-deps migrations
compose up -d --no-deps --wait --wait-timeout 180 backend
compose up -d --no-deps --force-recreate --wait --wait-timeout 60 nginx
compose exec -T nginx nginx -t
compose exec -T backend node -e "const u=new URL(process.env.BACKEND_URL);if(u.protocol!=='https:')throw new Error('BACKEND_URL must use HTTPS');fetch(new URL('/api/health',u),{signal:AbortSignal.timeout(10000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
mv -f -- "$NEXT" "$ROOT/.env.images"
echo 'Backend deployment completed; database and public HTTPS health checks passed.'
