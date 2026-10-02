#!/usr/bin/env bash
# Da de alta el dominio de un cliente: genera su server block y pide el certificado.
# Requisitos: el DNS del dominio ya apunta a este servidor; properties.public_domain = dominio.
# Uso (en el servidor):  ENV=prod sudo -E deploy/add-domain.sh reservas.hotelsol.com
set -euo pipefail
TENANT_DOMAIN="${1:?Uso: ENV=prod add-domain.sh <dominio>}"
ENV="${ENV:?Define ENV (prod|test)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="/etc/nginx/betan-bm/$ENV"

mkdir -p "$DEST"
TENANT_DOMAIN="$TENANT_DOMAIN" ENV="$ENV" "$HERE/render.sh" "$HERE/nginx-tenant.conf.tpl" > "$DEST/$TENANT_DOMAIN.conf"
nginx -t && systemctl reload nginx
certbot --nginx -d "$TENANT_DOMAIN" --redirect --non-interactive --agree-tos -m "${CERTBOT_EMAIL:?Define CERTBOT_EMAIL}"
nginx -t && systemctl reload nginx
echo "OK: $TENANT_DOMAIN"
