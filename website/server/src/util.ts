import type { Context } from 'hono'
import { getConnInfo } from 'hono/bun'
import { createHash, timingSafeEqual } from 'node:crypto'
import { config } from './config'

export function clientIp(c: Context): string {
  if (config.trustProxy) {
    const real = c.req.header('x-real-ip')
    if (real) return real.trim()
    const xff = c.req.header('x-forwarded-for')
    if (xff) return xff.split(',')[0]!.trim()
  }
  try { return getConnInfo(c).remote.address ?? 'unknown' } catch { return 'unknown' }
}

/** IP anonimizada (hash con sal): sirve para limitar abuso sin guardar la IP. */
export const hashIp = (ip: string) => createHash('sha256').update(config.hashSalt + ip).digest('hex').slice(0, 24)

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Quita saltos de línea y caracteres de control (evita inyección en cabeceras de email). */
export const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
export const multiLine = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))

export const isBot = (ua: string | undefined) => !ua || /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|curl|wget|python|headless/i.test(ua)
