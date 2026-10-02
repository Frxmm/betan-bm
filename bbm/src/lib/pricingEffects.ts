// Efecto de los cambios de precio: para cada cambio pasado (regla dinámica o
// manual) cuenta las reservas de ESA noche hechas en las 72 h ANTES frente a las
// 72 h DESPUÉS, agrupadas por regla. Lo usan el informe "Efecto reglas" y la
// herramienta del agente get_pricing_effects. Es indicativo, no causal (hay
// estacionalidad y otros factores) — por eso el veredicto exige una muestra
// mínima y compara siempre contra un umbral, no contra cero.
import { db } from '../db'
import { sql } from 'drizzle-orm'
import { getPropertyId } from './property'

export type EffectVerdict = 'funciona' | 'sin_efecto' | 'perjudica' | 'pocos_datos'

export interface RuleEffect {
  rule: string; ruleType: string | null; source: string
  threshold: number | null; adjustType: string | null; adjustValue: number | null
  changes: number; avgChangePct: number
  bookingsBefore: number; bookingsAfter: number
  liftPct: number | null          // (después − antes) / antes × 100
  verdict: EffectVerdict; advice: string
}

const MIN_CHANGES = 8

export function judge(avgChangePct: number, before: number, after: number, changes: number): { verdict: EffectVerdict; advice: string; liftPct: number | null } {
  const liftPct = before > 0 ? Math.round((after - before) / before * 1000) / 10 : (after > 0 ? 100 : null)
  if (changes < MIN_CHANGES) return { verdict: 'pocos_datos', liftPct, advice: `Solo ${changes} cambios en el periodo (mínimo ${MIN_CHANGES} para opinar) — amplía el rango o espera más datos.` }
  if (avgChangePct < 0) {
    // Rebaja: solo tiene sentido si trae reservas.
    if (after > before * 1.2) return { verdict: 'funciona', liftPct, advice: 'La rebaja atrae reservas (más de un 20 % por encima de antes). Mantener; se puede probar a escalarla en fechas parecidas.' }
    if (after >= before * 0.9) return { verdict: 'sin_efecto', liftPct, advice: 'Rebajas sin más reservas después: se está regalando precio. Reduce el descuento, hazla más selectiva (umbral de ocupación más bajo) o desactívala.' }
    return { verdict: 'perjudica', liftPct, advice: 'Tras rebajar entran MENOS reservas que antes: la rebaja no está moviendo demanda. Desactívala o revisa cuándo se dispara.' }
  }
  // Subida: no debe hundir las reservas.
  if (after >= before * 0.8) return { verdict: 'funciona', liftPct, advice: 'La subida no frena las reservas de forma apreciable: hay margen, se puede probar a subir un poco más.' }
  return { verdict: 'perjudica', liftPct, advice: 'Tras subir el precio caen claramente las reservas (más de un 20 %). Suaviza la subida o dispárala solo con menos disponibilidad.' }
}

export async function computePricingEffects(days: number): Promise<RuleEffect[]> {
  const d = Math.min(120, Math.max(3, Math.round(days)))
  const pid = getPropertyId()
  const rows = await db.execute(sql`
    WITH ch AS (
      SELECT DISTINCT ON (batch_id, date) rule_id, source, date, old_price::float AS old_p, new_price::float AS new_p, changed_at
      FROM price_change_log
      WHERE property_id = ${pid} AND old_price IS NOT NULL AND new_price IS NOT NULL AND old_price::float > 0
        AND changed_at >= now() - (${d} || ' days')::interval AND changed_at <= now() - interval '72 hours'
        AND date >= (changed_at AT TIME ZONE (SELECT timezone FROM properties WHERE id = ${pid}))::date
      ORDER BY batch_id, date, changed_at
    )
    SELECT COALESCE(pr.name, 'Manual') AS rule, pr.rule_type AS rule_type, ch.source,
           pr.threshold_pct::float AS threshold, pr.adjust_type AS adjust_type, pr.adjust_value::float AS adjust_value,
           COUNT(*)::int AS changes,
           ROUND(AVG((ch.new_p - ch.old_p) / ch.old_p * 100)::numeric, 1)::float AS avg_change_pct,
           COALESCE(SUM(b.before_n), 0)::int AS bookings_before,
           COALESCE(SUM(b.after_n), 0)::int AS bookings_after
    FROM ch
    LEFT JOIN pricing_rules pr ON pr.id = ch.rule_id AND pr.property_id = ${pid}
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE r.booked_at >= ch.changed_at - interval '72 hours' AND r.booked_at < ch.changed_at) AS before_n,
             COUNT(*) FILTER (WHERE r.booked_at >= ch.changed_at AND r.booked_at < ch.changed_at + interval '72 hours') AS after_n
      FROM reservations r
      WHERE r.property_id = ${pid} AND r.status NOT IN ('cancelled', 'no_show') AND r.check_in_date <= ch.date AND r.check_out_date > ch.date
    ) b ON true
    GROUP BY pr.name, pr.rule_type, ch.source, pr.threshold_pct, pr.adjust_type, pr.adjust_value
    ORDER BY changes DESC
  `) as unknown as any[]
  return rows.map(r => {
    const j = judge(Number(r.avg_change_pct), Number(r.bookings_before), Number(r.bookings_after), Number(r.changes))
    return {
      rule: r.rule, ruleType: r.rule_type ?? null, source: r.source,
      threshold: r.threshold ?? null, adjustType: r.adjust_type ?? null, adjustValue: r.adjust_value ?? null,
      changes: Number(r.changes), avgChangePct: Number(r.avg_change_pct),
      bookingsBefore: Number(r.bookings_before), bookingsAfter: Number(r.bookings_after),
      ...j,
    }
  })
}
