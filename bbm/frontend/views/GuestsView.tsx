import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api'
import { WorldMap, SpainMap } from '../components/GeoMaps'
import { fmtDate, toast } from '../lib/utils'
import { Modal } from '../components/Modal'
import MUNICIPALITIES from '../data/municipalities.json'

type Muni = { code: string; name: string }
const MUNI_LIST = MUNICIPALITIES as Muni[]

function MunicipalityPicker({ city, ineCode, onChange }: {
  city: string; ineCode: string
  onChange: (city: string, ineCode: string) => void
}) {
  const [query, setQuery] = useState(city)
  const [open, setOpen]   = useState(false)
  const ref               = useRef<HTMLDivElement>(null)

  useEffect(() => { setQuery(city) }, [city])

  const matches = query.length >= 2
    ? MUNI_LIST.filter(m => m.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : []

  const pick = (m: Muni) => {
    onChange(m.name, m.code)
    setQuery(m.name)
    setOpen(false)
  }

  const handleBlur = () => {
    // Si el texto escrito no corresponde a una selección válida, limpiar
    setTimeout(() => {
      if (!ineCode) { setQuery(''); onChange('', '') }
    }, 150)
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        value={query}
        placeholder="Escribe para buscar…"
        autoComplete="off"
        onChange={e => { setQuery(e.target.value); onChange(e.target.value, ''); setOpen(true) }}
        onFocus={() => query.length >= 2 && setOpen(true)}
        onBlur={handleBlur}
      />
      {open && matches.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 999, top: '100%', left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,.55)', maxHeight: 220, overflowY: 'auto' }}>
          {matches.map(m => (
            <div
              key={m.code}
              onMouseDown={() => pick(m)}
              style={{ padding: '7px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg2)')}
            >
              <span>{m.name}</span>
              <span style={{ color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{m.code}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function calcAge(dob: string | null | undefined): number | null {
  if (!dob) return null
  const d = new Date(dob), t = new Date()
  let age = t.getFullYear() - d.getFullYear()
  if (t.getMonth() < d.getMonth() || (t.getMonth() === d.getMonth() && t.getDate() < d.getDate())) age--
  return age
}

function StarRating({ value, onChange, readonly }: { value: number | null; onChange?: (v: number) => void; readonly?: boolean }) {
  const [hover, setHover] = useState(0)
  return (
    <span style={{ display: 'inline-flex', gap: 2, cursor: readonly ? 'default' : 'pointer' }}>
      {[1, 2, 3, 4, 5].map(n => (
        <span
          key={n}
          style={{
            fontSize: readonly ? 13 : 16,
            color: n <= (hover || value || 0) ? '#f59e0b' : 'var(--border)',
            transition: 'color .1s',
          }}
          onMouseEnter={() => !readonly && setHover(n)}
          onMouseLeave={() => !readonly && setHover(0)}
          onClick={() => !readonly && onChange?.(n === value ? 0 : n)}
        >★</span>
      ))}
    </span>
  )
}

// ─── Demographics panel ───────────────────────────────────────────────────────

const AGE_BUCKETS: Record<string, string> = {
  lt18:  '< 18 años',
  '18_25': '18–25 años',
  '26_35': '26–35 años',
  '36_50': '36–50 años',
  '51_65': '51–65 años',
  gt65:  '> 65 años',
}

const COUNTRY_NAMES: Record<string, string> = {
  ES:'España', FR:'Francia', DE:'Alemania', GB:'Reino Unido', IT:'Italia',
  PT:'Portugal', NL:'Países Bajos', BE:'Bélgica', CH:'Suiza', AT:'Austria',
  US:'EEUU', CA:'Canadá', MX:'México', AR:'Argentina', BR:'Brasil',
  CO:'Colombia', CL:'Chile', PE:'Perú', CN:'China', JP:'Japón',
  AU:'Australia', RU:'Rusia', PL:'Polonia', SE:'Suecia', NO:'Noruega',
  DK:'Dinamarca', FI:'Finlandia', IE:'Irlanda', RO:'Rumanía', CZ:'Chequia',
  MA:'Marruecos', DZ:'Argelia', SN:'Senegal', NG:'Nigeria', ZA:'Sudáfrica',
}

function DemBar({ value, total, max, color = 'var(--blue)' }: { value: number; total: number; max: number; color?: string }) {
  const barPct  = max > 0 ? Math.round((value / max) * 100) : 0
  const totPct  = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, height: 18, background: 'var(--bg)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${barPct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width .4s' }} />
      </div>
      <span style={{ minWidth: 80, fontSize: 12, color: 'var(--text2)', textAlign: 'right' }}>
        {value.toLocaleString()} <span style={{ opacity: .6 }}>({totPct}%)</span>
      </span>
    </div>
  )
}

function DemographicsPanel({ stats }: { stats: any }) {
  const { summary, ageDist, natDist, provinceDist } = stats
  const total      = Number(summary.total ?? 0)
  const withAge    = Number(summary.with_age ?? 0)
  const withNat    = Number(summary.with_nationality ?? 0)
  const avgAge     = summary.avg_age ? Number(summary.avg_age) : null
  const ageUnknown = total - withAge
  const natUnknown = total - withNat

  // ageDist rows from backend, sorted by bucket order
  const ageRows = Object.keys(AGE_BUCKETS)
    .map(k => ({ bucket: k, label: AGE_BUCKETS[k], count: Number((ageDist as any[]).find((r: any) => r.bucket === k)?.count ?? 0) }))
  const ageMax = Math.max(...ageRows.map(r => r.count), 1)

  // natDist already sorted desc
  const natRows: { nationality: string; count: number }[] = (natDist as any[]).map((r: any) => ({ nationality: r.nationality, count: Number(r.count) }))
  const natMax = natRows[0]?.count ?? 1

  const provRows: { code: string; province: string; count: number }[] =
    ((provinceDist ?? []) as any[]).map((r: any) => ({ code: r.code, province: r.province, count: Number(r.count) }))
  const provMax   = provRows[0]?.count ?? 1
  const provTotal = provRows.reduce((s, r) => s + r.count, 0)

  return (
    <div style={{ padding: '20px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
      {/* Ages */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Distribución por edad</h3>
          {avgAge && <span style={{ fontSize: 12, color: 'var(--text2)' }}>Media: <strong>{avgAge} años</strong></span>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {ageRows.map(({ label, count }) => (
            <div key={label}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{label}</div>
              <DemBar value={count} total={total} max={ageMax} color="var(--blue)" />
            </div>
          ))}
          {ageUnknown > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text2)' }}>Sin datos</div>
              <DemBar value={ageUnknown} total={total} max={total} color="var(--border)" />
            </div>
          )}
        </div>
      </div>

      {/* Nationalities */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Distribución por nacionalidad</h3>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>{natRows.length} países</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {natRows.map(({ nationality: code, count }) => (
            <div key={code}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                {COUNTRY_NAMES[code] ?? code} <span style={{ color: 'var(--text2)', fontWeight: 400 }}>({code})</span>
              </div>
              <DemBar value={count} total={total} max={natMax} color="#10b981" />
            </div>
          ))}
          {natUnknown > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text2)' }}>Sin datos</div>
              <DemBar value={natUnknown} total={total} max={total} color="var(--border)" />
            </div>
          )}
        </div>
      </div>

      {/* Mapamundi por nacionalidad */}
      {natRows.length > 0 && (
        <div style={{ gridColumn: '1 / -1' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>🌍 Huéspedes por nacionalidad</h3>
          <WorldMap counts={Object.fromEntries(natRows.map(r => [r.nationality, r.count]))} />
        </div>
      )}

      {/* Reservas por provincia (España): mapa + ranking */}
      {provRows.length > 0 && (
        <div style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>🇪🇸 Reservas por provincia de origen</h3>
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>
              {provTotal} reservas de huéspedes con ciudad en España
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 28, alignItems: 'start' }}>
            <SpainMap counts={Object.fromEntries(provRows.map(r => [r.code, r.count]))} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {provRows.slice(0, 12).map(({ code, province, count }) => (
                <div key={code}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    {province} <span style={{ color: 'var(--text2)', fontWeight: 400 }}>({code})</span>
                  </div>
                  <DemBar value={count} total={provTotal} max={provMax} color="#8b5cf6" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Summary */}
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 24, padding: '14px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        {([
          ['Total huéspedes', total.toLocaleString()],
          ['Con edad registrada', `${withAge.toLocaleString()} (${total ? Math.round(withAge / total * 100) : 0}%)`],
          ['Con nacionalidad',    `${withNat.toLocaleString()} (${total ? Math.round(withNat / total * 100) : 0}%)`],
          ['Edad media', avgAge ? `${avgAge} años` : '—'],
          ['Género', (() => {
            const g = Object.fromEntries(((stats.genderDist ?? []) as any[]).map((r: any) => [r.gender, Number(r.count)]))
            const m = g.male ?? 0, f = g.female ?? 0
            return m + f > 0 ? `♂ ${m.toLocaleString()} · ♀ ${f.toLocaleString()}` : '—'
          })()],
        ] as [string, string][]).map(([label, value]) => (
          <div key={label}>
            <div style={{ fontSize: 11, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.5px' }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── GuestsView ───────────────────────────────────────────────────────────────

// Por defecto la lista muestra huéspedes con estancias en los últimos 3 meses.
// Borrar el filtro de fecha muestra todos. La pestaña Demografía siempre es global.
const THREE_MONTHS_AGO = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)

export default function GuestsView() {
  const [tab,      setTab]      = useState<'lista' | 'demo'>('lista')
  const [query,    setQuery]    = useState('')
  const [nat,      setNat]      = useState('')
  const [stayFrom, setStayFrom] = useState(THREE_MONTHS_AGO)
  const [stayTo,   setStayTo]   = useState('')
  const [data,     setData]     = useState<any[]>([])
  const [meta,     setMeta]     = useState<any>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [editing,  setEditing]  = useState<any | null | 'new'>(null)
  const [sortBy,   setSortBy]   = useState('createdAt')
  const [sortDir,  setSortDir]  = useState<'asc'|'desc'>('desc')
  const [demoStats,   setDemoStats]   = useState<any | null>(null)
  const [demoLoading, setDemoLoading] = useState(false)
  const [demoError,   setDemoError]   = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = async (q?: string, nationality?: string, sf?: string, st?: string, sb = sortBy, sd = sortDir) => {
    setLoading(true); setError(null)
    try {
      const params: Record<string, string> = { limit: '100', sortBy: sb, sortDir: sd }
      if (q)           params.q           = q
      if (nationality) params.nationality = nationality
      if (sf) params.stayFrom = sf
      if (st) params.stayTo   = st
      const res: any = await api.listGuests(params)
      setData(res.data); setMeta(res.meta ?? null)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load(undefined, undefined, THREE_MONTHS_AGO) }, [])

  useEffect(() => {
    if (tab !== 'demo' || demoStats !== null || demoLoading) return
    setDemoLoading(true); setDemoError(null)
    fetch('/api/guests/stats').then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(new Error(d.error ?? 'Error')))).then(setDemoStats)
      .catch((e: any) => setDemoError(e.message ?? 'Error cargando datos')).finally(() => setDemoLoading(false))
  }, [tab])

  const triggerLoad = (q: string, natVal: string, sf: string, st: string, sb = sortBy, sd = sortDir) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => load(q || undefined, natVal || undefined, sf || undefined, st || undefined, sb, sd), 350)
  }

  const onSort = (col: string) => {
    const newDir = sortBy === col && sortDir === 'asc' ? 'desc' : sortBy === col ? 'asc' : 'asc'
    setSortBy(col); setSortDir(newDir)
    load(query || undefined, nat || undefined, stayFrom || undefined, stayTo || undefined, col, newDir)
  }

  const onSearch    = (val: string) => { setQuery(val);    triggerLoad(val, nat, stayFrom, stayTo) }
  const onNatChange = (val: string) => { setNat(val);      triggerLoad(query, val, stayFrom, stayTo) }
  const onSfChange  = (val: string) => { setStayFrom(val); triggerLoad(query, nat, val, stayTo) }
  const onStChange  = (val: string) => { setStayTo(val);   triggerLoad(query, nat, stayFrom, val) }

  const hasFilters = stayFrom || stayTo || nat

  const Th = ({ col, children, style }: { col?: string; children: React.ReactNode; style?: React.CSSProperties }) => (
    <th
      style={{ cursor: col ? 'pointer' : 'default', userSelect: 'none', whiteSpace: 'nowrap', ...style }}
      onClick={col ? () => onSort(col) : undefined}
    >
      {children}
      {col && sortBy === col && (
        <span style={{ marginLeft: 4, opacity: .7, fontSize: 10 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
      )}
      {col && sortBy !== col && (
        <span style={{ marginLeft: 4, opacity: .2, fontSize: 10 }}>▲▼</span>
      )}
    </th>
  )

  const tabStyle = (t: typeof tab) => ({
    padding: '5px 14px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: tab === t ? 'var(--blue)' : 'transparent',
    color: tab === t ? '#fff' : 'var(--text)',
    fontWeight: 500,
    fontSize: 13,
    cursor: 'pointer',
  })

  return (
    <>
      <div className="search-bar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={tabStyle('lista')} onClick={() => setTab('lista')}>Lista</button>
          <button style={tabStyle('demo')}  onClick={() => setTab('demo')}>Demografía</button>
        </div>

        {tab === 'lista' && (
          <>
            <input placeholder="Buscar por nombre, email, teléfono, documento…" type="search"
              value={query} onChange={e => onSearch(e.target.value)}
              style={{ maxWidth: 320 }} />
            <input placeholder="País (ISO2: ES, FR…)" type="text" maxLength={2}
              value={nat} onChange={e => onNatChange(e.target.value.toUpperCase())}
              style={{ width: 130, textTransform: 'uppercase' }}
              title="Buscar por nacionalidad (código ISO2)" />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>Estadía:</span>
              <input type="date" value={stayFrom} onChange={e => onSfChange(e.target.value)}
                style={{ width: 140 }} title="Fecha inicio estadía" />
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>—</span>
              <input type="date" value={stayTo} onChange={e => onStChange(e.target.value)}
                style={{ width: 140 }} title="Fecha fin estadía" />
              {hasFilters && (
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 8px' }}
                  onClick={() => { setStayFrom(''); setStayTo(''); setNat(''); triggerLoad(query, '', '', '') }}>
                  × Limpiar
                </button>
              )}
            </div>
          </>
        )}

        <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setEditing('new')}>
          + Nuevo huésped
        </button>
      </div>

      {tab === 'demo' ? (
        demoLoading ? (
          <div className="loading">Cargando datos…</div>
        ) : demoError ? (
          <div className="empty"><p style={{ color: 'var(--red)' }}>{demoError}</p></div>
        ) : demoStats ? (
          <div className="card">
            <div className="card-header">
              <h2>Demografía</h2>
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>{Number(demoStats.summary?.total ?? 0).toLocaleString()} huéspedes totales</span>
            </div>
            <DemographicsPanel stats={demoStats} />
          </div>
        ) : (
          <div className="empty"><div className="icon">📊</div><p>Sin huéspedes registrados</p></div>
        )
      ) : (
        <>
          {loading && <div className="loading">Cargando…</div>}
          {error   && <div className="empty"><p style={{ color: 'var(--red)' }}>{error}</p></div>}
          {!loading && !error && data.length === 0 && (
            <div className="empty"><div className="icon">📭</div><p>Sin huéspedes</p></div>
          )}
          {!loading && !error && data.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h2>Huéspedes <span style={{ color: 'var(--text2)', fontWeight: 400 }}>({meta?.total ?? data.length})</span></h2>
              </div>
              <table>
                <thead>
                  <tr>
                    <Th col="lastName">Nombre</Th>
                    <Th col="email">Email</Th>
                    <Th>Teléfono</Th>
                    <Th col="dateOfBirth" style={{ textAlign: 'center' }}>Edad</Th>
                    <Th col="nationality">Nacionalidad</Th>
                    <Th>Documento</Th>
                    <Th col="reservationCount" style={{ textAlign: 'center' }}>Reservas</Th>
                    <Th col="totalNights" style={{ textAlign: 'center' }}>Noches</Th>
                    <Th col="guestRating">Val. huésped</Th>
                    <Th col="hotelRating">Val. hotel</Th>
                    <Th>VIP</Th>
                    <Th col="createdAt">Alta</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((g: any) => (
                    <tr key={g.id} style={{ cursor: 'pointer' }} onClick={() => setEditing(g)}>
                      <td><strong>{g.firstName} {g.lastName}{g.secondLastName ? ` ${g.secondLastName}` : ''}</strong></td>
                      <td>{g.email ?? '—'}</td>
                      <td>{g.phone ?? '—'}</td>
                      <td style={{ textAlign: 'center', color: 'var(--text2)' }}>{calcAge(g.dateOfBirth) ?? '—'}</td>
                      <td style={{ textAlign: 'center' }}>{g.nationality ? g.nationality.toUpperCase() : '—'}</td>
                      <td>{g.idDocType ? `${g.idDocType.toUpperCase()} ${g.idDocNumber ?? ''}` : '—'}</td>
                      <td style={{ textAlign: 'center', fontWeight: 600 }}>{g.reservationCount ?? 0}</td>
                      <td style={{ textAlign: 'center', color: 'var(--text2)' }}>{g.totalNights ?? 0}</td>
                      <td><StarRating value={g.guestRating} readonly /></td>
                      <td><StarRating value={g.hotelRating} readonly /></td>
                      <td>{g.isVip ? '★' : ''}</td>
                      <td style={{ color: 'var(--text2)', fontSize: 12 }}>{fmtDate(g.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {editing !== null && (
        <GuestModal
          guest={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(query || undefined, stayFrom || undefined, stayTo || undefined) }}
          onDeleted={() => { setEditing(null); load(query || undefined, stayFrom || undefined, stayTo || undefined) }}
        />
      )}
    </>
  )
}

export function GuestModal({ guest, onClose, onSaved, onDeleted }: {
  guest: any; onClose: () => void; onSaved: () => void; onDeleted?: () => void
}) {
  const isEdit = !!guest?.id
  const g = guest ?? {}
  const [form, setForm] = useState({
    firstName:          g.firstName ?? '',
    lastName:           g.lastName ?? '',
    secondLastName:     g.secondLastName ?? '',
    gender:             g.gender ?? 'unspecified',
    email:              g.email ?? '',
    phone:              g.phone ?? '',
    dateOfBirth:        g.dateOfBirth ?? '',
    nationality:        g.nationality ?? '',
    idDocType:          g.idDocType ?? '',
    idDocNumber:        g.idDocNumber ?? '',
    idDocIssueDate:     g.idDocIssueDate ?? '',
    idDocExpiryDate:    g.idDocExpiryDate ?? '',
    idDocSupportNumber: g.idDocSupportNumber ?? '',
    city:               g.city ?? '',
    cityIneCode:        g.cityIneCode ?? '',
    isVip:              !!g.isVip,
    emailConsentGiven:  !!g.emailConsentGiven,
    guestRating:        (g.guestRating ?? null) as number | null,
    hotelRating:        (g.hotelRating ?? null) as number | null,
  })
  const [saving,     setSaving]     = useState(false)
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0)
  const [deleting,   setDeleting]   = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))
  const chk = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.checked }))

  const save = async () => {
    if (!form.firstName || !form.lastName) { toast('Nombre y apellido son obligatorios', 'err'); return }
    if (form.city && !form.cityIneCode) { toast('Debes seleccionar el municipio de la lista', 'err'); return }
    setSaving(true)
    try {
      const data = {
        firstName: form.firstName, lastName: form.lastName,
        secondLastName: form.secondLastName || undefined,
        gender: form.gender, email: form.email || undefined, phone: form.phone || undefined,
        dateOfBirth: form.dateOfBirth || undefined, nationality: form.nationality || undefined,
        idDocType: form.idDocType || undefined, idDocNumber: form.idDocNumber || undefined,
        idDocIssueDate: form.idDocIssueDate || undefined, idDocExpiryDate: form.idDocExpiryDate || undefined,
        idDocSupportNumber: form.idDocSupportNumber || undefined,
        city: form.city || undefined, cityIneCode: form.cityIneCode || undefined,
        isVip: form.isVip, emailConsentGiven: form.emailConsentGiven,
        guestRating: form.guestRating, hotelRating: form.hotelRating,
      }
      if (isEdit) { await api.updateGuest(g.id, data); toast('Huésped actualizado') }
      else        { await api.createGuest(data);        toast('Huésped creado') }
      onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  const confirmDelete = async () => {
    setDeleting(true)
    try {
      await api.deleteGuest(g.id)
      toast('Datos de identificación eliminados')
      onDeleted?.()
    } catch (e: any) { toast(e.message, 'err'); setDeleting(false); setDeleteStep(0) }
  }

  const resCount = g.reservationCount ?? 0

  return (
    <Modal title={isEdit ? 'Editar huésped' : 'Nuevo huésped'} onClose={onClose} footer={
      deleteStep === 0 ? (
        <>
          {isEdit && (
            <button className="btn btn-ghost"
              style={{ marginRight: 'auto', color: 'var(--red)', borderColor: 'var(--red)' }}
              onClick={() => setDeleteStep(1)}>
              Borrar permanentemente
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{isEdit ? 'Guardar' : 'Crear'}</button>
        </>
      ) : deleteStep === 1 ? (
        <>
          <span style={{ fontSize: 13, color: 'var(--text2)', marginRight: 'auto' }}>
            ¿Seguro? Esto eliminará todos los datos de forma irreversible.
          </span>
          <button className="btn btn-ghost" onClick={() => setDeleteStep(0)}>Cancelar</button>
          <button className="btn" style={{ background: 'var(--red)', color: '#fff' }}
            onClick={() => setDeleteStep(2)}>
            Sí, eliminar
          </button>
        </>
      ) : (
        <>
          <button className="btn btn-ghost" onClick={() => setDeleteStep(0)} disabled={deleting}>Cancelar</button>
          <button className="btn" style={{ background: 'var(--red)', color: '#fff' }}
            onClick={confirmDelete} disabled={deleting}>
            {deleting ? 'Eliminando…' : 'Eliminar definitivamente'}
          </button>
        </>
      )
    }>
      {deleteStep > 0 ? (
        <div style={{ padding: '8px 0' }}>
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '14px 16px', color: '#991b1b' }}>
            <strong>⚠ Anonimización de datos personales (RGPD)</strong>
            <p style={{ margin: '6px 0 0', fontSize: 13 }}>
              Se eliminarán los datos identificativos de <strong>{g.firstName} {g.lastName}</strong>:
              email, teléfono, DNI/pasaporte, fecha de nacimiento, dirección y foto.
            </p>
            <p style={{ margin: '6px 0 0', fontSize: 13 }}>
              El nombre, historial de reservas, transacciones y facturas <strong>se conservarán</strong> por obligación legal contable.
              Esta acción no puede deshacerse.
            </p>
          </div>
        </div>
      ) : (
        <div className="form-grid">
          <div className="form-group"><label>Nombre *</label><input value={form.firstName} onChange={set('firstName')} /></div>
          <div className="form-group"><label>Apellido 1 *</label><input value={form.lastName} onChange={set('lastName')} /></div>
          <div className="form-group"><label>Apellido 2</label><input value={form.secondLastName} onChange={set('secondLastName')} /></div>
          <div className="form-group">
            <label>Género</label>
            <select value={form.gender} onChange={set('gender')}>
              <option value="unspecified">Sin especificar</option>
              <option value="male">Masculino</option>
              <option value="female">Femenino</option>
              <option value="non_binary">No binario</option>
            </select>
          </div>
          <div className="form-group"><label>Email</label><input type="email" value={form.email} onChange={set('email')} /></div>
          <div className="form-group"><label>Teléfono</label><input value={form.phone} onChange={set('phone')} /></div>
          <div className="form-group"><label>Fecha de nacimiento</label><input type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} /></div>
          <div className="form-group"><label>Nacionalidad <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 400 }}>(ISO: ES, FR, DE…)</span></label><input value={form.nationality} onChange={set('nationality')} placeholder="ES" style={{ textTransform: 'uppercase' }} maxLength={2} /></div>
          <div className="form-group">
            <label>Tipo de documento</label>
            <select value={form.idDocType} onChange={set('idDocType')}>
              <option value="">Sin documento</option>
              <option value="dni">DNI</option>
              <option value="nie">NIE</option>
              <option value="passport">Pasaporte</option>
              <option value="driving_licence">Carnet conducir</option>
              <option value="other">Otro</option>
            </select>
          </div>
          <div className="form-group"><label>Número de documento</label><input value={form.idDocNumber} onChange={set('idDocNumber')} /></div>
          <div className="form-group"><label>Código soporte (NIE)</label><input value={form.idDocSupportNumber} onChange={set('idDocSupportNumber')} /></div>
          <div className="form-group"><label>Fecha de expedición</label><input type="date" value={form.idDocIssueDate} onChange={set('idDocIssueDate')} /></div>
          <div className="form-group"><label>Fecha de caducidad</label><input type="date" value={form.idDocExpiryDate} onChange={set('idDocExpiryDate')} /></div>
          <div className="form-group">
            <label>Municipio</label>
            <MunicipalityPicker
              city={form.city} ineCode={form.cityIneCode}
              onChange={(city, ineCode) => setForm(f => ({ ...f, city, cityIneCode: ineCode }))}
            />
          </div>
          <div className="form-group">
            <label>Código INE</label>
            <input value={form.cityIneCode} readOnly disabled style={{ opacity: 0.6, cursor: 'not-allowed' }} placeholder="—" />
          </div>

          <div className="form-group">
            <label>Nuestra valoración del huésped</label>
            <div style={{ paddingTop: 4 }}>
              <StarRating value={form.guestRating}
                onChange={v => setForm(f => ({ ...f, guestRating: v || null }))} />
              {form.guestRating && (
                <button style={{ marginLeft: 8, fontSize: 11, color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer' }}
                  onClick={() => setForm(f => ({ ...f, guestRating: null }))}>× quitar</button>
              )}
            </div>
          </div>
          <div className="form-group">
            <label>Valoración que nos ha dejado</label>
            <div style={{ paddingTop: 4 }}>
              <StarRating value={form.hotelRating}
                onChange={v => setForm(f => ({ ...f, hotelRating: v || null }))} />
              {form.hotelRating && (
                <button style={{ marginLeft: 8, fontSize: 11, color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer' }}
                  onClick={() => setForm(f => ({ ...f, hotelRating: null }))}>× quitar</button>
              )}
            </div>
          </div>

          <div className="form-group" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 20 }}>
            <input type="checkbox" id="g-vip" checked={form.isVip} onChange={chk('isVip')} />
            <label htmlFor="g-vip">Marcar como VIP</label>
          </div>
          <div className="form-group" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 20 }}>
            <input type="checkbox" id="g-consent" checked={form.emailConsentGiven} onChange={chk('emailConsentGiven')} />
            <label htmlFor="g-consent">Consentimiento email (RGPD)</label>
          </div>

          {isEdit && (resCount > 0 || (g.totalNights ?? 0) > 0) && (
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <div style={{ display: 'flex', gap: 16, padding: '10px 14px', background: 'var(--bg2)', borderRadius: 8, fontSize: 13 }}>
                <span><strong>{resCount}</strong> reserva{resCount !== 1 ? 's' : ''}</span>
                <span style={{ color: 'var(--text2)' }}>·</span>
                <span><strong>{g.totalNights ?? 0}</strong> noche{(g.totalNights ?? 0) !== 1 ? 's' : ''} en total</span>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
