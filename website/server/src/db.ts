// SQLite embebido (bun:sqlite). Sin servidor de BD que mantener.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { config } from './config'

export function openDb(path?: string): Database {
  if (!path) { mkdirSync(config.dataDir, { recursive: true }); path = `${config.dataDir}/web.db` }
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      hotel       TEXT NOT NULL,
      rooms       INTEGER,
      phone       TEXT,
      plan        TEXT,
      message     TEXT,
      source      TEXT,            -- utm_source / referrer
      ip_hash     TEXT,
      user_agent  TEXT,
      mail_status TEXT NOT NULL DEFAULT 'pending'   -- pending | sent | failed | not_configured
    );
    CREATE INDEX IF NOT EXISTS leads_created ON leads (created_at DESC);
    -- Interacciones anónimas (solo con consentimiento). vid = id aleatorio de UNA carga de página:
    -- no persiste entre visitas, no se vincula a ninguna persona.
    CREATE TABLE IF NOT EXISTS events (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     TEXT NOT NULL DEFAULT (datetime('now')),
      day    TEXT NOT NULL DEFAULT (date('now')),
      vid    TEXT NOT NULL,
      path   TEXT NOT NULL,
      type   TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      label  TEXT NOT NULL DEFAULT '',
      value  REAL,
      device TEXT NOT NULL DEFAULT '',
      ref    TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS events_day_type ON events (day, type);
    CREATE INDEX IF NOT EXISTS events_vid ON events (vid);
    CREATE TABLE IF NOT EXISTS pageviews (
      day      TEXT NOT NULL,
      path     TEXT NOT NULL,
      referrer TEXT NOT NULL DEFAULT '',
      n        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, path, referrer)
    );
  `)
  // Migraciones ligeras (columnas añadidas después)
  const cols = new Set((db.query(`PRAGMA table_info(leads)`).all() as { name: string }[]).map(c => c.name))
  const add = (name: string, ddl: string) => { if (!cols.has(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${ddl}`) }
  add('kind', `kind TEXT NOT NULL DEFAULT 'demo'`)               // demo | docs
  add('role', `role TEXT`)                                       // puesto (solo docs)
  add('marketing_ok', `marketing_ok INTEGER NOT NULL DEFAULT 0`) // acepta novedades (opcional)
  add('docs_views', `docs_views INTEGER NOT NULL DEFAULT 0`)
  add('last_access', `last_access TEXT`)
  db.exec(`CREATE INDEX IF NOT EXISTS leads_email ON leads (email, kind)`)
  return db
}

/** Borra eventos más antiguos que el plazo de conservación. */
export function purgeOldEvents(db: Database, days = config.eventsRetentionDays): number {
  if (!days || days <= 0) return 0
  return db.query(`DELETE FROM events WHERE ts < datetime('now', ?)`).run(`-${Math.floor(days)} days`).changes
}

/** Borra leads más antiguos que el plazo de conservación (RGPD: minimización). */
export function purgeOldLeads(db: Database, days = config.retentionDays): number {
  if (!days || days <= 0) return 0
  return db.query(`DELETE FROM leads WHERE created_at < datetime('now', ?)`).run(`-${Math.floor(days)} days`).changes
}
