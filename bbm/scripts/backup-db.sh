#!/usr/bin/env bash
# Backup completo de PostgreSQL (todos los tenants) con pg_dump -Fc.
# Variables (por defecto las del entorno; se ejecuta como usuario postgres vía systemd):
#   DB_NAME      base de datos (obligatoria)
#   BACKUP_DIR   destino (por defecto /var/backups/betan-bm)
#   KEEP_DAYS    días de retención (por defecto 14)
# Export de UN tenant: bun scripts/export-tenant.ts --tenant=<slug>
set -euo pipefail

DB_NAME="${DB_NAME:?Define DB_NAME (p.ej. DB_NAME=betan_bm_prod)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/betan-bm}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILE="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.dump"

pg_dump -Fc -d "$DB_NAME" -f "$FILE"

# Borrar backups más antiguos de $KEEP_DAYS días
find "$BACKUP_DIR" -name "${DB_NAME}_*.dump" -mtime +"$KEEP_DAYS" -delete

echo "OK: $FILE ($(du -sh "$FILE" | cut -f1))"
