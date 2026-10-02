import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL:           z.string().url('DATABASE_URL debe ser una URL válida de PostgreSQL'),
  PORT:                   z.coerce.number().int().default(3000),
  JWT_SECRET:             z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  STRIPE_SECRET_KEY:      z.string().optional(),
  STRIPE_WEBHOOK_SECRET:  z.string().optional(),
  STRIPE_PUBLIC_KEY:      z.string().optional(),
  PUBLIC_URL:             z.string().url().default('http://localhost:3000'),
  // Solo modo un-solo-hotel: permite que getSecret() caiga a las variables globales del .env
  ALLOW_ENV_SECRET_FALLBACK: z.enum(['0','1']).optional(),
  PEXELS_API_KEY:         z.string().optional(),
  SERPAPI_API_KEY:        z.string().optional(),
  // App Android de wake word — token estático de plataforma (ver routes/voice-brief.ts).
  // Token estático fijo (no JWT, no caduca): la app lo manda como Bearer en
  // POST /api/voice-brief. Si no está configurado, ese endpoint responde 503.
  VOICE_APP_TOKEN:        z.string().optional(),
  // Usuario (users.id) en cuyo nombre actúa el agente para esas preguntas —
  // le da permisos/roles reales y que createdBy no quede vacío en lo que
  // escriba. Si no se configura, actúa con rol 'direccion' sin usuario real
  // (igual que /api/ai/daily-summary).
  VOICE_APP_USER_ID:      z.coerce.number().int().positive().optional(),
})

const result = envSchema.safeParse(process.env)

if (!result.success) {
  console.error('❌ Variables de entorno incorrectas:')
  console.error(result.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = result.data
