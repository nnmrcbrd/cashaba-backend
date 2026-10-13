#!/usr/bin/env bash
set -Eeuo pipefail

# CI-only: exercises the built Linux API image without an application database,
# provider credentials, billing calls or financial writes.
docker build --target runtime -t cashaba-backend:runtime-check .
CONTAINER="$(docker run -d \
  -e NODE_ENV=production -e PORT=8000 \
  -e DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:9/fixture \
  -e JWT_ACCESS_SECRET=synthetic-access-runtime-check-only \
  -e JWT_REFRESH_SECRET=synthetic-refresh-runtime-check-only \
  -e FRONTEND_URL=https://synthetic.invalid \
  -e BACKEND_URL=https://api.synthetic.invalid \
  -e SMTP_HOST=synthetic.invalid -e SMTP_USER=fixture \
  -e SMTP_PASSWORD=fixture -e MAIL_FROM=fixture@synthetic.invalid \
  -e GEMINI_API_KEY=synthetic-not-a-provider-key -e BILLING_MODE=disabled \
  cashaba-backend:runtime-check)"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT
for attempt in $(seq 1 30); do
  if docker exec "$CONTAINER" node --input-type=module -e \
    "const root=await fetch('http://127.0.0.1:8000/',{signal:AbortSignal.timeout(5000)});const health=await fetch('http://127.0.0.1:8000/api/health',{signal:AbortSignal.timeout(5000)});if(root.status!==200||health.status!==503)process.exit(1);" >/dev/null 2>&1; then
    echo 'Linux production image starts; liveness is 200 and an unavailable synthetic database produces health 503.'
    exit 0
  fi
  sleep 1
done
echo 'Synthetic Docker runtime check failed' >&2
exit 1
