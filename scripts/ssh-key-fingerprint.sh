#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Only the public fingerprint is logged. Never print the private key,
# passphrase, key comment or public-key material. No server connection is made.
if [[ -z "${SSH_PRIVATE_KEY:-}" ]]; then
  echo '::error::SSH_PRIVATE_KEY is missing from this repository or environment.' >&2
  exit 1
fi

key_directory="$(mktemp -d)"
trap 'rm -f -- "$key_directory/key"; rmdir -- "$key_directory"' EXIT
printf '%s\n' "$SSH_PRIVATE_KEY" > "$key_directory/key"

# OpenSSH keys include their public portion even when the private portion is
# encrypted. Listing its fingerprint does not need or reveal the passphrase.
if ! details="$(ssh-keygen -l -E sha256 -f "$key_directory/key" 2>/dev/null)"; then
  echo '::error::Cannot read the deployment key fingerprint. Check the complete SSH_PRIVATE_KEY value and its original line breaks.' >&2
  exit 1
fi
fingerprint="$(printf '%s\n' "$details" | awk 'NR == 1 { print $2 }')"
if [[ ! "$fingerprint" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]]; then
  echo '::error::The deployment key did not yield a valid SHA256 fingerprint.' >&2
  exit 1
fi

printf '::notice title=Deployment SSH key fingerprint::%s\n' "$fingerprint"
