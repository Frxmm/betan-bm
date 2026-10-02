/**
 * Tests del gateway TTLock + IC cards (tarjetas físicas)
 *
 * Uso:
 *   bun scripts/ttlock-gateway-test.ts
 *
 * Variables de entorno (en .env):
 *   TTLOCK_CLIENT_ID, TTLOCK_CLIENT_SECRET, TTLOCK_USERNAME, TTLOCK_PASSWORD
 *
 * Opcionales:
 *   TTLOCK_TEST_LOCK_ID      lockId con gateway asociado para probar IC cards
 *   TTLOCK_TEST_CARD_UID     UID completo en decimal (10 dígitos) tal como aparece en la app
 *                            TTLock al añadir la tarjeta físicamente. Ej: 2100774653
 *   TTLOCK_TEST_ZKTECO_HEX  Raw hex de 4 bytes del lector ZKTeco (ej: 4d7054fd).
 *                            Si se especifica, se derivan y prueban los 3 formatos candidatos.
 *                            Usar cuando no se conoce aún el UID TTLock para esa tarjeta.
 *
 * Formato confirmado:
 *   TTLock almacena el UID de las tarjetas Mifare como un número decimal de hasta 10 dígitos
 *   (ej: 2100774653). Este es el valor que hay que pasar como cardNumber al API.
 *   ZKTeco C3-400 envía solo 3 bytes en LE (ej: 5533773) — no es directamente usable;
 *   hay que obtener el UID completo de 4 bytes desde la app TTLock o el endpoint de listado.
 *
 * Objetivo: verificar que el gateway está online y que se pueden añadir/borrar
 * tarjetas físicas en las cerraduras — prerequisito para asignar automáticamente
 * la tarjeta ZKTeco ya enrollada a la cerradura TTLock de la habitación.
 */

import { createHash } from 'node:crypto'

const BASE_AUTH = 'https://euapi.ttlock.com'
const BASE_V3   = 'https://euapi.ttlock.com/v3'

let passed = 0
let failed = 0
let warned = 0

function ok(label: string, value?: any) {
  console.log(`  ✓ ${label}`)
  if (value !== undefined) console.log(`    → ${JSON.stringify(value, null, 2).split('\n').join('\n    ')}`)
  passed++
}
function fail(label: string, err?: any) {
  console.error(`  ✗ ${label}`)
  if (err) console.error(`    → ${err instanceof Error ? err.message : JSON.stringify(err)}`)
  failed++
}
function warn(label: string, detail?: string) {
  console.log(`  ⚠ ${label}`)
  if (detail) console.log(`    ${detail}`)
  warned++
}
function section(name: string) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`)
}
function summary() {
  console.log(`\n${'─'.repeat(62)}`)
  console.log(`  ${passed} ✓ pasados   ${failed} ✗ fallados   ${warned} ⚠ avisos`)
  console.log(`${'─'.repeat(62)}\n`)
  process.exit(failed > 0 ? 1 : 0)
}
function md5(text: string) {
  return createHash('md5').update(text).digest('hex')
}
async function post(path: string, token: string, extra: Record<string, string> = {}): Promise<any> {
  const body = new URLSearchParams({
    clientId:    process.env.TTLOCK_CLIENT_ID!,
    accessToken: token,
    date:        String(Date.now()),
    ...extra,
  })
  const r    = await fetch(`${BASE_V3}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await r.text()
  if (!text || text.trim() === '') return { _raw: '(respuesta vacía)', _status: r.status }
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text.slice(0, 500), _status: r.status, _parseError: true }
  }
}

// ─── 1. Variables de entorno ──────────────────────────────────────────────────

section('1. Variables de entorno')
const required = ['TTLOCK_CLIENT_ID', 'TTLOCK_CLIENT_SECRET', 'TTLOCK_USERNAME', 'TTLOCK_PASSWORD']
const missing  = required.filter(k => !process.env[k])
if (missing.length) {
  fail(`Variables faltantes: ${missing.join(', ')}`)
  process.exit(1)
}
ok('Variables de entorno completas')

// ─── 2. OAuth2 token ─────────────────────────────────────────────────────────

section('2. OAuth2 token')
let token = ''

await (async () => {
  const body = new URLSearchParams({
    clientId:     process.env.TTLOCK_CLIENT_ID!,
    clientSecret: process.env.TTLOCK_CLIENT_SECRET!,
    username:     process.env.TTLOCK_USERNAME!,
    password:     md5(process.env.TTLOCK_PASSWORD!),
  })
  try {
    const r    = await fetch(`${BASE_AUTH}/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    })
    const data = await r.json() as any
    if (data.errcode) { fail(`Error ${data.errcode}: ${data.errmsg}`); return }
    token = data.access_token
    ok(`Token obtenido (uid=${data.uid})`, { token: token.slice(0, 8) + '…', expires_in: data.expires_in })
  } catch (e) { fail('Error de red', e) }
})()

if (!token) { fail('Sin token — abortando'); process.exit(1) }

// ─── 3. Listar gateways ───────────────────────────────────────────────────────

section('3. Listar gateways (v3/gateway/list)')
let gatewayId: string | null = null

await (async () => {
  try {
    const data = await post('/gateway/list', token, { pageNo: '1', pageSize: '20' })
    if (data.errcode) { fail(`Error ${data.errcode}: ${data.errmsg}`); return }

    const list: any[] = data.list ?? []
    if (list.length === 0) {
      warn('No se encontraron gateways en la cuenta', 'Verifica que el gateway está vinculado a la cuenta TTLock configurada en .env')
      return
    }
    ok(`${list.length} gateway(s) encontrado(s)`)
    for (const gw of list) {
      const online = gw.isOnline === 1 ? '🟢 online' : '🔴 offline'
      console.log(`    • gatewayId=${gw.gatewayId}  nombre="${gw.gatewayName}"  ${online}  modelo="${gw.gatewayMac ?? '?'}"`)
    }
    // Preferir el primero que esté online
    gatewayId = String((list.find(g => g.isOnline === 1) ?? list[0]).gatewayId)
    ok(`Usando gatewayId=${gatewayId} para los siguientes tests`)
  } catch (e) { fail('Error de red', e) }
})()

// ─── 4. Estado detallado del gateway ─────────────────────────────────────────

section('4. Estado del gateway seleccionado (v3/gateway/detail)')

if (gatewayId) {
  await (async () => {
    try {
      const data = await post('/gateway/detail', token, { gatewayId })
      if (data.errcode) { fail(`Error ${data.errcode}: ${data.errmsg}`); return }
      const online = data.isOnline === 1
      if (online) {
        ok('Gateway ONLINE', {
          gatewayName:    data.gatewayName,
          gatewayMac:     data.gatewayMac,
          networkStrength: data.networkStrength ?? '?',
        })
      } else {
        warn('Gateway OFFLINE — las operaciones de IC card requieren que esté online', `gatewayId=${gatewayId}`)
      }
    } catch (e) { fail('Error de red', e) }
  })()
} else {
  warn('Skipped — no hay gatewayId')
}

// ─── 5. Cerraduras vinculadas al gateway ─────────────────────────────────────

section('5. Cerraduras con soporte de gateway (v3/lock/list + hasGateway)')
let testLockId = process.env.TTLOCK_TEST_LOCK_ID ?? null
const locksWithGateway: { lockId: string; alias: string }[] = []

await (async () => {
  try {
    const data = await post('/lock/list', token, { pageNo: '1', pageSize: '50' })
    if (data.errcode) { fail(`Error ${data.errcode}: ${data.errmsg}`); return }

    const all: any[] = data.list ?? []
    for (const lock of all) {
      if (lock.hasGateway === 1 || lock.hasGateway === true) {
        locksWithGateway.push({ lockId: String(lock.lockId), alias: lock.lockAlias ?? lock.lockName ?? '?' })
      }
    }
    if (locksWithGateway.length === 0) {
      warn(`Ninguna de las ${all.length} cerraduras tiene hasGateway=1`,
        'Verifica en la app TTLock que la cerradura está emparejada con el gateway')
      return
    }
    ok(`${locksWithGateway.length} cerradura(s) con gateway de ${all.length} total`)
    for (const l of locksWithGateway) {
      console.log(`    • lockId=${l.lockId}  "${l.alias}"`)
    }
    if (!testLockId && locksWithGateway.length > 0) {
      testLockId = locksWithGateway[0]!.lockId
      console.log(`    ℹ Usando lockId=${testLockId} para tests de IC card (define TTLOCK_TEST_LOCK_ID para elegir otro)`)
    }
  } catch (e) { fail('Error de red', e) }
})()

// ─── 6. Listar IC cards ya registradas en la cerradura ───────────────────────

section('6. IC cards existentes en la cerradura (v3/card/list)')
let existingCards: any[] = []

// Endpoint correcto según doc oficial TTLock
const CARD_LIST_PATHS = ['/identityCard/list', '/card/list']

if (testLockId) {
  await (async () => {
    for (const path of CARD_LIST_PATHS) {
      try {
        const data = await post(path, token, {
          lockId:   testLockId!,
          pageNo:   '1',
          pageSize: '50',
        })
        if (data._parseError || data._raw) {
          console.log(`    ℹ ${path} → (HTTP ${data._status}): ${data._raw}`)
          continue
        }
        if (data.errcode && data.errcode !== 0) {
          console.log(`    ℹ ${path} → errcode=${data.errcode}: ${data.errmsg}`)
          continue
        }
        existingCards = data.list ?? []
        ok(`${existingCards.length} tarjeta(s) IC en lockId=${testLockId} (vía ${path})`)
        for (const c of existingCards) {
          console.log(`    • cardId=${c.cardId}  nombre="${c.cardName ?? '?'}"  nº="${c.cardNumber ?? c.cardNamber ?? '?'}"`)
        }
        return
      } catch (e) { console.log(`    ℹ ${path} → error de red: ${e}`) }
    }
    fail('Ningún endpoint de listado funcionó — ver detalles arriba')
  })()
} else {
  warn('Skipped — no hay lockId con gateway disponible')
}

// ─── 7. Alta de tarjeta IC de prueba ─────────────────────────────────────────

section('7. Alta de IC card de prueba (v3/identityCard/add)')

// Acepta el hex raw del lector ZKTeco (4 bytes, ej: "4d7054fd")
// o un UID decimal ya conocido. Si se dan ambos, el hex raw tiene prioridad.
const rawHex     = (process.env.TTLOCK_TEST_ZKTECO_HEX ?? '').toLowerCase().replace(/\s/g, '')
const manualUid  = process.env.TTLOCK_TEST_CARD_UID ?? ''

// Genera candidatos de cardNumber a partir del raw hex del UID Mifare (4 bytes).
//
// Conversión confirmada (nfcx_hid.py / nfc_read.py):
//   ZKTeco card_no = int.from_bytes(uid[0:3], 'little')   ← Wiegand 26, 3 bytes
//   TTLock cardNumber = int.from_bytes(uid, 'big')         ← decimal BE 4 bytes
//
// Ejemplo: uid = 4d7054fd
//   ZKTeco  → 5_533_773   (solo 3 bytes, el 4º se pierde)
//   TTLock  → 1_299_207_421
//
function candidatesFromHex(hex: string): { label: string; cardNumber: string }[] {
  if (hex.length < 8) return []
  const b = hex.match(/.{2}/g)!.map(h => parseInt(h, 16))
  // 1) 4-byte BE — formato confirmado para TTLock (= nfc_read.py "Decimal")
  const be4 = parseInt(hex.slice(0, 8), 16)
  // 2) 4-byte LE — bytes invertidos
  const hexLE4 = [...b.slice(0, 4)].reverse().map(x => x.toString(16).padStart(2, '0')).join('')
  const le4 = parseInt(hexLE4, 16)
  // 3) 3-byte LE — Wiegand 26, lo que ZKTeco usa como card_no
  const le3 = (b[2]! << 16) | (b[1]! << 8) | b[0]!

  return [
    { label: `4-byte BE ← formato TTLock confirmado`,  cardNumber: String(be4).padStart(10, '0') },
    { label: `4-byte LE`,                              cardNumber: String(le4).padStart(10, '0') },
    { label: `3-byte LE = ZKTeco card_no (Wiegand 26)`, cardNumber: String(le3).padStart(10, '0') },
  ]
}

// Candidatos a probar
const candidates: { label: string; cardNumber: string }[] =
  rawHex.length >= 6
    ? candidatesFromHex(rawHex)
    : manualUid
      ? [{ label: 'TTLOCK_TEST_CARD_UID (manual)', cardNumber: manualUid }]
      : []

let createdCardId: string | null = null
let winningCardNumber: string | null = null

// addType=2 → gateway / WiFi (no bluetooth)
// addForReversedCardNumber → TTLock invierte bytes internamente
// add                      → sin inversión
const CARD_ADD_PATHS = [
  { path: '/identityCard/addForReversedCardNumber', label: 'reversed' },
  { path: '/identityCard/add',                      label: 'directo'  },
]

if (testLockId && candidates.length > 0) {
  console.log(`\n  Candidatos a probar (${rawHex ? 'hex: ' + rawHex : 'UID manual'}):`)
  for (const c of candidates) console.log(`    • ${c.cardNumber}  (${c.label})`)

  await (async () => {
    const now     = Date.now()
    const startMs = now
    const endMs   = now + 2 * 3_600_000

    outer:
    for (const cand of candidates) {
      for (const { path, label } of CARD_ADD_PATHS) {
        console.log(`\n  → cardNumber=${cand.cardNumber} (${cand.label}) · endpoint=${label}`)
        try {
          const data = await post(path, token, {
            lockId:     testLockId!,
            cardNumber: cand.cardNumber,
            cardName:   'Test PMS',
            startDate:  String(startMs),
            endDate:    String(endMs),
            addType:    '2',
          })
          if (data._parseError || data._raw) {
            console.log(`    ℹ HTTP ${data._status}: ${data._raw}`); continue
          }
          if (data.errcode && data.errcode !== 0) {
            console.log(`    ℹ errcode=${data.errcode}: ${data.errmsg}`)
            if (data.errcode === 10017) console.log('      ↳ gateway offline o cerradura no emparejada')
            if (data.errcode === 10007) console.log('      ↳ tarjeta ya registrada en esta cerradura')
            if (data.errcode === 10003) console.log('      ↳ cardNumber fuera de rango o formato incorrecto')
            if (data.errcode === -3)    console.log('      ↳ parámetros inválidos')
            continue
          }
          createdCardId    = String(data.cardId ?? '')
          winningCardNumber = cand.cardNumber
          ok(`¡Tarjeta añadida!`, {
            cardNumber:  cand.cardNumber,
            formato:     cand.label,
            endpoint:    path,
            cardId:      createdCardId,
            startDate:   new Date(startMs).toISOString(),
            endDate:     new Date(endMs).toISOString(),
          })
          break outer
        } catch (e) { console.log(`    ℹ error de red: ${e}`) }
      }
    }
    if (!createdCardId) fail('Ninguna combinación formato+endpoint funcionó — ver detalles arriba')
  })()
} else if (candidates.length === 0) {
  warn(
    'Skipped — define TTLOCK_TEST_ZKTECO_HEX o TTLOCK_TEST_CARD_UID en .env',
    'Ejemplo: TTLOCK_TEST_ZKTECO_HEX=4d7054fd  (raw hex del lector ZKTeco, 4 bytes)',
  )
} else {
  warn('Skipped — no hay lockId disponible')
}

// ─── 8. Listado tras el alta ──────────────────────────────────────────────────

section('8. Tarjetas IC en la cerradura tras el alta (v3/identityCard/list)')

if (testLockId) {
  await (async () => {
    for (const path of ['/identityCard/list', '/card/list']) {
      try {
        const data = await post(path, token, { lockId: testLockId!, pageNo: '1', pageSize: '50' })
        if (data._parseError || data._raw) { console.log(`    ℹ ${path} → (HTTP ${data._status}): ${data._raw}`); continue }
        if (data.errcode && data.errcode !== 0) { console.log(`    ℹ ${path} → errcode=${data.errcode}: ${data.errmsg}`); continue }
        const list: any[] = data.list ?? []
        ok(`${list.length} tarjeta(s) IC registrada(s) en lockId=${testLockId} (vía ${path})`)
        for (const c of list) {
          const marker = c.cardId === Number(createdCardId) ? ' ← recién añadida' : ''
          console.log(`    • cardId=${c.cardId}  nombre="${c.cardName ?? '?'}"  nº="${c.cardNumber ?? c.cardNamber ?? '?'}"${marker}`)
        }
        return
      } catch (e) { console.log(`    ℹ ${path} → error de red: ${e}`) }
    }
    fail('No se pudo listar — ver detalles arriba')
  })()
} else {
  warn('Skipped — no hay lockId disponible')
}

// ─── 9. Baja de la tarjeta IC de prueba (con confirmación) ───────────────────

section('9. Baja de IC card de prueba (v3/identityCard/delete)')

if (testLockId && createdCardId) {
  // Pedir confirmación por teclado antes de borrar
  process.stdout.write(`\n  ¿Eliminar la tarjeta cardId=${createdCardId} de lockId=${testLockId}? [s/N] `)
  const confirmed = await new Promise<boolean>(resolve => {
    process.stdin.setEncoding('utf8')
    process.stdin.resume()
    process.stdin.once('data', chunk => {
      process.stdin.pause()
      resolve(chunk.toString().trim().toLowerCase() === 's')
    })
  })

  if (!confirmed) {
    warn(`Tarjeta cardId=${createdCardId} conservada — elimínala manualmente desde la app TTLock cuando quieras`)
  } else {
    await (async () => {
      try {
        const data = await post('/identityCard/delete', token, {
          lockId: testLockId!,
          cardId: createdCardId!,
        })
        if (data._parseError || data._raw) { fail(`Respuesta no-JSON (HTTP ${data._status}): ${data._raw}`); return }
        if (data.errcode && data.errcode !== 0) { fail(`Error ${data.errcode}: ${data.errmsg}`); return }
        ok(`Tarjeta IC eliminada — cardId=${createdCardId}`)
      } catch (e) { fail('Error de red', e) }
    })()
  }
} else if (!createdCardId) {
  warn('Skipped — no se creó tarjeta en el test anterior')
}

// ─── 10. Tabla de conversión ZKTeco ↔ TTLock ─────────────────────────────────

section('10. Tabla de conversión de UID (ZKTeco → TTLock)')

;(function checkUidFormats() {
  const hex = rawHex || (() => {
    // Si no hay hex, reconstruir desde TTLOCK_TEST_CARD_UID (asumiendo que es 3-byte LE)
    if (!manualUid) return ''
    const n = parseInt(manualUid, 10)
    const b0 = (n & 0xFF).toString(16).padStart(2, '0')
    const b1 = ((n >> 8) & 0xFF).toString(16).padStart(2, '0')
    const b2 = ((n >> 16) & 0xFF).toString(16).padStart(2, '0')
    return `${b0}${b1}${b2}fd` // fd ficticio — 4º byte desconocido
  })()

  if (!hex || hex.length < 6) {
    warn('Sin hex raw disponible — define TTLOCK_TEST_ZKTECO_HEX para ver la tabla completa')
    return
  }

  const b = hex.match(/.{2}/g)!.map(h => parseInt(h, 16))
  const le3 = (b[2]! << 16) | (b[1]! << 8) | b[0]!
  const be4 = parseInt(hex.slice(0, 8).padStart(8, '0'), 16)
  const hexLE4 = [...b.slice(0, 4)].reverse().map(x => x.toString(16).padStart(2, '0')).join('')
  const le4 = parseInt(hexLE4, 16)

  console.log(`    Raw hex ZKTeco (4 bytes):         ${hex.toUpperCase()}`)
  console.log(`    Bytes individuales:               ${b.slice(0,4).map(x => '0x' + x.toString(16).padStart(2,'0').toUpperCase()).join('  ')}`)
  console.log('')
  console.log(`    ┌──────────────────────────────────────────────────────────────────┐`)
  console.log(`    │ Formato                    │ Hex        │ Decimal (cardNumber) │`)
  console.log(`    ├──────────────────────────────────────────────────────────────────┤`)
  console.log(`    │ 4-byte BE ← TTLock ✓       │ ${hex.slice(0,8).toUpperCase().padEnd(10)} │ ${String(be4).padStart(10,'0').padEnd(20)} │`)
  console.log(`    │ 4-byte LE                  │ ${hexLE4.toUpperCase().padEnd(10)} │ ${String(le4).padStart(10,'0').padEnd(20)} │`)
  console.log(`    │ 3-byte LE = ZKTeco card_no │ ${le3.toString(16).padStart(6,'0').toUpperCase().padEnd(10)} │ ${String(le3).padStart(10,'0').padEnd(20)} │`)
  console.log(`    └──────────────────────────────────────────────────────────────────┘`)

  if (winningCardNumber) {
    console.log(`\n    ✓ Formato ganador en el test de alta: ${winningCardNumber}`)
    const winner = candidates.find(c => c.cardNumber === winningCardNumber)
    if (winner) console.log(`      (${winner.label})`)
  } else if (createdCardId === null && candidates.length > 0) {
    console.log('\n    ↳ Ningún formato funcionó en el alta — compara estos valores con')
    console.log('      la app TTLock > Configuración cerradura > Añadir tarjeta IC')
    console.log('      para ver cuál muestra la app al acercar físicamente la tarjeta.')
  }

  ok('Tabla generada')
})()

// ─────────────────────────────────────────────────────────────────────────────

summary()
