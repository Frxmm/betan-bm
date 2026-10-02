import { env } from './env'

export function isPexelsConfigured(): boolean {
  return !!env.PEXELS_API_KEY
}

// Busca una foto que encaje con la descripción del lugar y devuelve una URL
// grande lista para usar como fondo, más el crédito obligatorio del fotógrafo
// (términos de uso de Pexels: hay que atribuir).
export async function searchPlacePhoto(query: string): Promise<{ url: string; credit: string } | null> {
  if (!env.PEXELS_API_KEY) return null
  const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`, {
    headers: { Authorization: env.PEXELS_API_KEY },
  })
  if (!res.ok) return null
  const data = await res.json()
  const photo = data.photos?.[0]
  if (!photo) return null
  return {
    url:    photo.src?.large2x ?? photo.src?.large ?? photo.src?.original,
    credit: `Foto de ${photo.photographer} en Pexels`,
  }
}
