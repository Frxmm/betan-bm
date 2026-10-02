// ─── Mapas coropléticos de demografía (d3-geo, SVG puro, sin fetch externo) ───

import { useMemo, useState } from 'react'
import { geoNaturalEarth1, geoMercator, geoPath } from 'd3-geo'
import { feature } from 'topojson-client'
import WORLD from '../data/geo/world.geo.json'
import ES_PROVINCES from '../data/geo/es-provinces.json'
import COUNTRIES from '../data/countries.json'

const ISO2_TO_ISO3 = new Map(
  (COUNTRIES as { code: string; code3: string; name: string }[]).map(c => [c.code, c.code3])
)

// Escala de color: raíz cuadrada para que los valores pequeños no desaparezcan
function fill(count: number, max: number, hue: [number, number, number]): string {
  if (!count) return 'var(--bg3, #eef2f7)'
  const t = Math.sqrt(count / max)
  return `rgba(${hue[0]}, ${hue[1]}, ${hue[2]}, ${0.15 + t * 0.85})`
}

function Legend({ max, hue }: { max: number; hue: [number, number, number] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text2)' }}>
      <span>0</span>
      <div style={{
        width: 90, height: 8, borderRadius: 4,
        background: `linear-gradient(to right, rgba(${hue.join(',')},0.15), rgba(${hue.join(',')},1))`,
      }} />
      <span>{max.toLocaleString()}</span>
    </div>
  )
}

// ─── Mapamundi por país (counts: ISO-2 → número) ──────────────────────────────

const GREEN: [number, number, number] = [16, 185, 129]

export function WorldMap({ counts, unit = 'huéspedes' }: { counts: Record<string, number>; unit?: string }) {
  const [hover, setHover] = useState<string | null>(null)

  const { paths, max } = useMemo(() => {
    const byIso3 = new Map<string, number>()
    for (const [iso2, n] of Object.entries(counts)) {
      const iso3 = ISO2_TO_ISO3.get(iso2.toUpperCase())
      if (iso3) byIso3.set(iso3, (byIso3.get(iso3) ?? 0) + n)
    }
    const fc = WORLD as any
    const projection = geoNaturalEarth1().fitSize([960, 460], fc)
    const path = geoPath(projection)
    const max = Math.max(...byIso3.values(), 1)
    const paths = (fc.features as any[])
      .filter(f => f.id !== 'ATA') // la Antártida solo ocupa sitio
      .map(f => ({
        id: f.id as string,
        name: f.properties?.name as string,
        d: path(f) ?? '',
        count: byIso3.get(f.id) ?? 0,
      }))
    return { paths, max }
  }, [counts])

  return (
    <div>
      <svg viewBox="0 0 960 460" style={{ width: '100%', height: 'auto', display: 'block' }}>
        {paths.map(p => (
          <path
            key={p.id} d={p.d}
            fill={fill(p.count, max, GREEN)}
            stroke="var(--border, #cbd5e1)" strokeWidth={0.4}
            style={{ cursor: p.count ? 'pointer' : 'default', opacity: hover && hover !== p.id ? 0.75 : 1 }}
            onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)}
          >
            <title>{p.name}: {p.count.toLocaleString()} {unit}</title>
          </path>
        ))}
      </svg>
      <Legend max={max} hue={GREEN} />
    </div>
  )
}

// ─── España por provincias (counts: código INE 2 dígitos → número) ────────────

const PURPLE: [number, number, number] = [139, 92, 246]

export function SpainMap({ counts, unit = 'reservas' }: { counts: Record<string, number>; unit?: string }) {
  const [hover, setHover] = useState<string | null>(null)

  const { paths, max } = useMemo(() => {
    const topo = ES_PROVINCES as any
    const fc = feature(topo, topo.objects.provinces) as any
    const projection = geoMercator().fitSize([700, 520], fc)
    const path = geoPath(projection)
    const max = Math.max(...Object.values(counts), 1)
    const paths = (fc.features as any[]).map(f => ({
      id: String(f.id),
      name: f.properties?.name as string,
      d: path(f) ?? '',
      count: counts[String(f.id)] ?? 0,
    }))
    return { paths, max }
  }, [counts])

  return (
    <div>
      <svg viewBox="0 0 700 520" style={{ width: '100%', height: 'auto', display: 'block' }}>
        {paths.map(p => (
          <path
            key={p.id} d={p.d}
            fill={fill(p.count, max, PURPLE)}
            stroke="var(--border, #cbd5e1)" strokeWidth={0.6}
            style={{ cursor: p.count ? 'pointer' : 'default', opacity: hover && hover !== p.id ? 0.75 : 1 }}
            onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)}
          >
            <title>{p.name}: {p.count.toLocaleString()} {unit}</title>
          </path>
        ))}
      </svg>
      <Legend max={max} hue={PURPLE} />
    </div>
  )
}
