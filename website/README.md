# Web de Betan (www.betanbm.com)

Web comercial estática + backend **Bun + Hono** (`server/`) que sirve las páginas, recibe el formulario de
contacto, cuenta visitas sin cookies y ofrece un panel mínimo de leads.

```
website/
├── index.html · legal.html · 404.html     páginas
├── guias/                                 guías SEO (/guias/…)
├── assets/                                fuentes propias, iconos, consent.js (aviso de cookies), guide.css
├── sitemap.xml · robots.txt · manifest.webmanifest
├── server/                                backend Bun + Hono (API, estáticos, SQLite)
└── deploy/                                nginx, systemd y deploy.sh
```

## En local
```bash
cd website/server
bun install
bun run dev            # http://127.0.0.1:3100  (sirve la web y la API)
bun test               # 19 tests (formulario, eventos, guía bajo solicitud, límites, admin, estáticos)
```
Sin SMTP configurado, el formulario guarda el lead en SQLite (`server/data/web.db`) y avisa por consola.

## API
| Ruta | Qué hace |
|---|---|
| `POST /api/contact` | Solicitud de demo. Valida (zod), honeypot, tiempo mínimo, 5/h y 20/día por IP, rechaza otros orígenes, evita duplicados. Guarda el lead y envía aviso + autorrespuesta por correo. |
| `POST /api/hit` | Visita anónima (solo si el visitante aceptó el aviso de cookies): día + página + origen. Sin IP ni cookies. |
| `POST /api/events` | Interacciones anónimas (clics, secciones vistas, scroll, tiempo, FAQ, pasos del formulario). Solo si se aceptó el aviso de cookies (`assets/track.js`). |
| `POST /api/docs-request` | Pide la guía de usuario: guarda el lead y envía por email un enlace firmado, válido `DOCS_TTL_DAYS` (30). |
| `GET /docs/:token[/:capítulo]` | La guía (Markdown en `server/content/manual/`). `noindex`, sin referrer; enlace inválido o caducado → 404. |
| `GET /panel` | Panel de métricas y leads (pide `ADMIN_TOKEN`; el HTML no contiene datos). |
| `GET /api/admin/summary?days=30` | Resumen de interacciones: embudo del formulario, alcance por sección, scroll, tiempo, clics, FAQ. |
| `GET /api/health` | Estado y si hay SMTP. |
| `GET /api/admin/leads` · `/leads.csv` · `/stats?days=30` | Panel (cabecera `Authorization: Bearer $ADMIN_TOKEN`). |

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://www.betanbm.com/api/admin/leads
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://www.betanbm.com/api/admin/stats
```

## Qué se mide (solo con consentimiento)
Páginas y origen, clics en enlaces y botones (por tipo: `cta`, `nav`, `contact:whatsapp`, `outbound:…`), secciones que llegan a verse,
scroll (25/50/75/100 %), tiempo activo, FAQ abiertas, pasos del formulario (qué campos se completan, errores de validación, abandono),
dispositivo (móvil/tablet/escritorio) y errores JS. **Nunca** lo que se escribe. Sin cookies, sin IP; cada visita lleva un id aleatorio
que no persiste. Retención: `EVENTS_RETENTION_DAYS` (395). Abre `/panel` con tu `ADMIN_TOKEN`.

## Guía de usuario bajo solicitud (`/documentacion`)
Landing indexable con formulario → email con enlace personal firmado. El contenido está en `server/content/manual/*.md`
(copia saneada de `docs/user/`: sin nombres del primer cliente). Edita los `.md` y despliega; no hace falta tocar HTML.
Cada solicitud queda como lead (`kind=docs`) con nº de accesos y último acceso; la casilla de novedades es opcional (RGPD).

## Pliego de condiciones (`/condiciones`)
Página + PDF descargable (`/descargas/pliego-de-condiciones-betan.pdf`). El PDF se regenera con `bun run pdf` (necesita Chromium; `deploy.sh`
lo hace solo). Importes y SLA salen de `marketing/02-PRECIOS.md`: si cambias precios, actualiza `condiciones.html` y regenera el PDF.
**Hazlo revisar por un asesor/abogado antes de usarlo como contrato.**

## Puesta en marcha en el servidor (una vez)
Requisitos: Bun, nginx, certbot. DNS de `betanbm.com` y `www` apuntando al servidor.

```bash
sudo mkdir -p /srv/betanbm/server/data /var/www/certbot
sudo chown -R $USER /srv/betanbm && sudo chown www-data /srv/betanbm/server/data
# 1. .env (copia server/.env.example y rellena SMTP_PASS, HASH_SALT, ADMIN_TOKEN)
nano /srv/betanbm/server/.env
# 2. servicio
sudo cp deploy/betanbm-web.service /etc/systemd/system/   # revisa User y ruta de bun
sudo systemctl daemon-reload && sudo systemctl enable betanbm-web
# 3. nginx fase 1 (HTTP) -> certificado -> fase 2 (HTTPS)
sudo cp deploy/nginx-betanbm-http.conf /etc/nginx/sites-available/betanbm.com
sudo ln -sf /etc/nginx/sites-available/betanbm.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/certbot -d betanbm.com -d www.betanbm.com
sudo cp deploy/nginx-betanbm.conf /etc/nginx/sites-available/betanbm.com
sudo nginx -t && sudo systemctl reload nginx
```
`www-data` debe poder ejecutar `sudo systemctl restart betanbm-web` sin contraseña para el usuario de despliegue
(`/etc/sudoers.d/betanbm`: `usuario ALL=(root) NOPASSWD: /bin/systemctl restart betanbm-web`).

Gmail como SMTP: activa la verificación en dos pasos y crea una *contraseña de aplicación*
(https://myaccount.google.com/apppasswords) para `SMTP_PASS`.

## Scripts (`npm run` o `bun run`, desde `website/`)
| Script | Qué hace |
|---|---|
| `deploy` | Despliegue completo a producción: guarda de marcadores → tests → sitemap → PDF → rsync → `bun install` → reinicio → healthcheck |
| `deploy:dry` | Simulación del anterior (solo muestra qué cambiaría) |
| `deploy:test` | Despliegue **local**: construye lo mismo, lo instala en `website/.local-deploy/`, arranca el servidor en `http://127.0.0.1:3100`, lanza ~25 comprobaciones y lo deja en marcha (Ctrl-C para parar). `PORT=3200` para otro puerto |
| `deploy:check` | Igual que `deploy:test` pero termina tras las comprobaciones (código ≠ 0 si falla; útil para CI) |
| `dev` · `test` · `sitemap` · `pdf` | Servidor con recarga, tests, regenerar `sitemap.xml`, regenerar el PDF del pliego |

Variables de `deploy`: `DEPLOY_USER`/`DEPLOY_HOST`, `DEPLOY_PATH` (`/srv/betanbm`), `SKIP_TESTS=1`, `FORCE=1`.

## Desplegar
```bash
bash website/deploy/deploy.sh -n   # simulación
bash website/deploy/deploy.sh      # tests + sitemap + rsync + bun install + restart + healthcheck
```
`server/.env`, `server/data/` y `node_modules` viven en el servidor y no se tocan. El script se niega a publicar si
quedan marcadores `[DATO REAL]`, `[PLACEHOLDER]` o `[COMPLETAR]` (`FORCE=1` para saltarlo).

## SEO: qué hay y qué hacer tras publicar
Ya hecho: títulos y descripciones únicos, canonical, hreflang, Open Graph y Twitter con `og.png`, JSON-LD
(Organization, WebSite, SoftwareApplication con precios, FAQPage, Article y BreadcrumbList), `sitemap.xml`
con `lastmod` (`bun run sitemap`), `robots.txt`, 5 páginas de contenido (`/guias/…`), URLs limpias con
redirección 301 desde `.html`, 404 propio con `noindex`, iconos y manifest, fuentes propias con `preload`
(sin peticiones a terceros), compresión gzip, caché por tipo y cabeceras de seguridad.

Pendiente de tu lado, ya con el dominio online:
1. **Google Search Console**: añade `https://www.betanbm.com`, verifica el dominio (registro TXT en DNS) y envía `sitemap.xml`.
2. **Bing Webmaster Tools** (importa desde Search Console).
3. Comprueba los datos estructurados en https://search.google.com/test/rich-results y la tarjeta social en el depurador de Facebook/LinkedIn.
4. Mide con https://pagespeed.web.dev/ (móvil).
5. **Google Business Profile** con la web enlazada, y enlaces desde perfiles propios (LinkedIn, asociaciones, partners).
6. Publica una guía nueva cada mes (copia una de `guias/`, añádela a `guias/index.html` y ejecuta `bun run sitemap`).

## Privacidad (RGPD / LSSI)
- Aviso de cookies (`assets/consent.js`): «Rechazar» y «Aceptar» con el mismo peso; la analítica propia solo corre tras aceptar.
- `legal.html` describe el tratamiento real: leads en BD propia, 24 meses de conservación (`LEADS_RETENTION_DAYS`),
  IP guardada solo como hash, encargados (hosting y Gmail).
- Si cambias de proveedor de correo o hosting, actualiza «Destinatarios» en `legal.html`.
- Los correos en frío a hoteles están sujetos al art. 21 de la LSSI; el formulario de la web, en cambio, es una solicitud del propio interesado.

## Antes de publicar
- `CONFIG` (al final de `index.html`): email y WhatsApp de contacto.
- Rellena la guarda de plantilla: busca `[DATO REAL]`, `[PLACEHOLDER]`, `[COMPLETAR]`.
- Lo marcado como «Próximamente» (envío automático de SES, Salto/Nuki/Dormakaba…) no debe presentarse como disponible.
