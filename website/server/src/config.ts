// Configuración del backend de la web comercial. Todo por variables de entorno
// (Bun carga .env solo). Ver .env.example.
import { resolve } from 'node:path'

const env = process.env
const bool = (v: string | undefined, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes'].includes(v.toLowerCase()))

export const config = {
  port: Number(env.PORT ?? 3100),
  siteUrl: (env.SITE_URL ?? 'https://www.betanbm.com').replace(/\/$/, ''),
  /** Raíz de los ficheros estáticos (la carpeta `website/`). */
  staticDir: resolve(env.STATIC_DIR ?? `${import.meta.dir}/../..`),
  dataDir: resolve(env.DATA_DIR ?? `${import.meta.dir}/../data`),
  /** Detrás de nginx: confiar en X-Real-IP / X-Forwarded-For / X-Forwarded-Proto. */
  trustProxy: bool(env.TRUST_PROXY, true),
  /** Redirige betanbm.com → www.betanbm.com también desde la app (nginx ya lo hace). */
  canonicalRedirect: bool(env.CANONICAL_REDIRECT, false),
  /** Sal para anonimizar IPs en BD (cámbiala en producción). */
  hashSalt: env.HASH_SALT ?? 'cambia-esta-sal',
  adminToken: env.ADMIN_TOKEN ?? '',
  /** Clave para firmar los enlaces de la documentación (por defecto, HASH_SALT). */
  docsSecret: env.DOCS_SECRET ?? env.HASH_SALT ?? 'cambia-esta-sal',
  docsTtlDays: Number(env.DOCS_TTL_DAYS ?? 30),
  retentionDays: Number(env.LEADS_RETENTION_DAYS ?? 730),
  eventsRetentionDays: Number(env.EVENTS_RETENTION_DAYS ?? 395),
  mail: {
    host: env.SMTP_HOST ?? '',
    port: Number(env.SMTP_PORT ?? 587),
    secure: bool(env.SMTP_SECURE, false),
    user: env.SMTP_USER ?? '',
    pass: env.SMTP_PASS ?? '',
    from: env.MAIL_FROM ?? 'Betan <fco.rubio.ortega@gmail.com>',
    to: env.MAIL_TO ?? 'fco.rubio.ortega@gmail.com',
    autoReply: bool(env.MAIL_AUTOREPLY, true),
  },
  /** Orígenes aceptados en POST (además de siteUrl y su variante sin/con www). */
  extraOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:3100').split(',').map(s => s.trim()).filter(Boolean),
}

/** En producción no se arranca con secretos por defecto o débiles (permitirían falsificar enlaces de la guía). */
export function assertSecure(): void {
  if (env.NODE_ENV !== 'production') return
  const bad: string[] = []
  if (config.hashSalt === 'cambia-esta-sal' || config.hashSalt.length < 16) bad.push('HASH_SALT')
  if (config.docsSecret === 'cambia-esta-sal' || config.docsSecret.length < 24) bad.push('DOCS_SECRET (≥24 caracteres)')
  if (config.adminToken && config.adminToken.length < 24) bad.push('ADMIN_TOKEN (≥24 caracteres o vacío para desactivarlo)')
  if (bad.length) { console.error(`[config] Secretos ausentes o débiles en server/.env: ${bad.join(', ')}`); process.exit(1) }
}

export const smtpConfigured = () => !!(config.mail.host && config.mail.user && config.mail.pass)
