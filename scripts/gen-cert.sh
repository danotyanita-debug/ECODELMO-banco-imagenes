#!/usr/bin/env bash
# Genera un certificado HTTPS autofirmado para usar la app en la red local.
# Uso: scripts/gen-cert.sh [IP-de-tu-PC ...]    (si no das IP, se detectan)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
IPS=("$@")
if [ ${#IPS[@]} -eq 0 ]; then
  mapfile -t IPS < <(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' || true)
fi
SAN="DNS:localhost,IP:127.0.0.1"
for ip in "${IPS[@]}"; do SAN="$SAN,IP:$ip"; done
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=monitoreo-obras" -addext "subjectAltName=$SAN"
echo "Listo: certs/key.pem y certs/cert.pem (SAN: $SAN)"
echo "Reinicia con: npm start"
