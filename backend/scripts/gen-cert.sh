#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# gen-cert.sh — Generate a self-signed TLS cert for the karaoke backend.
#
# Produces:
#   backend/certs/cert.pem (mode 644)
#   backend/certs/key.pem  (mode 600)
#
# The cert's X509v3 SAN covers localhost, 127.0.0.1, ::1, and the host's
# primary LAN IPv4 (auto-detected via the UDP-connect idiom). Validity is
# 825 days (the maximum many browsers accept for self-signed certs).
#
# Idempotent: if cert.pem already exists and is valid for >30 more days,
# regeneration is skipped unless --force is passed.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
BACKEND_DIR="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
CERTS_DIR="$BACKEND_DIR/certs"
CERT="$CERTS_DIR/cert.pem"
KEY="$CERTS_DIR/key.pem"

DAYS=825
RENEW_THRESHOLD_DAYS=30
FORCE=0

for arg in "$@"; do
    case "$arg" in
        -f|--force) FORCE=1 ;;
        -h|--help)
            cat <<EOF
Usage: $0 [--force]

Generates a self-signed TLS cert at:
  $CERT
  $KEY

Options:
  -f, --force    Regenerate even if the existing cert is still valid.
  -h, --help     Show this help.
EOF
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Detect primary LAN IPv4 using the same UDP-connect trick as
# backend/api/rotation.py::_detect_lan_ip(). Falls back to 127.0.0.1.
# ---------------------------------------------------------------------------
detect_lan_ip() {
    python3 - <<'PY'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.connect(("8.8.8.8", 80))
    print(s.getsockname()[0])
except OSError:
    print("127.0.0.1")
finally:
    s.close()
PY
}

LAN_IP="$(detect_lan_ip)"

# ---------------------------------------------------------------------------
# Skip regeneration if cert is still valid for > RENEW_THRESHOLD_DAYS
# ---------------------------------------------------------------------------
if [[ "$FORCE" -eq 0 && -f "$CERT" ]]; then
    threshold_seconds=$(( RENEW_THRESHOLD_DAYS * 86400 ))
    if openssl x509 -in "$CERT" -checkend "$threshold_seconds" -noout >/dev/null 2>&1; then
        expiry="$(openssl x509 -in "$CERT" -noout -enddate | sed 's/notAfter=//')"
        echo "Existing cert is valid for >${RENEW_THRESHOLD_DAYS} days; skipping."
        echo "  cert:   $CERT"
        echo "  expiry: $expiry"
        echo "Pass --force to regenerate."
        exit 0
    fi
fi

# ---------------------------------------------------------------------------
# Generate
# ---------------------------------------------------------------------------
mkdir -p "$CERTS_DIR"
chmod 700 "$CERTS_DIR"

CONFIG_FILE="$(mktemp)"
trap 'rm -f "$CONFIG_FILE"' EXIT

cat >"$CONFIG_FILE" <<EOF
[req]
default_bits       = 2048
prompt             = no
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_req

[dn]
# A CN names a host, not a product, and modern clients validate the SAN block
# below instead — so this is cosmetic and stays a neutral service identifier
# (it matches the systemd unit and the pip package name).
CN = karaoke-backend

[v3_req]
basicConstraints     = CA:FALSE
keyUsage             = digitalSignature, keyEncipherment
extendedKeyUsage     = serverAuth
subjectAltName       = @alt_names

[alt_names]
DNS.1 = localhost
IP.1  = 127.0.0.1
IP.2  = ::1
IP.3  = $LAN_IP
EOF

openssl req \
    -x509 \
    -nodes \
    -newkey rsa:2048 \
    -keyout "$KEY" \
    -out "$CERT" \
    -days "$DAYS" \
    -config "$CONFIG_FILE" \
    -extensions v3_req \
    >/dev/null 2>&1

chmod 600 "$KEY"
chmod 644 "$CERT"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
expiry="$(openssl x509 -in "$CERT" -noout -enddate | sed 's/notAfter=//')"
sans="$(openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null \
    | sed -n '/X509v3 Subject Alternative Name/,/X509v3/p' \
    | grep -E 'DNS:|IP Address:' \
    | sed 's/^[[:space:]]*//')"

echo "Generated self-signed cert:"
echo "  cert:   $CERT"
echo "  key:    $KEY"
echo "  expiry: $expiry"
echo "  SANs:   $sans"
echo "  LAN IP: $LAN_IP"
