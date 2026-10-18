#!/usr/bin/env bash
# Despliegue LOCAL de prueba: construye exactamente lo que subiría a producción (tests, sitemap, PDF,
# mismos excludes del rsync), lo instala en una carpeta local, arranca el servidor y lo comprueba.
#   bash deploy/deploy-local.sh           # despliega, comprueba y deja el servidor en marcha (Ctrl-C para parar)
#   bash deploy/deploy-local.sh --check   # despliega, comprueba y termina (código de salida ≠ 0 si algo falla)
# Variables: PORT (3100), LOCAL_DEPLOY_DIR (website/.local-deploy), SKIP_TESTS=1
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${LOCAL_DEPLOY_DIR:-$SRC/.local-deploy}"
PORT="${PORT:-3100}"
BASE="http://127.0.0.1:$PORT"
CHECK_ONLY=0; [ "${1:-}" = "--check" ] && CHECK_ONLY=1

command -v bun >/dev/null || { echo "Falta bun en el PATH" >&2; exit 1; }
if (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then echo "El puerto $PORT ya está en uso (usa PORT=otro)" >&2; exit 1; fi

echo "▶ Tests, sitemap y PDF"
[ "${SKIP_TESTS:-0}" = "1" ] || (cd "$SRC/server" && NODE_ENV=test bun test 2>&1 | tail -4)
(cd "$SRC/server" && bun run sitemap >/dev/null)
(cd "$SRC/server" && bun run pdf >/dev/null 2>&1) || echo "  aviso: no se regeneró el PDF (¿falta chromium?); se usa el existente" >&2

echo "▶ Copiando a $DEST (mismos excludes que producción)"
mkdir -p "$DEST"
rsync -a --delete \
  --exclude '.local-deploy/' --exclude '/package.json' --exclude 'deploy/' --exclude 'README.md' --exclude '.DS_Store' \
  --exclude 'server/node_modules/' --exclude 'server/data/' --exclude 'server/.env' --exclude 'server/tests/' \
  "$SRC/" "$DEST/"
(cd "$DEST/server" && bun install --production --frozen-lockfile 2>&1 | tail -1)

echo "▶ Arrancando en $BASE"
mkdir -p "$DEST/server/data"
LOG="$DEST/server/data/server.log"
(
  cd "$DEST/server"
  exec env PORT="$PORT" NODE_ENV=production TRUST_PROXY=0 SITE_URL="$BASE" ALLOWED_ORIGINS="$BASE" \
    DATA_DIR="$DEST/server/data" HASH_SALT=local-salt-0123456789 DOCS_SECRET=local-docs-secret-0123456789 ADMIN_TOKEN="${ADMIN_TOKEN:-local-admin-token-0123456789}" \
    bun run index.ts
) >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT INT TERM

for i in $(seq 1 40); do curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "$BASE/api/health" >/dev/null 2>&1 || { echo "El servidor no arrancó; log:" >&2; tail -20 "$LOG" >&2; exit 1; }

echo "▶ Comprobaciones"
FAIL=0
expect() { # expect <código> <ruta> [content-type que debe contener]
  local want="$1" path="$2" ct="${3:-}" out code type
  out=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$BASE$path") ; code=${out%% *}; type=${out#* }
  if [ "$code" = "$want" ] && { [ -z "$ct" ] || [[ "$type" == *"$ct"* ]]; }; then printf '  ✓ %-42s %s\n' "$path" "$code"
  else printf '  ✗ %-42s %s (esperado %s %s) [%s]\n' "$path" "$code" "$want" "$ct" "$type"; FAIL=1; fi
}
expect 200 /                              text/html
expect 200 /guias/                        text/html
expect 200 /guias/software-hotel-pequeno  text/html
expect 200 /documentacion                 text/html
expect 200 /condiciones                   text/html
expect 200 /legal                         text/html
expect 200 /descargas/pliego-de-condiciones-betan.pdf application/pdf
expect 200 /sitemap.xml                   xml
expect 200 /robots.txt                    text/plain
expect 200 /assets/consent.js             javascript
expect 200 /assets/fonts/fonts.css        text/css
expect 200 /panel                         text/html
expect 200 /api/health                    json
expect 301 /index.html
expect 404 /no-existe
expect 404 /server/.env
expect 404 /server/package.json
expect 404 /docs/token-falso
expect 401 /api/admin/leads
# API: una petición inválida debe rechazarse (400) sin crear datos
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"nombre":"x"}' "$BASE/api/contact")
if [ "$code" = 400 ]; then echo "  ✓ POST /api/contact inválido → 400"; else echo "  ✗ POST /api/contact inválido → $code"; FAIL=1; fi
# Cabeceras de seguridad
H=$(curl -sI "$BASE/")
for h in content-security-policy x-content-type-options referrer-policy; do
  grep -qi "^$h:" <<<"$H" && echo "  ✓ cabecera $h" || { echo "  ✗ falta cabecera $h"; FAIL=1; }
done
# Ningún marcador de plantilla en lo publicado
if grep -rlE '\[(DATO REAL|PLACEHOLDER|COMPLETAR)' "$DEST/index.html" "$DEST/legal.html" "$DEST/guias" "$DEST/condiciones.html" "$DEST/documentacion.html" 2>/dev/null; then
  echo "  ✗ quedan marcadores de plantilla (arriba)"; FAIL=1; else echo "  ✓ sin marcadores de plantilla"; fi

if [ "$FAIL" != 0 ]; then echo "✗ Hay comprobaciones fallidas"; exit 1; fi
echo "✓ Todo correcto"
[ "$CHECK_ONLY" = 1 ] && exit 0

echo
echo "Servidor local en marcha: $BASE   (panel: $BASE/panel · token: ${ADMIN_TOKEN:-local-admin-token-0123456789})"
echo "Log: $LOG   ·   Ctrl-C para parar"
wait $PID
