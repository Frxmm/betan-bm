[Unit]
Description=betan-bm DB backup diario ({{ENV}}, 03:00)

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
