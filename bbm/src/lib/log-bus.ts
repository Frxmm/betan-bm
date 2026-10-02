import { hasPropertyContext, getPropertyId } from './property'

export type LogEntry = {
  ts:    string
  level: 'info' | 'warn' | 'error' | 'debug'
  tag:   string
  msg:   string
  data?: unknown
  /** Tenant que lo originó (null = plataforma/sin contexto). */
  propertyId?: number | null
}

// Cada suscriptor solo ve los logs de su tenant (y los de plataforma sin tenant)
const subscribers = new Set<{ fn: (e: LogEntry) => void; pid: number | null }>()
const ctxPid = () => hasPropertyContext() ? getPropertyId() : null
const visible = (e: LogEntry, pid: number | null) => e.propertyId == null || pid == null || e.propertyId === pid

// Ring buffer: últimas 500 entradas para nuevos suscriptores
const HISTORY_MAX = 500
const history: LogEntry[] = []

export function emit(level: LogEntry['level'], tag: string, msg: string, data?: unknown) {
  const entry: LogEntry = { ts: new Date().toISOString(), level, tag, msg, data, propertyId: ctxPid() }
  if (history.length >= HISTORY_MAX) history.shift()
  history.push(entry)
  for (const s of subscribers) if (visible(entry, s.pid)) s.fn(entry)
}

export function getHistory() { const pid = ctxPid(); return history.filter(e => visible(e, pid)) }

export function subscribe(fn: (e: LogEntry) => void): () => void {
  const sub = { fn, pid: ctxPid() }
  subscribers.add(sub)
  return () => subscribers.delete(sub)
}

// Helpers de nivel
export const log  = (tag: string, msg: string, data?: unknown) => emit('info',  tag, msg, data)
export const warn = (tag: string, msg: string, data?: unknown) => emit('warn',  tag, msg, data)
export const err  = (tag: string, msg: string, data?: unknown) => emit('error', tag, msg, data)
export const dbg  = (tag: string, msg: string, data?: unknown) => emit('debug', tag, msg, data)
