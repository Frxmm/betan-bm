import { test, expect, beforeEach } from 'bun:test'
import { openDb } from '../src/db'
import { createApp } from '../src/app'
import { mailer } from '../src/mail'
import { config } from '../src/config'

config.adminToken = 'test-admin-token'

let db: ReturnType<typeof openDb>
let app: ReturnType<typeof createApp>
const sent: any[] = []

beforeEach(() => {
  db = openDb(':memory:')
  app = createApp(db, { contact: { minFillMs: 0 } })
  sent.length = 0
  mailer.send = async (o) => { sent.push(o) }
})

const good = { nombre: 'Laura Pérez', email: 'Laura@Hotel.com', hotel: 'Hotel Sol', habitaciones: 18, telefono: '+34 600 111 222', plan: 'Pro', mensaje: 'Quiero ver la demo', consent: true }
const post = (body: unknown, headers: Record<string, string> = {}, ip = '1.1.1.1') =>
  app.request('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip, ...headers }, body: JSON.stringify(body) })

test('guarda el lead (email en minúsculas) y responde ok', async () => {
  const r = await post(good)
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ ok: true })
  const row = db.query('SELECT * FROM leads').get() as any
  expect(row.email).toBe('laura@hotel.com')
  expect(row.rooms).toBe(18)
  expect(row.ip_hash).not.toContain('1.1.1.1')
})

test('exige consentimiento y email válido', async () => {
  expect((await post({ ...good, consent: false })).status).toBe(400)
  const r = await post({ ...good, email: 'no-es-email' })
  expect(r.status).toBe(400)
  expect((await r.json() as any).fields.email).toBeTruthy()
  expect(db.query('SELECT COUNT(*) n FROM leads').get()).toEqual({ n: 0 })
})

test('honeypot relleno: responde ok pero no guarda', async () => {
  const r = await post({ ...good, website: 'http://spam' })
  expect(r.status).toBe(200)
  expect(db.query('SELECT COUNT(*) n FROM leads').get()).toEqual({ n: 0 })
})

test('formulario enviado demasiado rápido se descarta', async () => {
  const strict = createApp(db, { contact: { minFillMs: 5000 } })
  const r = await strict.request('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...good, t: Date.now() }) })
  expect(r.status).toBe(200)
  expect(db.query('SELECT COUNT(*) n FROM leads').get()).toEqual({ n: 0 })
})

test('limita a 5 envíos por hora y por IP', async () => {
  for (let i = 0; i < 5; i++) expect((await post({ ...good, hotel: 'Hotel ' + i }, {}, '9.9.9.9')).status).toBe(200)
  expect((await post({ ...good, hotel: 'Otro' }, {}, '9.9.9.9')).status).toBe(429)
  expect((await post({ ...good, hotel: 'Otro' }, {}, '8.8.8.8')).status).toBe(200)
})

test('duplicado reciente no crea otro lead', async () => {
  await post(good); await post(good)
  expect(db.query('SELECT COUNT(*) n FROM leads').get()).toEqual({ n: 1 })
})

test('rechaza orígenes ajenos', async () => {
  expect((await post(good, { Origin: 'https://malo.example' })).status).toBe(403)
  expect((await post(good, { Origin: 'https://www.betanbm.com' }, '2.2.2.2')).status).toBe(200)
})

test('sin SMTP el lead queda como not_configured', async () => {
  await post(good)
  await Bun.sleep(20)
  expect((db.query('SELECT mail_status s FROM leads').get() as any).s).toBe('not_configured')
})

test('hit cuenta visitas sin datos personales y filtra bots', async () => {
  const hit = (body: unknown, ua = 'Mozilla/5.0 Chrome') =>
    app.request('/api/hit', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua }, body: JSON.stringify(body) })
  expect((await hit({ path: '/', ref: 'https://www.google.com/search?q=x' })).status).toBe(204)
  await hit({ path: '/', ref: 'https://www.google.com/' })
  await hit({ path: '/', ref: '' }, 'Googlebot/2.1')
  await hit({ path: '/../etc/passwd' })
  const rows = db.query('SELECT path, referrer, n FROM pageviews').all()
  expect(rows).toEqual([{ path: '/', referrer: 'google.com', n: 2 }])
})

test('admin exige token', async () => {
  expect((await app.request('/api/admin/leads')).status).toBe(401)
  await post(good)
  const r = await app.request('/api/admin/leads', { headers: { Authorization: 'Bearer test-admin-token' } })
  expect(r.status).toBe(200)
  expect((await r.json() as any).data).toHaveLength(1)
})

test('CSV neutraliza fórmulas', async () => {
  await post({ ...good, hotel: '=HYPERLINK("x")' })
  const r = await app.request('/api/admin/leads.csv', { headers: { Authorization: 'Bearer test-admin-token' } })
  expect(await r.text()).toContain(`'=HYPERLINK`)
})

test('estáticos: / y URLs limpias, 404 y ficheros privados bloqueados', async () => {
  expect((await app.request('/')).status).toBe(200)
  expect((await app.request('/index.html')).status).toBe(301)
  expect((await app.request('/server/.env')).status).toBe(404)
  expect((await app.request('/server/package.json')).status).toBe(404)
  expect((await app.request('/README.md')).status).toBe(404)
  const nf = await app.request('/no-existe')
  expect(nf.status).toBe(404)
  expect(nf.headers.get('x-robots-tag')).toBe('noindex')
  expect((await app.request('/%2e%2e/%2e%2e/etc/passwd')).status).toBe(404)
  expect((await app.request('/', { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security')).toBeTruthy()
})

// ── Interacciones ───────────────────────────────────────────────────────────
const ev = (body: unknown, ua = 'Mozilla/5.0 Chrome') =>
  app.request('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua, 'X-Real-IP': '3.3.3.3' }, body: JSON.stringify(body) })

test('events guarda lotes válidos y descarta basura y bots', async () => {
  const ok = { vid: 'abc12345-6789', path: '/', dev: 'm', ref: 'google.com', events: [
    { t: 'view', g: '/', l: 'Betan', v: 390 }, { t: 'click', g: 'cta:anchor:#contacto', l: 'Pedir demo' }, { t: 'scroll', g: '50', v: 4200 }] }
  expect((await ev(ok)).status).toBe(204)
  await ev({ ...ok, vid: 'zz' })                                   // vid inválido
  await ev({ ...ok, path: '/../x' })                               // path inválido
  await ev({ ...ok, events: [{ t: 'hack', g: 'x' }] })              // tipo no permitido
  await ev(ok, 'Googlebot/2.1')                                    // bot
  const rows = db.query('SELECT type, target, device, ref FROM events ORDER BY id').all()
  expect(rows).toEqual([
    { type: 'view', target: '/', device: 'm', ref: 'google.com' },
    { type: 'click', target: 'cta:anchor:#contacto', device: 'm', ref: 'google.com' },
    { type: 'scroll', target: '50', device: 'm', ref: 'google.com' },
  ])
})

test('events limpia caracteres raros del texto', async () => {
  await ev({ vid: 'abc12345-6789', path: '/', events: [{ t: 'click', g: 'x<script>', l: 'Hola\u0000 <b>mundo</b>' }] })
  const r = db.query('SELECT target, label FROM events').get() as any
  expect(r.target).not.toContain('<'); expect(r.label).not.toContain('<')
})

test('summary calcula embudo y alcance', async () => {
  const send = (vid: string, evs: any[]) => ev({ vid, path: '/', dev: 'd', events: evs })
  await send('visit-0001-aaaa', [{ t: 'view', g: '/' }, { t: 'section', g: 'contacto' }, { t: 'form', g: 'form:start' }, { t: 'form', g: 'form:submit' }, { t: 'form', g: 'form:success' }, { t: 'time', g: 'active_s', v: 42 }])
  await send('visit-0002-bbbb', [{ t: 'view', g: '/' }, { t: 'section', g: 'contacto' }, { t: 'form', g: 'form:start' }, { t: 'form', g: 'form:abandon', v: 2 }])
  await send('visit-0003-cccc', [{ t: 'view', g: '/' }, { t: 'faq', g: 'open', l: '¿Cobráis comisión?' }])
  const r = await app.request('/api/admin/summary?days=7', { headers: { Authorization: 'Bearer test-admin-token' } })
  const s = await r.json() as any
  expect(s.views).toBe(3)
  expect(s.formFunnel).toMatchObject({ homeViews: 3, reachedContact: 2, started: 2, submitted: 1, success: 1, abandoned: 1 })
  expect(s.activeSeconds.p50).toBe(42)
  expect(s.faq[0].label).toBe('¿Cobráis comisión?')
})

test('panel es HTML sin datos y noindex', async () => {
  const r = await app.request('/panel')
  expect(r.status).toBe(200); expect(r.headers.get('x-robots-tag')).toContain('noindex')
  expect(await r.text()).not.toContain('test-admin-token')
})

// ── Documentación bajo solicitud ────────────────────────────────────────────
const docsBody = { nombre: 'Marta Ruiz', email: 'Marta@Hotel.es', hotel: 'Hostal Mar', puesto: 'Recepción', novedades: false, consent: true }
const reqDocs = (b: unknown, ip = '4.4.4.4') => app.request('/api/docs-request', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: JSON.stringify(b) })

test('docs: pedir la guía guarda el lead y envía el enlace solo por email', async () => {
  config.mail.host = 'smtp.test'; config.mail.user = 'u'; config.mail.pass = 'p'
  try {
    const r = await reqDocs(docsBody)
    expect(r.status).toBe(200)
    expect(JSON.stringify(await r.json())).not.toContain('/docs/')          // la respuesta no filtra el enlace
    await Bun.sleep(30)
    const toUser = sent.find(m => m.to === 'marta@hotel.es')
    expect(toUser.text).toMatch(/https:\/\/www\.betanbm\.com\/docs\/[\w-]+\.[\w-]+/)
    expect(db.query(`SELECT kind, role FROM leads`).get()).toEqual({ kind: 'docs', role: 'Recepción' })
  } finally { config.mail.host = ''; config.mail.user = ''; config.mail.pass = '' }
})

test('docs: con el enlace se ve la guía; sin él, o manipulado o caducado, no', async () => {
  config.mail.host = 'smtp.test'; config.mail.user = 'u'; config.mail.pass = 'p'
  try {
    await reqDocs(docsBody); await Bun.sleep(30)
    const link = sent.find(m => m.to === 'marta@hotel.es').text.match(/https:\/\/www\.betanbm\.com(\/docs\/[^\s]+)/)[1] as string
    const ok = await app.request(link)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('x-robots-tag')).toContain('noindex')
    expect(ok.headers.get('referrer-policy')).toBe('no-referrer')
    const html = await ok.text()
    expect(html).toContain('Guía de usuario'); expect(html).toContain('Marta Ruiz')
    expect(html).toContain(`${link}/01-primeros-pasos`)                      // enlaces entre capítulos con token
    expect((await app.request(`${link}/02-recepcion-dia-a-dia`)).status).toBe(200)
    expect((await app.request(`${link}/99-no-existe`)).status).toBe(404)
    expect((await app.request(link.slice(0, -3) + 'xyz')).status).toBe(404)   // firma alterada
    expect((await app.request('/docs/garbage')).status).toBe(404)
    expect((db.query('SELECT docs_views v FROM leads').get() as any).v).toBe(2)
    const { makeToken, verifyToken } = await import('../src/docs')
    expect(verifyToken(makeToken(1, Date.now() - 31 * 86_400_000))).toBeNull() // caducado
  } finally { config.mail.host = ''; config.mail.user = ''; config.mail.pass = '' }
})

test('docs: exige consentimiento y limita por email', async () => {
  expect((await reqDocs({ ...docsBody, consent: false })).status).toBe(400)
  for (let i = 0; i < 5; i++) await reqDocs(docsBody, '5.5.5.' + i)
  await Bun.sleep(30)
  expect(sent.filter(m => m.to === 'marta@hotel.es').length).toBeLessThanOrEqual(3)
})
