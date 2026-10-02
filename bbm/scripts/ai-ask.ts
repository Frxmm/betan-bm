// CLI para hablar directamente con el agente de IA (POST /api/ai/chat) sin
// pasar por el frontend — para probar respuestas y tools rápido.
//
// Uso:
//   bun scripts/ai-ask.ts                                — modo interactivo (REPL)
//   bun scripts/ai-ask.ts "¿cuántas reservas hay hoy?"    — pregunta única, imprime y sale
//   bun scripts/ai-ask.ts --user 12 "..."                 — firma el JWT con sub=12 (usa
//                                                            los roles reales de ese usuario)
//   bun scripts/ai-ask.ts --verbose "..."                 — muestra también las tools llamadas
//
// Sin --user, el JWT no lleva `sub` → loadUserCtx() no encuentra usuario → el
// agente actúa con roles=[] (sin acceso a datos financieros ni a acciones que
// requieran un rol). Con --user <id> usa los roles reales de ese usuario en BD,
// igual que si hubiera iniciado sesión — usa el id de un usuario que exista.
//
// La app debe estar corriendo en APP_URL (por defecto http://localhost:3000).

import { sign } from 'hono/jwt'
import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { resolveTenant, argsWithoutTenant } from './lib/tenant'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  console.error('ERROR: JWT_SECRET no configurado en .env')
  process.exit(1)
}

const APP_URL = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')

// El JWT lleva propertyId: --tenant=<slug> (o env TENANT) es obligatorio.
const TENANT_ID = (await resolveTenant()).id
const rawArgs = argsWithoutTenant()
let verbose = false
let userId: number | undefined
const positional: string[] = []
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--verbose') { verbose = true; continue }
  if (rawArgs[i] === '--user')    { userId = Number(rawArgs[++i]); continue }
  positional.push(rawArgs[i]!)
}
const oneShotQuestion = positional.join(' ').trim()

async function getToken(): Promise<string> {
  const payload: Record<string, any> = { propertyId: TENANT_ID, exp: Math.floor(Date.now() / 1000) + 1800 }   // 30 min
  if (userId != null && !isNaN(userId)) payload.sub = userId
  return sign(payload, JWT_SECRET!, 'HS256')
}

type Msg = { role: 'user' | 'assistant'; content: string }

async function ask(messages: Msg[]): Promise<{ text: string; actions: { tool: string; result: any }[] }> {
  const token = await getToken()
  const resp = await fetch(`${APP_URL}/api/ai/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ messages }),
  })
  const data: any = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`)
  return { text: data.text ?? '', actions: data.actions ?? [] }
}

function printResponse(text: string, actions: { tool: string; result: any }[]) {
  console.log(`\n${text}\n`)
  if (verbose && actions.length > 0) {
    console.log('── tools llamadas ──')
    for (const a of actions) console.log(`  ${a.tool}:`, JSON.stringify(a.result).slice(0, 300))
    console.log('')
  }
}

if (userId == null) {
  console.log('(sin --user <id>: el agente actúa sin roles — datos financieros y acciones con permisos quedarán bloqueados. Usa --user <id> para probar con los permisos reales de un usuario.)\n')
}

if (oneShotQuestion) {
  try {
    const { text, actions } = await ask([{ role: 'user', content: oneShotQuestion }])
    printResponse(text, actions)
  } catch (e: any) {
    console.error(`ERROR: ${e.message}`)
    process.exit(1)
  }
  process.exit(0)
}

// ── Modo interactivo ────────────────────────────────────────────────────────
console.log(`Chat con el agente de IA — ${APP_URL}  ("salir" o Ctrl+C para terminar)\n`)
const rl = readline.createInterface({ input: stdin, output: stdout })
const history: Msg[] = []

while (true) {
  const line = (await rl.question('> ')).trim()
  if (!line) continue
  if (['salir', 'exit', 'quit'].includes(line.toLowerCase())) break

  history.push({ role: 'user', content: line })
  try {
    const { text, actions } = await ask(history)
    history.push({ role: 'assistant', content: text })
    printResponse(text, actions)
  } catch (e: any) {
    console.error(`ERROR: ${e.message}`)
    history.pop()   // no dejar el turno del usuario colgado sin respuesta en el historial
  }
}
rl.close()
process.exit(0)
