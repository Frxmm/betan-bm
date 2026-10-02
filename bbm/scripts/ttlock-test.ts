/**
 * Tests de integración para TTLock Cloud API
 *
 * Uso:
 *   bun scripts/ttlock-test.ts
 *
 * Variables de entorno necesarias (en .env):
 *   TTLOCK_CLIENT_ID
 *   TTLOCK_CLIENT_SECRET
 *   TTLOCK_USERNAME       (cuenta TTLock App, ej: +34612345678)
 *   TTLOCK_PASSWORD       (contraseña en texto plano, el script la hashea)
 *
 * Opcional:
 *   TTLOCK_TEST_LOCK_ID   (lockId real para probar generación de código)
 */

import { createHash } from 'node:crypto'
import { isConfigured, createPasscode, deletePasscode } from '../src/lib/ttlock'

const BASE_AUTH = 'https://euapi.ttlock.com'
const BASE_V3   = 'https://euapi.ttlock.com/v3'

let passed = 0
let failed = 0

function ok(label: string, value?: any) {
  console.log(`  ✓ ${label}`)
  if (value !== undefined) console.log(`    → ${JSON.stringify(value)}`)
  passed++
}

function fail(label: string, err?: any) {
  console.error(`  ✗ ${label}`)
  if (err) console.error(`    → ${err instanceof Error ? err.message : JSON.stringify(err)}`)
  failed++
}

function section(name: string) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`)
}

function summary() {
  console.log(`\n${'─'.repeat(62)}`)
  console.log(`  ${passed} ✓ pasados   ${failed} ✗ fallados`)
  console.log(`${'─'.repeat(62)}\n`)
  process.exit(failed > 0 ? 1 : 0)
}

function md5(text: string) {
  return createHash('md5').update(text).digest('hex')
}

// ─── Test 1: Variables de entorno ─────────────────────────────────────────────

section('1. Variables de entorno')
;(function checkEnv() {
  const required = ['TTLOCK_CLIENT_ID', 'TTLOCK_CLIENT_SECRET', 'TTLOCK_USERNAME', 'TTLOCK_PASSWORD']
  const missing  = required.filter(k => !process.env[k])
  if (missing.length) {
    fail(`Variables faltantes: ${missing.join(', ')}`)
    console.error('\n  Añade estas variables al .env y vuelve a ejecutar.\n')
    process.exit(1)
  }
  ok('Todas las variables de entorno presentes')
  ok('isConfigured() = true', isConfigured())
})()

// ─── Test 2: MD5 del password ─────────────────────────────────────────────────

section('2. MD5 hash del password')
;(function checkMd5() {
  const known = md5('123456')
  if (known === 'e10adc3949ba59abbe56e057f20f883e') {
    ok('MD5("123456") correcto', known)
  } else {
    fail('MD5 incorrecto', known)
  }
  const pw = md5(process.env.TTLOCK_PASSWORD!)
  ok(`MD5 del password configurado`, pw)
})()

// ─── Test 3: OAuth2 token ─────────────────────────────────────────────────────

section('3. OAuth2 token (euapi.ttlock.com/oauth2/token)')
let accessToken: string | null = null
let uid: number | null = null

await (async function getToken() {
  const body = new URLSearchParams({
    clientId:     process.env.TTLOCK_CLIENT_ID!,
    clientSecret: process.env.TTLOCK_CLIENT_SECRET!,
    username:     process.env.TTLOCK_USERNAME!,
    password:     md5(process.env.TTLOCK_PASSWORD!),
  })
  try {
    const r    = await fetch(`${BASE_AUTH}/oauth2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const data = await r.json() as any

    if (data.errcode) {
      fail(`Error ${data.errcode}: ${data.errmsg}`)
      return
    }

    accessToken = data.access_token
    uid         = data.uid
    ok(`Token obtenido (uid=${data.uid})`, {
      access_token: data.access_token?.slice(0, 8) + '…',
      expires_in:   data.expires_in,
      uid:          data.uid,
    })
  } catch (e) {
    fail('Error de red al obtener token', e)
  }
})()

// ─── Test 4: Listar cerraduras ────────────────────────────────────────────────

section('4. Listar cerraduras (v3/lock/list)')
let firstLockId: string | null = null

if (accessToken) {
  await (async function listLocks() {
    const body = new URLSearchParams({
      clientId:    process.env.TTLOCK_CLIENT_ID!,
      accessToken: accessToken!,
      pageNo:      '1',
      pageSize:    '20',
      date:        String(Date.now()),
    })
    try {
      const r    = await fetch(`${BASE_V3}/lock/list`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      const data = await r.json() as any

      if (data.errcode) {
        fail(`Error ${data.errcode}: ${data.errmsg}`)
        return
      }

      const list = data.list ?? []
      ok(`${list.length} cerradura(s) encontrada(s) (total: ${data.count ?? '?'})`)
      for (const lock of list.slice(0, 5)) {
        console.log(`    • lockId=${lock.lockId}  nombre="${lock.lockAlias}"  modelo="${lock.lockName}"`)
      }
      if (list.length > 0) firstLockId = String(list[0].lockId)
    } catch (e) {
      fail('Error de red al listar cerraduras', e)
    }
  })()
} else {
  fail('Skipped — sin token')
}

// ─── Test 5: Generar código temporal ─────────────────────────────────────────

section('5. Generar código temporal (v3/keyboardPwd/create)')
const testLockId = process.env.TTLOCK_TEST_LOCK_ID ?? firstLockId
let createdPwdId: string | null = null

if (accessToken && testLockId) {
  await (async function createCode() {
    const now     = Date.now()
    const startMs = now + 60_000          // empieza en 1 minuto
    const endMs   = now + 3_600_000       // dura 1 hora (test)

    try {
      const { code, keyboardPwdId } = await createPasscode({
        lockId:  testLockId,
        name:    'Test PMS',
        startMs,
        endMs,
      })
      createdPwdId = keyboardPwdId
      ok(`Código creado: ${code}  (id=${keyboardPwdId})`)
    } catch (e) {
      fail('Error al crear código', e)
    }
  })()
} else if (!testLockId) {
  console.log('  ⚠ Skipped — no hay lockId. Define TTLOCK_TEST_LOCK_ID en .env o asegúrate de tener cerraduras en la cuenta.')
} else {
  fail('Skipped — sin token')
}

// ─── Test 6: Eliminar código temporal ─────────────────────────────────────────

section('6. Eliminar código generado (v3/keyboardPwd/delete)')

if (accessToken && testLockId && createdPwdId) {
  await (async function deleteCode() {
    try {
      await deletePasscode(testLockId!, createdPwdId!)
      ok(`Código ${createdPwdId} eliminado correctamente`)
    } catch (e) {
      fail('Error al eliminar código', e)
    }
  })()
} else if (!createdPwdId) {
  console.log('  ⚠ Skipped — no se creó código en el test anterior')
} else {
  fail('Skipped — sin token o lockId')
}

// ─── Test 7: Credenciales incorrectas ─────────────────────────────────────────

section('7. Respuesta con credenciales incorrectas')
await (async function badCreds() {
  const body = new URLSearchParams({
    clientId:     process.env.TTLOCK_CLIENT_ID!,
    clientSecret: process.env.TTLOCK_CLIENT_SECRET!,
    username:     process.env.TTLOCK_USERNAME!,
    password:     md5('esta_password_es_incorrecta_zzzz'),
  })
  try {
    const r    = await fetch(`${BASE_AUTH}/oauth2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const data = await r.json() as any
    if (data.errcode && data.errcode !== 0) {
      ok(`Rechazado correctamente — errcode=${data.errcode}: ${data.errmsg}`)
    } else {
      fail('Debería haber devuelto error con credenciales incorrectas', data)
    }
  } catch (e) {
    fail('Error de red', e)
  }
})()

// ─────────────────────────────────────────────────────────────────────────────

summary()
