// Guía de usuario con acceso por solicitud: enlace firmado (HMAC) con caducidad,
// contenido en Markdown (server/content/manual) renderizado en el servidor.
import { createHmac } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { Marked } from 'marked'
import { config } from './config'
import { safeEqual, escapeHtml } from './util'

const DIR = `${import.meta.dir}/../content/manual`
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const sign = (p: string) => createHmac('sha256', config.docsSecret).update(p).digest('base64url')

export function makeToken(leadId: number, now = Date.now()): string {
  const payload = b64(JSON.stringify({ l: leadId, e: Math.floor(now / 1000) + config.docsTtlDays * 86400 }))
  return `${payload}.${sign(payload)}`
}

/** Devuelve el id del lead si el token es válido y no ha caducado. */
export function verifyToken(token: string, now = Date.now()): number | null {
  const [payload, sig] = token.split('.')
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null
  try {
    const { l, e } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return Number.isInteger(l) && typeof e === 'number' && e * 1000 > now ? l : null
  } catch { return null }
}

export const docsUrl = (token: string) => `${config.siteUrl}/docs/${token}`

// ── Contenido ────────────────────────────────────────────────────────────────
export interface Chapter { slug: string; title: string; md: string }
let cache: Chapter[] | null = null

export async function chapters(): Promise<Chapter[]> {
  if (cache) return cache
  const files = (await readdir(DIR)).filter(f => /^\d\d-[a-z0-9-]+\.md$/i.test(f)).sort()
  cache = await Promise.all(files.map(async f => {
    const md = await Bun.file(`${DIR}/${f}`).text()
    return { slug: f.replace(/\.md$/, ''), title: md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? f, md }
  }))
  return cache
}

const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const marked = new Marked({ gfm: true, breaks: false })
marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens)
      const id = slugify(text.replace(/<[^>]+>/g, ''))
      return `<h${depth} id="${id}">${text}</h${depth}>\n`
    },
    // Nada de HTML crudo del markdown en la salida.
    html({ text }) { return escapeHtml(text) },
  },
})

export function renderMarkdown(md: string, token: string): string {
  const html = marked.parse(md, { async: false }) as string
  // enlaces entre capítulos: 02-recepcion-dia-a-dia.md#x → /docs/<token>/02-recepcion-dia-a-dia#x
  return html.replace(/href="(\d\d-[a-z0-9-]+)\.md(#[^"]*)?"/gi, (_m, slug, hash) => `href="/docs/${token}/${slug}${hash ?? ''}"`)
}

export function pageHtml(opts: { token: string; title: string; slug: string; body: string; list: Chapter[]; who: string }): string {
  const { token, title, slug, body, list, who } = opts
  const i = list.findIndex(c => c.slug === slug)
  const prev = i > 0 ? list[i - 1] : null, next = i >= 0 && i < list.length - 1 ? list[i + 1] : null
  const nav = list.map(c => `<a href="/docs/${token}/${c.slug}"${c.slug === slug ? ' aria-current="page"' : ''}>${escapeHtml(c.title.replace(/^Betan Booking Manager\s*[—-]\s*/, ''))}</a>`).join('')
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Guía de usuario Betan</title>
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/fonts/fonts.css"><link rel="stylesheet" href="/assets/guide.css">
<style>
.dwrap{display:grid;grid-template-columns:260px minmax(0,1fr);gap:32px;max-width:72rem;margin:0 auto;padding:8px 20px 72px}
.dnav{position:sticky;top:12px;align-self:start;display:grid;gap:2px;font-size:.95rem}.dnav a{padding:7px 10px;border-radius:8px;text-decoration:none;color:var(--muted)}
.dnav a[aria-current]{background:var(--surface);color:var(--ink);font-weight:700;border:1px solid var(--line)}
.dmain{min-width:0}.dmain h1{font-size:2rem}.dmain img{max-width:100%}.dmain pre{overflow:auto;background:var(--sunk);padding:12px;border-radius:8px}
.dmain code{background:var(--sunk);padding:1px 5px;border-radius:5px;font-size:.92em}.dmain pre code{padding:0;background:none}
.dmain table{display:block;overflow-x:auto}.pn{display:flex;justify-content:space-between;gap:12px;margin-top:3em}
.who{color:var(--muted);font-size:.9rem;margin:0 0 8px}
@media(max-width:860px){.dwrap{grid-template-columns:1fr}.dnav{position:static}}
@media print{.g-top,.dnav,.pn,footer{display:none}.dwrap{display:block}}
</style></head><body>
<header class="g-top"><a class="brand" href="/" aria-label="Betan, inicio">Betan</a><nav><a href="/documentacion">Documentación</a><a class="btn" href="/#contacto">Pedir demo</a></nav></header>
<div class="dwrap"><nav class="dnav" aria-label="Capítulos">${nav}</nav>
<article class="dmain"><p class="who">Acceso personal de ${escapeHtml(who)}. Guía de usuario de Betan Booking Manager.</p>${body}
<div class="pn">${prev ? `<a href="/docs/${token}/${prev.slug}">← ${escapeHtml(prev.title)}</a>` : '<span></span>'}${next ? `<a href="/docs/${token}/${next.slug}">${escapeHtml(next.title)} →</a>` : ''}</div></article></div>
<footer><p class="legal">¿Dudas o quieres verlo en tu hotel? <a href="mailto:${escapeHtml(config.mail.to)}">${escapeHtml(config.mail.to)}</a></p></footer></body></html>`
}
