// ─── WhatsApp Business Cloud API (Meta) ────────────────────────────────────────
// Envío de plantillas pre-aprobadas. Credenciales POR TENANT (getSecret):
//   WHATSAPP_TOKEN     — token permanente del sistema (Meta Business → System User)
//   WHATSAPP_PHONE_ID  — Phone Number ID del número del hotel (no el número en sí)
//
// Las plantillas deben existir aprobadas en Meta Business Manager (idioma "es")
// con el nombre `${branding.waPrefix}_${clave}` (ver WA_TEMPLATE_KEYS: variables
// de cada una). Un tenant puede sobrescribir el nombre en settings
// `whatsapp.templates` = { clave: 'nombre_en_meta' }.

import { getBranding, getSecret, getSetting, hasFeature } from './property'

export const WA_TEMPLATE_KEYS = ['checkin', 'pago', 'codigo', 'carrito', 'confirmacion', 'reenganche'] as const
export type WaTemplateKey = typeof WA_TEMPLATE_KEYS[number]

// Descripción y variables ({{1}}..{{n}} del body, en orden) de cada plantilla — la UI de Notificaciones lo lee
export const WA_TEMPLATE_INFO: Record<WaTemplateKey, { description: string; variables: string[] }> = {
  checkin:      { description: 'Enlace de check-in online',               variables: ['nombre', 'fecha entrada', 'fecha salida', 'enlace'] },
  pago:         { description: 'Recordatorio de saldo pendiente',          variables: ['nombre', 'importe pendiente', 'enlace'] },
  codigo:       { description: 'Código de cerradura',                      variables: ['nombre', 'habitación', 'código', 'entrada', 'salida'] },
  carrito:      { description: 'Recuperación de carrito con descuento',    variables: ['nombre', 'fecha entrada', 'fecha salida', '% dto', 'enlace'] },
  confirmacion: { description: 'Confirmación de reserva',                  variables: ['nombre', 'fecha entrada', 'fecha salida', 'habitación', 'enlace'] },
  reenganche:   { description: 'Reenganche de reserva cancelada',          variables: ['nombre', 'fecha entrada', 'fecha salida', '% dto', 'enlace'] },
}

// Nombre real de la plantilla en Meta para el tenant del contexto
export async function waTemplateName(key: WaTemplateKey | string): Promise<string> {
  const overrides = (await getSetting<Record<string, string>>('whatsapp.templates', {})) ?? {}
  if (overrides[key]) return overrides[key]
  return `${(await getBranding()).waPrefix}_${key}`
}

// Catálogo completo (clave, nombre efectivo, descripción, variables) para la UI
export async function waTemplateCatalog() {
  return Promise.all(WA_TEMPLATE_KEYS.map(async key => ({
    key, name: await waTemplateName(key), ...WA_TEMPLATE_INFO[key],
  })))
}

const GRAPH = 'https://graph.facebook.com/v21.0'

export async function isWhatsappConfigured(): Promise<boolean> {
  if (!await hasFeature('whatsapp')) return false
  return !!(await getSecret('WHATSAPP_TOKEN') && await getSecret('WHATSAPP_PHONE_ID'))
}

// Normaliza a formato internacional sin '+' (Cloud API): español si no trae prefijo
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '')
  if (!digits) return null
  if (digits.startsWith('+'))  return digits.slice(1)
  if (digits.startsWith('00')) return digits.slice(2)
  if (/^[67]\d{8}$/.test(digits)) return '34' + digits   // móvil español sin prefijo
  if (/^34\d{9}$/.test(digits))   return digits
  if (digits.length >= 10)        return digits           // internacional ya con prefijo
  return null
}

export async function sendWhatsappTemplate(opts: {
  to:       string      // teléfono en cualquier formato razonable
  template: WaTemplateKey | string   // clave del catálogo (checkin, pago…) o nombre literal de plantilla aprobada
  params:   string[]    // variables {{1}}..{{n}} del body, en orden
  lang?:    string
}): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  if (!await isWhatsappConfigured()) return { ok: false, error: 'WhatsApp no configurado (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID)' }

  const to = normalizePhone(opts.to)
  if (!to) return { ok: false, error: `Teléfono no válido: ${opts.to}` }

  const name = (WA_TEMPLATE_KEYS as readonly string[]).includes(opts.template) ? await waTemplateName(opts.template) : opts.template
  const res = await fetch(`${GRAPH}/${await getSecret('WHATSAPP_PHONE_ID')}/messages`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${await getSecret('WHATSAPP_TOKEN')}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name,
        language: { code: opts.lang ?? 'es' },
        components: [{
          type:       'body',
          parameters: opts.params.map(text => ({ type: 'text', text })),
        }],
      },
    }),
  })

  const data: any = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`
    return { ok: false, error: `WhatsApp: ${msg}` }
  }
  return { ok: true, messageId: data?.messages?.[0]?.id }
}
