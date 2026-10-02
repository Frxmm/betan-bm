#!/usr/bin/env bash
# Despliegue de la instancia multi-tenant.
#   DEPLOY_HOST  usuario@servidor   (obligatorio)
#   DEPLOY_PATH  ruta base en el servidor, p.ej. /srv/betan-bm   (obligatorio)
# Uso:
#   bash scripts/deploy.sh <test|prod>            compila, sube y reinicia
#   bash scripts/deploy.sh migrate <test|prod>    aplica migraciones en el servidor
set -euo pipefail
: "${DEPLOY_HOST:?Define DEPLOY_HOST (usuario@servidor)}"
: "${DEPLOY_PATH:?Define DEPLOY_PATH (p.ej. /srv/betan-bm)}"

if [ "${1:-}" = "migrate" ]; then
  ENV="${2:?test|prod}"
  ssh "$DEPLOY_HOST" "cd $DEPLOY_PATH/$ENV && bun run scripts/migrate.ts"
  exit 0
fi

ENV="${1:?test|prod}"
bun run build
rsync -avz ./dist/betan-bm ./drizzle ./scripts/migrate.ts ./scripts/backup-db.sh "$DEPLOY_HOST:$DEPLOY_PATH/$ENV/"
ssh "$DEPLOY_HOST" "sudo systemctl restart betan-bm-$ENV"
