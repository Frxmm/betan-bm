# Plantilla systemd — UNA instancia multi-tenant por entorno (prod/test).
# Render: ENV=prod PORT=3000 BASE_DIR=/srv/betan-bm deploy/render.sh deploy/betan-bm.service.tpl \
#           | sudo tee /etc/systemd/system/betan-bm-prod.service
[Unit]
Description=betan-bm PMS multi-tenant ({{ENV}})
After=network.target postgresql.service

[Service]
Type=simple
User={{RUN_USER}}
WorkingDirectory={{BASE_DIR}}/{{ENV}}
EnvironmentFile={{BASE_DIR}}/{{ENV}}/.env
Environment=PORT={{PORT}}
ExecStart={{BASE_DIR}}/{{ENV}}/betan-bm
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=betan-bm-{{ENV}}

[Install]
WantedBy=multi-user.target
