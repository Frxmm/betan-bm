import type { Context } from 'hono'

export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function notFound(c: Context, resource = 'Recurso') {
  return c.json({ error: `${resource} no encontrado` }, 404)
}

export function conflict(c: Context, message: string) {
  return c.json({ error: message }, 409)
}

export function badRequest(c: Context, message: string, details?: unknown) {
  return c.json({ error: message, details }, 400)
}

export function serverError(c: Context, err: unknown) {
  console.error('[ERROR]', err)
  // Bun.sql wraps PG errors: the real message is in err.cause or err.detail
  let message = 'Error interno del servidor'
  if (err instanceof Error) {
    const cause = (err as any).cause
    message = (cause instanceof Error ? cause.message : null) ?? err.message
    const detail = (err as any).detail
    if (detail) message += ` — ${detail}`
  }
  return c.json({ error: message }, 500)
}
