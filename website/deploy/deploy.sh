#!/usr/bin/env bash
# Publica la web (estáticos + backend Bun) en betanbm.com por rsync/SSH y reinicia el servicio.
#   DEPLOY_HOST  usuario@servidor   (por defecto: $USER@betanbm.com; ajusta DEPLOY_USER)
#   DEPLOY_PATH  carpeta remota     (por defecto /srv/betanbm)
#   SKIP_TESTS=1 salta los tests; FORCE=1 publica aunque queden marcadores de plantilla.
# Uso:
#   bash website/deploy/deploy.sh          # despliega
#   bash website/deploy/deploy.sh -n       # dry-run: muestra qué cambiaría
# Atajos (desde website/): npm run deploy · npm run deploy:dry · npm run deploy:test (local)
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-direccion}"
DEPLOY_HOST="${DEPLOY_HOST:-$DEPLOY_USER@hotelbetania.es}"
DEPLOY_PATH="${DEPLOY_PATH:-/srv/betanbm}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

# Evita publicar con datos de plantilla sin rellenar.
if grep -rq '\[DATO REAL\]\|\[PLACEHOLDER\]\|\[COMPLETAR' "$SRC/index.html" "$SRC/legal.html" "$SRC/guias"; then
  echo "AVISO: quedan marcadores [DATO REAL]/[PLACEHOLDER]/[COMPLETAR]:" >&2
  grep -rn '\[DATO REAL\]\|\[PLACEHOLDER\]\|\[COMPLETAR' "$SRC/index.html" "$SRC/legal.html" "$SRC/guias" | cut -c1-120 >&2
  [ "${FORCE:-0}" = "1" ] || { echo "Rellénalos o ejecuta con FORCE=1." >&2; exit 1; }
fi

DRY=()
[ "${1:-}" = "-n" ] && DRY=(--dry-run)

if [ ${#DRY[@]} -eq 0 ]; then
  [ "${SKIP_TESTS:-0}" = "1" ] || (cd "$SRC/server" && NODE_ENV=test bun test)
  (cd "$SRC/server" && bun run sitemap >/dev/null)
  (cd "$SRC/server" && bun run pdf >/dev/null 2>&1) || echo "AVISO: no se regeneró el PDF del pliego (¿falta chromium?); se publica el existente." >&2
fi

# server/.env, server/data y node_modules viven en el servidor: no se tocan.
rsync -avz --delete "${DRY[@]}" \
  --exclude '.local-deploy/' --exclude '/package.json' --exclude 'deploy/' --exclude 'README.md' --exclude '.DS_Store' \
  --exclude 'server/node_modules/' --exclude 'server/data/' --exclude 'server/.env' --exclude 'server/tests/' \
  "$SRC/" "$DEPLOY_HOST:$DEPLOY_PATH/"

if [ ${#DRY[@]} -eq 0 ]; then
  ssh "$DEPLOY_HOST" "cd $DEPLOY_PATH/server && bun install --production --frozen-lockfile && sudo systemctl restart betanbm-web && sleep 1 && curl -fsS http://127.0.0.1:3100/api/health"
  echo; echo "OK: publicado en https://www.betanbm.com"
fi
