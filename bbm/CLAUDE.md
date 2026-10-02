
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Multi-tenant (reglas del proyecto)

Un tenant = una fila de `properties`. Toda petición, scheduler o script corre dentro de un contexto
(`runWithProperty`, `src/lib/property.ts`). Reglas innegociables:

- Nunca escribas un id de propiedad literal: usa `getPropertyId()`. Fuera de contexto lanza error (no hay fallback a 1).
- Toda consulta/actualización/borrado por `:id` añade `property_id = getPropertyId()` (o JOIN al padre): evita IDOR entre tenants.
- Datos del hotel (nombre, CIF, dirección, teléfono, RTA, web, emails, dominio) vienen de `getBranding()`; nunca literales.
- Nada de nombres mágicos ('Dir AL', 'Web directa', 'Stripe online'...): ids/claves en `properties.settings` (`getSetting`).
- Integraciones opcionales detrás de `hasFeature(key)` y credenciales con `getSecret(NAME)` (por tenant, no `.env`).
- Schedulers: cada pasada con `forEachActiveProperty(label, fn, { feature })`. Caches en memoria con clave por tenant.
- Moneda y zona horaria salen de `properties.currencyCode` / `properties.timezone`.
- Scripts: `--tenant=<slug>` (o env `TENANT`) y `withTenant()` de `scripts/lib/tenant.ts`. Lo específico de un cliente concreto vive en `scripts/legacy-betania/` (ignorado por git).
- El único sitio con datos del primer cliente es `scripts/tenant-betania-backfill.sql` (se ejecuta a mano, no es migración).
- `bun test` incluye `tests/tenant-isolation.test.ts`, un análisis estático que falla si reaparecen acoplamientos.

Documentación: `../docs/04-MULTITENANT.md`. Despliegue: `deploy/README.md`.
