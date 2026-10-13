#!/usr/bin/env bash
set -Eeuo pipefail

# Run manually on a new Ubuntu/Debian amd64 VPS, never on the development PC.
[[ "$(id -u)" == 0 ]] || { echo 'Run with sudo on the VPS' >&2; exit 1; }
DEPLOY_USER="${1:?Pass an existing VPS deployment username}"
[[ "$DEPLOY_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || { echo 'Invalid deployment username' >&2; exit 1; }
id -- "$DEPLOY_USER" >/dev/null
[[ "$(uname -m)" == x86_64 ]] || { echo 'The workflow currently publishes linux/amd64 images' >&2; exit 1; }
source /etc/os-release
[[ "$ID" == ubuntu || "$ID" == debian ]] || { echo 'This setup supports Ubuntu and Debian' >&2; exit 1; }

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  ARCH="$(dpkg --print-architecture)"
  CODENAME="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
  printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$ID" "$CODENAME" "$ARCH" > /etc/apt/sources.list.d/docker.sources
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
usermod -aG docker "$DEPLOY_USER"
DEPLOY_GROUP="$(id -gn "$DEPLOY_USER")"
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" /opt/casha-ba-backend /opt/casha-ba-backend/docker/tls
docker compose version
echo 'VPS prerequisites prepared. Reconnect over SSH to apply Docker group membership.'
echo 'Configure server environment files, DNS, TLS certificates and registry access before deployment.'
