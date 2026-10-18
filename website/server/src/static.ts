// Servidor de ficheros estáticos: URLs limpias (/legal, /guias/x), 404 propio,
// caché sensata y bloqueo de lo que no es público (server/, deploy/, .env...).
import type { Context } from 'hono'
import { resolve, sep, extname } from 'node:path'
import { stat } from 'node:fs/promises'
import { config } from './config'

const BLOCKED = /^\/(server|deploy|data|node_modules|\.git)(\/|$)|\/\.|\.(md|sh|ts|tsx|env|db|sql|lock|log|json|ya?ml|toml|lockb|bak|orig|swp|map)$|(^|\/)(bun\.lock|package\.json|tsconfig\.json)$/i

function cacheControl(path: string, isHtml: boolean): string {
  if (isHtml) return 'public, no-cache'
  if (path.startsWith('/assets/fonts/')) return 'public, max-age=31536000, immutable'
  if (/\.(js|css)$/i.test(path)) return 'public, max-age=3600, must-revalidate'
  if (/\.(xml|txt|webmanifest)$/i.test(path)) return 'public, max-age=3600'
  return 'public, max-age=604800'
}

async function findFile(urlPath: string): Promise<{ file: string; isHtml: boolean } | null> {
  const root = config.staticDir
  const base = resolve(root, '.' + urlPath)
  if (base !== root && !base.startsWith(root + sep)) return null
  const candidates = extname(urlPath) ? [base] : [base + '.html', resolve(base, 'index.html')]
  for (const f of candidates) {
    try {
      const s = await stat(f)
      if (s.isFile()) return { file: f, isHtml: f.endsWith('.html') }
    } catch { /* siguiente */ }
  }
  return null
}

export async function serveStaticSite(c: Context): Promise<Response> {
  let path: string
  try { path = decodeURIComponent(new URL(c.req.url).pathname) } catch { return notFound() }
  if (path.includes('\0') || path.includes('..')) return notFound()

  // Una sola URL por contenido (SEO): /index.html → /, /x.html → /x, /dir/index → /dir/
  const m = path.match(/^(.*?)(?:\/index)?\.html$/)
  if (m) {
    const to = (m[1] || '/') + (path.endsWith('/index.html') && m[1] ? '/' : '')
    return c.redirect(to + new URL(c.req.url).search, 301)
  }
  if (path.length > 1 && path.endsWith('/') && !(await isDir(path))) return c.redirect(path.slice(0, -1) + new URL(c.req.url).search, 301)

  if (BLOCKED.test(path)) return notFound()
  const hit = await findFile(path === '/' ? '/index' : path)
  if (!hit) return notFound()

  const bun = Bun.file(hit.file)
  const etag = `W/"${bun.size}-${Math.floor(bun.lastModified)}"`
  const headers = new Headers({
    'Cache-Control': cacheControl(path, hit.isHtml),
    'ETag': etag,
    'Last-Modified': new Date(bun.lastModified).toUTCString(),
  })
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers })
  if (hit.file.endsWith('.webmanifest')) headers.set('Content-Type', 'application/manifest+json')
  if (c.req.method === 'HEAD') {
    headers.set('Content-Type', bun.type); headers.set('Content-Length', String(bun.size))
    return new Response(null, { headers })
  }
  headers.set('Content-Type', bun.type)
  return new Response(bun, { headers })
}

async function isDir(urlPath: string): Promise<boolean> {
  try { return (await stat(resolve(config.staticDir, '.' + urlPath))).isDirectory() } catch { return false }
}

export async function notFound(): Promise<Response> {
  const f = Bun.file(resolve(config.staticDir, '404.html'))
  const body = (await f.exists()) ? await f.text() : '<h1>404</h1>'
  return new Response(body, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } })
}
