import { createContext, useContext, useState, useEffect, useCallback } from 'react'

// Branding y módulos del tenant (GET /api/settings/property). Nada fijo: todo
// viene del establecimiento al que pertenece la sesión.
export interface Property {
  id: number
  name: string
  slug: string
  legalName?: string
  vatNumber?: string
  touristRegistryNumber?: string
  address?: string
  postalCode?: string
  city?: string
  region?: string
  countryCode?: string
  phone?: string
  email?: string
  receptionEmail?: string
  fromEmail?: string
  websiteUrl?: string
  publicDomain?: string
  mapsUrl?: string
  logoUrl?: string
  starLabel?: string
  localeDefault?: string
  fullAddress?: string
  timezone?: string
  currencyCode?: string
  /** Aviso diario de recepción (settings ui.dailyReminder). */
  dailyReminder?: { enabled?: boolean; title?: string; body?: string } | null
  /** Módulos contratados (módulo → activo). */
  features: Record<string, boolean>
  /** Sesión de soporte: un administrador de plataforma "entró como" este tenant. */
  impersonating?: boolean
}

interface PropertyContextValue {
  property: Property
  /** Alias de property.currencyCode / timezone / features para acceso directo. */
  currency: string
  timezone: string
  features: Record<string, boolean>
  loaded: boolean
  setProperty: (p: Property) => void
  reload: () => Promise<void>
}

const PropertyContext = createContext<PropertyContextValue | null>(null)

const EMPTY_PROPERTY: Property = { id: 0, name: '', slug: '', features: {} }

export function PropertyProvider({ children }: { children: React.ReactNode }) {
  const [property, setProperty] = useState<Property>(EMPTY_PROPERTY)
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/settings/property', { credentials: 'include' })
      const j = await r.json()
      if (r.ok && j.data) setProperty(j.data as Property)
    } catch { /* se mantiene el estado anterior */ }
    finally { setLoaded(true) }
  }, [])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    document.title = property.name || 'Booking Manager'
  }, [property.name])

  return (
    <PropertyContext.Provider value={{
      property, loaded, setProperty, reload,
      currency: property.currencyCode ?? 'EUR', timezone: property.timezone ?? 'Europe/Madrid', features: property.features,
    }}>
      {children}
    </PropertyContext.Provider>
  )
}

export function useProperty() {
  const ctx = useContext(PropertyContext)
  if (!ctx) throw new Error('useProperty must be used within PropertyProvider')
  return ctx
}
