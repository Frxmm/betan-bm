#!/usr/bin/env bash
# Sustituye {{VAR}} en una plantilla con variables de entorno. Falla si queda alguna sin definir.
# Uso: DOMAIN=booking.ejemplo.com PORT=3000 ENV=prod deploy/render.sh deploy/nginx.conf.tpl
set -euo pipefail
tpl="${1:?Uso: render.sh <plantilla>}"
out="$(cat "$tpl")"
for v in $(grep -o '{{[A-Z_]*}}' "$tpl" | sort -u | tr -d '{}'); do
  val="${!v:-}"
  [ -n "$val" ] || { echo "Falta la variable $v para $tpl" >&2; exit 1; }
  out="${out//\{\{$v\}\}/$val}"
done
printf '%s\n' "$out"
