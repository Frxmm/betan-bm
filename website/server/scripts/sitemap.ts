// Genera ../sitemap.xml a partir de las páginas HTML indexables (lastmod = fecha de modificación).
// Uso: bun run sitemap   (ejecútalo antes de desplegar)
import { Glob } from 'bun'
import { stat } from 'node:fs/promises'
import { config } from '../src/config'

const root = config.staticDir
const urls: { loc: string; lastmod: string; priority: string }[] = []

for await (const rel of new Glob('**/*.html').scan({ cwd: root })) {
  if (/^(server|deploy|node_modules|data|\.local-deploy)\//.test(rel) || rel === '404.html') continue
  const file = `${root}/${rel}`
  const html = await Bun.file(file).text()
  if (/<meta[^>]+name="robots"[^>]+noindex/i.test(html)) continue
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1]
  const path = '/' + rel.replace(/(?:^|\/)index\.html$/, m => (m.startsWith('/') ? '/' : '')).replace(/\.html$/, '')
  const loc = canonical ?? config.siteUrl + (path === '/' ? '/' : path)
  const lastmod = new Date((await stat(file)).mtimeMs).toISOString().slice(0, 10)
  urls.push({ loc, lastmod, priority: loc === config.siteUrl + '/' ? '1.0' : loc.endsWith('/guias/') ? '0.8' : '0.7' })
}
urls.sort((a, b) => a.loc.length - b.loc.length || a.loc.localeCompare(b.loc))

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`
await Bun.write(`${root}/sitemap.xml`, xml)
console.log(`sitemap.xml: ${urls.length} URLs`)
for (const u of urls) console.log('  ' + u.loc)
