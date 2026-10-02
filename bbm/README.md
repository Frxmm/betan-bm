# betan-bm

PMS multi-tenant para hoteles (reservas, calendario, housekeeping, caja, facturación, motor de reservas, portal del huésped).
Una instancia sirve a varios hoteles; cada hotel es un tenant (`properties`).

```bash
bun install
bun run dev                      # servidor con hot reload
bun test                         # tests (incluye aislamiento multi-tenant)
```

## Tenants

```bash
bun scripts/create-tenant.ts --slug=hotel-sol --name="Hotel Sol" --admin-email=dir@hotelsol.com
bun scripts/create-user.ts --tenant=hotel-sol --email=ana@hotelsol.com --first=Ana --roles=recepcion
bun scripts/create-user.ts --tenant=hotel-sol --email=yo@plataforma.com --first=Yo --platform-admin
bun scripts/export-tenant.ts --tenant=hotel-sol
```

Los scripts de `scripts/` reciben `--tenant=<slug>` (o env `TENANT`).

## Docs y despliegue

- Arquitectura multi-tenant: `../docs/04-MULTITENANT.md`
- Despliegue, nginx, certbot y backups: `deploy/README.md`
