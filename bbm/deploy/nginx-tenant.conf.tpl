# Dominio propio de UN tenant (properties.public_domain = {{TENANT_DOMAIN}}).
# Lo genera deploy/add-domain.sh; certbot añade luego el bloque SSL.
# El tenant se resuelve en la app por el Host (X-Forwarded-Host).
server {
    listen 80;
    server_name {{TENANT_DOMAIN}};

    client_max_body_size 25m;

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
        # frame-ancestors lo emite la app por tenant en las páginas públicas.
    }
}
