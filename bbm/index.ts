import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { env } from './src/lib/env'
import { emit } from './src/lib/log-bus'
import { requireAuth } from './src/middleware/auth'
import { tenantFromJwt, tenantFromRequest } from './src/middleware/tenant'
import authRoutes         from './src/routes/auth'
import userRoutes         from './src/routes/users'
import dashboardRoutes    from './src/routes/dashboard'
import reservationRoutes  from './src/routes/reservations'
import guestRoutes        from './src/routes/guests'
import roomRoutes         from './src/routes/rooms'
import financialRoutes    from './src/routes/financial'
import catalogRoutes      from './src/routes/catalog'
import notificationRoutes from './src/routes/notifications'
import aiRoutes, { startAiScheduledTasksScheduler } from './src/routes/ai'
import settingsRoutes     from './src/routes/settings'
import tenantRoutes, { propertyRoutes } from './src/routes/tenants'
import reportsRoutes      from './src/routes/reports'
import ttlockRoutes       from './src/routes/ttlock'
import zktecoRoutes       from './src/routes/zkteco'
import sesRoutes          from './src/routes/ses'
import housekeepingRoutes from './src/routes/housekeeping'
import laundryRoutes      from './src/routes/laundry'
import nobedsRoutes       from './src/routes/nobeds'
import fdmRoutes           from './src/routes/fdm'
import jumboRoutes         from './src/routes/jumbo'
import postalRoutes       from './src/routes/postal'
import alertRoutes        from './src/routes/alerts'
import engagementRoutes   from './src/routes/engagement'
import feedbackRoutes     from './src/routes/feedback'
import pricingEffectsRoutes from './src/routes/pricing-effects'
import corporateRoutes    from './src/routes/corporate'
import competitorRoutes   from './src/routes/competitors'
import cashDrawerRoutes   from './src/routes/cashdrawer'
import whatsappRoutes     from './src/routes/whatsapp'
import publicRoutes       from './src/routes/public'
import customerRoutes     from './src/routes/customer'
import roomAccessRoutes   from './src/routes/room-access'
import idScanRoutes       from './src/routes/id-scan'
import voiceBriefRoutes   from './src/routes/voice-brief'
import jumboIntegrationRoutes from './src/routes/jumbo-integration'
import floorplanRoutes    from './src/routes/floorplans'
import { startAutoStatusScheduler } from './src/lib/autoStatus'
import { startCartRecoveryScheduler } from './src/lib/cartRecovery'
import { startCancellationRecoveryScheduler } from './src/lib/cancellationRecovery'
import { startEventsScheduler } from './src/lib/eventsScheduler'
import { startPricingRulesScheduler } from './src/lib/pricingRulesEngine'
import { startCompetitorPricingScheduler } from './src/lib/competitorPricing'
import index              from './frontend/index.html'
import bookingHtml        from './frontend-public/booking.html'
import bookingWidgetHtml  from './frontend-public/booking-widget.html'
import portalHtml         from './frontend-public/portal.html'
import portalWidgetHtml  from './frontend-public/portal-widget.html'
import contractHtml      from './frontend-public/contract.html'
import roomHtml           from './frontend-public/room.html'
// Embebido en el binario con bun build --compile (viaja dentro del ELF)

const app = new Hono()

app.use('*', logger((str) => {
  process.stdout.write(str + '\n')
  if (str.includes('-->') || str.includes('<--')) {
    emit('info', 'HTTP', str.replace(/\x1b\[[0-9;]*m/g, '').trim())
  }
}))
app.use('/api/*', cors())

// Rutas públicas (sin auth) — el tenant se resuelve por dominio / ?tenant= / X-Tenant
app.use('/api/public/*', tenantFromRequest)
app.route('/api/auth',           authRoutes)
app.route('/api/public',         publicRoutes)
app.route('/api/zkteco',         zktecoRoutes)   // auth manejado por ruta (enroller key + JWT)
app.route('/api/room-access',    roomAccessRoutes) // auth propia (JWT type='room-guest'), no requireAuth de staff
app.route('/api/voice-brief',    voiceBriefRoutes) // auth propia (token estático de la app Android), no requireAuth de staff
app.route('/api/jumbo-integration', jumboIntegrationRoutes) // auth propia (token estático de jumbo_integration.py), no requireAuth de staff
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

// Todas las demás rutas de API requieren auth
app.use('/api/*', requireAuth)
app.use('/api/*', tenantFromJwt)   // el tenant sale SIEMPRE del JWT

app.route('/api/users',         userRoutes)
app.route('/api/dashboard',     dashboardRoutes)
app.route('/api/reservations',  reservationRoutes)
app.route('/api/guests',        guestRoutes)
app.route('/api/id-scan',       idScanRoutes)
app.route('/api/postal',        postalRoutes)
app.route('/api/rooms',         roomRoutes)
app.route('/api/financial',     financialRoutes)
app.route('/api/catalog',       catalogRoutes)
app.route('/api/notifications', notificationRoutes)
app.route('/api/ai',            aiRoutes)
app.route('/api/tenants',       tenantRoutes)      // solo isPlatformAdmin (requirePlatformAdmin dentro del router)
app.route('/api/settings/property', propertyRoutes) // datos del establecimiento del tenant actual
app.route('/api/settings',      settingsRoutes)
app.route('/api/reports',       reportsRoutes)
app.route('/api/ttlock',        ttlockRoutes)
app.route('/api/ses',           sesRoutes)
app.route('/api/housekeeping',  housekeepingRoutes)
app.route('/api/floorplans',    floorplanRoutes)  // planos del tenant (módulo liveMap)
app.route('/api/laundry',       laundryRoutes)
app.route('/api/nobeds',        nobedsRoutes)
app.route('/api/fdm',           fdmRoutes)
app.route('/api/jumbo',         jumboRoutes)
app.route('/api/customer',      customerRoutes)
app.route('/api/alerts',        alertRoutes)
app.route('/api/engagement',    engagementRoutes)
app.route('/api/feedback',      feedbackRoutes)
app.route('/api/pricing-effects', pricingEffectsRoutes)
app.route('/api/corporate',      corporateRoutes)
app.route('/api/cash-drawer',   cashDrawerRoutes)
app.route('/api/whatsapp',      whatsappRoutes)
app.route('/api/competitors',   competitorRoutes)

const apiFetch = async (req: Request) => {
  try {
    return await app.fetch(req)
  } catch (e: any) {
    console.error('[API error]', e)
    return new Response(
      JSON.stringify({ error: e?.message ?? 'Error interno del servidor' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

const server = Bun.serve({
  port: Number(env.PORT),
  // Por defecto Bun cierra una conexión tras 10s sin actividad ("idle") — de
  // sobra para casi todo, pero /api/ai/daily-summary y /api/ai/proactive
  // mantienen la conexión abierta 25-35s+ mientras Claude hace varias
  // iteraciones de tools. Bun mataba la conexión a los 10s (log: "[Bun.serve]:
  // request timed out after 10 seconds") y nginx lo veía como "upstream
  // prematurely closed connection" → 502 al cliente, aunque el handler seguía
  // corriendo y terminaba bien en el servidor. 120s da margen de sobra.
  idleTimeout: 120,
  routes: {
    '/api/*': apiFetch,
    '/avatars/:filename': async (req) => {
      const filename = new URL(req.url).pathname.split('/').pop() ?? ''
      const file = Bun.file(`${process.cwd()}/public/avatars/${filename}`)
      if (!await file.exists()) return new Response('Not found', { status: 404 })
      return new Response(file)
    },
    // Compatibilidad: el PDF estático del contrato ya no se usa — las condiciones de
    // admisión salen del tenant (properties.admissionTermsHtml) vía API pública.
    '/public/docs/contrato-admision.pdf': (req) =>
      Response.redirect(new URL('/api/public/contract-terms', req.url).toString(), 302),
    '/public/*': async (req) => {
      const pathname = new URL(req.url).pathname.replace(/^\/public/, '')
      if (pathname.includes('..')) return new Response('Not found', { status: 404 })
      const file = Bun.file(`${process.cwd()}/public${pathname}`)
      if (!await file.exists()) return new Response('Not found', { status: 404 })
      return new Response(file)
    },
    '/booking':                bookingHtml,
    '/booking/success':        bookingHtml,
    '/booking-widget':         bookingWidgetHtml,
    '/booking-widget/success': bookingWidgetHtml,
    '/portal':                 portalHtml,
    '/portal-widget':          portalWidgetHtml,
    '/sign':                   contractHtml,
    '/room':                   roomHtml,
    '/*':               index,
  },
  error(e) {
    return new Response(
      JSON.stringify({ error: e?.message ?? 'Error interno del servidor' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  },
  development: {
    hmr: true,
    console: true,
  },
})

console.log(`Server running on port ${server.port}`)
startAutoStatusScheduler()
startCartRecoveryScheduler()
startCancellationRecoveryScheduler()
startAiScheduledTasksScheduler()
startEventsScheduler()
startPricingRulesScheduler()
startCompetitorPricingScheduler()
