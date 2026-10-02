# Plantilla nginx de la PLATAFORMA (una instancia multi-tenant).
# Render: DOMAIN=booking.ejemplo.com PORT=3000 ENV=prod BASE_DIR=/srv/betan-bm deploy/render.sh deploy/nginx.conf.tpl
#
# Tres piezas:
#   1. Servidor de la plataforma ({{DOMAIN}}): app de staff + API + páginas públicas.
#   2. include de /etc/nginx/betan-bm/{{ENV}}/*.conf: un fichero por dominio de cliente
#      (generado con deploy/add-domain.sh a partir de nginx-tenant.conf.tpl).
#   3. default_server que corta (444) cualquier Host no declarado, para que un
#      dominio apuntado por error a esta IP no llegue nunca a la app.
#
# Aislamiento de iframes (frame-ancestors): la app añade la cabecera
# Content-Security-Policy por tenant (según su website_url/public_domain) en las
# páginas públicas /booking* y portal. nginx NO la fija en esas rutas y no
# oculta la de la app; solo pone un valor restrictivo por defecto en el resto.

upstream betan_bm_{{ENV}} {
    server 127.0.0.1:{{PORT}};
    keepalive 16;
}

# 3. Host desconocido (HTTP y HTTPS)
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_certificate     /etc/letsencrypt/live/{{DOMAIN}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{DOMAIN}}/privkey.pem;
    return 444;
}

# 1. Plataforma
server {
    server_name {{DOMAIN}};

    client_max_body_size 25m;

    # Widget embebible / páginas públicas: la CSP frame-ancestors la pone la app por tenant.
    location ~ ^/(booking|portal|room|contract) {
        proxy_pass http://betan_bm_{{ENV}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
        # Sin add_header aquí: manda la cabecera de la app.
    }

    location / {
        proxy_pass http://betan_bm_{{ENV}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;

        # La app de staff nunca debe poder enmarcarse en otro sitio.
        add_header Content-Security-Policy "frame-ancestors 'self'" always;
        add_header X-Content-Type-Options nosniff always;
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/{{DOMAIN}}/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/{{DOMAIN}}/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}
server {
    listen 80;
    server_name {{DOMAIN}};
    return 301 https://$host$request_uri;
}

# 2. Dominios de clientes
include /etc/nginx/betan-bm/{{ENV}}/*.conf;
