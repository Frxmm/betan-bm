# Backup diario de toda la BD (todos los tenants). Instalar junto a betan-bm-backup.timer.tpl.
[Unit]
Description=betan-bm DB backup ({{ENV}})
After=postgresql.service

[Service]
Type=oneshot
User=postgres
Environment=DB_NAME={{DB}}
Environment=BACKUP_DIR=/var/backups/betan-bm
Environment=KEEP_DAYS=14
ExecStart={{BASE_DIR}}/{{ENV}}/scripts/backup-db.sh
StandardOutput=journal
StandardError=journal
