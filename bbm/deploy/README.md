# Despliegue — instancia multi-tenant

Una única instancia (binario + BD por entorno) sirve a TODOS los hoteles (tenants). Cada hotel es una fila de
`properties`; el tenant se resuelve por JWT (staff) o por dominio / `?tenant=slug` (público). Ver `docs/04-MULTITENANT.md`.

`bun build --compile` genera un binario autónomo (`dist/betan-bm`); el servidor no necesita Bun salvo para migrar.

## Plantillas (parametrizadas)

| Fichero | Variables | Para qué |
|---|---|---|
| `betan-bm.service.tpl` | `ENV, PORT, BASE_DIR, RUN_USER` | unidad systemd `betan-bm-<ENV>` |
| `nginx.conf.tpl` | `ENV, PORT, DOMAIN, BASE_DIR` | plataforma + default_server 444 + include de dominios de clientes |
| `nginx-tenant.conf.tpl` | `ENV, TENANT_DOMAIN` | un dominio de cliente (lo usa `add-domain.sh`) |
| `betan-bm-backup.{service,timer}.tpl` | `ENV, DB, BASE_DIR` | backup diario `pg_dump` |
| `setup-db.sql` | variables psql `dbuser, dbname, dbpass` | usuario y BD |

`deploy/render.sh <plantilla>` sustituye `{{VAR}}` desde el entorno y falla si falta alguna.

## Estructura en el servidor

```
$BASE_DIR (p.ej. /srv/betan-bm)
├── prod/   betan-bm, drizzle/, scripts/{migrate.ts,backup-db.sh}, .env      → puerto 3000
└── test/   idem                                                              → puerto 3001
```

## Alta del servidor (una vez por entorno)

```bash
export ENV=prod PORT=3000 BASE_DIR=/srv/betan-bm RUN_USER=www-data DOMAIN=booking.tudominio.com DB=betan_bm_prod

# 1. Directorios y .env
sudo mkdir -p $BASE_DIR/$ENV && sudo chown -R $RUN_USER $BASE_DIR
# .env mínimo: DATABASE_URL, JWT_SECRET (>=32 chars), PUBLIC_URL=https://$DOMAIN, PORT
#   NO pongas credenciales de integraciones aquí: viven por tenant en properties.settings (secrets.*).
#   ALLOW_ENV_SECRET_FALLBACK=1 solo si la instancia tiene UN único hotel y quieres usar el .env.

# 2. BD
sudo -u postgres psql -v dbuser=betan_bm -v dbname=$DB -v dbpass='<fuerte>' -f deploy/setup-db.sql

# 3. systemd
deploy/render.sh deploy/betan-bm.service.tpl | sudo tee /etc/systemd/system/betan-bm-$ENV.service
deploy/render.sh deploy/betan-bm-backup.service.tpl | sudo tee /etc/systemd/system/betan-bm-backup-$ENV.service
deploy/render.sh deploy/betan-bm-backup.timer.tpl   | sudo tee /etc/systemd/system/betan-bm-backup-$ENV.timer
sudo systemctl daemon-reload && sudo systemctl enable betan-bm-$ENV betan-bm-backup-$ENV.timer

# 4. nginx + certificado de la plataforma
deploy/render.sh deploy/nginx.conf.tpl | sudo tee /etc/nginx/sites-available/betan-bm-$ENV
sudo ln -s /etc/nginx/sites-available/betan-bm-$ENV /etc/nginx/sites-enabled/
sudo mkdir -p /etc/nginx/betan-bm/$ENV
sudo certbot certonly --nginx -d $DOMAIN        # antes de nginx -t (la plantilla referencia el cert)
sudo nginx -t && sudo systemctl reload nginx
```

## Despliegue de versiones (desde local)

```bash
export DEPLOY_HOST=usuario@servidor DEPLOY_PATH=/srv/betan-bm
bun run deploy:test         # compila, rsync, reinicia betan-bm-test
bun run db:migrate:test     # aplica migraciones en el servidor (Bun requerido allí)
bun run deploy:prod
bun run db:migrate:prod
```

Las migraciones se aplican a mano y a conciencia (afectan a todos los tenants a la vez): haz antes un backup.

## Dominios de clientes (certbot por dominio)

1. El cliente apunta su DNS (`A`/`CNAME`) al servidor.
2. `properties.public_domain = <dominio>` (alta del tenant o UI de plataforma).
3. En el servidor: `ENV=prod CERTBOT_EMAIL=ops@tudominio.com sudo -E deploy/add-domain.sh reservas.hotelsol.com`
   (genera `/etc/nginx/betan-bm/prod/<dominio>.conf`, recarga nginx y ejecuta certbot).

Un dominio no declarado nunca llega a la app (`default_server` devuelve 444).
No usamos certificado comodín: cada dominio de cliente es independiente; los subdominios propios
(`<slug>.tudominio.com`) pueden cubrirse con un wildcard DNS-01 si algún día se quiere.

## frame-ancestors (widget embebido)

Decisión: **la app emite la cabecera `Content-Security-Policy: frame-ancestors` por tenant** en las páginas públicas
(`/booking*`, portal), permitiendo `'self'` más `website_url` y `public_domain` del tenant (y `www.`). nginx no fija
esa cabecera en esas rutas ni la oculta; solo pone `frame-ancestors 'self'` en el resto (app de staff). Motivo:
nginx no conoce los dominios permitidos de cada tenant, y mantenerlos en nginx obligaría a recargar por cada alta.
Si la app olvida emitir la cabecera en una ruta pública, esa ruta sería embebible: el test de rutas debe vigilarlo.

## Backups

- **Completo (todos los tenants):** `scripts/backup-db.sh` (timer diario 03:00, retención 14 días, `pg_dump -Fc`).
  Restaurar: `pg_restore -d <db> --clean --if-exists <fichero>.dump`.
- **Un tenant:** `bun scripts/export-tenant.ts --tenant=<slug>` → NDJSON por tabla (sin secretos ni hashes por defecto).
  Útil para entregar datos a un cliente o auditar; la restauración de un solo tenant sobre una BD viva NO está automatizada.
- Copia los `.dump` fuera del servidor (rclone/borg); un backup en el mismo disco no es un backup.
