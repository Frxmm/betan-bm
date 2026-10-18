// Backend de www.betanbm.com (Bun + Hono): formulario de contacto, analítica
// sin cookies, panel de leads y servidor de la web estática.
import { config, smtpConfigured, assertSecure } from './src/config'
import { openDb, purgeOldLeads, purgeOldEvents } from './src/db'
import { createApp } from './src/app'

const db = openDb()
const purged = purgeOldLeads(db)
if (purged) console.log(`[retención] ${purged} leads antiguos borrados`)
purgeOldEvents(db)
setInterval(() => { try { purgeOldLeads(db); purgeOldEvents(db) } catch (e) { console.error('[retención]', e) } }, 24 * 3_600_000).unref()

const app = createApp(db)

assertSecure()
console.log(`[web] http://127.0.0.1:${config.port} · estáticos: ${config.staticDir} · SMTP: ${smtpConfigured() ? 'sí' : 'NO configurado'} · admin: ${config.adminToken ? 'sí' : 'no'}`)

export default { port: config.port, hostname: '127.0.0.1', fetch: app.fetch }
